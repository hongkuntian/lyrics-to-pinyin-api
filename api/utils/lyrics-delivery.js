import {randomUUID} from 'node:crypto';
import {waitUntil} from '@vercel/functions';
import {publicRawLyrics} from './lyric-annotations.js';

const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,normalize(value[k])])):value;
const rawResult=body=>body?.song?body:body?.document?.response;

/** Request-owned, bounded fanout. The handler is awaited through completion;
 * no background continuation is needed to finish an early readable response. */
export function withLyricsDelivery(handler,{library=false,timeoutMs=16000,cleanupTimeoutMs=2000,waitUntilFn=waitUntil}={}) {
 const flights=new Map();
 return async(req,res)=>{
  if(req.lyricDelivery)return handler(req,res);
  if(library&&req.body?.action!=='lyrics')return handler(req,res);
  if(library&&!req.lyricaUser)return res.status(401).json({version:1,code:'unauthorized'});
  const requested=library?req.body?.delivery:req.body?.options?.delivery;
  if(requested!==undefined&&requested!=='progressive-v1')return res.status(400).json({...(library?{version:1}:{}),code:'invalid_request'});
  const body=structuredClone(req.body??{});
  if(library)delete body.delivery;else if(body.options)delete body.options.delivery;
  const key=JSON.stringify({method:req.method,body:normalize(body)});
  let flight=flights.get(key);const joined=Boolean(flight);
  if(!flight) {
   const controller=new AbortController(),id=randomUUID(),deadlineAtMS=Date.now()+timeoutMs;
   flight={id,deadlineAtMS,controller,readers:new Set(),latest:null,sequence:0,done:false};flights.set(key,flight);
   const children=new Set();
   const context={signal:controller.signal,acquisitionID:id,deadlineAtMS,own:promise=>{
    children.add(promise);promise.then(()=>children.delete(promise),()=>children.delete(promise));return promise;
   },publish:(response,diagnostics={})=>{
    if(flight.done||controller.signal.aborted)return;
    const snapshot=publicRawLyrics(structuredClone(response));delete snapshot.library;
    flight.latest={version:1,event:'readable',acquisitionID:id,sequence:++flight.sequence,deadlineAtMS,response:snapshot,...diagnostics};
    for(const reader of flight.readers)reader.publish(flight.latest);
   }};
   flight.promise=(async()=>{
    let timer;
    const headers={},capture={statusCode:200,setHeader(k,v){headers[k]=v;},status(v){this.statusCode=v;return this;},json(value){this.body=value;return this;}};
    try {
     const operation=Promise.resolve().then(()=>handler({...req,body,lyricDelivery:context},capture)).finally(async()=>{while(children.size)await Promise.allSettled([...children]);}).then(()=>({status:capture.statusCode,body:capture.body,headers}));
     flight.cleanup=operation.catch(()=>{});
     const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({status:504,body:{code:'provider_timeout'},headers});},timeoutMs);});
     return await Promise.race([operation,deadline]);
    }catch(error){return {status:502,body:{code:error.code??'provider_unavailable'},headers};}
    finally{clearTimeout(timer);flight.done=true;if(flights.get(key)===flight)flights.delete(key);}
   })();
  }
  let closed=false,started=false,bytes=0;
  const progressive=requested==='progressive-v1';
  const write=frame=>{
   if(closed||!progressive)return;
   if(!started){res.status(200);res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Accel-Buffering','no');started=true;}
   const line=JSON.stringify(frame)+'\n';bytes+=Buffer.byteLength(line);
   if(bytes>2_000_000){release();res.destroy?.();return;}
   try{res.write(line);}catch{release();}
  };
  const reader={publish:write};flight.readers.add(reader);
  let release;
  const disconnected=new Promise(resolve=>{release=()=>{if(closed)return;closed=true;flight.readers.delete(reader);if(!flight.done&&!flight.readers.size){flight.controller.abort();if(flights.get(key)===flight)flights.delete(key);}resolve(null);};});
  res.once?.('close',release);
  if(flight.latest)write(flight.latest);
  try {
   const result=await Promise.race([flight.promise,disconnected]);if(!result||closed)return;
   if(result.body?.song)result.body=publicRawLyrics(result.body);
   if(!progressive){for(const [k,v]of Object.entries(result.headers))res.setHeader(k,v);if(joined&&Object.hasOwn(result.headers,'X-Lyrics-Cache'))res.setHeader('X-Lyrics-Cache','COALESCED');return res.status(result.status).json(result.body);}
   const success=result.status===200&&!result.body?.refreshError&&(library?result.body?.document:result.body?.song);
   if(!success&&!started){for(const[k,v]of Object.entries(result.headers))res.setHeader(k,v);return res.status(result.status).json(result.body);}
   if(success&&!started&&!library){const response=rawResult(result.body);if(response)write({version:1,event:'readable',acquisitionID:flight.id,sequence:++flight.sequence,deadlineAtMS:flight.deadlineAtMS,response});}
   write({version:1,event:success?'complete':'refresh_failed',acquisitionID:flight.id,sequence:++flight.sequence,deadlineAtMS:flight.deadlineAtMS,
    ...(success?(library?{document:result.body.document}:{response:result.body}):{code:result.body?.refreshError??result.body?.code??'lyrics_unavailable'}),
    ...(result.headers['X-Request-ID']?{requestID:result.headers['X-Request-ID']}:{}),...(result.headers['X-Lyrics-Cache']?{cache:result.headers['X-Lyrics-Cache']}:{}),...(result.headers['Server-Timing']?{serverTiming:result.headers['Server-Timing']}:{} )});
   res.end();
  }finally{
   res.off?.('close',release);flight.readers.delete(reader);if(!flight.done&&!flight.readers.size)flight.controller.abort();
   if(flight.controller.signal.aborted&&flight.cleanup){
    // Cancellation stops acquisition. Await normal provider/lease cleanup;
    // slow storage cleanup has explicit platform ownership after this request.
    let timer;const settled=await Promise.race([flight.cleanup.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),cleanupTimeoutMs);})]);clearTimeout(timer);
    if(!settled)waitUntilFn(flight.cleanup);
   }
  }
 };
}
