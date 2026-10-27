import {createHash} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {parseBoundedSessionJSON} from './protocol.js';
import {SessionV2Error} from './errors.js';

export const INSTALL_BINDING_VERSION=1;
const domain='lyrica.sessions.physical-install.v1\0';
const fields=['key_id','bundle_id','audience','environment'];
const invalid=()=>{throw new SessionV2Error('invalid_request');};
const unavailable=()=>{throw new SessionV2Error('unavailable');};
const ascii=(value,maximum,disallowed)=>typeof value==='string'&&value.length>0&&value.length<=maximum&&!disallowed.test(value);
const bundleID=value=>ascii(value,128,/[^A-Za-z0-9.-]/);
const record=value=>value!==null&&typeof value==='object'&&!isProxy(value)&&!Array.isArray(value)&&
 [Object.prototype,null].includes(Object.getPrototypeOf(value));
function serverField(value,key){
 if(!record(value))unavailable();
 const descriptor=Object.getOwnPropertyDescriptor(value,key);
 if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))unavailable();
 return descriptor.value;
}

/** Pure, unused server-only encoder. Config is explicit AppAuth policy data;
 * no environment, SQL, authentication, provenance, generation or IO is read.
 * Only fixed own data fields are inspected; caller configuration is not frozen.
 */
export function createInstallBinding(options){
 const policy=serverField(options,'policy');
 const audience=serverField(policy,'audience'),environment=serverField(policy,'environment');
 const prefix=serverField(policy,'prefix'),bundles=serverField(policy,'bundles');
 if(!ascii(audience,64,/[^A-Za-z0-9_-]/)||!['development','production'].includes(environment)||
  typeof prefix!=='string'||prefix.length!==10||/[^A-Z0-9]/.test(prefix)||
  !bundles||typeof bundles!=='object'||isProxy(bundles)||!Array.isArray(bundles)||bundles.length<1||bundles.length>64)unavailable();
 const admittedBundles=new Set();
 for(let index=0;index<bundles.length;index++){
  const descriptor=Object.getOwnPropertyDescriptor(bundles,String(index));
  if(!descriptor||!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||!bundleID(descriptor.value))unavailable();
  admittedBundles.add(descriptor.value);
 }
 // prefix is validated above, then deliberately excluded: historic key tuples
 // do not persist it. It must never be reconstructed/inserted into this frame.
 return Object.freeze({
  deriveScope(rawTupleJSON){
   // Refuse caller objects/proxies before enumeration or any property read.
   // The own2KiB UTF8 cap precedes the shared16KiB parser's structural checks.
   if(typeof rawTupleJSON!=='string'||rawTupleJSON.length>2048||Buffer.byteLength(rawTupleJSON,'utf8')>2048)invalid();
   const tuple=parseBoundedSessionJSON(rawTupleJSON);
   if(tuple===null||typeof tuple!=='object'||Array.isArray(tuple)||Object.keys(tuple).length!==fields.length||
    fields.some(key=>!Object.hasOwn(tuple,key)))invalid();
   const {key_id,bundle_id,audience:tupleAudience,environment:tupleEnvironment}=tuple;
   if(typeof key_id!=='string'||key_id.length!==44||!/^[A-Za-z0-9+/]{43}=$/.test(key_id)||
    tupleAudience!==audience||tupleEnvironment!==environment||!admittedBundles.has(bundle_id))invalid();
   const key=Buffer.from(key_id,'base64');
   if(key.length!==32||key.toString('base64')!==key_id)invalid();
   const hash=createHash('sha256').update(domain,'utf8');
   for(const bytes of [key,Buffer.from(bundle_id,'utf8'),Buffer.from(tupleAudience,'utf8'),Buffer.from(tupleEnvironment,'utf8')]){
    const length=Buffer.alloc(4);length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
   }
   // Linkable pseudonymous lookup only. No public DTO/log or positive receipt.
   return hash.digest('hex');
  }
 });
}
