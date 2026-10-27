import {isProxy} from 'node:util/types';
import {SessionV2Error} from './errors.js';
import {parseBoundedSessionJSON} from './protocol.js';

const invalid=()=>{throw new SessionV2Error('invalid_request');};
const MAX=9007199254740991,DAY=86400000;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digestPattern=/^[0-9a-f]{64}$/;
const environmentPattern=/^preview:[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const controlPattern=/[\u0000-\u001f\u007f-\u009f]/u;
const spacePattern=/\p{White_Space}/u;
const keyPattern=/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const codes=Object.freeze({rooms:'r','grants-host':'h','grants-guest':'g','grants-approver':'a',
 events:'e',receipts:'c',assets:'o',complete:'x'});
const maximumMarker='p2:ffffffff-ffff-ffff-ffff-ffffffffffff:a';

function freeze(value){
 if(value!==null&&typeof value==='object'){
  for(const child of Object.values(value))freeze(child);
  Object.freeze(value);
 }
 return value;
}

export const PRIVACY_CODEC_FIELDS=freeze({
 personaTuple:['environment','persona_id','original_principal_id','original_key_id','controller_kind',
  'controller_principal_id','controller_key_id','privacy_generation','status','guest_credential_digest',
  'guest_credential_expires_at_ms','withdrawn_at_ms','scrub_due_at_ms','scrub_cursor','created_at_ms',
  'updated_at_ms','controller_privacy_epoch','private_transfer_from_generation'],
 dependency:['version','environment','selector','cursor','invalidatedAtMS'],
 scrub:['version','environment','personaID','privacyGeneration','withdrawnAtMS','scrubDueAtMS','phase','cursor']
});
export const PRIVACY_CODEC_LIMITS=freeze({rawBytes:16384,parserNodes:4096,parserDepth:24,
 personaWrapperBytes:10,personaBytes:512,dependencyBytes:512,scrubBytes:4096,
 markerBytes:41,markerColumnBytes:96,identifierBytes:160,environmentBytes:128,
 maxUInt:MAX,guestLifetimeMS:7776000000,scrubIntervalMS:DAY,eventSeqMax:30001});

/** SQL int8 adapter only. No Number(object), valueOf, reflection or rounding. */
export function decodePrivacyUInt(value){
 if(typeof value==='number'){
  if(!uint(value))invalid();
  return value;
 }
 if(typeof value==='bigint'){
  if(value<0n||value>9007199254740991n)invalid();
  return Number(value);
 }
 if(typeof value==='string'){
  // Bound before the regex/conversion, including pathological decimal strings.
  if(value.length>16||!/^(0|[1-9][0-9]*)$/.test(value))invalid();
  const result=Number(value);
  if(!uint(result))invalid();
  return result;
 }
 invalid();
}
const uint=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
const nullableUInt=value=>value===null||uint(value);
const uuid=value=>typeof value==='string'&&uuidPattern.test(value);
const digest=value=>typeof value==='string'&&digestPattern.test(value);
const environment=value=>typeof value==='string'&&(['production','development','test'].includes(value)||environmentPattern.test(value));
const identifier=value=>typeof value==='string'&&Buffer.byteLength(value)>=1&&Buffer.byteLength(value)<=160&&!controlPattern.test(value);
const nullableIdentifier=value=>value===null||identifier(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function exactKeys(value,expected){
 if(!object(value)||Object.keys(value).length!==expected.length||expected.some(key=>!Object.hasOwn(value,key)))invalid();
}
function preflight(rawJSON){
 // Do not reflect, stringify or inspect any caller object, including proxies.
 if(typeof rawJSON!=='string'||rawJSON.length>16384||Buffer.byteLength(rawJSON)>16384)invalid();
}
function storableString(value){
 // PostgreSQL text/jsonb cannot contain NUL or unpaired UTF-16 surrogates.
 // Other escapes/UTF8 are preserved byte-for-byte by normalization.
 for(let i=0;i<value.length;i++){
  const code=value.charCodeAt(i);
  if(code===0)invalid();
  if(code>=0xd800&&code<=0xdbff){
   const next=value.charCodeAt(++i);
   if(!(next>=0xdc00&&next<=0xdfff))invalid();
  }else if(code>=0xdc00&&code<=0xdfff)invalid();
 }
}
function storableTree(value){
 if(typeof value==='string')storableString(value);
 else if(value!==null&&typeof value==='object'){
  for(const [key,child] of Object.entries(value)){storableString(key);storableTree(child);}
 }
}
function parseRaw(rawJSON,{tuple=false}={}){
 preflight(rawJSON);
 // canonicalCommandHash (called by the existing parser) only accepts OBJECT
 // roots. Preserve the external fixed-array API using a constant internal
 // envelope, never a second JSON parser or a caller-controlled property API.
 // The wrapper costs 10 raw/canonical bytes, one root node and one depth level.
 let parsed=parseBoundedSessionJSON(tuple?'{"tuple":'+rawJSON+'}':rawJSON);
 if(tuple){exactKeys(parsed,['tuple']);parsed=parsed.tuple;}
 storableTree(parsed);
 return parsed;
}
function normalizedText(value){
 // Only freshly parsed, bounded, storable, closed values reach this encoder.
 // PostgreSQL jsonb::text uses comma-space and colon-space; key ordering does
 // not change byte length. Actual PG differential qualification is separate.
 if(Array.isArray(value))return '['+value.map(normalizedText).join(', ')+']';
 if(object(value))return '{'+Object.entries(value).map(([key,child])=>JSON.stringify(key)+': '+normalizedText(child)).join(', ')+'}';
 return JSON.stringify(value);
}
const normalizedBytes=value=>Buffer.byteLength(normalizedText(value));
function marker(value){
 return typeof value==='string'&&/^p2:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[rhgaecox]$/.test(value);
}
function deadline(withdrawn,due){
 // Safe nonnegative subtraction avoids overflow of withdrawn+DAY near MAX.
 return uint(withdrawn)&&uint(due)&&due>=withdrawn&&due-withdrawn<=DAY;
}
function reserveOption(options){
 if(options===undefined)return false;
 // This one fixed service option is separate from the raw storage boundary.
 // Refuse proxies/accessors without invoking traps or caller getters.
 if(options===null||typeof options!=='object'||isProxy(options))invalid();
 const prototype=Object.getPrototypeOf(options);
 if(prototype!==Object.prototype&&prototype!==null)invalid();
 const descriptor=Object.getOwnPropertyDescriptor(options,'reserveFuture');
 if(descriptor===undefined)return false;
 if(!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='boolean')invalid();
 return descriptor.value;
}
function validatePersona(tuple){
 if(!Array.isArray(tuple)||tuple.length!==18)invalid();
 const [env,id,origin,key,kind,controller,controllerKey,generation,status,credential,expires,
  withdrawn,due,cursor,created,updated,epoch,bridge]=tuple;
 if(!environment(env)||!uuid(id)||!identifier(origin)||!identifier(key)||
  !['guest','apple','erased'].includes(kind)||!nullableIdentifier(controller)||!nullableIdentifier(controllerKey)||
  !uint(generation)||!['live','withdrawn','erased'].includes(status)||
  !(credential===null||digest(credential))||!nullableUInt(expires)||!nullableUInt(withdrawn)||!nullableUInt(due)||
  !(cursor===null||marker(cursor))||!uint(created)||!uint(updated)||updated<created||!uint(epoch)||!nullableUInt(bridge))invalid();
 if(kind==='guest'){
  if(controller!==origin||controllerKey!==key||credential===null||expires===null||expires<=created||
   expires-created>7776000000||epoch!==0||bridge!==null)invalid();
 }else if(kind==='apple'){
  if(controller===null||controllerKey!==null||credential!==null||expires!==null)invalid();
 }else if(status!=='erased'||controller!==null||controllerKey!==null||credential!==null||expires!==null)invalid();
 if(status==='live'){
  if(withdrawn!==null||due!==null||cursor!==null)invalid();
 }else if(!deadline(withdrawn,due))invalid();
 if(bridge!==null){
  if(kind==='guest'||bridge>=generation)invalid();
  if(status==='live'&&(kind!=='apple'||generation-bridge!==1))invalid();
 }
 // 030 transition guards and Root's new immutable/initial-insert/CAS rules
 // require OLD plus actual SQL authority. A snapshot does not prove them.
}
function futurePersonaBytes(tuple){
 const live=tuple[8]==='live';
 // Root's clarified admission boundary reserves mandatory withdrawal for
 // THIS exact identity/controller. A transfer must preflight its separately
 // derived actual target tuple with the same reserve before source mutation.
 if(live&&tuple[7]===MAX)invalid();
 const terminal=tuple.slice();
 terminal[15]=MAX;terminal[13]=maximumMarker;
 if(live){
  // Check before adding, and budget the real +1 width (including rollovers).
  terminal[7]=tuple[7]+1;terminal[8]='withdrawn';
  // Future authoritative withdrawal time is unknown. Both MAX-width values
  // are safe representations and satisfy the inclusive deadline interval.
  terminal[11]=MAX;terminal[12]=MAX;
 }
 // Existing terminal generation/withdrawal/due, exact controller, captured
 // epoch, bridge, guest dependency/expiry, origin and creation never change
 // in this reservation. The only remaining reserve is progress/updated time.
 return Math.max(normalizedBytes(tuple),normalizedBytes(terminal));
}

/** Raw fixed 18-value SQL tuple. Representation and space, never authority. */
export function decodePersonaTuple(rawJSON,options){
 const tuple=parseRaw(rawJSON,{tuple:true});
 validatePersona(tuple);
 const reserveFuture=reserveOption(options),current=normalizedBytes(tuple);
 if(current>512)invalid();
 const future=reserveFuture?futurePersonaBytes(tuple):null;
 if(future!==null&&future>512)invalid();
 const named=Object.fromEntries(PRIVACY_CODEC_FIELDS.personaTuple.map((field,index)=>[field,tuple[index]]));
 return freeze({...named,tuple,normalizedBytes:current,futureNormalizedBytes:future});
}

/** EXACT031 payload; consuming service must bind row, claim and chronology. */
export function decodePrivacyDependency(rawJSON){
 const payload=parseRaw(rawJSON);
 exactKeys(payload,PRIVACY_CODEC_FIELDS.dependency);
 if(payload.version!==2||!environment(payload.environment))invalid();
 const selector=payload.selector;
 if(!object(selector))invalid();
 if(selector.kind==='indexed-sweep'){
  exactKeys(selector,['kind']);
  if(payload.invalidatedAtMS!==null)invalid();
 }else{
  exactKeys(selector,['kind','value']);
  if(!uint(payload.invalidatedAtMS))invalid();
  switch(selector.kind){
  case 'credential':if(!digest(selector.value))invalid();break;
  case 'guest-key':if(typeof selector.value!=='string'||!keyPattern.test(selector.value))invalid();break;
  case 'guest-user':case 'apple-controller':
   if(!identifier(selector.value)||spacePattern.test(selector.value))invalid();
   break;
  default:invalid();
  }
 }
 if(payload.cursor!==null&&(!Array.isArray(payload.cursor)||payload.cursor.length!==2||
  !environment(payload.cursor[0])||!uuid(payload.cursor[1])))invalid();
 const current=normalizedBytes(payload);
 // Exactly mirror 031's size-only worst cursor, even though 128 literal 'x'
 // bytes are not themselves an admitted environment namespace.
 const future=normalizedBytes({...payload,cursor:['x'.repeat(128),'ffffffff-ffff-ffff-ffff-ffffffffffff']});
 if(current>512||future>512)invalid();
 return freeze({payload,normalizedBytes:current,futureNormalizedBytes:future});
}

/** Closed <=4096-byte scrub payload, independent of persona's compact marker. */
export function decodePrivacyScrub(rawJSON){
 const payload=parseRaw(rawJSON);
 exactKeys(payload,PRIVACY_CODEC_FIELDS.scrub);
 if(payload.version!==2||!environment(payload.environment)||!uuid(payload.personaID)||
  !uint(payload.privacyGeneration)||!deadline(payload.withdrawnAtMS,payload.scrubDueAtMS)||
  typeof payload.phase!=='string'||!Object.hasOwn(codes,payload.phase))invalid();
 const {phase,cursor}=payload;
 if(phase==='complete'){
  if(cursor!==null)invalid();
 }else if(cursor!==null){
  switch(phase){
  case 'rooms':case 'grants-host':case 'grants-guest':case 'grants-approver':
   if(!uuid(cursor))invalid();
   break;
  case 'events':
   if(!Array.isArray(cursor)||cursor.length!==2||!uuid(cursor[0])||!uint(cursor[1])||cursor[1]<1||cursor[1]>30001)invalid();
   break;
  case 'receipts':
   if(!Array.isArray(cursor)||cursor.length!==4||!uuid(cursor[0])||!digest(cursor[1])||!digest(cursor[2])||!uuid(cursor[3]))invalid();
   break;
  case 'assets':
   if(!Array.isArray(cursor)||cursor.length!==4||cursor[0]!==payload.personaID||cursor[1]!==payload.privacyGeneration||
    !uint(cursor[2])||!uuid(cursor[3]))invalid();
   break;
  default:invalid();
  }
 }
 const current=normalizedBytes(payload);
 if(current>4096)invalid();
 return freeze({payload,normalizedBytes:current});
}

/** Compact phase/job mirror only. No claim, receipt, liveness or completion. */
export function privacyScrubMarker(jobID,phase){
 if(!uuid(jobID)||typeof phase!=='string'||!Object.hasOwn(codes,phase))invalid();
 return 'p2:'+jobID+':'+codes[phase];
}
