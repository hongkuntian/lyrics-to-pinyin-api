import {LibraryError} from './store.js';

const invalid=()=>{throw new LibraryError('invalid_provider_stream',502);};
const index=x=>Number.isSafeInteger(x)&&x>=0;
/** Bounded JSON lexer/parser. Only complete string leaves reach the observer. */
export class JSONLeaves {
 constructor(onString){this.onString=onString;this.stack=[];this.token='';this.string=false;this.escape=false;this.bytes=0;this.root=false;}
 path(){const p=this.stack.at(-1);return p?p.path.concat(p.key??p.index):[];}
 value(){const p=this.stack.at(-1);if(!p){if(this.root)invalid();this.root=true;return;}if(p.state!=='value')invalid();p.state='comma';p.afterComma=false;if(p.array)p.index++;}
 accept(token){
  const p=this.stack.at(-1);
  if(token==='{'||token==='['){const path=this.path();this.value();if(this.stack.length>=20)invalid();this.stack.push({path,array:token==='[',index:0,state:token==='['?'value':'key',keys:new Set()});return;}
  if(token==='}'||token===']'){if(!p||p.array!==(token===']')||!['comma',p.array?'value':'key'].includes(p.state)||p.afterComma)invalid();this.stack.pop();return;}
  if(token===':'){if(!p||p.state!=='colon')invalid();p.state='value';return;}
  if(token===','){if(!p||p.state!=='comma')invalid();p.state=p.array?'value':'key';p.afterComma=true;return;}
  let v;try{v=JSON.parse(token);}catch{invalid();}
  if(p?.state==='key'){if(typeof v!=='string'||p.keys.has(v))invalid();p.keys.add(v);p.key=v;p.state='colon';p.afterComma=false;return;}
  const path=this.path();this.value();if(p)p.afterComma=false;if(typeof v==='string')this.onString(path,v);
 }
 feed(text){this.bytes+=Buffer.byteLength(text);if(this.bytes>500_000)invalid();for(const c of text){
  if(this.string){this.token+=c;if(this.escape){this.escape=false;continue;}if(c==='\\'){this.escape=true;continue;}if(c==='"'){this.string=false;this.accept(this.token);this.token='';}continue;}
  if(this.token&&!/[\s{}\[\]:,"]/.test(c)){this.token+=c;continue;}
  if(this.token){this.accept(this.token);this.token='';}
  if(/\s/.test(c))continue;
  if(c==='"'){this.string=true;this.token=c;continue;}
  if('{}[]:,'.includes(c)){this.accept(c);continue;}this.token=c;
 }}
 finish(){if(this.token&&!this.string){this.accept(this.token);this.token='';}if(this.string||this.stack.length||!this.root)invalid();}
}

/** Responses SSE: one message/text identity, exact completed terminal, no retry. */
export async function responseStream(result,{onText,onResponse=()=>{}}={}) {
 if(!result.ok||result.headers?.get('content-type')?.split(';')[0].trim().toLowerCase()!=='text/event-stream'){
  const raw=await result.text();if(Buffer.byteLength(raw)>2_000_000)invalid();let value;try{value=JSON.parse(raw);}catch{invalid();}onResponse(value);return value;
 }
 const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',event=[],total=0,responseID=null,message=null,textID=null,text='',terminal=null,doneText=false;
 const dispatch=()=>{
  if(!event.length)return;const raw=event.filter(l=>l.startsWith('data:')).map(l=>l.slice(5).replace(/^ /,'')).join('\n');event=[];if(!raw)return;
  if(raw==='[DONE]'){if(!terminal)invalid();return;}
  let e;try{e=JSON.parse(raw);}catch{invalid();}if(!e||typeof e.type!=='string'||terminal)invalid();
  if(['response.created','response.in_progress'].includes(e.type)){const r=e.response;if(!r||typeof r.id!=='string'||responseID&&responseID!==r.id)invalid();responseID=r.id;}
  if(e.type==='response.output_item.added'&&e.item?.type==='message'){
   if(message||!index(e.output_index)||typeof e.item.id!=='string')invalid();message={id:e.item.id,index:e.output_index};
  }
  if(['response.output_text.delta','response.output_text.done'].includes(e.type)){
   if(!message||e.item_id!==message.id||e.output_index!==message.index||!index(e.content_index))invalid();
   if(textID!==null&&textID!==e.content_index)invalid();textID=e.content_index;
   if(e.type.endsWith('.delta')){if(doneText||typeof e.delta!=='string')invalid();text+=e.delta;if(Buffer.byteLength(text)>500_000)invalid();onText?.(e.delta);}
   else{if(doneText||e.text!==text)invalid();doneText=true;}
  }
  if(['response.completed','response.failed','response.incomplete'].includes(e.type)){
   const r=e.response;onResponse(r);if(!r||!responseID||r.id!==responseID)invalid();
   if(e.type!=='response.completed'||r.status!=='completed')throw new LibraryError('provider_incomplete',502);
   if(Array.isArray(r.output)&&r.output.some(item=>item.type==='message'&&Array.isArray(item.content)&&item.content.some(part=>part.type==='refusal')))throw new LibraryError('provider_refused',422);
   const item=r.output?.[message?.index],part=item?.content?.[textID];
   if(!message||!index(textID)||item?.id!==message.id||item.type!=='message'||part?.type!=='output_text'||part.text!==text)invalid();terminal=r;
  }
  if(e.type==='error')throw new LibraryError('provider_unavailable',502);
 };
 const line=l=>{if(l==='')dispatch();else event.push(l);};
 for await(const chunk of result.body){total+=chunk.byteLength;if(total>2_000_000)invalid();pending+=decoder.decode(chunk,{stream:true});let at;while((at=pending.search(/[\r\n]/))>=0){if(pending[at]==='\r'&&at===pending.length-1)break;const n=pending[at]==='\r'&&pending[at+1]==='\n'?2:1;line(pending.slice(0,at));pending=pending.slice(at+n);}}
 pending+=decoder.decode();if(pending.endsWith('\r'))pending=pending.slice(0,-1);if(pending)line(pending);dispatch();if(!terminal)invalid();return terminal;
}
