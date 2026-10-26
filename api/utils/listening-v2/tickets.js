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
 const ancestors=new Set();let nodes=0;
 function canonical(input,depth){
  if(++nodes>4096||depth>24)invalid();
  if(input===null||typeof input==='boolean')return input;
  if(typeof input==='string'){if(Buffer.byteLength(input)>16384)invalid();return input;}
  if(typeof input==='number'){if(!Number.isSafeInteger(input))invalid();return input;}
  if(typeof input!=='object'||ancestors.has(input))invalid();
  if(!Array.isArray(input)&&!object(input))invalid();
  ancestors.add(input);
  let result;
  if(Array.isArray(input)){
   if(Object.keys(input).length!==input.length)invalid();
   result=Array.from(input,item=>canonical(item,depth+1));
  }else{
   result=Object.create(null);
   for(const key of Object.keys(input).sort()){
    if(['__proto__','prototype','constructor'].includes(key))invalid();
    result[key]=canonical(input[key],depth+1);
   }
  }
  ancestors.delete(input);return result;
 }
 const serialized=JSON.stringify(canonical(value,0));
 if(Buffer.byteLength(serialized)>16384)invalid();
 return createHash('sha256').update(serialized).digest('hex');
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
