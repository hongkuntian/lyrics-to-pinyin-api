import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {SessionV2Error} from './errors.js';

const ticketLifetimeMS=10*60*1000;
const contextKeys=['environment','principalID','keyID','action','bodyHash','sourceRecapRevision'];
const ticketKeys=[...contextKeys,'version','signingKeyID','sessionID','commandID','nonce','issuedAtMS','notAfterMS'];
const invalid=()=>{throw new SessionV2Error('invalid_request');};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
 (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
function exactKeys(value,keys){
 if(!object(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||
  Object.keys(value).some(key=>!keys.includes(key)))invalid();
}
const opaque=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\s\x00-\x1f\x7f]/u.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
function validateContext(value){
 exactKeys(value,contextKeys);
 if(!opaque(value.environment,128)||!opaque(value.principalID,128)||!opaque(value.keyID,256)||
  !['create','restart'].includes(value.action)||typeof value.bodyHash!=='string'||!/^[a-f\d]{64}$/.test(value.bodyHash)||
  (value.action==='create'?value.sourceRecapRevision!==null:!integer(value.sourceRecapRevision)))invalid();
}

/** Hash validated semantic intent, before adding its ticket. This is not authorization.
 * Object order is insignificant; array order, Unicode and exact integers remain significant.
 * Refuse values that JSON would silently drop/coerce and bound depth, nodes and bytes.
 */
export function canonicalCommandHash(value){
 if(!object(value))invalid();
 const maxBytes=16384,maxNodes=4096,hash=createHash('sha256'),ancestors=new Set();let nodes=0,bytes=0;
 function write(text,size=Buffer.byteLength(text)){
  if(bytes+size>maxBytes)invalid();bytes+=size;hash.update(text);
 }
 function quotedSize(text,limit){
  if(text.length>limit)invalid();
  let size=2;
  for(let i=0;i<text.length;i++){
   const code=text.charCodeAt(i);
   if(code===34||code===92||[8,9,10,12,13].includes(code))size+=2;
   else if(code<32)size+=6;
   else if(code>=0xd800&&code<=0xdbff){
    const next=text.charCodeAt(i+1);
    if(next>=0xdc00&&next<=0xdfff){size+=4;i++;}else size+=6;
   }else if(code>=0xdc00&&code<=0xdfff)size+=6;
   else size+=code<128?1:code<2048?2:3;
   if(size>limit)invalid();
  }
  if(size>limit)invalid();return size;
 }
 function string(text){const size=quotedSize(text,maxBytes-bytes);write(JSON.stringify(text),size);}
 function canonical(input,depth){
  if(++nodes>maxNodes||depth>24)invalid();
  if(input===null){write('null');return;}
  if(typeof input==='boolean'){write(input?'true':'false');return;}
  if(typeof input==='string'){string(input);return;}
  if(typeof input==='number'){if(!Number.isSafeInteger(input))invalid();write(JSON.stringify(input));return;}
  if(typeof input!=='object'||ancestors.has(input))invalid();
  if(!Array.isArray(input)&&!object(input))invalid();
  ancestors.add(input);
  if(Array.isArray(input)){
   if(input.length>maxNodes||Object.getPrototypeOf(input)!==Array.prototype)invalid();
   for(const key in input)if(Object.hasOwn(input,key)&&(!/^(0|[1-9]\d*)$/.test(key)||Number(key)>=input.length))invalid();
   write('[');
   for(let i=0;i<input.length;i++){
    const descriptor=Object.getOwnPropertyDescriptor(input,String(i));
    if(!descriptor||!Object.hasOwn(descriptor,'value'))invalid();
    if(i)write(',');canonical(descriptor.value,depth+1);
   }
   write(']');
  }else{
   write('{');
   // Collect only a bounded key set before sorting. Reserve their encoded
   // size (including escaping), punctuation and a minimum byte per value.
   // Never allocate Object.keys(input) for an arbitrarily wide object.
   const keys=[];let minimumRemaining=1;
   for(const key in input){
    if(!Object.hasOwn(input,key))continue;
    if(keys.length>=maxNodes)invalid();
    if(['__proto__','prototype','constructor'].includes(key))invalid();
    const descriptor=Object.getOwnPropertyDescriptor(input,key);
    if(!descriptor||!Object.hasOwn(descriptor,'value'))invalid();
    const size=quotedSize(key,maxBytes-bytes-minimumRemaining-2-(keys.length?1:0));
    minimumRemaining+=size+2+(keys.length?1:0);
    if(bytes+minimumRemaining>maxBytes)invalid();
    keys.push(key);
   }
   keys.sort();
   for(let i=0;i<keys.length;i++){
    if(i)write(',');string(keys[i]);write(':');canonical(input[keys[i]],depth+1);
   }
   write('}');
  }
  ancestors.delete(input);
 }
 canonical(value,0);return hash.digest('hex');
}

/** Server-only signer. Callers cannot choose room/command UUIDs or ticket lifetime.
 * The authenticated handler supplies the identity, deployment and canonical body hash.
 * Verification has no side effects: replay protection is the separate atomic receipt/room write.
 */
export function createCreationTickets({keys,activeKeyID,now=Date.now}={}){
 if(!Array.isArray(keys)||keys.length<1||keys.length>4||typeof now!=='function')throw new SessionV2Error('unavailable');
 const signingKeys=new Map();
 for(const entry of keys){
  if(!object(entry)||!opaque(entry.id,32)||!Buffer.isBuffer(entry.secret)||entry.secret.length<32||signingKeys.has(entry.id))
   throw new SessionV2Error('unavailable');
  signingKeys.set(entry.id,Buffer.from(entry.secret));
 }
 if(!signingKeys.has(activeKeyID))throw new SessionV2Error('unavailable');
 const mac=(encoded,key)=>createHmac('sha256',key).update(encoded).digest();
 function time(){const value=now();if(!integer(value)||!integer(value+ticketLifetimeMS))throw new SessionV2Error('unavailable');return value;}
 return Object.freeze({
  issue(context){
   validateContext(context);const issuedAtMS=time();
   const payload={...context,version:2,signingKeyID:activeKeyID,sessionID:randomUUID(),commandID:randomUUID(),
    nonce:randomBytes(24).toString('base64url'),issuedAtMS,notAfterMS:issuedAtMS+ticketLifetimeMS};
   const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
   const ticket=encoded+'.'+mac(encoded,signingKeys.get(activeKeyID)).toString('base64url');
   if(ticket.length>4096)throw new SessionV2Error('unavailable');
   return Object.freeze({ticket,sessionID:payload.sessionID,commandID:payload.commandID,notAfterMS:payload.notAfterMS});
  },
  verify(ticket,context){
   validateContext(context);
   if(typeof ticket!=='string'||ticket.length>4096||!/^[-_A-Za-z\d]+\.[-_A-Za-z\d]+$/.test(ticket))invalid();
   const [encoded,signature]=ticket.split('.');
   const bytes=Buffer.from(encoded,'base64url'),supplied=Buffer.from(signature,'base64url');
   if(bytes.toString('base64url')!==encoded||supplied.toString('base64url')!==signature||supplied.length!==32)invalid();
   let payload;
   try{payload=JSON.parse(bytes.toString('utf8'));}catch{invalid();}
   if(!object(payload)||!signingKeys.has(payload.signingKeyID))invalid();
   if(!timingSafeEqual(supplied,mac(encoded,signingKeys.get(payload.signingKeyID))))invalid();
   exactKeys(payload,ticketKeys);
   for(const key of contextKeys)if(payload[key]!==context[key])invalid();
   const uuid=/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/;
   if(payload.version!==2||!uuid.test(payload.sessionID)||!uuid.test(payload.commandID)||
    typeof payload.nonce!=='string'||!/^[-_A-Za-z\d]{32}$/.test(payload.nonce)||
    !integer(payload.issuedAtMS)||!integer(payload.notAfterMS)||payload.notAfterMS-payload.issuedAtMS!==ticketLifetimeMS)invalid();
   const current=time();if(payload.issuedAtMS>current)invalid();
   if(current>=payload.notAfterMS)throw new SessionV2Error('expired');
   return Object.freeze(payload);
  }
 });
}
