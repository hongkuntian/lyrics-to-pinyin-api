import {createHash,createHmac,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {AppAuthStore} from '../app-auth/store.js';
import {createCurrentAuthContext,decodeAuthTimeMS} from './auth-context.js';
import {createAdmissionStore} from './admission-store.js';
import {restoreAdmissionState,validateAdmissionCommand} from './admission.js';
import {parseBoundedSessionJSON} from './protocol.js';
import {SessionV2Error} from './errors.js';

const fail=(code='unavailable')=>{throw new SessionV2Error(code);};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const uint=decodeAuthTimeMS,MAX=Number.MAX_SAFE_INTEGER,guestLifetime=7776000000;
const actions=new Set(['admission.decide','admission.cancel','leave']);
const installFields=['principalID','keyID','bundleID','audience','attestEnvironment'];
const sameInstall=(a,b)=>installFields.every(k=>a[k]===b[k]);
const sameRef=(a,b)=>a?.id===b?.id&&a?.generation===b?.generation;
const sorted=xs=>[...new Set(xs)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
const frozen=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};
const signature=value=>JSON.stringify(value);
function closed(value,required,optional=[],code='unavailable'){
 if(!value||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(code);
 const keys=Reflect.ownKeys(value);
 if(required.some(k=>!Object.hasOwn(value,k))||keys.length>required.length+optional.length)fail(code);
 for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k);
  if(typeof k!=='string'||!required.includes(k)&&!optional.includes(k)||!Object.hasOwn(d,'value')||!d.enumerable)fail(code);
 }
}
function array(value,max){if(!Array.isArray(value)||types.isProxy(value)||value.length>max||
 Object.getPrototypeOf(value)!==Array.prototype||Reflect.ownKeys(value).length!==value.length+1)fail();
 for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));
  if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail();}
}
async function safe(fn){try{return await fn();}catch(error){if(error instanceof SessionV2Error)throw error;fail();}}
const clock=async tx=>uint((await tx.query(`WITH privacy_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
 SELECT floor(extract(epoch FROM at)*1000)::text AS now_ms FROM privacy_clock`)).rows[0].now_ms);
const ref=p=>({id:p.persona_id,generation:uint(p.privacy_generation)});
const personaSQL=`SELECT environment,persona_id,original_principal_id,original_key_id,controller_kind,controller_principal_id,
 controller_key_id,privacy_generation,status,guest_credential_digest,guest_credential_expires_at_ms,created_at_ms,updated_at_ms,
 controller_privacy_epoch,private_transfer_from_generation
 FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=ANY($2::uuid[]) ORDER BY persona_id`;
const keysSQL=`SELECT key_id,user_id,bundle_id,audience,environment,revoked FROM public.app_attest_keys
 WHERE key_id=ANY($1::text[]) ORDER BY key_id COLLATE "C"`;
const currentPersonasSQL=`WITH privacy_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
 SELECT p.persona_id,p.privacy_generation,p.status,p.controller_kind,p.controller_principal_id,p.controller_key_id,
 p.original_principal_id,p.original_key_id,p.guest_credential_digest,p.guest_credential_expires_at_ms,p.created_at_ms,
 p.controller_privacy_epoch,u.sessions_privacy_epoch AS current_controller_epoch,
 u.id AS controller_id,u.access_kind,u.disabled,k.key_id,k.user_id AS key_owner,k.revoked AS key_revoked,
 k.bundle_id,k.audience,k.environment AS attest_environment,t.digest AS token_digest,t.user_id AS token_owner,t.revoked AS token_revoked,
 CASE WHEN t.expires_at IS NULL THEN NULL ELSE floor(extract(epoch FROM t.expires_at)*1000)::text END AS token_expires_ms,
 floor(extract(epoch FROM privacy_clock.at)*1000)::text AS now_ms
 FROM listening_v2.privacy_personas p
 LEFT JOIN public.library_users u ON u.id=p.controller_principal_id
 LEFT JOIN public.app_attest_keys k ON k.key_id=p.original_key_id
 LEFT JOIN public.library_tokens t ON t.digest=p.guest_credential_digest
 CROSS JOIN privacy_clock WHERE p.environment=$1 AND p.persona_id=ANY($2::uuid[]) ORDER BY p.persona_id`;

