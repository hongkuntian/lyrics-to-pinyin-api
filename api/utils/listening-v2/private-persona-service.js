import {createHash,createHmac,randomUUID} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {AppAuthStore} from '../app-auth/store.js';
import {createCurrentAuthContext} from './auth-context.js';
import {createReceiptStore} from './receipt-store.js';
import {createPrivacyLifecycle} from './privacy-lifecycle.js';
import {parseBoundedSessionJSON} from './protocol.js';
import {decodePersonaTuple,decodePrivacyScrub,decodePrivacyUInt,privacyScrubMarker,PRIVACY_CODEC_FIELDS} from './privacy-codec.js';
import {SessionV2Error} from './errors.js';

const DAY=86400000,MAX=9007199254740991,fields=PRIVACY_CODEC_FIELDS.personaTuple;
const fail=(code='unavailable')=>{throw new SessionV2Error(code);};
const uint=decodePrivacyUInt,json=JSON.stringify;
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const increment=n=>{n=uint(n);if(n===MAX)fail('conflict');return n+1;};
const plus=(n,d)=>{n=uint(n);if(n>MAX-d)fail();return n+d;};
function closed(x,required,optional=[],code='unavailable'){
 if(!x||typeof x!=='object'||isProxy(x)||![Object.prototype,null].includes(Object.getPrototypeOf(x)))fail(code);
 const keys=Reflect.ownKeys(x);
 if(required.some(k=>!Object.hasOwn(x,k))||keys.length>required.length+optional.length)fail(code);
 for(const k of keys){const d=Object.getOwnPropertyDescriptor(x,k);
  if(typeof k!=='string'||!required.includes(k)&&!optional.includes(k)||!d.enumerable||!Object.hasOwn(d,'value'))fail(code);}
}
function array(x,max){
 if(!Array.isArray(x)||isProxy(x)||Object.getPrototypeOf(x)!==Array.prototype||x.length>max||Reflect.ownKeys(x).length!==x.length+1)fail();
 for(let n=0;n<x.length;n++){const d=Object.getOwnPropertyDescriptor(x,String(n));if(!d||!Object.hasOwn(d,'value')||!d.enumerable)fail();}
}
async function safe(work){try{return await work();}catch(error){if(error instanceof SessionV2Error)throw error;fail();}}
const numeric=new Set(['privacy_generation','guest_credential_expires_at_ms','withdrawn_at_ms','scrub_due_at_ms',
 'created_at_ms','updated_at_ms','controller_privacy_epoch','private_transfer_from_generation']);
function decodeRow(row){
 if(!row)fail('unauthorized');
 try{return decodePersonaTuple(json(fields.map(k=>row[k]!==null&&numeric.has(k)?uint(row[k]):row[k])));}
 catch{fail();}
}
const same=(a,b)=>json(a.tuple)===json(b.tuple);
const reference=p=>freeze({id:p.persona_id,generation:p.privacy_generation});
const selectPersona=`SELECT ${fields.join(',')} FROM listening_v2.privacy_personas`;
function intent(raw){
 const c=parseBoundedSessionJSON(raw);closed(c,['version','action','payload'],[],'invalid_request');
 confirmation(c.payload);
 if(c.version!==2||c.action!=='privacy.retain')fail('invalid_request');return c;
}
function confirmation(p){
 closed(p,['scope','confirmed'],[],'invalid_request');
 if(p.scope!=='my_sessions_persona'||p.confirmed!==true)fail('invalid_request');
}
function eraseCommand(c,internal=false){
 closed(c,['version','action','sessionID','commandID','expected','payload',...(internal?['environment']:[])],[],'invalid_request');
 closed(c.expected,['privacyGeneration'],[],'invalid_request');confirmation(c.payload);
 if(c.version!==2||c.action!=='privacy.erase'||!uuid(c.sessionID)||!uuid(c.commandID)||
  typeof c.expected.privacyGeneration!=='number'||!Number.isSafeInteger(c.expected.privacyGeneration)||
  c.expected.privacyGeneration<0||Object.is(c.expected.privacyGeneration,-0))fail('invalid_request');
 return c;
}

