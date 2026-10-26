import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {createReceiptStore,decodeSafeUInt} from './receipt-store.js';
import {createAdmissionState,restoreAdmissionState,validateAdmissionCommand,reduceAdmission,
 expireAdmissions,removeAdmissionMember,ADMISSION_LIMITS} from './admission.js';
import {parseBoundedSessionJSON} from './protocol.js';
import {SessionV2Error} from './errors.js';

const fail=(code='unavailable')=>{throw new SessionV2Error(code);};
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const uuid=s=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s);
const digest=s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
const opaque=s=>typeof s==='string'&&s.length<=160&&/^[\x21-\x7e]+$/.test(s);
const installKeys=['principalID','keyID','bundleID','audience','attestEnvironment'];
const sameInstall=(a,b)=>installKeys.every(k=>a[k]===b[k]);
const samePersona=(a,b)=>a.id===b.id&&a.generation===b.generation;
const day=86400000,MAX=Number.MAX_SAFE_INTEGER;
const lifecycle=new Set(['admission.expire','admission.remove']);
const actions=['create','admission.request','admission.decide','admission.cancel','settings.update','leave',
 'remembered.forget',...lifecycle];
const clone=value=>structuredClone(value);
function closed(value,required,optional=[],code='unavailable'){
 if(value===null||typeof value!=='object'||types.isProxy(value)||
  ![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(code);
 const keys=Reflect.ownKeys(value);
 if(keys.length>required.length+optional.length||required.some(k=>!Object.hasOwn(value,k)))fail(code);
 for(const key of keys){
  if(typeof key!=='string'||!required.includes(key)&&!optional.includes(key))fail(code);
  const d=Object.getOwnPropertyDescriptor(value,key);if(!Object.hasOwn(d,'value')||!d.enumerable)fail(code);
 }
}
function freeze(value){if(value&&typeof value==='object'){
 for(const child of Object.values(value))freeze(child);Object.freeze(value);
}return value;}
function installation(i){closed(i,installKeys);if(!installKeys.every(k=>opaque(i[k]))||
 !['production','development'].includes(i.attestEnvironment))fail();}
function persona(p){closed(p,['id','generation']);if(!uuid(p.id)||!uint(p.generation))fail();}
function profile(p){closed(p,['reference','revision','roomConsentRevision','persona']);persona(p.persona);
 if(!opaque(p.reference)||!uint(p.revision)||!uint(p.roomConsentRevision)||!p.roomConsentRevision)fail();}
function sorted(value,max,check){
 if(types.isProxy(value)||!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||
  value.length>max||Reflect.ownKeys(value).length!==value.length+1)fail();
 for(let i=0;i<value.length;i++){
  const d=Object.getOwnPropertyDescriptor(value,String(i));
  if(!d||!Object.hasOwn(d,'value')||!check(d.value)||i>0&&value[i-1]>=d.value)fail();
 }
}
function context(value,permit,authentication,environment){
 closed(value,['version','environment','mode','install','persona','knownKeys','knownPersonas','hostScopes','grantPairs','grantIDs','notAfterMS']);
 if(value.version!==1||value.environment!==environment||!['member','lifecycle'].includes(value.mode)||
  !uint(value.notAfterMS)||value.notAfterMS>decodeSafeUInt(permit.notAfterMS))fail();
 sorted(value.knownKeys,335,opaque);sorted(value.knownPersonas,335,uuid);sorted(value.hostScopes,4,digest);
 sorted(value.grantPairs,335,digest);sorted(value.grantIDs,335,uuid);
 if(value.mode==='member'){
  installation(value.install);persona(value.persona);
  if(value.install.principalID!==authentication.principalID||value.install.keyID!==authentication.keyID||
   value.persona.id!==permit.actorPersonaID||value.persona.generation!==permit.actorPrivacyGeneration||
   !value.knownKeys.includes(value.install.keyID)||!value.knownPersonas.includes(value.persona.id))fail();
 }else if(value.install!==null||value.persona!==null||permit.actorPersonaID!==null||permit.actorPrivacyGeneration!==null)fail();
 return freeze(clone(value));
}
/** Local, bounded wire intentions only; no existing core schema or HTTP change. */
function validate(raw){
 const c=parseBoundedSessionJSON(raw);
 if(c.action==='create'){
  closed(c,['version','action','expected','payload'],[],'invalid_request');
  closed(c.expected,[],[],'invalid_request');
  closed(c.payload,['provider','storefront','title','profileReference','profileRevision','roomConsentRevision','initialIntent'],[],'invalid_request');
  const p=c.payload;
  if(c.version!==2||!['appleMusic','spotify'].includes(p.provider)||typeof p.storefront!=='string'||
   !/^[a-zA-Z0-9-]{1,16}$/.test(p.storefront)||typeof p.title!=='string'||Buffer.byteLength(p.title)>320||
   !opaque(p.profileReference)||!uint(p.profileRevision)||!uint(p.roomConsentRevision)||!p.roomConsentRevision||p.initialIntent!=='none')fail('invalid_request');
  validateAdmissionCommand(JSON.stringify({version:2,action:'settings.update',sessionID:'00000000-0000-4000-8000-000000000001',
   commandID:'00000000-0000-4000-8000-000000000002',expected:{settingsRevision:0},payload:{title:p.title}}));
 }else if(c.action==='remembered.forget'||lifecycle.has(c.action)){
  closed(c,['version','action','sessionID','commandID','expected','payload'],[],'invalid_request');
  if(c.version!==2||!uuid(c.sessionID)||!uuid(c.commandID))fail('invalid_request');
  if(c.action==='remembered.forget'){
   closed(c.expected,['grantGeneration'],[],'invalid_request');closed(c.payload,['grantID'],[],'invalid_request');
   if(!uint(c.expected.grantGeneration)||!uuid(c.payload.grantID))fail('invalid_request');
  }else if(c.action==='admission.remove'){
   closed(c.expected,['memberLeaseVersion'],[],'invalid_request');closed(c.payload,['memberID','reason'],[],'invalid_request');
   if(!uint(c.expected.memberLeaseVersion)||!uuid(c.payload.memberID)||
    !['authorization_withdrawn','participation_closed'].includes(c.payload.reason))fail('invalid_request');
  }else{closed(c.expected,[],[],'invalid_request');closed(c.payload,[],[],'invalid_request');}
 }else validateAdmissionCommand(raw);
 return c;
}
function checkProfile(p,c,who){
 profile(p);
 if(!samePersona(p.persona,who)||p.reference!==c.payload.profileReference||p.revision!==c.payload.profileRevision||
  p.roomConsentRevision!==c.payload.roomConsentRevision)fail('forbidden');
}
function checkPair(p,s,authorization){
 closed(p,['environment','hostScope','guestKeyID','digest']);
 if(p.environment!==s.environment||p.hostScope!==s.originalHost.scope||!opaque(p.guestKeyID)||!digest(p.digest)||
  !authorization.hostScopes.includes(p.hostScope)||!authorization.knownKeys.includes(p.guestKeyID)||
  !authorization.grantPairs.includes(p.digest))fail();
}
function validateFacts(f,c,positiveWork){
 const fields={create:['kind','antiAbuse','profile','hostScope','memberID','inviteDigest','codeDigest','expiresAtMS'],
  request:['kind','antiAbuse','profile','resolve','pair','hmacKeyVersion','policyRevision','grantID','requestID','memberID'],
  pair:['kind','antiAbuse','pair','hmacKeyVersion','policyRevision','grantID','memberID'],plain:['kind']};
 closed(f,['kind'],['antiAbuse','profile','hostScope','memberID','inviteDigest','codeDigest','expiresAtMS',
  'resolve','pair','hmacKeyVersion','policyRevision','grantID','requestID']);
 if(!Object.hasOwn(fields,f.kind))fail();
 closed(f,fields[f.kind],f.kind==='plain'?['antiAbuse']:[]);
 if(positiveWork||Object.hasOwn(f,'antiAbuse')){closed(f.antiAbuse,['status','notAfterMS']);
  if(!['allowed','denied','unavailable'].includes(f.antiAbuse.status)||!uint(f.antiAbuse.notAfterMS))fail();
 }
 if(f.kind==='create'){
  profile(f.profile);
  if(!digest(f.hostScope)||!digest(f.inviteDigest)||!digest(f.codeDigest)||!uuid(f.memberID)||!uint(f.expiresAtMS))fail();
 }
 if(f.kind==='request'){
  profile(f.profile);closed(f.resolve,['ticket','sessionID','environment','install','inviteGeneration','issuedAtMS','expiresAtMS']);
  installation(f.resolve.install);
  if(!opaque(f.resolve.ticket)||!uuid(f.resolve.sessionID)||typeof f.resolve.environment!=='string'||
   !uint(f.resolve.inviteGeneration)||!uint(f.resolve.issuedAtMS)||!uint(f.resolve.expiresAtMS)||
   f.resolve.expiresAtMS-f.resolve.issuedAtMS!==60000||!uuid(f.requestID))fail();
 }
 if(['request','pair'].includes(f.kind)){
  closed(f.pair,['environment','hostScope','guestKeyID','digest']);
  if(typeof f.pair.environment!=='string'||!/^(production|development|test|preview:[A-Za-z0-9][A-Za-z0-9._-]{0,119})$/.test(f.pair.environment)||
   !digest(f.pair.hostScope)||!opaque(f.pair.guestKeyID)||!digest(f.pair.digest))fail();
  if(!Number.isInteger(f.hmacKeyVersion)||f.hmacKeyVersion<1||f.hmacKeyVersion>65535||
   !uint(f.policyRevision)||!uuid(f.grantID)||!uuid(f.memberID))fail();
 }
 return freeze(clone(f));
}
function positive(c){return ['create','admission.request','settings.update','remembered.forget'].includes(c.action)||
 c.action==='admission.decide'&&c.payload.decision==='approve';}
function metadata(raw){
 closed(raw,['version','miscCount','reservedEvents','reservedReceipts','storefront']);
 if(raw.version!==1||!uint(raw.miscCount)||raw.miscCount>1000||!uint(raw.reservedEvents)||!uint(raw.reservedReceipts)||
  typeof raw.storefront!=='string'||!/^[a-zA-Z0-9-]{1,16}$/.test(raw.storefront))fail();return raw;
}
function owned(s){
 const guests=s.members.filter(m=>m.status==='active'&&m.id!==s.originalHost.memberID).length;
 return {events:s.pending.length*3+guests,receipts:s.pending.length*2+guests+1}; // End has its own receipt.
}
const refs=s=>[...new Set([...s.members,...s.pending].map(p=>p.persona.id))].sort();
const resultProjection=(r,s,room)=>({stateVersion:decodeSafeUInt(room.state_version),sessionRevision:decodeSafeUInt(room.session_revision),
 settingsRevision:s.settings.revision,eventSeq:decodeSafeUInt(room.event_seq),
 ...(r.admission?{admissionID:r.admission.id}:{}),...(r.code?{code:r.code}:{})});

// The event columns own request/room/environment/time/persona metadata. Only
// terminal outcome references belong in the existing <=512-byte public payload.
function terminalPayload(t){return {version:t.version,status:t.status,pairDigest:t.pairDigest,
 ...(t.memberID!==null?{memberID:t.memberID,memberLeaseVersion:t.memberLeaseVersion}:{}),
 ...(t.decidedByMemberID!==null?{decidedByMemberID:t.decidedByMemberID}:{})};}
function compactTerminal(p){
 closed(p,['version','status','pairDigest'],['memberID','memberLeaseVersion','decidedByMemberID']);
 if(p.version!==2||!['admitted','denied','cancelled','expired'].includes(p.status)||!digest(p.pairDigest)||
  (Object.hasOwn(p,'decidedByMemberID')&&(!uuid(p.decidedByMemberID)||!['admitted','denied'].includes(p.status))))fail();
 if(p.status==='denied'&&!uuid(p.decidedByMemberID))fail();
 if(p.status==='admitted'){
  if(!uuid(p.memberID)||!uint(p.memberLeaseVersion)||!p.memberLeaseVersion)fail();
 }else if(Object.hasOwn(p,'memberID')||Object.hasOwn(p,'memberLeaseVersion'))fail();
 return p;
}

/** Inert SQL service. See the accompanying contract for the mandatory SAME-TX
 * auth/scope preparation, fact resolver, final reference validation and the
 * unapplied cooldown-only representation proposal. None is a request callback.
 * No network, after-commit work, migration application or capabilities here.
 */
export function createAdmissionStore({db,environment,lockAuthorization,resolveFacts,revalidateFacts,resolveTerminalAuthority,...receiptOptions}={}){
 if(!db||typeof db.transaction!=='function'||typeof lockAuthorization!=='function'||
  typeof resolveFacts!=='function'||typeof revalidateFacts!=='function'||typeof resolveTerminalAuthority!=='function')fail();
 const contexts=new WeakMap();
 const wrappedDB={transaction:fn=>db.transaction(async tx=>{
  try{return await fn(tx);}finally{contexts.delete(tx);}
 })};
 async function bytes(tx,value){return decodeSafeUInt((await tx.query(
  'SELECT octet_length($1::jsonb::text)::text AS bytes',[JSON.stringify(value)])).rows[0].bytes);}
 async function checkedReferences(tx,s,a,allowWithdrawn=[]){
  for(const item of [...s.members,...s.pending]){
   if(!a.knownKeys.includes(item.install.keyID)||!a.knownPersonas.includes(item.persona.id))fail();
  }
  // At most 35 rows, already locked in the earlier hook. Never lock here.
  const ids=refs(s),rows=(await tx.query(`SELECT persona_id,privacy_generation,status FROM listening_v2.privacy_personas
   WHERE environment=$1 AND persona_id=ANY($2::uuid[])`,[environment,ids])).rows;
  if(rows.length!==ids.length)fail();
  for(const item of [...s.members,...s.pending]){
   const p=rows.find(p=>p.persona_id===item.persona.id);
   // Closed membership is retained history, not live authority. Requiring its
   // old persona to remain live would block other members' reserved departures
   // after the first privacy withdrawal. Rejoining must pass the active check
   // on the postimage; terminal hydration independently requires current live
   // authority. Missing rows/scopes and generation regression still refuse.
   const historical=item.status==='left'||item.status==='removed';
   if(historical||allowWithdrawn.includes(item.id)){if(decodeSafeUInt(p.privacy_generation)<item.persona.generation)fail();}
   else if(decodeSafeUInt(p.privacy_generation)!==item.persona.generation||p.status!=='live')fail('unauthorized');
  }
 }
 async function canonicalTerminalPersona(tx,t,a){
  if(!a.knownPersonas.includes(t.persona.id))fail();
  const p=(await tx.query(`SELECT original_principal_id,original_key_id,privacy_generation,status
   FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2`,[environment,t.persona.id])).rows[0];
  if(!p||p.status!=='live'||decodeSafeUInt(p.privacy_generation)!==t.persona.generation)fail('unauthorized');
  if(!a.knownKeys.includes(p.original_key_id))fail();
  if(t.install&&(p.original_principal_id!==t.install.principalID||p.original_key_id!==t.install.keyID))fail();
  return p;
 }
 async function terminalWinner(tx,c,s,room,a,nowMS){
  const event=(await tx.query(`SELECT event_id,session_id,environment,payload,server_at_ms,actor_persona_id,actor_privacy_generation
   FROM listening_v2.semantic_events WHERE environment=$1 AND event_id=$2 AND session_id=$3 AND type='admission.terminal'`,
   [environment,c.payload.requestID,c.sessionID])).rows[0];
  if(!event)return null;
  // A scrubbed marker still owns the unique event UUID. Never synthesize a
  // requester from the current actor, current member, grant or default flags.
  if(event.actor_persona_id===null||event.actor_privacy_generation===null)fail('unauthorized');
  const p=compactTerminal(event.payload),t={environment:event.environment,sessionID:event.session_id,id:event.event_id,
   version:p.version,status:p.status,persona:{id:event.actor_persona_id,generation:decodeSafeUInt(event.actor_privacy_generation)},
   pairDigest:p.pairDigest,memberID:p.memberID??null,memberLeaseVersion:p.memberLeaseVersion??null,
   decidedByMemberID:p.decidedByMemberID??null,atMS:decodeSafeUInt(event.server_at_ms)};
  persona(t.persona);
  if(t.environment!==environment||t.sessionID!==s.sessionID||t.id!==c.payload.requestID||t.atMS>nowMS)fail();
  const origin=await canonicalTerminalPersona(tx,t,a);
  const reference=freeze({version:1,environment,sessionID:t.sessionID,requestID:t.id,persona:t.persona,atMS:t.atMS,
   originalPrincipalID:origin.original_principal_id,originalKeyID:origin.original_key_id,
   pairDigest:t.pairDigest,status:t.status,memberID:t.memberID,memberLeaseVersion:t.memberLeaseVersion,decidedByMemberID:t.decidedByMemberID});
  const answer=await resolveTerminalAuthority({tx,command:c,room,nowMS,authorization:a,reference});
  closed(answer,['version','status'],['environment','sessionID','requestID','persona','install','notAfterMS']);
  if(answer.version!==1)fail();
  if(answer.status!=='available'){
   closed(answer,['version','status']);
   if(!['withdrawn','unavailable'].includes(answer.status))fail();
   fail(answer.status==='withdrawn'?'unauthorized':'unavailable');
  }
  closed(answer,['version','status','environment','sessionID','requestID','persona','install','notAfterMS']);
  installation(answer.install);persona(answer.persona);
  if(answer.environment!==environment||answer.sessionID!==t.sessionID||answer.requestID!==t.id||
   !samePersona(answer.persona,t.persona)||answer.install.principalID!==origin.original_principal_id||
   answer.install.keyID!==origin.original_key_id||!uint(answer.notAfterMS)||answer.notAfterMS<=nowMS||answer.notAfterMS<a.notAfterMS)fail();
  t.install=clone(answer.install);
  const m=s.members.find(m=>m.id===t.memberID);
  if(m&&(!sameInstall(m.install,t.install)||!samePersona(m.persona,t.persona)||m.leaseVersion<t.memberLeaseVersion))fail();
  const authority=freeze({terminal:t,notAfterMS:answer.notAfterMS});
  contexts.get(tx).terminalAuthority=authority;
  return authority.terminal;
 }
 async function headroom(tx,s,whole){
  // Upper bound of every combination of guest Leave/removal and pending expiry.
  // All decimal widths use the safe-integer maximum; expired pending rows only
  // shrink. Rejoin/approval/settings re-run this proof before accepting work.
  if(s.stateVersion>MAX-36||s.membershipRevision>MAX-25||s.members.some(m=>m.leaseVersion===MAX))fail('rate_limited');
  const worst=clone(s);worst.updatedAtMS=MAX;worst.stateVersion=MAX;worst.membershipRevision=MAX;
  for(const m of worst.members){if(m.id!==s.originalHost.memberID){m.status='removed';m.leaseVersion=MAX;m.endedAtMS=MAX;}}
  if(await bytes(tx,worst)>ADMISSION_LIMITS.stateBytes||
   await bytes(tx,{...whole,admission:worst})>262144-8192)fail('rate_limited');
  // Independent reducer dry-run validates the closed postimage as well.
  try{restoreAdmissionState(JSON.stringify(worst));}catch{fail('rate_limited');}
 }
 async function grantRow(tx,s,f,a){
  checkPair(f.pair,s,a);
  const g=(await tx.query(`SELECT * FROM listening_v2.returning_grants
   WHERE environment=$1 AND host_install_scope=$2 AND pair_digest=$3`,[environment,f.pair.hostScope,f.pair.digest])).rows[0];
  if(g&&(!a.grantIDs.includes(g.grant_id)||g.grant_id!==f.grantID||g.hmac_key_version!==f.hmacKeyVersion))fail();
  if(g)for(const side of ['host','guest','approver']){
   if(g[side+'_persona_id']!==null){
    if(!a.knownPersonas.includes(g[side+'_persona_id']))fail();
    const p=(await tx.query(`SELECT status,privacy_generation FROM listening_v2.privacy_personas
     WHERE environment=$1 AND persona_id=$2`,[environment,g[side+'_persona_id']])).rows[0];
    if(!p||p.status!=='live'||decodeSafeUInt(p.privacy_generation)!==decodeSafeUInt(g[side+'_privacy_generation']))fail('unauthorized');
   }
  }
  return g??null;
 }
 function grantFact(g,f){return {status:'available',pair:f.pair,policyRevision:f.policyRevision,grantID:f.grantID,
  generation:g?decodeSafeUInt(g.grant_generation):0,grantStatus:g?.status??'none'};}
 async function writeGrant(tx,e,f,g,nowMS){
  if(e.expectedPolicyRevision!==f.policyRevision||e.expectedGeneration!==(g?decodeSafeUInt(g.grant_generation):0))fail('conflict');
  const r=await tx.query(`INSERT INTO listening_v2.returning_grants(environment,grant_id,host_install_scope,pair_digest,hmac_key_version,
   grant_generation,status,host_persona_id,host_privacy_generation,guest_persona_id,guest_privacy_generation,
   approver_persona_id,approver_privacy_generation,approved_session_id,created_at_ms,updated_at_ms,cooldown_until_ms)
   VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11,$12,$13,$14,$14,0)
   ON CONFLICT(environment,host_install_scope,pair_digest) DO UPDATE SET grant_generation=EXCLUDED.grant_generation,status='active',
   host_persona_id=EXCLUDED.host_persona_id,host_privacy_generation=EXCLUDED.host_privacy_generation,
   guest_persona_id=EXCLUDED.guest_persona_id,guest_privacy_generation=EXCLUDED.guest_privacy_generation,
   approver_persona_id=EXCLUDED.approver_persona_id,approver_privacy_generation=EXCLUDED.approver_privacy_generation,
   approved_session_id=EXCLUDED.approved_session_id,revoked_at_ms=NULL,updated_at_ms=EXCLUDED.updated_at_ms
   WHERE listening_v2.returning_grants.grant_id=$2 AND listening_v2.returning_grants.grant_generation=$15
   AND listening_v2.returning_grants.hmac_key_version=$5 RETURNING *`,[
   environment,e.grantID,e.pair.hostScope,e.pair.digest,f.hmacKeyVersion,e.nextGeneration,e.hostPersona.id,e.hostPersona.generation,
   e.guestPersona.id,e.guestPersona.generation,e.approverPersona.id,e.approverPersona.generation,e.sessionID,nowMS,e.expectedGeneration]);
  if(r.rows.length!==1)fail('conflict');await grantHeadroom(tx,r.rows[0]);
 }
 async function grantHeadroom(tx,g){
  if(decodeSafeUInt(g.grant_generation)>=MAX)fail('rate_limited');
  // Preserve the independent <=1 KiB grant record even after Forget/cooldown.
  const future=[g.environment,g.grant_id,g.host_install_scope,g.pair_digest,65535,MAX,'revoked',
   g.host_persona_id,g.host_privacy_generation===null?null:MAX,g.guest_persona_id,g.guest_privacy_generation===null?null:MAX,
   g.approver_persona_id,g.approver_privacy_generation===null?null:MAX,g.approved_session_id,
   decodeSafeUInt(g.created_at_ms),MAX,MAX,MAX];
  if(await bytes(tx,future)>1024)fail('rate_limited');
 }
 async function writeCooldown(tx,e,f,g,nowMS){
  const r=await tx.query(`INSERT INTO listening_v2.returning_grants(environment,grant_id,host_install_scope,pair_digest,hmac_key_version,
   grant_generation,status,created_at_ms,revoked_at_ms,updated_at_ms,cooldown_until_ms)
   VALUES($1,$2,$3,$4,$5,0,'revoked',$6,$6,$6,$7)
   ON CONFLICT(environment,host_install_scope,pair_digest) DO UPDATE SET
   cooldown_until_ms=GREATEST(listening_v2.returning_grants.cooldown_until_ms,EXCLUDED.cooldown_until_ms),updated_at_ms=$6
   WHERE listening_v2.returning_grants.grant_id=$2 AND listening_v2.returning_grants.grant_generation=$8
   AND listening_v2.returning_grants.hmac_key_version=$5 RETURNING *`,[
   environment,f.grantID,e.pair.hostScope,e.pair.digest,f.hmacKeyVersion,nowMS,e.untilMS,g?decodeSafeUInt(g.grant_generation):0]);
  if(r.rows.length!==1)fail('conflict');await grantHeadroom(tx,r.rows[0]);
 }
 async function job(tx,id,kind,key,payload,due,nowMS){
  await tx.query(`INSERT INTO listening_v2.outbox(environment,job_id,job_key,kind,room_id,payload,created_at_ms,due_at_ms,retry_until_ms)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(environment,job_key) DO UPDATE SET
   payload=EXCLUDED.payload,state='pending',created_at_ms=EXCLUDED.created_at_ms,due_at_ms=EXCLUDED.due_at_ms,
   retry_until_ms=EXCLUDED.retry_until_ms,attempt_count=0,claim_epoch=listening_v2.outbox.claim_epoch+1,
   claim_nonce_hash=NULL,claim_until_ms=NULL,completed_at_ms=NULL,delete_after_ms=NULL`,
   [environment,randomUUID(),key,kind,id,payload,nowMS,due,nowMS+day]);
 }
 async function eventsAndJobs(tx,c,s,entries,room,nowMS){
  const baseSeq=decodeSafeUInt(room.event_seq)-entries.length,baseLane=decodeSafeUInt(room.semantic_event_count)-entries.length;
  for(let i=0;i<entries.length;i++){
   const e=entries[i],t=e.terminal;
   if(await bytes(tx,e.payload)>512)fail();
   await tx.query(`INSERT INTO listening_v2.semantic_events(environment,session_id,event_id,seq,lane,lane_seq,state_version,type,
    actor_persona_id,actor_privacy_generation,command_id,payload,server_at_ms,delete_after_ms)
    VALUES($1,$2,$3,$4,'semantic',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[
    environment,s.sessionID,t?.id??randomUUID(),baseSeq+i+1,baseLane+i+1,room.state_version,e.type,
    e.persona?.id??null,e.persona?.generation??null,c.commandID,e.payload,nowMS,
    Math.max(nowMS+day,s.expiresAtMS+day)]);
  }
  if(entries.length)await job(tx,s.sessionID,'wake',`wake:${s.sessionID}`,
   {version:2,environment,sessionID:s.sessionID,eventSeq:room.event_seq},nowMS,nowMS);
  if(c.action==='create')await job(tx,s.sessionID,'room_expiry',`room-expiry:${s.sessionID}`,
   {version:2,environment,sessionID:s.sessionID,scope:'room'},s.expiresAtMS,nowMS);
  if(s.pending.length){
   await job(tx,s.sessionID,'room_expiry',`admission-expiry:${s.sessionID}`,
    {version:2,environment,sessionID:s.sessionID,scope:'admissions'},Math.min(...s.pending.map(p=>p.expiresAtMS)),nowMS);
  }else await tx.query(`UPDATE listening_v2.outbox SET state='cancelled',claim_epoch=claim_epoch+1,claim_nonce_hash=NULL,
   claim_until_ms=NULL,completed_at_ms=$3,delete_after_ms=$4 WHERE environment=$1 AND job_key=$2 AND state IN ('pending','claimed')`,
   [environment,`admission-expiry:${s.sessionID}`,nowMS,nowMS+day]);
 }
 async function mutate({tx,command:c,room,nowMS,actorPersonaID,actorPrivacyGeneration}){
  const slot=contexts.get(tx);if(!slot)fail();const a=slot.authorization;
  if(lifecycle.has(c.action)!==(a.mode==='lifecycle'))fail('forbidden');
  // Missing representation is unavailable before any positive write. This is
  // deliberately not a migration runner or an alternate in-memory store.
  await tx.query('SELECT cooldown_until_ms FROM listening_v2.returning_grants WHERE false');
  const before=room?restoreAdmissionState(JSON.stringify(room.state.admission)):null;
  const newPositive=positive(c)&&!(c.action==='admission.decide'&&!before.pending.some(p=>p.id===c.payload.requestID));
  const rawFacts=await resolveFacts({tx,command:c,room,nowMS,authorization:a});
  const f=validateFacts(rawFacts,c,newPositive);slot.facts=f;
  if(before&&(before.environment!==environment||before.sessionID!==c.sessionID||before.status!==room.status||
   before.settings.revision!==room.settings_revision||before.inviteGeneration!==room.invite_generation||
   before.originalHost.scope!==room.host_install_scope||before.originalHost.persona.id!==room.host_persona_id||
   before.originalHost.persona.generation!==room.host_privacy_generation))fail();
  if(before&&(!a.hostScopes.includes(before.originalHost.scope)||nowMS<room.updated_at_ms||
   decodeSafeUInt(room.event_seq)!==decodeSafeUInt(room.semantic_event_count)+decodeSafeUInt(room.reaction_event_count)))fail();
  const withdrawalIDs=c.action==='admission.remove'?[c.payload.memberID]:c.action==='admission.expire'?
   before.pending.filter(p=>p.expiresAtMS<=nowMS).map(p=>p.id):[];
  if(before)await checkedReferences(tx,before,a,withdrawalIDs);
  if(await revalidateFacts({tx,command:c,room,nowMS,authorization:a,facts:f,terminalAuthority:null,phase:'mutation'})!==true)fail();
  if(newPositive){
   if(f.antiAbuse.status==='denied')fail('rate_limited');
   if(f.antiAbuse.status!=='allowed'||f.antiAbuse.notAfterMS<=nowMS||f.antiAbuse.notAfterMS<a.notAfterMS)fail();
   if(f.kind==='request'&&f.resolve.expiresAtMS<a.notAfterMS)fail();
  }
  let next,outcome,g=null,forget=false;
  const entries=[];
  if(c.action==='create'){
   if(f.kind!=='create'||!a.hostScopes.includes(f.hostScope))fail();checkProfile(f.profile,c,a.persona);
   next=createAdmissionState({environment,sessionID:c.sessionID,nowMS,expiresAtMS:f.expiresAtMS,title:c.payload.title,
    host:{install:a.install,persona:a.persona,profile:f.profile,memberID:f.memberID,scope:f.hostScope}});
   outcome={state:next,result:{status:'accepted'},effects:{terminals:[],grant:null,cooldown:null}};
   entries.push({type:'session.created',persona:a.persona,payload:{}});
  }else{
   const member=a.mode==='member'?before.members.find(m=>m.status==='active'&&sameInstall(m.install,a.install)&&samePersona(m.persona,a.persona)):null;
   const facts={nowMS,actor:a.mode==='member'?{install:a.install,persona:a.persona,
    lease:member?{memberID:member.id,version:member.leaseVersion}:null}:null};
   if(c.action==='admission.request'){
    if(f.kind!=='request')fail();checkProfile(f.profile,c,a.persona);checkPair(f.pair,before,a);
    if(f.pair.guestKeyID!==a.install.keyID)fail('forbidden');
    g=await grantRow(tx,before,f,a);
    if((await tx.query('SELECT event_id FROM listening_v2.semantic_events WHERE environment=$1 AND event_id=$2',
     [environment,f.requestID])).rows.length)fail('conflict');
    facts.join={requestID:f.requestID,memberID:f.memberID,pair:f.pair,cooldownUntilMS:g?decodeSafeUInt(g.cooldown_until_ms):0,
     resolve:f.resolve,profile:f.profile};facts.grant=grantFact(g,f);
   }
   if(['admission.decide','admission.cancel'].includes(c.action)){
    const pending=before.pending.find(p=>p.id===c.payload.requestID);
    if(!pending){
     facts.terminal=await terminalWinner(tx,c,before,room,a,nowMS);
    }else if(c.action==='admission.decide'){
     if(f.kind!=='pair')fail();checkPair(f.pair,before,a);
     facts.approval={memberID:f.memberID,pair:f.pair,requester:{install:pending.install,persona:pending.persona}};
     g=await grantRow(tx,before,f,a);facts.grant=grantFact(g,f);
    }
   }
   if(c.action==='admission.expire')outcome=expireAdmissions(before,nowMS);
   else if(c.action==='admission.remove')outcome=removeAdmissionMember(before,{nowMS,memberID:c.payload.memberID,
    expectedLeaseVersion:c.expected.memberLeaseVersion,reason:c.payload.reason});
   else if(c.action==='remembered.forget'){
    if(!member||member.id!==before.originalHost.memberID)fail('forbidden');
    if(f.kind!=='pair')fail();g=await grantRow(tx,before,f,a);
    if(!g||g.grant_id!==c.payload.grantID)fail('not_found');
    if(decodeSafeUInt(g.grant_generation)!==c.expected.grantGeneration)fail('conflict');
    if(decodeSafeUInt(g.grant_generation)===MAX)fail();forget=true;
    outcome={state:before,result:{status:'accepted'},effects:{terminals:[],grant:null,cooldown:null}};
    entries.push({type:'trust.forgotten',persona:a.persona,payload:{}});
   }else outcome=reduceAdmission(before,JSON.stringify({version:c.version,action:c.action,sessionID:c.sessionID,
    commandID:c.commandID,expected:c.expected,payload:c.payload}),facts);
   next=outcome.state;
   for(const t of outcome.effects.terminals)entries.push({type:'admission.terminal',persona:t.persona,
    payload:terminalPayload(t),terminal:t});
   if(next.lifetimeRequestCount>before.lifetimeRequestCount&&next.pending.some(p=>p.id===f.requestID))
    entries.push({type:'admission.requested',persona:a.persona,payload:{admissionID:f.requestID}});
   for(const m of next.members){
    const old=before.members.find(p=>p.id===m.id);
    if(m.status==='active'&&(!old||old.status!=='active'))entries.push({type:'member.joined',persona:m.persona,payload:{memberID:m.id}});
    if(m.status!=='active'&&old?.status==='active')entries.push({type:'member.left',persona:m.persona,payload:{memberID:m.id}});
   }
   if(next.settings.revision!==before.settings.revision)entries.push({type:'settings.changed',persona:a.persona,
    payload:{settingsRevision:next.settings.revision}});
  }
  if(outcome.result.status==='unavailable')fail();
  if(outcome.result.code==='rate_limited')fail('rate_limited');
  await checkedReferences(tx,next,a,withdrawalIDs);
  const priorMeta=room?metadata(room.state.admissionStore):{version:1,miscCount:0,reservedEvents:0,reservedReceipts:0,storefront:c.payload.storefront};
  if(room){
   const old=owned(before);
   if(priorMeta.reservedEvents!==old.events||priorMeta.reservedReceipts!==old.receipts||
    JSON.stringify([...room.privacy_persona_ids].sort())!==JSON.stringify(refs(before)))fail();
  }
  const reservations=owned(next),misc=priorMeta.miscCount+(next.settings.revision!==(before?.settings.revision??0)||forget?1:0);
  if(misc>1000)fail('rate_limited');
  const meta={...priorMeta,miscCount:misc,reservedEvents:reservations.events,reservedReceipts:reservations.receipts};
  const whole={...(room?.state??{occurrences:[],visits:[]}),admission:next,admissionStore:meta};
  if(await bytes(tx,next)>16384||await bytes(tx,whole)>262144-8192||await bytes(tx,meta)>4096)fail('rate_limited');
  if(newPositive&&outcome.result.status==='accepted'){
   const futureState=(room?decodeSafeUInt(room.state_version):1)+(before?next.stateVersion-before.stateVersion:0)+(forget?1:0);
   const futureSession=(room?decodeSafeUInt(room.session_revision):0)+(before?next.membershipRevision-before.membershipRevision:0);
   if(!uint(futureState)||!uint(futureSession)||futureState>MAX-36||futureSession>MAX-25)fail('rate_limited');
   await headroom(tx,next,whole);
  }
  const consume=room&&(outcome.effects.terminals.length>0||next.members.some(m=>m.status!=='active'&&before.members.find(p=>p.id===m.id)?.status==='active'));
  const extE=room?decodeSafeUInt(room.reserved_semantic_events)-priorMeta.reservedEvents:0;
  const extR=room?decodeSafeUInt(room.reserved_receipts)-priorMeta.reservedReceipts:0;
  const events=(room?decodeSafeUInt(room.semantic_event_count):0)+entries.length;
  if(extE<0||extR<0||events+extE+reservations.events>20000||
   (room?decodeSafeUInt(room.receipt_count):0)+1+extR+reservations.receipts>30000)fail('rate_limited');
  if(outcome.effects.grant)await writeGrant(tx,outcome.effects.grant,f,g,nowMS);
  if(outcome.effects.cooldown)await writeCooldown(tx,outcome.effects.cooldown,f,g,nowMS);
  if(forget){
   const changed=await tx.query(`UPDATE listening_v2.returning_grants SET status='revoked',grant_generation=grant_generation+1,
    revoked_at_ms=$4,updated_at_ms=$4 WHERE environment=$1 AND grant_id=$2 AND grant_generation=$3 RETURNING *`,
    [environment,g.grant_id,c.expected.grantGeneration,nowMS]);
   if(changed.rows.length!==1)fail('conflict');await grantHeadroom(tx,changed.rows[0]);
  }
  let stored;
  if(!room){
   stored=(await tx.query(`INSERT INTO listening_v2.rooms(environment,session_id,host_install_scope,host_persona_id,
    host_privacy_generation,privacy_persona_ids,provider,invite_digest,code_digest,invite_generation,state,created_at_ms,
    expires_at_ms,updated_at_ms,state_version,event_seq,semantic_event_count,reserved_semantic_events,reserved_receipts)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$11,1,$13::integer,$13::integer,$14,$15) RETURNING *`,[
    environment,c.sessionID,f.hostScope,actorPersonaID,actorPrivacyGeneration,refs(next),c.payload.provider,
    f.inviteDigest,f.codeDigest,whole,nowMS,next.expiresAtMS,entries.length,reservations.events,reservations.receipts])).rows[0];
  }else{
   const delta=next.stateVersion-before.stateVersion+(forget?1:0);
   stored=(await tx.query(`UPDATE listening_v2.rooms SET state=$3,privacy_persona_ids=$4,state_version=state_version+$5,
    session_revision=session_revision+$6,settings_revision=$7,invite_generation=$8,semantic_event_count=$9,
    event_seq=event_seq+$10,reserved_semantic_events=$11,reserved_receipts=$12,updated_at_ms=$13
    WHERE environment=$1 AND session_id=$2 AND state_version=$14 RETURNING *`,[
    environment,c.sessionID,whole,refs(next),delta,next.membershipRevision-before.membershipRevision,next.settings.revision,
    next.inviteGeneration,events,entries.length,extE+reservations.events,extR+reservations.receipts+(consume?1:0),nowMS,room.state_version])).rows[0];
   if(!stored)fail('conflict');
  }
  await eventsAndJobs(tx,c,next,entries,stored,nowMS);
  return {status:outcome.result.status==='refused'?'refused':'accepted',result:resultProjection(outcome.result,next,stored),
   ...(consume?{consumeReservedReceipt:true}:{})};
 }
 const receipts=createReceiptStore({...receiptOptions,db:wrappedDB,environment,
  lockAuthorization:async args=>{
   const permit=await lockAuthorization(args);
   if(!permit||types.isProxy(permit))fail();
   const descriptor=Object.getOwnPropertyDescriptor(permit,'admissionContext');
   if(!descriptor||!Object.hasOwn(descriptor,'value')||typeof permit.revalidate!=='function')fail();
   const authorization=context(descriptor.value,permit,args.authentication,environment);
   const slot={authorization,facts:null,terminalAuthority:null};contexts.set(args.tx,slot);
   return {...permit,notAfterMS:authorization.notAfterMS,revalidate:async request=>{
    const answer=await permit.revalidate(request);if(answer!==true)return answer;
    if(slot.terminalAuthority)await canonicalTerminalPersona(request.tx,slot.terminalAuthority.terminal,authorization);
    if(slot.facts&&await revalidateFacts({...request,authorization,facts:slot.facts,terminalAuthority:slot.terminalAuthority})!==true)fail();
    return true;
   }};
  },mutations:Object.fromEntries(actions.map(action=>[action,mutate]))});
 return Object.freeze({async execute(input){
  closed(input,['authentication','rawCommand'],['creationTicket'],'invalid_request');
  // Capture raw text once, before any await; caller-supplied facts/identity/tx
  // extension fields cannot enter a transaction or replace a retried intent.
  const raw=input.rawCommand;validate(raw);
  return receipts.execute({authentication:input.authentication,rawCommand:raw,
   ...(input.creationTicket!==undefined?{creationTicket:input.creationTicket}:{})});
 }});
}
