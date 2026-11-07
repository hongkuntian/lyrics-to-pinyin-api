import {randomUUID} from 'node:crypto';
/** Observer only: close/backpressure cannot cancel a claimed provider operation. */
export function translationDelivery(res,doc,target,job) {
 const streamID=randomUUID();let sequence=0,active=false,closed=false,bytes=0;
 const close=()=>{closed=true;};
 const stop=()=>{closed=true;try{res.destroy?.();}catch{}};res.once?.('close',close);
 const emit=(event,fields={})=>{
  if(closed)return;
  try{
   const line=JSON.stringify({version:1,event,streamID,jobID:job.id,documentID:doc.id,sourceHash:doc.sourceHash,target,sequence:++sequence,...fields})+'\n';
   bytes+=Buffer.byteLength(line);if(bytes>2_000_000){stop();return;}
   if(!active){res.status(200);res.setHeader('Content-Type','application/x-ndjson');res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Accel-Buffering','no');active=true;}
   if(res.write(line)===false){stop();}
  }catch{stop();}
 };
 return {get started(){return active;},onStart:()=>emit('start'),onLine:line=>emit('line',{line}),
  complete:translation=>emit('complete',{translation}),failed:code=>emit('failed',{code}),
  end(){try{res.off?.('close',close);if(active&&!closed)res.end();}catch{stop();}closed=true;}};
}
