import {isProxy} from 'node:util/types';
import {LibraryError} from '../song-library/store.js';
import {createPrivacyLifecycle} from './privacy-lifecycle.js';
import {decodePersonaTuple,decodePrivacyDependency,decodePrivacyUInt,PRIVACY_CODEC_FIELDS} from './privacy-codec.js';
const unavailable=()=>{throw new LibraryError('sessions_privacy_unavailable',503);};
const deferred=()=>{throw new LibraryError('sessions_privacy_deferred',409);};
const transitionUnavailable=()=>{throw new LibraryError('sessions_privacy_transition_unavailable',503);};
const json=JSON.stringify,MAX=9007199254740991,uint=decodePrivacyUInt;
const same=(a,b)=>json(a)===json(b);
const first=async(tx,sql,args=[])=>(await tx.query(sql,args)).rows[0]??null;
const clock=async tx=>uint((await first(tx,`WITH writer_privacy_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
 SELECT floor(extract(epoch FROM at)*1000)::text AS now_ms FROM writer_privacy_clock`)).now_ms);
async function transactionID(tx){
 const id=(await first(tx,'SELECT pg_current_xact_id()::text AS transaction_id'))?.transaction_id;
 if(typeof id!=='string'||!/^[1-9]\d{0,19}$/.test(id)||BigInt(id)>18446744073709551615n)unavailable();return id;
}
function closedConfiguration(value){
 if(!value||typeof value!=='object'||isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))unavailable();
 const keys=Reflect.ownKeys(value),d=Object.getOwnPropertyDescriptor(value,'coordinatorEnvironment');
 if(keys.length!==1||keys[0]!=='coordinatorEnvironment'||!d||!d.enumerable||!Object.hasOwn(d,'value')||typeof d.value!=='string')unavailable();
 decodePrivacyDependency(json({version:2,environment:d.value,selector:{kind:'indexed-sweep'},cursor:null,invalidatedAtMS:null}));return d.value;
}
const numeric=new Set(['privacy_generation','guest_credential_expires_at_ms','withdrawn_at_ms','scrub_due_at_ms',
 'created_at_ms','updated_at_ms','controller_privacy_epoch','private_transfer_from_generation']);
const columns=PRIVACY_CODEC_FIELDS.personaTuple.join(',');
const tuple=row=>PRIVACY_CODEC_FIELDS.personaTuple.map(k=>numeric.has(k)&&row[k]!==null?uint(row[k]):row[k]);
const decode=row=>decodePersonaTuple(json(tuple(row)));
const userSQL=`SELECT id,access_kind,disabled,sessions_privacy_epoch::text AS sessions_privacy_epoch FROM public.library_users`;
const tokenSQL=`SELECT digest,user_id,revoked,expires_at::text AS deadline,isfinite(expires_at) AS finite,
 CASE WHEN expires_at IS NULL OR NOT isfinite(expires_at) THEN NULL ELSE floor(extract(epoch FROM expires_at)*1000)::text END AS expires_ms
 FROM public.library_tokens`;
const keySQL=`SELECT key_id,user_id,revoked,bundle_id,audience,environment FROM public.app_attest_keys`;
const transferSQL=`SELECT ${columns} FROM listening_v2.privacy_personas
 WHERE original_principal_id COLLATE "C"=$1::text COLLATE "C" AND original_key_id COLLATE "C"=$2::text COLLATE "C"
 AND controller_kind='guest' AND status='live' ORDER BY environment COLLATE "C",persona_id LIMIT 101`;

/** Server-only construction. Absence returns before SQL/schema/field queries.
 * No client flag, supplied time, generic auth callback or positive permit.
 * Actual entrypoints, not this infrastructure, own bearer/operator authority.
 */