/** Private, disabled composition. The public object exposes only raw intentions
 * plus exact bearers; all auth/persona/lock/fact hooks below are closure-owned.
 * This does not repair shared lifecycle writers or grant any audio authority.
 */
export function createPrivateAdmissionService(options){
 closed(options,['db','environment','policy','bindingKeys','activeBindingKeyVersion','receiptKeyPolicy','ticketKeys','activeTicketKeyID'],
  ['pairKeys','pairPolicyRevision','antiAbuse']);
 const environment=options.environment;
 if(!options.db||typeof options.db.query!=='function'||typeof options.db.transaction!=='function')fail();
 const queryDB=options.db.query.bind(options.db),transactionDB=options.db.transaction.bind(options.db);
 const scopes=new WeakMap(),readable=new WeakSet(),historical=new WeakSet();
 const db={query:queryDB,transaction:fn=>transactionDB(async tx=>{try{return await fn(tx);}finally{scopes.delete(tx);}})};
 closed(options.policy,['audience','environment','prefix','bundles']);array(options.policy.bundles,32);
 const policy=frozen(structuredClone(options.policy));
 const currentAuth=createCurrentAuthContext({authStore:new AppAuthStore(db,{policy}),environment});
 function ring(entries,kind){
  array(entries,4);const out=new Map();
  for(const entry of entries){closed(entry,[kind,'secret']);const id=entry[kind];
   if(kind==='version'? !Number.isInteger(id)||id<1||id>65535 : typeof id!=='string'||!id.length||id.length>32)fail();
   if(types.isProxy(entry.secret)||!Buffer.isBuffer(entry.secret)||entry.secret.length<32||entry.secret.length>4096||out.has(id))fail();
   out.set(id,Buffer.from(entry.secret));
  }return out;
 }
 const bindings=ring(options.bindingKeys,'version'),pairs=ring(options.pairKeys??[],'version');
 const tickets=ring(options.ticketKeys,'id'),activeBindingKeyVersion=options.activeBindingKeyVersion,activeTicketKeyID=options.activeTicketKeyID;
 if(!bindings.has(activeBindingKeyVersion)||!tickets.has(activeTicketKeyID))fail();
 const pairPolicyRevision=options.pairPolicyRevision===undefined?null:uint(options.pairPolicyRevision);
 closed(options.receiptKeyPolicy,['environment','keys']);array(options.receiptKeyPolicy.keys,4);
 if(options.receiptKeyPolicy.environment!==environment||!options.receiptKeyPolicy.keys.length)fail();
 const descriptors=options.receiptKeyPolicy.keys.map(k=>{closed(k,['version','verificationHash']);
  if(!Number.isInteger(k.version)||!digest(k.verificationHash))fail();return {...k};}).sort((a,b)=>a.version-b.version);
 const actual=[...bindings].sort(([a],[b])=>a-b).map(([version,secret])=>({version,verificationHash:createHmac('sha256',secret)
  .update(JSON.stringify(['sessions-v2.receipt-key-check',version,environment])).digest('hex')}));
 if(signature(actual)!==signature(descriptors))fail();
 const manifest=frozen({keys:descriptors,hash:createHash('sha256').update(signature(descriptors)).digest('hex')});
 let authorizeAbuse=null;
 if(options.antiAbuse!=null){closed(options.antiAbuse,['authorize']);if(typeof options.antiAbuse.authorize!=='function')fail();
  authorizeAbuse=options.antiAbuse.authorize;}
 const installation=(p,k)=>{
  if(!k||k.key_id!==p.original_key_id||!policy.bundles.includes(k.bundle_id)||k.audience!==policy.audience||k.environment!==policy.environment)fail();
  return frozen({principalID:p.original_principal_id,keyID:p.original_key_id,bundleID:k.bundle_id,
   audience:k.audience,attestEnvironment:k.environment});
 };
 const getRoom=async(tx,id,lock=false)=>(await tx.query(`SELECT * FROM listening_v2.rooms WHERE environment=$1 AND session_id=$2${lock?' FOR UPDATE':''}`,
  [environment,id])).rows[0]??null;
 const stateOf=room=>{if(!room)fail('not_found');const s=restoreAdmissionState(JSON.stringify(room.state.admission));
  if(s.environment!==environment||s.sessionID!==room.session_id||s.status!==room.status||s.originalHost.scope!==room.host_install_scope||
   s.originalHost.persona.id!==room.host_persona_id||s.originalHost.persona.generation!==uint(room.host_privacy_generation)||
   s.inviteGeneration!==uint(room.invite_generation)||s.settings.revision!==uint(room.settings_revision))fail();return s;};
 const roomFingerprint=r=>r===null?'null':signature([r.session_id,r.status,String(r.state_version),String(r.session_revision),
  String(r.settings_revision),String(r.invite_generation),r.host_install_scope,r.host_persona_id,String(r.host_privacy_generation),r.state.admission]);
 async function receipts(tx,authentication,c,lock=false){
  const args=[environment,c.sessionID,c.commandID];
  const alternatives=[...bindings].sort(([a],[b])=>a-b).map(([version,secret])=>{
   const bind=(kind,id)=>createHmac('sha256',secret).update(JSON.stringify(['sessions-v2.command-receipt',version,environment,kind,id])).digest('hex');
   args.push(version,bind('principal',authentication.principalID),bind('key',authentication.keyID));const n=args.length;
   return `(binding_key_version=$${n-2} AND principal_binding=$${n-1} AND key_binding=$${n})`;
  });
  const rows=(await tx.query(`SELECT * FROM listening_v2.command_receipts WHERE environment=$1 AND session_id=$2 AND command_id=$3
   AND (${alternatives.join(' OR ')}) ORDER BY session_id,principal_binding,key_binding,command_id${lock?' FOR UPDATE':''}`,args)).rows;
  if(rows.length>1)fail();return rows[0]??null;
 }
 async function terminal(tx,id,sessionID){return (await tx.query(`SELECT event_id,environment,session_id,type,payload,server_at_ms,
  actor_persona_id,actor_privacy_generation FROM listening_v2.semantic_events
  WHERE environment=$1 AND event_id=$2 AND session_id=$3 AND type='admission.terminal'`,[environment,id,sessionID])).rows[0]??null;}
 function terminalFact(event){
  if(!event||!event.actor_persona_id||event.actor_privacy_generation===null)fail('unauthorized');
  const p=event.payload;closed(p,['version','status','pairDigest'],['memberID','memberLeaseVersion','decidedByMemberID']);
  if(p.version!==2||!['admitted','denied','cancelled','expired'].includes(p.status)||!digest(p.pairDigest))fail();
  if(p.status==='admitted'){if(!uuid(p.memberID)||uint(p.memberLeaseVersion)<1)fail();}
  else if(p.memberID!==undefined||p.memberLeaseVersion!==undefined)fail();
  if(p.decidedByMemberID!==undefined&&!uuid(p.decidedByMemberID)||p.status==='denied'&&!p.decidedByMemberID)fail();
  const fact=frozen({id:event.event_id,persona:{id:event.actor_persona_id,generation:uint(event.actor_privacy_generation)},
   atMS:uint(event.server_at_ms),status:p.status,version:2,pairDigest:p.pairDigest,memberID:p.memberID??null,
   memberLeaseVersion:p.memberLeaseVersion??null,decidedByMemberID:p.decidedByMemberID??null});
  historical.add(fact);return fact;
 }
 function pairFor(s,target){
  if(!pairs.size||pairPolicyRevision===null)fail();
  const matched=[...pairs].filter(([version,secret])=>createHmac('sha256',secret)
   .update(signature(['sessions-v2.returning-pair',version,environment,s.originalHost.scope,target.install.keyID])).digest('hex')===target.pairDigest);
  if(matched.length!==1)fail();
  return frozen({pair:{environment,hostScope:s.originalHost.scope,guestKeyID:target.install.keyID,digest:target.pairDigest},
   hmacKeyVersion:matched[0][0],policyRevision:pairPolicyRevision});
 }
 function ownedBy(p,auth){return p.controller_kind==='guest'?
  p.original_principal_id===auth.principalID&&p.original_key_id===auth.keyID:
  p.controller_kind==='apple'&&p.controller_principal_id===auth.principalID&&auth.accessKind==='apple';}
 async function live(tx,plan){
  const rows=(await tx.query(currentPersonasSQL,[environment,sorted([...plan.positive.keys()])])).rows;
  if(rows.length!==plan.positive.size)fail('unauthorized');let notAfterMS=MAX;
  for(const r of rows){const expected=plan.positive.get(r.persona_id),nowMS=uint(r.now_ms);
   if(r.status!=='live'||uint(r.privacy_generation)!==expected.generation||r.controller_id!==r.controller_principal_id||r.disabled!==false)fail('unauthorized');
   if(r.controller_kind==='guest'){
    const expires=uint(r.guest_credential_expires_at_ms),actualExpiry=uint(r.token_expires_ms),created=uint(r.created_at_ms);
    if(r.access_kind!=='guest'||r.controller_principal_id!==r.original_principal_id||r.controller_key_id!==r.original_key_id||
     r.key_id!==r.original_key_id||r.key_owner!==r.original_principal_id||r.key_revoked!==false||
     r.token_digest!==r.guest_credential_digest||!digest(r.token_digest)||r.token_owner!==r.original_principal_id||r.token_revoked!==false||
     r.audience!==policy.audience||r.attest_environment!==policy.environment||!policy.bundles.includes(r.bundle_id)||
     expires<=created||expires-created>guestLifetime||actualExpiry!==expires||nowMS>=expires)fail('unauthorized');
    notAfterMS=Math.min(notAfterMS,expires);
   }else if(r.controller_kind!=='apple'||r.access_kind!=='apple'||r.controller_key_id!==null||
    r.guest_credential_digest!==null||r.guest_credential_expires_at_ms!==null||
    uint(r.controller_privacy_epoch)!==uint(r.current_controller_epoch))fail('unauthorized');
  }return notAfterMS;
 }
 function addPositive(plan,reference){
  if(!reference||!uuid(reference.id))fail('unauthorized');const generation=uint(reference.generation),prior=plan.positive.get(reference.id);
  if(prior&&prior.generation!==generation)fail('unauthorized');plan.positive.set(reference.id,{id:reference.id,generation});
 }
 function checkReferences(plan,state){
  for(const item of [...state.members,...state.pending]){
   const p=plan.personas.get(item.persona.id);if(!p||!plan.knownKeys.includes(item.install.keyID))fail('conflict');
   if(p.original_principal_id!==item.install.principalID||p.original_key_id!==item.install.keyID)fail();
   if(item.status==='left'||item.status==='removed'){
    if(uint(p.privacy_generation)<item.persona.generation)fail();
   }else{
    if(!sameRef(plan.positive.get(item.persona.id),item.persona))fail('conflict');
    // Current controller authority for private history is weaker than an
    // active installation. A moved/revoked key cannot be newly admitted or
    // remain a source of active room rights, even while A retains history.
    const key=plan.keys.get(p.original_key_id);
    if(p.controller_principal_id!==p.original_principal_id||key?.user_id!==p.original_principal_id||key.revoked!==false)fail('unauthorized');
    if(!sameInstall(installation(p,plan.keys.get(p.original_key_id)),item.install))fail();
   }
  }
 }
 async function compose(tx,authentication,operation,suppliedManifest){
  if(scopes.has(tx))fail();
  if(suppliedManifest&&(signature(suppliedManifest.keys)!==signature(manifest.keys)||suppliedManifest.hash!==manifest.hash))fail();
  const {command:c,mode}=operation,room=await getRoom(tx,c.sessionID),state=stateOf(room);
  const receipt=mode==='admissionRead'?null:await receipts(tx,authentication,c);
  const plan={tx,operation,authentication,room,state,receipt,positive:new Map(),events:new Map(),personas:new Map(),keys:new Map(),
   grant:null,pair:null,abuse:null,notAfterMS:MAX,mutationAuthorized:false};
  scopes.set(tx,plan);
  const targetIDs=sorted([...(c.payload.requestID?[c.payload.requestID]:[]),...(receipt?.result?.admissionID?[receipt.result.admissionID]:[])]);
  plan.targetIDs=targetIDs;
  for(const id of targetIDs){if(!uuid(id))fail();const e=await terminal(tx,id,c.sessionID);if(e)plan.events.set(id,e);}
  const target=state.pending.find(p=>p.id===c.payload.requestID)??(plan.events.has(c.payload.requestID)?terminalFact(plan.events.get(c.payload.requestID)):null);
  plan.target=target;
  let actor;
  if(receipt){if(!receipt.actor_persona_id||receipt.actor_privacy_generation===null)fail('unauthorized');
   actor={id:receipt.actor_persona_id,generation:uint(receipt.actor_privacy_generation)};
  }else if(mode==='admissionRead'){if(!target)fail('not_found');actor=target.persona;
  }else{
   const p=(await tx.query(`SELECT persona_id,privacy_generation FROM listening_v2.privacy_personas
    WHERE environment=$1 AND original_principal_id=$2 AND original_key_id=$3 AND status='live'`,
    [environment,authentication.principalID,authentication.keyID])).rows;
   if(p.length!==1)fail('unauthorized');actor=ref(p[0]);
  }
  plan.actor=actor;addPositive(plan,actor);
  const writing=mode==='execute'&&!receipt;
  if(writing){for(const item of [...state.members,...state.pending])if(!['left','removed'].includes(item.status))addPositive(plan,item.persona);}
  // Only exact targeted outcomes are collected. The historical cleanup mirror
  // and unrelated terminal event history never select live auth dependencies.
  for(const id of targetIDs){
   const item=state.pending.find(p=>p.id===id);
   const event=plan.events.get(id);
   if(item)addPositive(plan,item.persona);else if(event)addPositive(plan,terminalFact(event).persona);
   else if(receipt?.result?.admissionID===id)fail();
  }
  if(writing&&c.action==='admission.decide'&&target?.status==='pending'){
   plan.pair=pairFor(state,target);
   plan.grant=(await tx.query(`SELECT * FROM listening_v2.returning_grants WHERE environment=$1 AND host_install_scope=$2 AND pair_digest=$3`,
    [environment,state.originalHost.scope,plan.pair.pair.digest])).rows[0]??null;
   if(plan.grant&&plan.grant.hmac_key_version!==plan.pair.hmacKeyVersion)fail();
   for(const side of ['host','guest','approver'])if(plan.grant?.[side+'_persona_id'])
    addPositive(plan,{id:plan.grant[side+'_persona_id'],generation:uint(plan.grant[side+'_privacy_generation'])});
  }
  const ids=sorted([...plan.positive.keys(),...state.members.map(x=>x.persona.id),...state.pending.map(x=>x.persona.id),state.originalHost.persona.id]);
  const personaRows=(await tx.query(personaSQL,[environment,ids])).rows;
  if(personaRows.length!==ids.length)fail();personaRows.forEach(p=>plan.personas.set(p.persona_id,p));
  // Only a server-retained, branded terminal reference may cross the exact
  // one-time private bridge. This never maps caller revisions, active leases,
  // asset/write capabilities or principal/key-bound G command receipts to A.
  if(mode==='admissionRead'&&target&&historical.has(target)){
   const p=plan.personas.get(target.persona.id);
   if(p?.controller_kind==='apple'&&p.controller_principal_id===authentication.principalID&&
    p.private_transfer_from_generation!==null&&uint(p.private_transfer_from_generation)===target.persona.generation&&
    uint(p.privacy_generation)>target.persona.generation){
    actor=ref(p);plan.actor=actor;plan.positive.set(actor.id,actor);
   }
  }
  const keyIDs=sorted([...personaRows.map(p=>p.original_key_id),authentication.keyID,state.originalHost.install.keyID]);
  const keyRows=(await tx.query(keysSQL,[keyIDs])).rows;
  if(keyRows.length!==keyIDs.length)fail();keyRows.forEach(k=>plan.keys.set(k.key_id,k));plan.knownKeys=keyIDs;
  const users=[],tokens=[];
  for(const id of plan.positive.keys()){
   const p=plan.personas.get(id);if(!p)fail();
   if(p.controller_kind==='guest'){users.push(p.original_principal_id);tokens.push(p.guest_credential_digest);}
   else if(p.controller_kind==='apple')users.push(p.controller_principal_id);else fail('unauthorized');
  }
  const requiredScopes={userIDs:sorted(users),credentialDigests:sorted(tokens),keyIDs};
  if(Object.values(requiredScopes).some(v=>v.length>64))fail();
  const discovery=await currentAuth.discover({tx,authentication,requiredScopes});
  plan.auth=await currentAuth.lock({tx,discovery});
  // No connection or guard participates in these metadata-only operations.
  for(const id of ids)await tx.query('SELECT persona_id FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2 FOR UPDATE',[environment,id]);
  const lockedPersonas=(await tx.query(personaSQL,[environment,ids])).rows,lockedKeys=(await tx.query(keysSQL,[keyIDs])).rows;
  if(signature(lockedPersonas)!==signature(personaRows)||signature(lockedKeys)!==signature(keyRows))fail('conflict');
  if(plan.pair){const locked=(await tx.query(`SELECT * FROM listening_v2.returning_grants
   WHERE environment=$1 AND host_install_scope=$2 AND pair_digest=$3 FOR UPDATE`,
   [environment,state.originalHost.scope,plan.pair.pair.digest])).rows[0]??null;
   if(signature(locked)!==signature(plan.grant))fail('conflict');
  }
  plan.personaFingerprint=signature(personaRows);plan.keyFingerprint=signature(keyRows);
  plan.notAfterMS=Math.min(plan.auth.notAfterMS,await live(tx,plan));
  if(target?.status==='pending'&&(mode==='admissionRead'||writing&&c.action==='admission.decide'&&c.payload.decision==='approve')){
   // Approval cannot turn a pre-deadline read into a post-deadline admission.
   // Negative commands retain the reducer's ordinary expiry settlement path.
   if(await clock(tx)>=target.expiresAtMS)fail('expired');
   plan.notAfterMS=Math.min(plan.notAfterMS,uint(target.expiresAtMS));
  }
  const actorPersona=plan.personas.get(actor.id);
  if(!sameRef(ref(actorPersona),actor))fail('unauthorized');
  if(!ownedBy(actorPersona,plan.auth))fail(mode==='admissionRead'?'not_found':'unauthorized');
  plan.actorAuthority=frozen({persona:actor,install:installation(actorPersona,plan.keys.get(actorPersona.original_key_id))});readable.add(plan.actorAuthority);
  if(writing){checkReferences(plan,state);
   if(!sameInstall(plan.actorAuthority.install,plan.auth))fail('forbidden');
   const active=state.members.find(m=>m.status==='active'&&sameInstall(m.install,plan.actorAuthority.install)&&sameRef(m.persona,actor));
   if(c.action==='admission.decide'&&!active||c.action==='leave'&&(!active||active.id===state.originalHost.memberID))fail('forbidden');
   if(c.action==='admission.cancel'&&(!target||!sameRef(target.persona,actor)))fail('not_found');
  }
  if(writing&&c.action==='admission.decide'&&c.payload.decision==='approve'&&target?.status==='pending'){
   if(!authorizeAbuse)fail();
   const request=frozen({version:1,environment,principalID:authentication.principalID,keyID:authentication.keyID,
    sessionID:c.sessionID,commandID:c.commandID,bodyHash:operation.bodyHash,pairDigest:target.pairDigest});
   const answer=await authorizeAbuse(request);
   closed(answer,[...Object.keys(request),'status','notAfterMS']);
   if(Object.keys(request).some(k=>answer[k]!==request[k])||!['allowed','denied','unavailable'].includes(answer.status))fail();
   if(answer.status!=='allowed')fail(answer.status==='denied'?'rate_limited':'unavailable');
   plan.abuse=frozen({status:'allowed',notAfterMS:uint(answer.notAfterMS)});plan.notAfterMS=Math.min(plan.notAfterMS,plan.abuse.notAfterMS);
  }
  if(await clock(tx)>=plan.notAfterMS)fail('unauthorized');
  plan.facts=plan.pair?frozen({kind:'pair',...plan.pair,antiAbuse:plan.abuse??{status:'unavailable',notAfterMS:0},
   grantID:plan.grant?.grant_id??randomUUID(),memberID:state.members.find(m=>sameInstall(m.install,target.install))?.id??randomUUID()}):frozen({kind:'plain'});
  return plan;
 }
 async function revalidate(plan,{tx,command,room,receipt,phase}){
  if(tx!==plan.tx||scopes.get(tx)!==plan||signature(command)!==signature(plan.operation.command))fail();
  await plan.auth.revalidate({tx});
  const personas=(await tx.query(personaSQL,[environment,sorted([...plan.personas.keys()])])).rows;
  const keys=(await tx.query(keysSQL,[plan.knownKeys])).rows;
  if(signature(personas)!==plan.personaFingerprint||signature(keys)!==plan.keyFingerprint)fail('conflict');
  if(await live(tx,plan)<plan.notAfterMS)fail('unauthorized');
  if(phase!=='locked'){
   const latest=await getRoom(tx,command.sessionID),s=stateOf(latest);
   if(roomFingerprint(latest)!==roomFingerprint(room))fail('conflict');
   if(phase!=='commit'||!plan.mutationAuthorized){
    if(roomFingerprint(latest)!==roomFingerprint(plan.room))fail('conflict');
    if(plan.operation.mode!=='admissionRead'){
     const saved=await receipts(tx,plan.authentication,command);
     if(signature(saved)!==signature(plan.receipt))fail('conflict');
    }
    if(plan.pair){const grant=(await tx.query(`SELECT * FROM listening_v2.returning_grants
     WHERE environment=$1 AND host_install_scope=$2 AND pair_digest=$3`,
     [environment,plan.state.originalHost.scope,plan.pair.pair.digest])).rows[0]??null;
     if(signature(grant)!==signature(plan.grant))fail('conflict');
    }
   }else checkReferences(plan,s);
   if(receipt){
    if(receipt.actor_persona_id!==plan.actor.id||uint(receipt.actor_privacy_generation)!==plan.actor.generation)fail('unauthorized');
   }
   for(const id of plan.targetIDs){const event=plan.events.get(id)??null;
    if(event||phase!=='commit'||!plan.mutationAuthorized){
     if(signature(await terminal(tx,id,command.sessionID))!==signature(event))fail('conflict');
    }
   }
   // New terminal after our mutation is checked by the accepted SQL service.
   if(phase==='mutation')plan.mutationAuthorized=true;
  }
  if(await clock(tx)>=plan.notAfterMS)fail('unauthorized');return true;
 }
 const admission=createAdmissionStore({db,environment,bindingKeys:[...bindings].map(([version,secret])=>({version,secret})),activeBindingKeyVersion,
  ticketKeys:[...tickets].map(([id,secret])=>({id,secret})),activeTicketKeyID,
  lockAuthorization:async args=>{
   const {command:c}=args;const {environment:_,...wire}=c;
   const {bodyHash}=validateAdmissionCommand(JSON.stringify(wire));
   const plan=await compose(args.tx,args.authentication,{command:c,bodyHash,mode:'execute'},args.bindingKeyManifest);
   return {version:1,environment,principalID:plan.auth.principalID,keyID:plan.auth.keyID,bindingKeyManifestHash:manifest.hash,
    actorPersonaID:plan.actor.id,actorPrivacyGeneration:plan.actor.generation,notAfterMS:plan.notAfterMS,
    admissionContext:{version:1,environment,mode:'member',install:plan.actorAuthority.install,persona:plan.actor,
     knownKeys:[...plan.knownKeys].sort(),knownPersonas:[...plan.personas.keys()].sort(),hostScopes:[plan.state.originalHost.scope],
     grantPairs:plan.pair?[plan.pair.pair.digest]:[],grantIDs:plan.pair?[plan.facts.grantID]:[],notAfterMS:plan.notAfterMS},
    revalidate:request=>revalidate(plan,request)};
  },
  resolveFacts:async({tx})=>{const plan=scopes.get(tx);if(!plan||!readable.has(plan.actorAuthority))fail();return plan.facts;},
  revalidateFacts:async({tx,command,room,phase})=>{
   const plan=scopes.get(tx);if(!plan)fail();
   // Receipt revalidation owns room/replay/commit scope comparison. This second
   // consumer does not rediscover auth or acquire any locks.
   await plan.auth.revalidate({tx});await live(tx,plan);
   if(phase==='mutation'&&roomFingerprint(room)!==roomFingerprint(plan.room))fail('conflict');
   if(signature(command)!==signature(plan.operation.command)||await clock(tx)>=plan.notAfterMS)fail('unauthorized');return true;
  },
  resolveTerminalAuthority:async({tx,reference})=>{
   const plan=scopes.get(tx);if(!plan)fail();const event=plan.events.get(reference.requestID);const t=terminalFact(event);
   if(!historical.has(t)||!sameRef(t.persona,reference.persona)||!sameRef(plan.positive.get(t.persona.id),t.persona))fail();
   const p=plan.personas.get(t.persona.id);if(p.original_principal_id!==reference.originalPrincipalID||p.original_key_id!==reference.originalKeyID)fail();
   const install=installation(p,plan.keys.get(p.original_key_id));
   pairFor(plan.state,{install,pairDigest:t.pairDigest});await plan.auth.revalidate({tx});await live(tx,plan);
   return {version:1,status:'available',environment,sessionID:reference.sessionID,requestID:t.id,persona:t.persona,install,notAfterMS:plan.notAfterMS};
  }});
 function parseInput(input,reading=false){
  closed(input,['bearer',reading?'rawQuery':'rawCommand'],[],'invalid_request');
  const raw=reading?input.rawQuery:input.rawCommand,c=parseBoundedSessionJSON(raw);
  if(reading){
   closed(c,['version','action','sessionID','payload'],[],'invalid_request');closed(c.payload,['requestID'],[],'invalid_request');
   if(c.version!==2||c.action!=='admission.read'||!uuid(c.sessionID)||!uuid(c.payload.requestID))fail('invalid_request');
   return {bearer:input.bearer,raw,command:frozen({...c,environment}),bodyHash:null};
  }
  if(!actions.has(c.action))fail();const {command,bodyHash}=validateAdmissionCommand(raw);
  return {bearer:input.bearer,raw,command:frozen({...command,environment}),bodyHash};
 }
 async function read(input,mode){return safe(async()=>{
  const parsed=parseInput(input,mode==='admissionRead'),authentication=await currentAuth.prepare(parsed.bearer);
  return db.transaction(async tx=>{
   const plan=await compose(tx,authentication,{command:parsed.command,bodyHash:parsed.bodyHash,mode});
   await revalidate(plan,{tx,command:parsed.command,phase:'locked'});
   const room=await getRoom(tx,parsed.command.sessionID,true);
   const receipt=mode==='receiptRead'?await receipts(tx,authentication,parsed.command,true):null;
   await revalidate(plan,{tx,command:parsed.command,room,receipt,phase:'replay'});
   let result;
   if(mode==='receiptRead'){
    if(!receipt)fail('not_found');
    if(receipt.action!==parsed.command.action||receipt.canonical_body_hash!==parsed.bodyHash)fail('conflict');
    // Use only the gateway's small result vocabulary; no arbitrary stored data.
    const body=receipt.result,ints=['stateVersion','sessionRevision','queueRevision','settingsRevision','transitionRevision','authorityEpoch','eventSeq','privacyGeneration','count'];
    const ids=['occurrenceID','visitID','executionID','admissionID'];closed(body,[],[...ints,...ids,'noop','code']);const projected={};
    for(const [k,v] of Object.entries(body)){
     if(ints.includes(k))uint(v);else if(ids.includes(k)){if(v!==null&&!uuid(v))fail();}
     else if(k==='noop'){if(typeof v!=='boolean')fail();}else if(!['invalid_request','unauthorized','forbidden','not_found','conflict','expired','rate_limited','unavailable'].includes(v))fail();
     projected[k]=ints.includes(k)?uint(v):v;
    }
    if(!['accepted','executing','applied','refused','expired','uncertain','cancelled'].includes(receipt.status))fail();
    result={version:2,sessionID:receipt.session_id,commandID:receipt.command_id,status:receipt.status,result:projected,replayed:true};
   }else{
    const t=plan.target;if(!t)fail('not_found');
    const p=plan.personas.get(t.persona.id);if(!ownedBy(p,plan.auth))fail('not_found');
    if(t.status==='pending'){
     if(!sameInstall(t.install,plan.actorAuthority.install)||!sameInstall(t.install,plan.auth))fail('not_found');
     if(await clock(tx)>=t.expiresAtMS)fail('expired');
     result={version:2,sessionID:parsed.command.sessionID,admission:{id:t.id,version:t.version,status:'pending',expiresAtMS:t.expiresAtMS}};
    }else{
     if(!historical.has(t)||t.atMS>await clock(tx))fail();
     // Generation equality was proved by GuestLive/controller validation. There
     // is intentionally no <= generation transfer heuristic here.
     result={version:2,sessionID:parsed.command.sessionID,admission:{id:t.id,version:2,status:t.status,
      memberID:t.memberID,memberLeaseVersion:t.memberLeaseVersion}};
    }
   }
   await revalidate(plan,{tx,command:parsed.command,room,receipt,phase:'commit'});
   if(await clock(tx)>=plan.notAfterMS)fail('unauthorized');return frozen(structuredClone(result));
  });
 });}
 return Object.freeze({
  execute:input=>safe(async()=>{const p=parseInput(input);const authentication=await currentAuth.prepare(p.bearer);
   return admission.execute({authentication,rawCommand:p.raw});}),
  readAdmission:input=>read(input,'admissionRead'),readReceipt:input=>read(input,'receiptRead')
 });
}
