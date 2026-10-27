import {parseBoundedSessionJSON} from './protocol.js';
import {SessionV2Error} from './errors.js';

export const TERMINAL_PAYLOAD_VERSION=2;
export const TERMINAL_PAYLOAD_MAX_BYTES=4096;
const MAX=9007199254740991,DAY=86400000;
const invalid=()=>{throw new SessionV2Error('invalid_request');};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uint=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
const uuid=value=>typeof value==='string'&&value.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const digest=value=>typeof value==='string'&&value.length===64&&/^[0-9a-f]{64}$/.test(value);
const environment=value=>typeof value==='string'&&Buffer.byteLength(value)<=128&&
 (['production','development','test'].includes(value)||/^preview:[A-Za-z0-9][A-Za-z0-9._-]{0,119}(?![\s\S])/.test(value));
function keys(value,required,optional=[]){
 if(!object(value)||required.some(k=>!Object.hasOwn(value,k))||
  Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))invalid();
}
function freeze(value){
 if(value!==null&&typeof value==='object'){
  for(const child of Object.values(value))freeze(child);
  Object.freeze(value);
 }
 return value;
}
function normalized(value){
 // Only this module's freshly parsed, closed ASCII/string/safe-uint tree can
 // reach this private size encoder. SQL jsonb::text is the byte authority;
 // comma/colon spaces match its normalized representation, not compact JSON.
 if(Array.isArray(value))return '['+value.map(normalized).join(', ')+']';
 if(object(value))return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+': '+normalized(v)).join(', ')+'}';
 return JSON.stringify(value);
}
const bytes=value=>Buffer.byteLength(normalized(value));
function validate(payload){
 keys(payload,['version','environment','selector','invalidatedAtMS','phase','cursor'],['repair']);
 if(payload.version!==2||!environment(payload.environment)||!uint(payload.invalidatedAtMS))invalid();
 const s=payload.selector;
 if(!object(s))invalid();
 switch(s.kind){
 case 'credential':
  keys(s,['kind','value']);if(!digest(s.value))invalid();break;
 case 'installation':
  keys(s,['kind','value','bindingVersion','throughGeneration']);
  if(!digest(s.value)||s.bindingVersion!==1||!uint(s.throughGeneration))invalid();break;
 case 'private-transfer':
  keys(s,['kind','targetEnvironment','personaID','fromGeneration','toGeneration']);
  if(!environment(s.targetEnvironment)||!uuid(s.personaID)||!uint(s.fromGeneration)||!uint(s.toGeneration)||
   s.fromGeneration===MAX||s.toGeneration-s.fromGeneration!==1)invalid();break;
 default:invalid();
 }
 if(!['rooms','complete'].includes(payload.phase))invalid();
 if(payload.cursor!==null&&(!Array.isArray(payload.cursor)||payload.cursor.length!==2||
  !environment(payload.cursor[0])||!uuid(payload.cursor[1])))invalid();
 if(payload.phase==='complete'&&payload.cursor!==null)invalid();
 if(Object.hasOwn(payload,'repair')){
  const r=payload.repair;
  keys(r,['rootJobID','predecessorJobID','originalCreatedAtMS','originalRetryUntilMS','repairOrdinal']);
  if(!uuid(r.rootJobID)||!uuid(r.predecessorJobID)||!uint(r.originalCreatedAtMS)||!uint(r.originalRetryUntilMS)||
   !uint(r.repairOrdinal)||r.repairOrdinal<1||r.originalRetryUntilMS<r.originalCreatedAtMS||
   r.originalRetryUntilMS-r.originalCreatedAtMS>DAY||payload.invalidatedAtMS>r.originalCreatedAtMS)invalid();
 }
}
function maximumFuture(payload){
 // This is a fixed size reservation, not an offered postimage/repair API.
 // The cursor environment reserves128 bytes even though its all-x spelling
 // is not itself a valid namespace. All allowed numeric/repair widths fit.
 let selector={...payload.selector};
 if(selector.kind==='installation')selector.throughGeneration=MAX;
 if(selector.kind==='private-transfer')selector={...selector,fromGeneration:MAX-1,toGeneration:MAX};
 return {...payload,selector,invalidatedAtMS:MAX,phase:'rooms',
  cursor:['x'.repeat(128),'ffffffff-ffff-ffff-ffff-ffffffffffff'],
  repair:{rootJobID:'ffffffff-ffff-ffff-ffff-ffffffffffff',predecessorJobID:'ffffffff-ffff-ffff-ffff-ffffffffffff',
   originalCreatedAtMS:MAX,originalRetryUntilMS:MAX,repairOrdinal:MAX}};
}

/** Closed representation only. No source/SQL/permission/attestation/End proof. */
export function parseTerminalPayload(rawJSON){
 // Refuse caller objects (including proxies) without reflection/coercion.
 // Bound UTF-8 BEFORE the shared parser/hash/duplicate-key scan runs.
 if(typeof rawJSON!=='string'||rawJSON.length>TERMINAL_PAYLOAD_MAX_BYTES||
  Buffer.byteLength(rawJSON)>TERMINAL_PAYLOAD_MAX_BYTES)invalid();
 const payload=parseBoundedSessionJSON(rawJSON);
 validate(payload);
 if(bytes(payload)>TERMINAL_PAYLOAD_MAX_BYTES||bytes(maximumFuture(payload))>TERMINAL_PAYLOAD_MAX_BYTES)invalid();
 return freeze(payload);
}