export function createAuthPrivacyWriters(database,configuration){
 if(configuration===undefined)return null;
 let coordinator;try{coordinator=closedConfiguration(configuration);}catch{unavailable();}
 if(!database||isProxy(database)||typeof database.query!=='function'||typeof database.transaction!=='function')unavailable();
 const lifecycle=createPrivacyLifecycle({db:database,coordinatorEnvironment:coordinator}),plans=new WeakMap();
 const safe=async work=>{try{return await work();}catch(error){if(error instanceof LibraryError)throw error;unavailable();}};
 async function allTokens(tx,id){
  const rows=(await tx.query(`${tokenSQL} WHERE user_id=$1 ORDER BY digest COLLATE "C" LIMIT 65`,[id])).rows;
  if(rows.length>64)deferred();return rows;
 }
 async function allKeys(tx,id){
  const rows=(await tx.query(`${keySQL} WHERE user_id=$1 ORDER BY key_id COLLATE "C" LIMIT 65`,[id])).rows;
  if(rows.length>64)deferred();return rows;
 }
 async function currentUser(tx,id){const u=await first(tx,`${userSQL} WHERE id=$1`,[id]);if(!u)unavailable();uint(u.sessions_privacy_epoch);return u;}
 function actor(scope){
  if(!scope||typeof scope!=='object'||isProxy(scope))unavailable();
  const {principalID,keyID,credentialDigest,bundleID,audience,attestEnvironment}=scope;
  if([principalID,keyID,bundleID,audience,attestEnvironment].some(v=>typeof v!=='string')||!/^[a-f0-9]{64}$/.test(credentialDigest??''))unavailable();
  return Object.freeze({principalID,keyID,credentialDigest,bundleID,audience,attestEnvironment});
 }
 async function noLiveDigest(tx,digest){
  if(await first(tx,`SELECT persona_id FROM listening_v2.privacy_personas WHERE guest_credential_digest COLLATE "C"=$1::text COLLATE "C"
   AND controller_kind='guest' AND status='live' LIMIT 1`,[digest]))deferred();
 }
 async function noLiveController(tx,id){
  if(await first(tx,`SELECT persona_id FROM listening_v2.privacy_personas WHERE controller_principal_id COLLATE "C"=$1::text COLLATE "C"
   AND controller_kind='apple' AND status='live' LIMIT 1`,[id]))deferred();
 }
 async function unfinished(tx,selectors){
  // Every namespace and pending/claimed/dead successor. Negative only.
  for(const selector of selectors)if(await first(tx,`SELECT job_id FROM listening_v2.outbox
   WHERE kind='privacy_dependency' AND state<>'published' AND payload->'selector'=$1::jsonb LIMIT 1`,[json(selector)]))deferred();
 }
 async function dormant(tx,p){
  // PW-01: no closed auth-key -> original_install_scope mapping is retained.
  // ANY retained guard conservatively refuses this configured writer. Preserve
  // its entire safety image; absence never initializes or releases a guard.
  if(await first(tx,'SELECT guard_id FROM listening_v2.output_guards LIMIT 1'))transitionUnavailable();
  // PW-02: no account-role End/handoff producer; account cannot execute the
  // independent terminal event/counters. No guest-removal-on-host or JSON guess.
  const affected=`(p.controller_kind='guest' AND p.guest_credential_digest=ANY($1::text[]))
   OR (p.controller_kind='guest' AND p.original_principal_id=$2)
   OR (p.controller_kind='apple' AND p.controller_principal_id=$3)
   OR p.original_key_id=ANY($4::text[])`;
  const values=[p.digests,p.guestOwner,p.appleOwner,p.keyIDs];
  if(await first(tx,`SELECT r.session_id FROM listening_v2.rooms r WHERE r.status='active' OR EXISTS(
   SELECT 1 FROM listening_v2.privacy_personas p WHERE p.environment=r.environment
   AND (r.host_persona_id=p.persona_id OR r.privacy_persona_ids @> ARRAY[p.persona_id]) AND (${affected})) LIMIT 1`,values))transitionUnavailable();
  // PW-03: retained physical-install/generation grant semantics need Root's
  // closed transition too. Do not silently keep or revoke an unrelated newly
  // approved generation. Affected live grant work safely refuses for now.
  if(await first(tx,`SELECT g.grant_id FROM listening_v2.returning_grants g WHERE g.status='active' AND EXISTS(
   SELECT 1 FROM listening_v2.privacy_personas p WHERE p.environment=g.environment
   AND p.persona_id IN (g.host_persona_id,g.guest_persona_id,g.approver_persona_id) AND (${affected})) LIMIT 1`,values))transitionUnavailable();
 }
 async function capture(tx,kind,{ownerID,scope=null,keyID=null,targetID=null,newDigest=null}){
  if(typeof ownerID!=='string'||!ownerID.length||ownerID.length>160||
   keyID!==null&&typeof keyID!=='string'||targetID!==null&&typeof targetID!=='string'||
   newDigest!==null&&(typeof newDigest!=='string'||!/^[a-f0-9]{64}$/.test(newDigest)))unavailable();
  const query=tx.query,id=await transactionID(tx),u=await currentUser(tx,ownerID);
  const tokens=['delete','disable','rotation'].includes(kind)?await allTokens(tx,ownerID):kind==='key'?[]:
   [await first(tx,`${tokenSQL} WHERE digest=$1`,[scope.credentialDigest])];
  if(tokens.some(t=>!t||t.user_id!==ownerID))unavailable();
  const keys=kind==='signIn'||kind==='key'?[await first(tx,`${keySQL} WHERE key_id=$1`,[keyID??scope.keyID])]:await allKeys(tx,ownerID);
  if(keys.some(k=>!k||k.user_id!==ownerID))unavailable();
  const p={kind,tx,query,id,u,tokens,keys,scope,targetID,newDigest,negative:[],transfers:[],hints:[],phase:'prepared',
   digests:tokens.filter(t=>kind!=='rotation'||t.digest!==newDigest).map(t=>t.digest),keyIDs:keys.map(k=>k.key_id),
   guestOwner:kind==='delete'||kind==='disable'?ownerID:null,
   appleOwner:(kind==='delete'||kind==='disable')&&u.access_kind==='apple'?ownerID:null};
  if(kind==='rotation')await noLiveDigest(tx,newDigest);
  await dormant(tx,p);
  // Actual engine producer evidence: sampled AFTER real source/auth anchors,
  // before intentional closure. No invented invalidation or expiry timestamp.
  for(const t of tokens)if(!t.revoked&&(kind!=='rotation'||t.digest!==newDigest))
   p.negative.push(await lifecycle.prepareCredentialClosure(tx,t.digest));
  for(const k of keys)if(!k.revoked&&(['delete','disable','key'].includes(kind)||kind==='signIn'&&ownerID!==targetID))
   p.negative.push(await lifecycle.prepareGuestKeyClosure(tx,k.key_id));
  if((kind==='delete'||kind==='disable')&&!u.disabled){
   if(u.access_kind==='guest')p.negative.push(await lifecycle.prepareGuestUserClosure(tx,ownerID));
   if(u.access_kind==='apple')p.negative.push(await lifecycle.prepareAppleControllerClosure(tx,ownerID));
  }
  if(kind==='signIn'){
   const target=await currentUser(tx,targetID);if(target.access_kind!=='apple')unavailable();p.target=target;
   if(target.disabled)await noLiveController(tx,targetID); // AUTH-only reenable, no resurrection.
   const candidates=(await tx.query(transferSQL,[ownerID,scope.keyID])).rows.map(decode);
   if(candidates.length>100||candidates.length&&u.access_kind!=='guest')deferred();
   if(candidates.length){
    if(u.disabled||keys[0].revoked||keys[0].bundle_id!==scope.bundleID||keys[0].audience!==scope.audience||keys[0].environment!==scope.attestEnvironment)deferred();
    await unfinished(tx,[{kind:'credential',value:scope.credentialDigest},{kind:'guest-key',value:scope.keyID},
     {kind:'guest-user',value:ownerID},{kind:'apple-controller',value:targetID}]);
    const token=tokens[0],at=await clock(tx);
    if(token.revoked||token.finite!==true||token.expires_ms===null||uint(token.expires_ms)<=at)deferred();
    for(const old of candidates){
     if(old.guest_credential_digest!==scope.credentialDigest||old.guest_credential_expires_at_ms!==uint(token.expires_ms)||
      old.guest_credential_expires_at_ms<=at||old.guest_credential_expires_at_ms-old.created_at_ms>7776000000||old.privacy_generation===MAX)deferred();
     const next=old.tuple.slice();next[4]='apple';next[5]=targetID;next[6]=null;next[7]=old.privacy_generation+1;
     next[9]=null;next[10]=null;next[15]=at;next[16]=uint(target.sessions_privacy_epoch);next[17]=old.privacy_generation;
     // Reserve THIS verified actual target's mandatory future withdrawal before
     // changing any persona/source. No fake legacy bridge or guessed controller.
     p.transfers.push({before:old,after:decodePersonaTuple(json(next),{reserveFuture:true})});
    }
    for(const transfer of p.transfers){const b=transfer.before,r=await first(tx,
     `SELECT ${columns} FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2 FOR UPDATE`,[b.environment,b.persona_id]);
     if(!r||!same(decode(r).tuple,b.tuple))deferred();}
    if(!same((await tx.query(transferSQL,[ownerID,scope.keyID])).rows.map(r=>decode(r).tuple),candidates.map(r=>r.tuple)))deferred();
   }
  }
  if(tx.query!==query||await transactionID(tx)!==id)unavailable();
  const handle=Object.freeze(Object.create(null));plans.set(handle,p);return handle;
 }
 async function owned(tx,handle,phase){
  const p=plans.get(handle);
  if(!p||p.tx!==tx||p.query!==tx?.query||p.phase!==phase){if(p)plans.delete(handle);unavailable();}
  if(await transactionID(tx)!==p.id){plans.delete(handle);unavailable();}return p;
 }
 async function applyBeforeAuth(tx,handle){return safe(async()=>{
  const p=await owned(tx,handle,'prepared');p.phase='applying';
  for(const {before:b,after:a} of p.transfers){
   const changed=await tx.query(`UPDATE listening_v2.privacy_personas SET controller_kind='apple',controller_principal_id=$3,
    controller_key_id=NULL,privacy_generation=$4,guest_credential_digest=NULL,guest_credential_expires_at_ms=NULL,
    updated_at_ms=$5,controller_privacy_epoch=$6,private_transfer_from_generation=$7
    WHERE environment=$1 AND persona_id=$2 AND status='live' AND controller_kind='guest' AND privacy_generation=$7
    AND original_principal_id=$8 AND original_key_id=$9 AND guest_credential_digest=$10
    AND guest_credential_expires_at_ms=$11 AND pg_current_xact_id()::text=$12 RETURNING persona_id`,
    [b.environment,b.persona_id,a.controller_principal_id,a.privacy_generation,a.updated_at_ms,a.controller_privacy_epoch,
     b.privacy_generation,b.original_principal_id,b.original_key_id,b.guest_credential_digest,b.guest_credential_expires_at_ms,p.id]);
   if(changed.rows.length!==1)deferred();
  }
  p.phase='applied';
 });}
 async function persistAfterAuth(tx,handle){return safe(async()=>{
  const p=await owned(tx,handle,'applied');p.phase='persisting';
  // Spotify persistence precedes this last outbox phase. No earlier locks here.
  for(const negative of p.negative){const {jobID}=await lifecycle.persistSourceClosure(tx,negative);
   const hint=await first(tx,`SELECT environment,job_id,payload::text AS payload,state FROM listening_v2.outbox WHERE environment=$1 AND job_id=$2`,[coordinator,jobID]);
   if(!hint||hint.state==='published')unavailable();p.hints.push(hint);}
  p.phase='persisted';
 });}
 async function verifyPostimage(tx,handle){
  const p=plans.get(handle);if(p)plans.delete(handle); // Consume before any await, even failed final SQL.
  return safe(async()=>{
   if(!p||p.tx!==tx||p.query!==tx?.query||p.phase!=='persisted'||await transactionID(tx)!==p.id)unavailable();
   await dormant(tx,p);
   for(const {after:a} of p.transfers){const r=await first(tx,
    `SELECT ${columns} FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2`,[a.environment,a.persona_id]);
    if(!r||!same(decode(r).tuple,a.tuple))unavailable();}
   if(p.kind==='signIn'){
    const target=await currentUser(tx,p.targetID);if(target.disabled||target.access_kind!=='apple'||target.sessions_privacy_epoch!==p.target.sessions_privacy_epoch)unavailable();
    if((await tx.query(transferSQL,[p.u.id,p.scope.keyID])).rows.length)deferred();
   }
   if(p.kind==='rotation')await noLiveDigest(tx,p.newDigest);
   for(const old of p.hints){const now=await first(tx,`SELECT environment,job_id,payload::text AS payload,state FROM listening_v2.outbox
    WHERE environment=$1 AND job_id=$2`,[old.environment,old.job_id]);if(!now||!same(now,old))unavailable();}
   if(await transactionID(tx)!==p.id)unavailable();
   // Carry the canonical retained privacy cutoff into the SAME last clock
   // statement as exact S/C/C2. An earlier privacy sample cannot close this gap.
   return p.transfers.length?Math.min(...p.transfers.map(t=>t.before.guest_credential_expires_at_ms)):undefined;
  });
 }
 return Object.freeze({
  prepareSignIn:(tx,scope,targetID)=>safe(()=>{const s=actor(scope);return capture(tx,'signIn',{ownerID:s.principalID,scope:s,targetID});}),
  prepareSignOut:(tx,scope)=>safe(()=>{const s=actor(scope);return capture(tx,'signOut',{ownerID:s.principalID,scope:s});}),
  prepareDelete:(tx,scope)=>safe(()=>{const s=actor(scope);return capture(tx,'delete',{ownerID:s.principalID,scope:s});}),
  prepareDisableUser:(tx,ownerID)=>safe(()=>capture(tx,'disable',{ownerID})),
  prepareRevokeKey:(tx,keyID,ownerID)=>safe(()=>capture(tx,'key',{ownerID,keyID})),
  prepareRotation:(tx,ownerID,newDigest)=>safe(()=>capture(tx,'rotation',{ownerID,newDigest})),
  applyBeforeAuth,persistAfterAuth,verifyPostimage
 });
}
