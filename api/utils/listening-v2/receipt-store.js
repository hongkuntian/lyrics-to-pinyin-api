import {createHash,createHmac} from 'node:crypto';
import {SessionV2Error} from './errors.js';
import {canonicalCommandHash,createCreationTickets} from './tickets.js';
import {parseBoundedSessionJSON} from './protocol.js';

const fail=(code='unavailable')=>{throw new SessionV2Error(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
 (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const uuid=value=>typeof value==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);
const opaque=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\s\x00-\x1f\x7f]/u.test(value);
const statuses=['accepted','executing','applied','refused','expired','uncertain','cancelled'];
const publicCodes=['invalid_request','unauthorized','forbidden','not_found','conflict','expired','rate_limited','unavailable'];
const creation=action=>action==='create'||action==='restart';
// One closed standalone action uses session_id as its private actor namespace.
const standalone=action=>action==='privacy.erase';
const thirtyDays=2592000000;

/** pg normally returns int8 as decimal text. Validate before any Number coercion.
 * A driver configured to return an already rounded unsafe Number is refused too.
 */
export function decodeSafeUInt(value){
 if(typeof value==='number'){
  if(!Number.isSafeInteger(value)||value<0)fail();
  return value;
 }
 if(typeof value==='string'){
  if(value.length>16||!/^(0|[1-9]\d*)$/.test(value))fail();
  value=BigInt(value);
 }
 if(typeof value!=='bigint'||value<0n||value>9007199254740991n)fail();
 return Number(value);
}
function add(a,b){const value=a+b;return decodeSafeUInt(value);}
function exact(value,required,optional=[],code='invalid_request'){
 if(!object(value)||required.some(k=>!Object.hasOwn(value,k))||
  Object.keys(value).some(k=>!required.includes(k)&&!optional.includes(k)))fail(code);
}
function freeze(value){
 if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
 return value;
}
const roomUInts=['invite_generation','share_generation','session_revision','queue_revision','settings_revision',
 'transition_revision','state_version','event_seq','authority_epoch','observation_sequence','desired_queue_revision',
 'applied_queue_revision','created_at_ms','expires_at_ms','updated_at_ms','receipt_count','reserved_receipts'];
const roomNullableUInts=['host_privacy_generation','ended_at_ms','event_delete_after_ms','receipt_delete_after_ms'];
function decodeRoom(row){
 if(!row)return null;
 const result={...row};
 for(const key of roomUInts)result[key]=decodeSafeUInt(row[key]);
 for(const key of roomNullableUInts)result[key]=row[key]===null?null:decodeSafeUInt(row[key]);
 return freeze(result);
}
// A deliberately small, non-PII receipt projection. Names, URLs, source/lease
// tickets, provider bodies and arbitrary nested domain state cannot be stored.
const resultUInts=['stateVersion','sessionRevision','queueRevision','settingsRevision','transitionRevision',
 'authorityEpoch','eventSeq','privacyGeneration','count'];
const resultIDs=['occurrenceID','visitID','executionID','admissionID'];
function redactedResult(value){
 exact(value,[],[...resultUInts,...resultIDs,'noop','code'],'unavailable');
 const result={};
 for(const [key,entry] of Object.entries(value)){
  if(resultUInts.includes(key))result[key]=decodeSafeUInt(entry);
  else if(resultIDs.includes(key)){if(entry!==null&&!uuid(entry))fail();result[key]=entry;}
  else if(key==='noop'){if(typeof entry!=='boolean')fail();result[key]=entry;}
  else {if(!publicCodes.includes(entry))fail();result[key]=entry;}
 }
 return freeze(result);
}
function decodeReceipt(row){
 if(!row)return null;
 if(!statuses.includes(row.status)||!Number.isInteger(row.binding_key_version))fail();
 return freeze({...row,created_at_ms:decodeSafeUInt(row.created_at_ms),
  ticket_expires_at_ms:row.ticket_expires_at_ms===null?null:decodeSafeUInt(row.ticket_expires_at_ms),
  delete_after_ms:decodeSafeUInt(row.delete_after_ms),
  actor_privacy_generation:row.actor_privacy_generation===null?null:decodeSafeUInt(row.actor_privacy_generation),
  result:redactedResult(row.result)});
}
const response=(receipt,replayed)=>freeze({version:2,sessionID:receipt.session_id,commandID:receipt.command_id,
 status:receipt.status,result:receipt.result,replayed});

/** Disabled server-only transaction gateway; importing this creates no runtime.
 *
 * lockAuthorization MUST lock the current users/tokens/exact App Attest key on
 * THIS tx (the exact key FOR UPDATE serializes replay across HMAC versions),
 * then all required connection/guard/persona/grant scopes in canonical order.
 * It must also validate bindingKeyManifest against trusted immutable per-env
 * version/secret configuration and attest its hash in bindingKeyManifestHash.
 * It returns a version-1 permit bound to the authenticated principal/key/env,
 * actor persona/generation (both null for no retained actor), notAfterMS (the
 * minimum locked session/credential/referenced-guest deadline), and read-only
 * revalidate({tx,command,room,receipt,phase,nowMS}) returning exactly true.
 * Revalidation checks current session/credential/key/controller/GuestLive,
 * permission/membership and every referenced privacy generation, including on
 * saved results. All earlier scopes MUST be known and locked before returning.
 * Missing scopes abort; neither revalidate nor a reducer may invert lock order.
 *
 * mutations is a registry of TRUSTED SERVER reducers, fixed at construction.
 * They receive the supplied tx and may perform only short transactional SQL
 * and bounded local work: no network/provider/catalog/image IO, nested db/pool
 * transactions or after-commit effects. They own strict action validation,
 * expected revisions, domain invariants and event/outbox/terminal reservations.
 * They must not change receipt rows/counters. This is not a request callback API.
 */
export function createReceiptStore({db,environment,bindingKeys,activeBindingKeyVersion,
 ticketKeys,activeTicketKeyID,lockAuthorization,mutations,now=Date.now,
 readClockMS=async tx=>(await tx.query(
  'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms')).rows[0].now_ms}={}){
 if(!db||typeof db.transaction!=='function'||typeof lockAuthorization!=='function'||typeof now!=='function'||
  typeof readClockMS!=='function'||typeof environment!=='string'||!object(mutations)||!Object.keys(mutations).length||
  !/^(production|development|test|preview:[A-Za-z0-9][A-Za-z0-9._-]{0,119})$/.test(environment??''))fail();
 const reducers=new Map();
 for(const [action,reducer] of Object.entries(mutations)){
  if(!/^[a-z][a-z0-9_.]{0,63}$/.test(action)||typeof reducer!=='function')fail();
  reducers.set(action,reducer);
 }
 if(!Array.isArray(bindingKeys)||bindingKeys.length<1||bindingKeys.length>4)fail();
 const ring=new Map();
 for(const key of bindingKeys){
  if(!object(key)||!Number.isInteger(key.version)||key.version<1||key.version>65535||
   !Buffer.isBuffer(key.secret)||key.secret.length<32||ring.has(key.version))fail();
  ring.set(key.version,Buffer.from(key.secret));
 }
 if(!ring.has(activeBindingKeyVersion))fail();
 // Copy signing keys now; caller mutation cannot rotate a live store in place.
 if(!Array.isArray(ticketKeys))fail();
 const signingKeys=ticketKeys.map(key=>({...key,secret:Buffer.isBuffer(key?.secret)?Buffer.from(key.secret):null}));
 const ticketsAt=time=>createCreationTickets({keys:signingKeys,activeKeyID:activeTicketKeyID,now:time});
 const preflightTickets=ticketsAt(()=>decodeSafeUInt(now()));
 const versions=[...ring.keys()].sort((a,b)=>a-b);
 const keyDescriptors=versions.map(version=>({version,verificationHash:createHmac('sha256',ring.get(version))
  .update(JSON.stringify(['sessions-v2.receipt-key-check',version,environment])).digest('hex')}));
 const bindingKeyManifest=freeze({keys:keyDescriptors,hash:createHash('sha256').update(JSON.stringify(keyDescriptors)).digest('hex')});
 const binding=(version,kind,id)=>createHmac('sha256',ring.get(version)).update(JSON.stringify([
  'sessions-v2.command-receipt',version,environment,kind,id])).digest('hex');
 const clock=async tx=>decodeSafeUInt(await readClockMS(tx));
 const getRoom=async(tx,id)=>decodeRoom((await tx.query(
  'SELECT * FROM listening_v2.rooms WHERE environment=$1 AND session_id=$2 FOR UPDATE',[environment,id])).rows[0]);

 function parse(input){
  exact(input,['authentication','rawCommand'],['creationTicket']);
  const authentication=input.authentication,rawCommand=input.rawCommand,encodedTicket=input.creationTicket;
  if(!object(authentication)||!opaque(authentication.principalID,128)||!opaque(authentication.keyID,256))fail('unauthorized');
  const value=parseBoundedSessionJSON(rawCommand);
  const isCreation=creation(value.action);
  exact(value,['version','action','expected','payload',...(isCreation?[]:['sessionID','commandID'])]);
  if(value.version!==2||!reducers.has(value.action)||!object(value.expected)||!object(value.payload))fail('invalid_request');
  let bodyHash,ticket=null,sessionID,commandID;
  if(isCreation){
   const sourceRecapRevision=value.action==='restart'?value.expected.sourceRecapRevision:null;
   if(value.action==='restart'&&(!Number.isSafeInteger(sourceRecapRevision)||sourceRecapRevision<0))fail('invalid_request');
   bodyHash=canonicalCommandHash(rawCommand);
   const context={environment,principalID:authentication.principalID,keyID:authentication.keyID,
    action:value.action,bodyHash,sourceRecapRevision};
   ticket=Object.freeze({...preflightTickets.verify(encodedTicket,context),encoded:encodedTicket});
   sessionID=ticket.sessionID;commandID=ticket.commandID;
  }else{
   if(encodedTicket!==undefined||!uuid(value.sessionID)||!uuid(value.commandID))fail('invalid_request');
   sessionID=value.sessionID.toLowerCase();commandID=value.commandID.toLowerCase();
   const {commandID:_,...semantic}=value;bodyHash=canonicalCommandHash(JSON.stringify(semantic));
  }
  const command=freeze({...value,environment,sessionID,commandID});
  return {authentication:Object.freeze({...authentication}),command,bodyHash,ticket};
 }
 function permitFor(value,authentication){
  if(!object(value)||value.version!==1||value.environment!==environment||value.principalID!==authentication.principalID||
   value.keyID!==authentication.keyID||value.bindingKeyManifestHash!==bindingKeyManifest.hash||typeof value.revalidate!=='function')fail();
  if((value.actorPersonaID===null)!==(value.actorPrivacyGeneration===null)||
   (value.actorPersonaID!==null&&!uuid(value.actorPersonaID)))fail();
  return Object.freeze({revalidate:value.revalidate,notAfterMS:decodeSafeUInt(value.notAfterMS),actorPersonaID:value.actorPersonaID,
   actorPrivacyGeneration:value.actorPrivacyGeneration===null?null:decodeSafeUInt(value.actorPrivacyGeneration)});
 }
 async function authorized(permit,context){
  if(context.nowMS>=permit.notAfterMS)fail('unauthorized');
  const answer=await permit.revalidate(context);
  if(answer===false)fail('unauthorized');
  if(answer!==true)fail();
 }
 function verifyTicket(ticket,command,authentication,bodyHash,time){
  if(!ticket)return;
  const current=ticketsAt(()=>time).verify(ticket.encoded,{environment,principalID:authentication.principalID,
   keyID:authentication.keyID,action:command.action,bodyHash,sourceRecapRevision:ticket.sourceRecapRevision});
  if(current.sessionID!==command.sessionID||current.commandID!==command.commandID||
   ['signingKeyID','nonce','issuedAtMS','notAfterMS'].some(field=>current[field]!==ticket[field]))fail('invalid_request');
 }
 async function checkRetainedVersions(tx){
  // At most four configured versions plus one unknown/empty successor. Each
  // strict lower bound seeks through command_receipts_binding_versions rather
  // than reading every row with an already recognized version.
  let after=0;
  for(let probe=0;probe<=versions.length;probe++){
   const row=(await tx.query(`SELECT binding_key_version FROM listening_v2.command_receipts
    WHERE environment=$1 AND binding_key_version>$2 ORDER BY binding_key_version LIMIT 1`,[environment,after])).rows[0];
   if(!row)return;
   const version=decodeSafeUInt(row.binding_key_version);
   if(version<=after||!ring.has(version))fail();
   after=version;
  }
  fail();
 }
 async function transact({authentication,command,bodyHash,ticket}){
  return db.transaction(async tx=>{
   if(!tx||typeof tx.query!=='function')fail();
   const permit=permitFor(await lockAuthorization({tx,authentication,environment,command,bindingKeyManifest}),authentication);
   const authContext={tx,command,room:null,receipt:null,phase:'locked',nowMS:await clock(tx)};
   await authorized(permit,authContext);
   verifyTicket(ticket,command,authentication,bodyHash,authContext.nowMS);
   // There is no key registry in the eight-table foundation. Never silently
   // ignore a retained version: the operator must supply its original secret.
   // Exclusive authenticated key locking serializes old/new store instances.
   await checkRetainedVersions(tx);
   const room=standalone(command.action)?null:await getRoom(tx,command.sessionID);
   const params=[environment,command.sessionID,command.commandID];
   const alternatives=versions.map(version=>{
    params.push(version,binding(version,'principal',authentication.principalID),binding(version,'key',authentication.keyID));
    const end=params.length;return `(binding_key_version=$${end-2} AND principal_binding=$${end-1} AND key_binding=$${end})`;
   });
   const rows=(await tx.query(`SELECT * FROM listening_v2.command_receipts WHERE environment=$1
    AND ${creation(command.action)?"(session_id=$2 OR action IN ('create','restart'))":'session_id=$2'}
    AND command_id=$3 AND (${alternatives.join(' OR ')})
    ORDER BY session_id,principal_binding,key_binding,command_id FOR UPDATE`,params)).rows;
   if(rows.length>1)fail(); // Corrupt/diverged historical namespace, never choose a winner.
   const receipt=decodeReceipt(rows[0]);
   const context={tx,command,room,receipt,phase:receipt?'replay':'mutation',nowMS:await clock(tx)};
   await authorized(permit,context); // Privacy/entitlement precedes even hash-conflict disclosure.
   if(receipt){
    if(receipt.session_id!==command.sessionID||receipt.action!==command.action||receipt.canonical_body_hash!==bodyHash||
     (ticket&&receipt.ticket_expires_at_ms!==ticket.notAfterMS))fail('conflict');
    await authorized(permit,{...context,phase:'commit',nowMS:await clock(tx)});
    const commitTime=await clock(tx);
    if(commitTime>=permit.notAfterMS)fail('unauthorized');
    verifyTicket(ticket,command,authentication,bodyHash,commitTime);
    return response(receipt,true);
   }
   if(creation(command.action)){if(room)fail('conflict');}
   else if(!standalone(command.action)){
    if(!room)fail('not_found');
    if(room.status!=='active'||context.nowMS>=room.expires_at_ms)fail('expired');
   }
   const outcome=await reducers.get(command.action)({tx,command,room,nowMS:context.nowMS,
    actorPersonaID:permit.actorPersonaID,actorPrivacyGeneration:permit.actorPrivacyGeneration});
   exact(outcome,['status','result'],['consumeReservedReceipt'],'unavailable');
   if(!statuses.includes(outcome.status)||
    (outcome.consumeReservedReceipt!==undefined&&typeof outcome.consumeReservedReceipt!=='boolean')||
    (standalone(command.action)&&outcome.consumeReservedReceipt!==undefined))fail();
   const result=redactedResult(outcome.result);
   // Newly inserted creation room is now visible on this same connection.
   const finalRoom=standalone(command.action)?null:await getRoom(tx,command.sessionID);
   if(creation(command.action)){
    if(['refused','expired','cancelled'].includes(outcome.status)){if(finalRoom)fail();}
    else if(!finalRoom||finalRoom.created_at_ms<ticket.issuedAtMS)fail();
   }else if(!standalone(command.action)&&!finalRoom)fail();
   const writtenAt=await clock(tx);
   let deleteAfter=add(writtenAt,thirtyDays);
   if(finalRoom){
    deleteAfter=Math.max(deleteAfter,add(finalRoom.expires_at_ms,thirtyDays),finalRoom.receipt_delete_after_ms??0);
    const reserved=outcome.consumeReservedReceipt===true?1:0;
    const updated=await tx.query(`UPDATE listening_v2.rooms SET receipt_count=receipt_count+1,
     reserved_receipts=reserved_receipts-$3 WHERE environment=$1 AND session_id=$2
     AND ($3=0 AND receipt_count+reserved_receipts<30000 OR $3=1 AND reserved_receipts>=1)
     RETURNING receipt_count`,[environment,command.sessionID,reserved]);
    if(updated.rows.length!==1)fail();
   }else if(outcome.consumeReservedReceipt)fail();
   const inserted=decodeReceipt((await tx.query(`INSERT INTO listening_v2.command_receipts(
    environment,session_id,principal_binding,key_binding,command_id,binding_key_version,room_id,action,
    canonical_body_hash,status,actor_persona_id,actor_privacy_generation,result,created_at_ms,ticket_expires_at_ms,delete_after_ms)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,[
    environment,command.sessionID,binding(activeBindingKeyVersion,'principal',authentication.principalID),
    binding(activeBindingKeyVersion,'key',authentication.keyID),command.commandID,activeBindingKeyVersion,
    finalRoom?command.sessionID:null,command.action,bodyHash,outcome.status,permit.actorPersonaID,permit.actorPrivacyGeneration,
    result,writtenAt,ticket?.notAfterMS??null,deleteAfter])).rows[0]);
   // Use fresh DB wall time after all work, never transaction-start now(). A
   // thrown deadline/auth error rolls back reducer, counters, events AND receipt.
   await authorized(permit,{tx,command,room:finalRoom,receipt:inserted,phase:'commit',nowMS:await clock(tx)});
   const commitTime=await clock(tx);
   if(commitTime>=permit.notAfterMS)fail('unauthorized');
   verifyTicket(ticket,command,authentication,bodyHash,commitTime);
   if(finalRoom&&(commitTime>=finalRoom.expires_at_ms||finalRoom.created_at_ms>commitTime))fail('expired');
   return response(inserted,false);
  });
 }
 return Object.freeze({async execute(input){
  const parsed=parse(input);
  for(let attempt=0;attempt<3;attempt++){
   try{return await transact(parsed);}
   catch(error){
    if(error instanceof SessionV2Error)throw error;
    if(['40001','40P01'].includes(error?.code)){if(attempt<2)continue;fail('conflict');}
    // Connection/commit ambiguity is lookup/retry of this same intent by the
    // caller, never an automatic new transaction or provider execution here.
    fail();
   }
  }
 }});
}