/** Private actual-method component. Pure construction; fixed trusted config.
 * No route, public DTO, live-factory import, activation, admission-budget claim,
 * caller auth callback, permit, clock, negative flag or request-selected scope.
 * Live retained-profile capacity stays ZERO until Root's later measured gate.
 */
export function createPrivatePersonaService(options){
 closed(options,['db','environment','policy','coordinatorEnvironment','bindingKeys','activeBindingKeyVersion',
  'receiptKeyPolicy','ticketKeys','activeTicketKeyID']);
 if(!options.db||isProxy(options.db)||typeof options.db.query!=='function'||typeof options.db.transaction!=='function')fail();
 const environment=options.environment,coordinatorEnvironment=options.coordinatorEnvironment;
 const query=options.db.query.bind(options.db),transaction=options.db.transaction.bind(options.db);
 const plans=new WeakMap(),sessionDigests=new WeakMap();
 const db={query,transaction:work=>transaction(async tx=>{try{return await work(tx);}finally{plans.delete(tx);}})};
 closed(options.policy,['audience','environment','prefix','bundles']);array(options.policy.bundles,32);
 const policy=freeze(structuredClone(options.policy));
 const currentAuth=createCurrentAuthContext({authStore:new AppAuthStore(db,{policy}),environment});
 const lifecycle=createPrivacyLifecycle({db,coordinatorEnvironment});
 function ring(entries,kind){
  array(entries,4);const result=new Map();
  for(const entry of entries){closed(entry,[kind,'secret']);const id=entry[kind];
   if(kind==='version'?!Number.isInteger(id)||id<1||id>65535:typeof id!=='string'||!id.length||id.length>32)fail();
   if(isProxy(entry.secret)||!Buffer.isBuffer(entry.secret)||entry.secret.length<32||entry.secret.length>4096||result.has(id))fail();
   result.set(id,Buffer.from(entry.secret));
  }return result;
 }
 const bindings=ring(options.bindingKeys,'version'),tickets=ring(options.ticketKeys,'id');
 const activeBindingKeyVersion=options.activeBindingKeyVersion,activeTicketKeyID=options.activeTicketKeyID;
 if(!bindings.has(activeBindingKeyVersion)||!tickets.has(activeTicketKeyID))fail();
 closed(options.receiptKeyPolicy,['environment','keys']);array(options.receiptKeyPolicy.keys,4);
 if(options.receiptKeyPolicy.environment!==environment||!options.receiptKeyPolicy.keys.length)fail();
 const configured=options.receiptKeyPolicy.keys.map(k=>{closed(k,['version','verificationHash']);
  if(!Number.isInteger(k.version)||!digest(k.verificationHash))fail();return {...k};}).sort((a,b)=>a.version-b.version);
 const descriptors=[...bindings].sort(([a],[b])=>a-b).map(([version,secret])=>({version,verificationHash:createHmac('sha256',secret)
  .update(json(['sessions-v2.receipt-key-check',version,environment])).digest('hex')}));
 if(json(configured)!==json(descriptors))fail();
 const manifest=freeze({keys:descriptors,hash:createHash('sha256').update(json(descriptors)).digest('hex')});
 async function prepare(bearer){
  const authentication=await currentAuth.prepare(bearer);
  sessionDigests.set(authentication.evidence,createHash('sha256').update(bearer).digest('hex'));return authentication;
 }
 async function lockAuth(tx,authentication){
  // Current actor's user/C/K/exact S are the complete auth set. Historical
  // Apple origin K may now belong to B and grants no B-key lock/right here.
  const discovery=await currentAuth.discover({tx,authentication});
  return currentAuth.lock({tx,discovery});
 }
 async function source(tx,authentication,scope,{finite=false}={}){
  const sessionDigest=sessionDigests.get(authentication.evidence);if(!sessionDigest)fail('unauthorized');
  const r=(await tx.query(`WITH persona_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
   SELECT s.expires_at::text AS session_deadline,t.expires_at::text AS credential_deadline,
    u.access_kind,u.sessions_privacy_epoch::text AS epoch,
    floor(extract(epoch FROM c.at)*1000)::text AS now_ms,
    CASE WHEN t.expires_at IS NULL THEN NULL ELSE floor(extract(epoch FROM t.expires_at)*1000)::text END AS expires_ms,
    (t.expires_at IS NOT NULL AND isfinite(t.expires_at)) AS finite,
    (t.expires_at<=c.at+interval '90 days') AS within_guest_bound,
    (isfinite(s.expires_at) AND s.expires_at>c.at AND
     (t.expires_at IS NULL OR (isfinite(t.expires_at) AND t.expires_at>c.at))) AS live
   FROM public.app_auth_sessions s JOIN public.app_attest_keys k ON k.key_id=s.key_id
   JOIN public.library_tokens t ON t.digest=s.credential_digest JOIN public.library_users u ON u.id=k.user_id
   CROSS JOIN persona_clock c WHERE s.digest=$1 AND s.key_id=$2 AND s.credential_digest=$3
    AND k.user_id=$4 AND t.user_id=$4 AND k.bundle_id=$5 AND k.audience=$6 AND s.audience=$6
    AND k.environment=$7 AND k.bundle_id=ANY($8::text[]) AND NOT s.revoked AND NOT k.revoked
    AND NOT t.revoked AND NOT u.disabled`,[sessionDigest,scope.keyID,scope.credentialDigest,scope.principalID,
   scope.bundleID,scope.audience,scope.attestEnvironment,policy.bundles])).rows[0];
  if(!r||r.live!==true||finite&&r.finite!==true)fail('unauthorized');
  if(!['guest','apple'].includes(r.access_kind)||r.access_kind!==scope.accessKind)fail('forbidden');
  return freeze({...r,epoch:uint(r.epoch),nowMS:uint(r.now_ms),expiresMS:r.expires_ms===null?null:uint(r.expires_ms)});
 }
 function unchangedSource(before,after,{epoch=before.epoch}={}){
  if(before.session_deadline!==after.session_deadline||before.credential_deadline!==after.credential_deadline||
   before.access_kind!==after.access_kind||after.epoch!==epoch)fail('unauthorized');
 }
 function owned(p,scope){
  return p.controller_kind==='guest'?scope.accessKind==='guest'&&p.original_principal_id===scope.principalID&&
   p.original_key_id===scope.keyID&&p.controller_principal_id===scope.principalID&&p.controller_key_id===scope.keyID:
   p.controller_kind==='apple'&&scope.accessKind==='apple'&&p.controller_principal_id===scope.principalID;
 }
 function live(p,scope,s){
  if(!owned(p,scope)||p.status!=='live')fail('conflict');
  if(p.controller_kind==='apple'){
   if(p.controller_privacy_epoch!==s.epoch||s.epoch===MAX)fail('conflict');
  }else if(p.guest_credential_digest!==scope.credentialDigest||p.guest_credential_expires_at_ms!==s.expiresMS||
   s.finite!==true||p.guest_credential_expires_at_ms<=s.nowMS)fail('conflict');
 }
 async function unfinished(tx,scope){
  // No environment predicate: public source anchors and dependency eras are
  // global. Include pending, claimed, dead and every unfinished successor.
  // These bounded existence probes do not scan/trim persona owner history.
  const selectors=[{kind:'credential',value:scope.credentialDigest},{kind:'guest-key',value:scope.keyID},
   {kind:scope.accessKind==='guest'?'guest-user':'apple-controller',value:scope.principalID}];
  for(const selector of selectors){
   const row=(await tx.query(`SELECT job_id FROM listening_v2.outbox WHERE kind='privacy_dependency'
    AND state<>'published' AND payload->'selector'=$1::jsonb LIMIT 1`,[json(selector)])).rows[0];
   if(row)fail('conflict');
  }
 }
 async function getPersona(tx,id,lock=false){
  const row=(await tx.query(`${selectPersona} WHERE environment=$1 AND persona_id=$2${lock?' FOR UPDATE':''}`,[environment,id])).rows[0];
  return decodeRow(row);
 }
 async function finalAuth(tx,authentication,scope,before,epoch=before.epoch){
  await scope.revalidate({tx});
  // Last service SQL. Exact persisted timestamps compare to fresh DB time;
  // no Date conversion, caller clock, rounding or replacement-S selection.
  unchangedSource(before,await source(tx,authentication,scope),{epoch});
 }
 async function retain(input){return safe(async()=>{
  closed(input,['bearer','rawIntent'],[],'invalid_request');const raw=input.rawIntent,bearer=input.bearer;intent(raw);
  const authentication=await prepare(bearer);
  return db.transaction(async tx=>{
   const scope=await lockAuth(tx,authentication),before=await source(tx,authentication,scope,{finite:true});
   if(scope.accessKind==='guest'&&before.within_guest_bound!==true)fail('unauthorized');
   if(scope.accessKind==='apple'&&before.epoch===MAX)fail('conflict');
   // The source user anchor also serializes absent-origin creation with other
   // cooperating retainers and the processor's final dependency publication.
   const rows=(await tx.query(`${selectPersona} WHERE environment=$1 AND original_principal_id=$2
    AND original_key_id=$3 AND status='live' FOR UPDATE`,[environment,scope.principalID,scope.keyID])).rows;
   if(rows.length>1)fail();await unfinished(tx,scope);
   let p;
   if(rows.length){
    p=decodeRow(rows[0]);live(p,scope,before);
    // The exact selected controller/identity must still have terminal space.
    decodePersonaTuple(json(p.tuple),{reserveFuture:true});
   }else{
    const tuple=[environment,randomUUID(),scope.principalID,scope.keyID,scope.accessKind,scope.principalID,
     scope.accessKind==='guest'?scope.keyID:null,1,'live',scope.accessKind==='guest'?scope.credentialDigest:null,
     scope.accessKind==='guest'?before.expiresMS:null,null,null,null,before.nowMS,before.nowMS,
     scope.accessKind==='guest'?0:before.epoch,null];
    p=decodePersonaTuple(json(tuple),{reserveFuture:true});
    // Actual033 CHECK measures PostgreSQL-normalized all18 bytes on INSERT.
    const inserted=(await tx.query(`INSERT INTO listening_v2.privacy_personas(${fields.join(',')})
     VALUES(${fields.map((_,n)=>'$'+(n+1)).join(',')}) RETURNING ${fields.join(',')}`,p.tuple)).rows[0];
    if(!same(decodeRow(inserted),p))fail();
   }
   const current=await getPersona(tx,p.persona_id);if(!same(current,p))fail('conflict');
   await finalAuth(tx,authentication,scope,before);return reference(p);
  });
 });}
 function savedReceipt(p,scope,s,receipt){
  if(!owned(p,scope)||receipt.session_id!==p.persona_id||receipt.room_id!==null||receipt.action!=='privacy.erase'||
   receipt.actor_persona_id!==p.persona_id||receipt.actor_privacy_generation===null)fail('unauthorized');
  const generation=uint(receipt.actor_privacy_generation);
  if(receipt.status!=='accepted'||json(receipt.result)!==json({privacyGeneration:increment(generation)}))fail();
  // Exact current or one terminal predecessor only. No broad <=generation
  // capability or transfer bridge. Stored receipt is negative/minimal, never
  // a substitute for live profile/admission/asset authority.
  if(p.status==='live'){
   if(generation!==p.privacy_generation)fail('unauthorized');
   if(p.controller_kind!=='apple'||p.controller_privacy_epoch>=s.epoch)fail();
  }else if(p.status!=='withdrawn'||p.privacy_generation===0||generation!==p.privacy_generation-1)fail('unauthorized');
 }
 // This is the gateway's existing receipt binding namespace, with the same
 // copied keys and attested manifest. Discovery never authenticates a receipt:
 // the unchanged gateway still performs retained-version and exact locked lookup.
 function receiptBinding(version,kind,id){return createHmac('sha256',bindings.get(version)).update(json([
  'sessions-v2.command-receipt',version,environment,kind,id])).digest('hex');}
 const receiptFields=['environment','session_id','principal_binding','key_binding','command_id','binding_key_version',
  'room_id','action','canonical_body_hash','status','actor_persona_id','actor_privacy_generation','result',
  'created_at_ms','ticket_expires_at_ms','delete_after_ms'];
 const receiptNumbers=new Set(['binding_key_version','actor_privacy_generation','created_at_ms','ticket_expires_at_ms','delete_after_ms']);
 function receiptSnapshot(r){
  if(!r||r.environment!==environment||r.action!=='privacy.erase'||r.room_id!==null||r.status!=='accepted'||
   (r.actor_persona_id===null)!==(r.actor_privacy_generation===null))fail();
  closed(r.result,['privacyGeneration']);
  if(typeof r.result.privacyGeneration!=='number'||!Number.isSafeInteger(r.result.privacyGeneration)||r.result.privacyGeneration<1)fail();
  return json(receiptFields.map(k=>receiptNumbers.has(k)&&r[k]!==null?uint(r[k]):r[k]));
 }
 async function discoverReceipt(tx,scope,command){
  const params=[environment,command.sessionID,command.commandID];
  const alternatives=[...bindings.keys()].sort((a,b)=>a-b).map(version=>{
   params.push(version,receiptBinding(version,'principal',scope.principalID),receiptBinding(version,'key',scope.keyID));
   const n=params.length;return `(binding_key_version=$${n-2} AND principal_binding=$${n-1} AND key_binding=$${n})`;
  });
  const rows=(await tx.query(`SELECT *,xmin::text AS _receipt_xmin,ctid::text AS _receipt_ctid FROM listening_v2.command_receipts
   WHERE environment=$1 AND session_id=$2 AND command_id=$3 AND (${alternatives.join(' OR ')})`,params)).rows;
  if(rows.length>1)fail();return rows[0]??null;
 }
 async function lockedReceipt(tx,observed,receipt,snapshot){
  if(!observed||!receipt||receiptSnapshot(receipt)!==snapshot)fail();
  // The gateway has already locked its exact row. Re-read the actual durable
  // postimage, including at commit, before any result is released.
  const row=(await tx.query(`SELECT *,xmin::text AS _receipt_xmin,ctid::text AS _receipt_ctid FROM listening_v2.command_receipts
   WHERE environment=$1 AND session_id=$2 AND principal_binding=$3 AND key_binding=$4 AND command_id=$5 FOR UPDATE`,
   [observed.environment,observed.session_id,observed.principal_binding,observed.key_binding,observed.command_id])).rows[0];
  if(!row||typeof observed._receipt_xmin!=='string'||typeof observed._receipt_ctid!=='string'||
   row._receipt_xmin!==observed._receipt_xmin||row._receipt_ctid!==observed._receipt_ctid||receiptSnapshot(row)!==snapshot)fail();
 }
 async function compose({tx,authentication,command,bindingKeyManifest}){
  eraseCommand(command,true);if(command.environment!==environment||json(bindingKeyManifest)!==json(manifest))fail();
  const scope=await lockAuth(tx,authentication),before=await source(tx,authentication,scope);
  const receipt=await discoverReceipt(tx,scope,command),snapshot=receipt?receiptSnapshot(receipt):null;
  const replayOnly=receipt!==null&&receipt.actor_persona_id===null;
  let p=null;
  if(!replayOnly){
   const observed=await getPersona(tx,command.sessionID);
   if(!(observed.controller_kind==='guest'&&observed.original_principal_id===authentication.principalID&&observed.original_key_id===authentication.keyID||
    observed.controller_kind==='apple'&&observed.controller_principal_id===authentication.principalID))fail('unauthorized');
   p=await getPersona(tx,command.sessionID,true);if(!same(p,observed))fail('conflict');
   if(!owned(p,scope))fail('unauthorized');
  }
  const plan={tx,authentication,scope,before,p,command:json(command),mutation:false,after:null,epoch:before.epoch};plans.set(tx,plan);
  return {version:1,environment,principalID:scope.principalID,keyID:scope.keyID,bindingKeyManifestHash:manifest.hash,
   actorPersonaID:p?.persona_id??null,actorPrivacyGeneration:p?.privacy_generation??null,notAfterMS:scope.notAfterMS,
   revalidate:async request=>{
    if(request.tx!==tx||plans.get(tx)!==plan||json(request.command)!==plan.command||request.room!==null)fail();
    if(request.phase==='replay'||request.phase==='mutation'&&receipt){
     await lockedReceipt(tx,receipt,request.receipt,snapshot);
    }
    if(replayOnly){
     // A missing/replaced row must never fall through to a fresh mutation.
     if(request.phase==='mutation')fail();
     if(request.phase==='commit'){
      await lockedReceipt(tx,receipt,request.receipt,snapshot);
      // The gateway reaches commit only after canonical body hash equality.
      if(request.receipt.result.privacyGeneration!==increment(command.expected.privacyGeneration))fail();
     }
    }else{
     const actual=await getPersona(tx,p.persona_id);if(!same(actual,plan.after??p))fail('conflict');
     if(request.receipt&&request.phase!=='commit')savedReceipt(actual,scope,before,request.receipt);
     if(request.phase==='mutation'){
      live(p,scope,before);if(p.privacy_generation!==command.expected.privacyGeneration)fail('conflict');
      await unfinished(tx,scope);
      await scope.assertFreshSession({tx,maxAgeMS:120000});plan.mutation=true;
     }
     if(request.phase==='commit'&&request.receipt){
      if(!plan.after){
       await lockedReceipt(tx,receipt,request.receipt,snapshot);savedReceipt(actual,scope,before,request.receipt);
       if(request.receipt.result.privacyGeneration!==increment(command.expected.privacyGeneration))fail();
      }else if(request.receipt.actor_persona_id!==p.persona_id||request.receipt.actor_privacy_generation!==p.privacy_generation)fail();
     }
    }
    await finalAuth(tx,authentication,scope,before,plan.epoch);return true;
   }};
 }
 async function withdrawGuest(tx,plan){
  const p=plan.p,generation=increment(p.privacy_generation);
  // New authorized erase is the first invalidation under the held source
  // anchors. Dead/expired/effectively withdrawn live rows were refused above;
  // their earlier historical time cannot be replaced with "erase now".
  const s=await source(tx,plan.authentication,plan.scope);unchangedSource(plan.before,s);live(p,plan.scope,s);
  const withdrawn=s.nowMS,due=plus(withdrawn,DAY),jobID=randomUUID(),marker=privacyScrubMarker(jobID,'rooms');
  const payload=decodePrivacyScrub(json({version:2,environment,personaID:p.persona_id,privacyGeneration:generation,
   withdrawnAtMS:withdrawn,scrubDueAtMS:due,phase:'rooms',cursor:null})).payload;
  const post={...p,privacy_generation:generation,status:'withdrawn',withdrawn_at_ms:withdrawn,scrub_due_at_ms:due,
   scrub_cursor:marker,updated_at_ms:Math.max(p.updated_at_ms,withdrawn)};
  const expected=decodePersonaTuple(json(fields.map(k=>post[k])));
  const row=(await tx.query(`UPDATE listening_v2.privacy_personas SET privacy_generation=$4,status='withdrawn',withdrawn_at_ms=$5,
   scrub_due_at_ms=$6,scrub_cursor=$7,updated_at_ms=$8 WHERE environment=$1 AND persona_id=$2 AND privacy_generation=$3
    AND status='live' AND controller_kind='guest' AND controller_principal_id=$9 AND controller_key_id=$10
    AND guest_credential_digest=$11 AND guest_credential_expires_at_ms=$12 AND controller_privacy_epoch=0
   RETURNING ${fields.join(',')}`,[environment,p.persona_id,p.privacy_generation,generation,withdrawn,due,marker,
   post.updated_at_ms,plan.scope.principalID,plan.scope.keyID,plan.scope.credentialDigest,p.guest_credential_expires_at_ms])).rows[0];
  if(!row||!same(decodeRow(row),expected))fail('conflict');
  await tx.query(`INSERT INTO listening_v2.outbox(environment,job_id,job_key,kind,persona_id,privacy_generation,payload,
   created_at_ms,due_at_ms,retry_until_ms) VALUES($1,$2,$3,'privacy_scrub',$4,$5,$6::jsonb,$7,$7,$8)`,
   [environment,jobID,`privacy-scrub:${jobID}`,p.persona_id,generation,json(payload),withdrawn,due]);
  plan.after=expected;
 }
 async function mutate({tx,command,room,actorPersonaID,actorPrivacyGeneration}){
  // This is a fixed trusted reducer. No arbitrary external reducer, request
  // callback or a caller's expected/payload bypasses this closed validation.
  eraseCommand(command,true);const plan=plans.get(tx);
  if(!plan||plan.tx!==tx||!plan.mutation||plan.after||room!==null||json(command)!==plan.command||
   actorPersonaID!==plan.p.persona_id||actorPrivacyGeneration!==plan.p.privacy_generation)fail();
  const p=await getPersona(tx,plan.p.persona_id);if(!same(p,plan.p))fail('conflict');
  const s=await source(tx,plan.authentication,plan.scope);unchangedSource(plan.before,s);live(p,plan.scope,s);
  if(p.privacy_generation!==command.expected.privacyGeneration)fail('conflict');
  // Even already-retained older rows must have their mandatory negative space.
  decodePersonaTuple(json(p.tuple),{reserveFuture:true});
  if(p.controller_kind==='guest')await withdrawGuest(tx,plan);
  else {
   const epoch=increment(s.epoch),prepared=await lifecycle.prepareAppleEpochAdvance(tx,plan.scope.principalID);
   const row=(await tx.query(`UPDATE public.library_users SET sessions_privacy_epoch=$3
    WHERE id=$1 AND sessions_privacy_epoch=$2 AND access_kind='apple' AND NOT disabled RETURNING sessions_privacy_epoch`,
    [plan.scope.principalID,p.controller_privacy_epoch,epoch])).rows[0];
   if(!row||uint(row.sessions_privacy_epoch)!==epoch)fail('conflict');
   await lifecycle.persistSourceClosure(tx,prepared);plan.epoch=epoch;plan.after=p;
   // Canonical epoch immediately denies ALL A-controlled history, irrespective
   // of namespace or cardinality. No unbounded persona UPDATE or C revocation.
  }
  return {status:'accepted',result:{privacyGeneration:increment(p.privacy_generation)}};
 }
 const receipts=createReceiptStore({db,environment,bindingKeys:[...bindings].map(([version,secret])=>({version,secret})),activeBindingKeyVersion,
  ticketKeys:[...tickets].map(([id,secret])=>({id,secret})),activeTicketKeyID,lockAuthorization:compose,mutations:{'privacy.erase':mutate}});
 return Object.freeze({retain,erase:input=>safe(async()=>{
  closed(input,['bearer','rawCommand'],[],'invalid_request');const raw=input.rawCommand,bearer=input.bearer;
  eraseCommand(parseBoundedSessionJSON(raw));const authentication=await prepare(bearer);
  return receipts.execute({authentication,rawCommand:raw});
 })});
}
