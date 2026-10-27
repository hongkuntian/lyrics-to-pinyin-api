import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {isProxy} from 'node:util/types';
import {SessionV2Error,transactionRetrySignal} from './errors.js';
import {restoreAdmissionState} from './admission.js';
import {decodePersonaTuple,decodePrivacyDependency,decodePrivacyScrub,decodePrivacyUInt,
 privacyScrubMarker,PRIVACY_CODEC_FIELDS} from './privacy-codec.js';

const DAY=86400000,MAX=9007199254740991,LEASE=30000,AUTH_CAP=64;
const fail=()=>{throw new SessionV2Error('unavailable');};
const uint=decodePrivacyUInt;
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
const digest=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const json=JSON.stringify;
// Internal SQL snapshots only. JSONB object key order is not identity.
const canonical=x=>Array.isArray(x)?'['+x.map(canonical).join(',')+']':x&&typeof x==='object'?
 '{'+Object.keys(x).sort().map(k=>json(k)+':'+canonical(x[k])).join(',')+'}':json(x);
const equal=(a,b)=>canonical(a)===canonical(b);
const sorted=xs=>[...new Set(xs)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
function closed(x,fields){
 if(!x||typeof x!=='object'||isProxy(x)||![Object.prototype,null].includes(Object.getPrototypeOf(x)))fail();
 const keys=Reflect.ownKeys(x);
 if(keys.length!==fields.length||fields.some(k=>!Object.hasOwn(x,k)))fail();
 for(const k of keys){const d=Object.getOwnPropertyDescriptor(x,k);
  if(typeof k!=='string'||!fields.includes(k)||!d.enumerable||!Object.hasOwn(d,'value'))fail();}
}
function increment(n){n=uint(n);if(n===MAX)fail();return n+1;}
function plus(n,delta){n=uint(n);if(n>MAX-delta)fail();return n+delta;}
async function safe(work){try{return await work();}catch(error){const signal=transactionRetrySignal(error);if(signal)throw signal;fail();}}
const clock=async tx=>uint((await tx.query(`WITH lifecycle_clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
 SELECT floor(extract(epoch FROM at)*1000)::text AS now_ms FROM lifecycle_clock`)).rows[0].now_ms);
const xid=async tx=>(await tx.query('SELECT txid_current()::text AS xid')).rows[0].xid;
const personaColumns=PRIVACY_CODEC_FIELDS.personaTuple.join(',');
const numericPersona=new Set(['privacy_generation','guest_credential_expires_at_ms','withdrawn_at_ms','scrub_due_at_ms',
 'created_at_ms','updated_at_ms','controller_privacy_epoch','private_transfer_from_generation']);
function decodePersona(row){
 const tuple=PRIVACY_CODEC_FIELDS.personaTuple.map(k=>numericPersona.has(k)&&row[k]!==null?uint(row[k]):row[k]);
 return decodePersonaTuple(json(tuple));
}
const candidateSelect=`SELECT ${personaColumns} FROM listening_v2.privacy_personas`;
// Closed SQL choices. Values never name a table/column/predicate. Both first
// and successor statements retain the complete 031 index prefix and C order.
const selectors=Object.freeze({
 credential:{first:`${candidateSelect} WHERE guest_credential_digest COLLATE "C"=$1::text COLLATE "C"
 AND controller_kind='guest' AND status='live' ORDER BY environment COLLATE "C",persona_id LIMIT 100`,
 next:`${candidateSelect} WHERE guest_credential_digest COLLATE "C"=$1::text COLLATE "C"
 AND controller_kind='guest' AND status='live' AND (guest_credential_digest COLLATE "C",environment COLLATE "C",persona_id)>($1::text COLLATE "C",$2::text COLLATE "C",$3::uuid)
 ORDER BY environment COLLATE "C",persona_id LIMIT 100`},
 'guest-key':{first:`${candidateSelect} WHERE original_key_id COLLATE "C"=$1::text COLLATE "C"
 AND controller_kind='guest' AND status='live' ORDER BY environment COLLATE "C",persona_id LIMIT 100`,
 next:`${candidateSelect} WHERE original_key_id COLLATE "C"=$1::text COLLATE "C"
 AND controller_kind='guest' AND status='live' AND (original_key_id COLLATE "C",environment COLLATE "C",persona_id)>($1::text COLLATE "C",$2::text COLLATE "C",$3::uuid)
 ORDER BY environment COLLATE "C",persona_id LIMIT 100`},
 'guest-user':{first:`${candidateSelect} WHERE original_principal_id COLLATE "C"=$1::text COLLATE "C"
 AND controller_kind='guest' AND status='live' ORDER BY environment COLLATE "C",persona_id LIMIT 100`,
 next:`${candidateSelect} WHERE original_principal_id COLLATE "C"=$1::text COLLATE "C"
 AND controller_kind='guest' AND status='live' AND (original_principal_id COLLATE "C",environment COLLATE "C",persona_id)>($1::text COLLATE "C",$2::text COLLATE "C",$3::uuid)
 ORDER BY environment COLLATE "C",persona_id LIMIT 100`},
 'apple-controller':{first:`${candidateSelect} WHERE controller_principal_id COLLATE "C"=$1::text COLLATE "C"
 AND controller_kind='apple' AND status='live' ORDER BY environment COLLATE "C",persona_id LIMIT 100`,
 next:`${candidateSelect} WHERE controller_principal_id COLLATE "C"=$1::text COLLATE "C"
 AND controller_kind='apple' AND status='live' AND (controller_principal_id COLLATE "C",environment COLLATE "C",persona_id)>($1::text COLLATE "C",$2::text COLLATE "C",$3::uuid)
 ORDER BY environment COLLATE "C",persona_id LIMIT 100`},
 'indexed-sweep':{first:`${candidateSelect} WHERE controller_kind='guest' AND status='live'
 ORDER BY environment COLLATE "C",persona_id LIMIT 100`,
 next:`${candidateSelect} WHERE controller_kind='guest' AND status='live'
 AND (environment COLLATE "C",persona_id)>($1::text COLLATE "C",$2::uuid)
 ORDER BY environment COLLATE "C",persona_id LIMIT 100`}
});
const userSQL=`SELECT id,access_kind,disabled,sessions_privacy_epoch::text AS sessions_privacy_epoch FROM public.library_users`;
const tokenSQL=`SELECT digest,user_id,revoked,CASE WHEN expires_at IS NULL THEN NULL
 ELSE floor(extract(epoch FROM expires_at)*1000)::text END AS expires_ms FROM public.library_tokens`;
const keySQL=`SELECT key_id,user_id,revoked FROM public.app_attest_keys`;
async function source(tx,selector){
 switch(selector.kind){
 case 'credential':return (await tx.query(`${tokenSQL} WHERE digest=$1`,[selector.value])).rows[0]??null;
 case 'guest-key':return (await tx.query(`${keySQL} WHERE key_id=$1`,[selector.value])).rows[0]??null;
 case 'guest-user':case 'apple-controller':return (await tx.query(`${userSQL} WHERE id=$1`,[selector.value])).rows[0]??null;
 case 'indexed-sweep':return null;
 default:fail();
 }
}
async function candidates(tx,p,first=false){
 const sweep=p.selector.kind==='indexed-sweep',cursor=first?null:p.cursor;
 return (await tx.query(selectors[p.selector.kind][cursor?'next':'first'],[
 ...(!sweep?[p.selector.value]:[]),...(cursor??[])])).rows.map(decodePersona);
}
const outboxSQL=`SELECT *,payload::text AS raw_payload FROM listening_v2.outbox`;

/** Trusted INTERNAL coordinator only. Construction performs no IO. Root owns
 * actual writer authority and preheld complete earlier locks at producer seams.
 * No returned object is a public request handler, positive permit or scheduler.
 */
export function createPrivacyLifecycle(options){
 closed(options,['db','coordinatorEnvironment']);
 const database=options.db,coordinator=options.coordinatorEnvironment;
 if(typeof coordinator!=='string')fail();
 if(!database||isProxy(database)||typeof database.query!=='function'||typeof database.transaction!=='function')fail();
 // Validate even the configured namespace with the completed closed codec.
 decodePrivacyDependency(json({version:2,environment:coordinator,selector:{kind:'indexed-sweep'},cursor:null,invalidatedAtMS:null}));
 const transaction=database.transaction.bind(database),plans=new WeakMap(),claims=new WeakMap();
 const envelope=(selector,time,cursor=null)=>decodePrivacyDependency(json({version:2,environment:coordinator,selector,cursor,invalidatedAtMS:time})).payload;
 function dependencyRow(row){
  if(!row||row.kind!=='privacy_dependency'||row.environment!==coordinator||!uuid(row.job_id)||
   row.job_key!==`privacy-dependency:${row.job_id}`||['room_id','guard_id','persona_id','asset_id','privacy_generation','guard_revision','send_ordinal'].some(k=>row[k]!==null))fail();
  const p=decodePrivacyDependency(row.raw_payload??json(row.payload)).payload;
  if(p.environment!==coordinator||p.invalidatedAtMS!==null&&p.invalidatedAtMS>uint(row.created_at_ms))fail();
  checkEnvelope(row);return p;
 }
 function scrubRow(row){
  if(!row||row.kind!=='privacy_scrub'||!uuid(row.job_id)||row.job_key!==`privacy-scrub:${row.job_id}`||
   ['room_id','guard_id','asset_id','guard_revision','send_ordinal'].some(k=>row[k]!==null))fail();
  const p=decodePrivacyScrub(row.raw_payload??json(row.payload)).payload;
  if(p.environment!==row.environment||p.personaID!==row.persona_id||p.privacyGeneration!==uint(row.privacy_generation))fail();
  checkEnvelope(row);return p;
 }
 function checkEnvelope(row){
  const created=uint(row.created_at_ms),due=uint(row.due_at_ms),retry=uint(row.retry_until_ms);
  if(due<created||retry<due||retry-created>DAY||!Number.isInteger(row.attempt_count)||row.attempt_count<0||row.attempt_count>10)fail();
  uint(row.claim_epoch);
 }
 async function active(tx,selector){
  const rows=(await tx.query(`${outboxSQL} WHERE environment=$1 AND kind='privacy_dependency'
   AND state<>'published' AND payload->'selector'=$2::jsonb`,[coordinator,json(selector)])).rows;
  if(rows.length!==1)fail();const p=dependencyRow(rows[0]);if(!equal(p.selector,selector))fail();return rows[0];
 }
 async function prepare(tx,selector,mode){
  if(typeof selector.value!=='string')fail();
  const canonical=envelope(selector,0).selector;
  const before=await source(tx,canonical);if(!before)fail();
  // This is a producer preimage, never a generic "negative" flag. The caller
  // already holds real source anchors; no lower-lock auth pass is added here.
  if(mode==='expiry'){
   if(before.revoked!==false||before.expires_ms===null)fail();
  }else if(canonical.kind==='credential'||canonical.kind==='guest-key'){
   if(before.revoked!==false)fail();
  }else if(before.disabled!==false||before.access_kind!==(canonical.kind==='guest-user'?'guest':'apple'))fail();
  const transactionID=await xid(tx),sample=await clock(tx);
  let at=sample;
  if(canonical.kind==='credential'&&before.expires_ms!==null)at=Math.min(at,uint(before.expires_ms));
  if(mode==='expiry'&&uint(before.expires_ms)>sample)fail();
  const handle=Object.freeze(Object.create(null));
  plans.set(handle,{tx,xid:transactionID,selector:canonical,before:freeze(structuredClone(before)),mode,at});
  return handle;
 }
 async function verifyPlan(tx,handle){
  const p=plans.get(handle);if(!p||p.tx!==tx||p.xid!==await xid(tx))fail();
  const after=await source(tx,p.selector),b=p.before;
  let negative=false;
  switch(p.selector.kind){
  case 'credential':
   negative=p.mode==='expiry'?after&&equal(after,b)&&uint(after.expires_ms)<=await clock(tx):
    after&&after.digest===b.digest&&after.user_id===b.user_id&&after.revoked===true&&after.expires_ms===b.expires_ms;
   break;
  case 'guest-key':negative=after&&after.key_id===b.key_id&&(after.revoked===true||after.user_id!==b.user_id);break;
  case 'guest-user':negative=after&&after.id===b.id&&after.disabled===true&&after.access_kind===b.access_kind;break;
  case 'apple-controller':negative=after&&after.id===b.id&&after.access_kind==='apple'&&
   (p.mode==='epoch'?after.disabled===b.disabled&&uint(after.sessions_privacy_epoch)===increment(b.sessions_privacy_epoch):
    after.disabled===true&&after.sessions_privacy_epoch===b.sessions_privacy_epoch);break;
  default:fail();
  }
  if(!negative)fail();
  return p;
 }
 async function insertDependency(tx,selector,time,{created=null,cursor=null,retry=null}={}){
  const at=created??await clock(tx),payload=envelope(selector,time,cursor),jobID=randomUUID();
  if(time!==null&&time>at)fail();
  const until=retry??plus(at,DAY);
  const added=(await tx.query(`INSERT INTO listening_v2.outbox
   (environment,job_id,job_key,kind,payload,created_at_ms,due_at_ms,retry_until_ms)
   VALUES($1,$2,$3,'privacy_dependency',$4::jsonb,$5,$5,$6) ON CONFLICT DO NOTHING RETURNING job_id`,
   [coordinator,jobID,`privacy-dependency:${jobID}`,json(payload),at,until])).rows;
  if(added.length===1)return jobID;
  const existing=await active(tx,selector),stored=dependencyRow(existing);
  if(time!==null&&(stored.invalidatedAtMS===null||stored.invalidatedAtMS>time))fail();
  return existing.job_id;
 }
 async function persistSourceClosure(tx,handle){return safe(async()=>{
  try{const p=await verifyPlan(tx,handle),jobID=await insertDependency(tx,p.selector,p.at);
   return freeze({jobID});}finally{plans.delete(handle);}
 });}
 async function repairSourceClosure(tx,handle){return safe(async()=>{
  try{const p=await verifyPlan(tx,handle),observed=await active(tx,p.selector),old=dependencyRow(observed);
  if(!['pending','dead'].includes(observed.state))fail();
  // Exact last-position CAS, NOT claim stealing. Earlier evidence alone resets
  // progress. Original creation/retry/attempt/dead metadata remain untouched.
  const changed=(await tx.query(`UPDATE listening_v2.outbox SET
   payload=jsonb_set(jsonb_set(payload,'{invalidatedAtMS}',to_jsonb(LEAST((payload->>'invalidatedAtMS')::bigint,$6::bigint))),
    '{cursor}',CASE WHEN $6::bigint<(payload->>'invalidatedAtMS')::bigint THEN 'null'::jsonb ELSE payload->'cursor' END)
   WHERE environment=$1 AND job_id=$2 AND kind='privacy_dependency' AND payload=$3::jsonb
    AND state=$4 AND claim_epoch=$5 AND state IN ('pending','dead')
    AND claim_nonce_hash IS NULL AND claim_until_ms IS NULL RETURNING job_id`,
   [coordinator,observed.job_id,json(old),observed.state,uint(observed.claim_epoch),p.at])).rows;
  if(changed.length!==1)fail();return freeze({jobID:observed.job_id});}finally{plans.delete(handle);}
 });}
 async function ensureSweep(){return safe(()=>transaction(async tx=>{
  return freeze({jobID:await insertDependency(tx,{kind:'indexed-sweep'},null)});
 }));}
 function claimValue(handle,kind){const c=claims.get(handle);if(!c||c.kind!==kind)fail();return c;}
 async function claim(kind){return safe(()=>transaction(async tx=>{
  const at=await clock(tx);
  const rows=(await tx.query(`${outboxSQL} WHERE kind=$1 ${kind==='privacy_dependency'?'AND environment=$3':''}
   AND ((state='pending' AND due_at_ms<=$2) OR (state='claimed' AND claim_until_ms<=$2))
   ORDER BY due_at_ms,environment COLLATE "C",job_id LIMIT 1 FOR UPDATE SKIP LOCKED`,
   kind==='privacy_dependency'?[kind,at,coordinator]:[kind,at])).rows;
  if(!rows.length)return null;const observed=rows[0];
  const payload=kind==='privacy_dependency'?dependencyRow(observed):scrubRow(observed);
  if(observed.attempt_count>=10||uint(observed.retry_until_ms)<=at){
   await tx.query(`UPDATE listening_v2.outbox SET state='dead',claim_nonce_hash=NULL,claim_until_ms=NULL,
    completed_at_ms=$3,delete_after_ms=$4 WHERE environment=$1 AND job_id=$2 AND payload=$5::jsonb
    AND state=$6 AND claim_epoch=$7 RETURNING job_id`,[observed.environment,observed.job_id,at,plus(at,DAY),json(payload),observed.state,uint(observed.claim_epoch)]);
   return null; // Durable debt kept. This module has no DELETE path.
  }
  const nonce=createHash('sha256').update(randomBytes(32)).digest('hex'),epoch=increment(observed.claim_epoch);
  const until=Math.min(plus(at,LEASE),uint(observed.retry_until_ms));
  const changed=(await tx.query(`UPDATE listening_v2.outbox SET state='claimed',attempt_count=attempt_count+1,
   claim_epoch=$3,claim_nonce_hash=$4,claim_until_ms=$5 WHERE environment=$1 AND job_id=$2
   AND payload=$6::jsonb AND state=$7 AND claim_epoch=$8 RETURNING *,payload::text AS raw_payload`,
   [observed.environment,observed.job_id,epoch,nonce,until,json(payload),observed.state,uint(observed.claim_epoch)])).rows[0];
  if(!changed)fail();const handle=Object.freeze(Object.create(null));
  claims.set(handle,freeze({kind,row:structuredClone(changed),payload,epoch,nonce}));return handle;
 }));}
 async function lockClaim(tx,c){
  const row=(await tx.query(`${outboxSQL} WHERE environment=$1 AND job_id=$2 FOR UPDATE`,[c.row.environment,c.row.job_id])).rows[0];
  const payload=c.kind==='privacy_dependency'?dependencyRow(row):scrubRow(row);
  if(row.state!=='claimed'||uint(row.claim_epoch)!==c.epoch||row.claim_nonce_hash!==c.nonce||
   !equal(payload,c.payload)||row.job_key!==c.row.job_key||String(row.created_at_ms)!==String(c.row.created_at_ms)||
   String(row.retry_until_ms)!==String(c.row.retry_until_ms)||row.attempt_count!==c.row.attempt_count)fail();
  const at=await clock(tx);if(at>=uint(row.claim_until_ms)||at>=uint(row.retry_until_ms))fail();return at;
 }
 async function advance(tx,c,payload,status,at){
  if(status!=='pending'&&status!=='published')fail();
  const completed=status==='published'?at:null,after=status==='published'?plus(at,DAY):null;
  const changed=(await tx.query(`UPDATE listening_v2.outbox SET payload=$3::jsonb,state=$4,claim_nonce_hash=NULL,claim_until_ms=NULL,
   due_at_ms=LEAST(retry_until_ms,GREATEST(created_at_ms,$5::bigint)),completed_at_ms=$6,delete_after_ms=$7
   WHERE environment=$1 AND job_id=$2 AND kind=$8 AND state='claimed' AND payload=$9::jsonb
   AND claim_epoch=$10 AND claim_nonce_hash=$11 RETURNING job_id`,
   [c.row.environment,c.row.job_id,json(payload),status,at,completed,after,c.kind,json(c.payload),c.epoch,c.nonce])).rows;
  if(changed.length!==1)fail();
 }
 async function retry(handle){return safe(async()=>{
  const c=claims.get(handle);if(!c)fail();
  const result=await transaction(async tx=>{
   const rows=(await tx.query(`${outboxSQL} WHERE environment=$1 AND job_id=$2 FOR UPDATE`,[c.row.environment,c.row.job_id])).rows;
   const r=rows[0],payload=c.kind==='privacy_dependency'?dependencyRow(r):scrubRow(r);
   if(r.state!=='claimed'||uint(r.claim_epoch)!==c.epoch||r.claim_nonce_hash!==c.nonce||!equal(payload,c.payload)||
    r.job_key!==c.row.job_key||String(r.created_at_ms)!==String(c.row.created_at_ms)||
    String(r.retry_until_ms)!==String(c.row.retry_until_ms)||r.attempt_count!==c.row.attempt_count)fail();
   const at=await clock(tx),dead=r.attempt_count>=10||at>=uint(r.retry_until_ms),due=Math.min(plus(at,1000),uint(r.retry_until_ms));
   const changed=(await tx.query(`UPDATE listening_v2.outbox SET state=$3,claim_nonce_hash=NULL,claim_until_ms=NULL,
    due_at_ms=$4,completed_at_ms=$5,delete_after_ms=$6 WHERE environment=$1 AND job_id=$2
    AND state='claimed' AND payload=$7::jsonb AND claim_epoch=$8 AND claim_nonce_hash=$9 AND kind=$10 AND job_key=$11 RETURNING job_id`,
    [r.environment,r.job_id,dead?'dead':'pending',Math.max(uint(r.created_at_ms),due),dead?at:null,dead?plus(at,DAY):null,json(c.payload),c.epoch,c.nonce,c.kind,c.row.job_key])).rows;
   if(changed.length!==1)fail();
   return freeze({status:dead?'dead':'pending'});
  });claims.delete(handle);return result;
 });}
 // Discovery is nonlocking and complete for the selected prefix. Token/key
 // current owners join original/controller users BEFORE any category locks.
 async function discoverScope(tx,people,selector){
  const tokens=sorted(people.filter(p=>p.controller_kind==='guest').map(p=>p.guest_credential_digest));
  const keys=sorted(people.filter(p=>p.controller_kind==='guest').map(p=>p.original_key_id));
  if(selector.kind==='credential')tokens.push(selector.value);
  if(selector.kind==='guest-key')keys.push(selector.value);
  const tokenIDs=sorted(tokens),keyIDs=sorted(keys);
  const tr=tokenIDs.length?(await tx.query(`${tokenSQL} WHERE digest=ANY($1::text[]) ORDER BY digest COLLATE "C"`,[tokenIDs])).rows:[];
  const kr=keyIDs.length?(await tx.query(`${keySQL} WHERE key_id=ANY($1::text[]) ORDER BY key_id COLLATE "C"`,[keyIDs])).rows:[];
  const users=sorted([...people.map(p=>p.controller_principal_id),...tr.map(t=>t.user_id),...kr.map(k=>k.user_id),
   ...(['guest-user','apple-controller'].includes(selector.kind)?[selector.value]:[])]);
  const ur=users.length?(await tx.query(`${userSQL} WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C"`,[users])).rows:[];
  return {users,tokenIDs,keyIDs,ur,tr,kr,over:users.length>AUTH_CAP||tokenIDs.length>AUTH_CAP||keyIDs.length>AUTH_CAP};
 }
 async function lockScope(tx,s){
  if(s.over)fail();
  // NO KEY UPDATE agrees with the writer/new-retention user serialization.
  const users=s.users.length?(await tx.query(`${userSQL} WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C" FOR NO KEY UPDATE`,[s.users])).rows:[];
  const tokens=s.tokenIDs.length?(await tx.query(`${tokenSQL} WHERE digest=ANY($1::text[]) ORDER BY digest COLLATE "C" FOR UPDATE`,[s.tokenIDs])).rows:[];
  const keys=s.keyIDs.length?(await tx.query(`${keySQL} WHERE key_id=ANY($1::text[]) ORDER BY key_id COLLATE "C" FOR UPDATE`,[s.keyIDs])).rows:[];
  if(!equal(users,s.ur)||!equal(tokens,s.tr)||!equal(keys,s.kr))fail();
  return {users:new Map(users.map(x=>[x.id,x])),tokens:new Map(tokens.map(x=>[x.digest,x])),keys:new Map(keys.map(x=>[x.key_id,x]))};
 }
 async function evidence(tx,selector,created){
  const rows=(await tx.query(`${outboxSQL} WHERE environment=$1 AND kind='privacy_dependency'
   AND payload->'selector'=$2::jsonb ORDER BY created_at_ms,job_id LIMIT 100`,[coordinator,json(selector)])).rows;
  // A full evidence page is ambiguous: do not silently discard older eras.
  if(rows.length===100)fail();
  const times=rows.map(r=>{const p=dependencyRow(r);if(p.invalidatedAtMS===null)return null;
   return p.invalidatedAtMS>=created?p.invalidatedAtMS:null;}).filter(t=>t!==null);
  if(!times.length)fail();return Math.min(...times);
 }
 async function invalidation(tx,p,auth,at,payload){
  const times=[],created=p.created_at_ms;
  const proof=async(kind,value)=>{
   if(payload.selector.kind===kind&&payload.selector.value===value){
    if(payload.invalidatedAtMS<created)fail();return payload.invalidatedAtMS;
   }
   return evidence(tx,{kind,value},created);
  };
  const u=auth.users.get(p.controller_principal_id);
  if(p.controller_kind==='apple'){
   if(!u||u.disabled!==false||u.access_kind!=='apple'||uint(u.sessions_privacy_epoch)!==p.controller_privacy_epoch)
    times.push(await proof('apple-controller',p.controller_principal_id));
  }else if(p.controller_kind==='guest'){
   const t=auth.tokens.get(p.guest_credential_digest),k=auth.keys.get(p.original_key_id);
   if(!u||u.disabled!==false||u.access_kind!=='guest')times.push(await proof('guest-user',p.original_principal_id));
   if(!k||k.revoked!==false||k.user_id!==p.original_principal_id)times.push(await proof('guest-key',p.original_key_id));
   if(at>=p.guest_credential_expires_at_ms)times.push(p.guest_credential_expires_at_ms);
   if(!t||t.revoked!==false||t.user_id!==p.original_principal_id||t.expires_ms===null||uint(t.expires_ms)!==p.guest_credential_expires_at_ms)
    times.push(await proof('credential',p.guest_credential_digest));
  }else fail();
  if(!times.length){if(payload.selector.kind!=='indexed-sweep')fail();return null;}
  const earliest=Math.min(...times);if(earliest<created||earliest>at)fail();return earliest;
 }
 async function scrubHandoff(tx,p,at,withdrawn){
  const generation=increment(p.privacy_generation),due=plus(withdrawn,DAY),jobID=randomUUID();
  const payload=decodePrivacyScrub(json({version:2,environment:p.environment,personaID:p.persona_id,
   privacyGeneration:generation,withdrawnAtMS:withdrawn,scrubDueAtMS:due,phase:'rooms',cursor:null})).payload;
  const marker=privacyScrubMarker(jobID,'rooms');
  const post={...p,privacy_generation:generation,status:'withdrawn',withdrawn_at_ms:withdrawn,scrub_due_at_ms:due,scrub_cursor:marker,updated_at_ms:Math.max(at,p.updated_at_ms)};
  decodePersonaTuple(json(PRIVACY_CODEC_FIELDS.personaTuple.map(k=>post[k])));
  const changed=(await tx.query(`UPDATE listening_v2.privacy_personas SET privacy_generation=$4,status='withdrawn',
   withdrawn_at_ms=$5,scrub_due_at_ms=$6,scrub_cursor=$7,updated_at_ms=$8
   WHERE environment=$1 AND persona_id=$2 AND privacy_generation=$3 AND status='live'
    AND controller_kind=$9 AND controller_principal_id=$10 AND controller_privacy_epoch=$11
    AND guest_credential_digest IS NOT DISTINCT FROM $12 AND guest_credential_expires_at_ms IS NOT DISTINCT FROM $13
   RETURNING persona_id`,[p.environment,p.persona_id,p.privacy_generation,generation,withdrawn,due,marker,post.updated_at_ms,
    p.controller_kind,p.controller_principal_id,p.controller_privacy_epoch,p.guest_credential_digest,p.guest_credential_expires_at_ms])).rows;
  if(changed.length!==1)fail();
  await tx.query(`INSERT INTO listening_v2.outbox(environment,job_id,job_key,kind,persona_id,privacy_generation,payload,
   created_at_ms,due_at_ms,retry_until_ms) VALUES($1,$2,$3,'privacy_scrub',$4,$5,$6::jsonb,$7,$7,$8)`,
   [p.environment,jobID,`privacy-scrub:${jobID}`,p.persona_id,generation,json(payload),at,Math.min(plus(at,DAY),Math.max(at,due))]);
 }
 async function processDependency(handle){return safe(async()=>{
  const c=claimValue(handle,'privacy_dependency');
  const outcome=await transaction(async tx=>{
   const found=await candidates(tx,c.payload),selected=[];let scope=await discoverScope(tx,[],c.payload.selector);
   for(const p of found){const proposed=await discoverScope(tx,[...selected,p],c.payload.selector);
    if(proposed.over)break;selected.push(p);scope=proposed;}
   if(found.length&&!selected.length||scope.over)fail();
   const auth=await lockScope(tx,scope);
   // Exact selector source anchors must exist even for an empty final range.
   // Missing/deleted source without a retained stable anchor is repair debt.
   if(c.payload.selector.kind!=='indexed-sweep'&&!await source(tx,c.payload.selector))fail();
   const locked=[];
   for(const p of selected){const r=(await tx.query(`${candidateSelect} WHERE environment=$1 AND persona_id=$2 FOR UPDATE`,[p.environment,p.persona_id])).rows[0];
    if(!r||!equal(decodePersona(r).tuple,p.tuple))fail();locked.push(p);}
   const at=await lockClaim(tx,c);let withdrawn=0;
   for(const p of locked){const invalidated=await invalidation(tx,p,auth,at,c.payload);
    if(invalidated!==null){await scrubHandoff(tx,p,at,invalidated);withdrawn++;}}
   let payload=c.payload,status='pending';
   if(locked.length){const last=locked.at(-1);payload=envelope(c.payload.selector,c.payload.invalidatedAtMS,[last.environment,last.persona_id]);}
   else {
    // Recheck the complete live range, including keys behind the old cursor,
    // under exactly the same source/new-retention anchors, with job last.
    const remaining=await candidates(tx,c.payload,true);
    if(remaining.length&&c.payload.selector.kind!=='indexed-sweep')payload=envelope(c.payload.selector,c.payload.invalidatedAtMS,null);
    else status='published'; // Sweep reached its end: next pass starts NULL.
   }
   const fresh=await clock(tx);if(fresh>=uint(c.row.claim_until_ms)||fresh>=uint(c.row.retry_until_ms))fail();
   await advance(tx,c,payload,status,fresh);
   return freeze({status,processed:locked.length,withdrawn});
  });claims.delete(handle);return outcome;
 });}
 async function replaceDeadDependency(jobID){return safe(async()=>{
  if(!uuid(jobID))fail();return transaction(async tx=>{
   const observed=(await tx.query(`${outboxSQL} WHERE environment=$1 AND job_id=$2`,[coordinator,jobID])).rows[0];
   const payload=dependencyRow(observed);if(observed.state!=='dead')fail();
   const scope=await discoverScope(tx,[],payload.selector);await lockScope(tx,scope);
   if(payload.selector.kind!=='indexed-sweep'&&!await source(tx,payload.selector))fail();
   const actual=(await tx.query(`${outboxSQL} WHERE environment=$1 AND job_id=$2 FOR UPDATE`,[coordinator,jobID])).rows[0];
   if(!actual||actual.state!=='dead'||!equal(dependencyRow(actual),payload)||String(actual.claim_epoch)!==String(observed.claim_epoch)||
    actual.job_key!==observed.job_key||String(actual.created_at_ms)!==String(observed.created_at_ms)||
    String(actual.retry_until_ms)!==String(observed.retry_until_ms)||actual.attempt_count!==observed.attempt_count)fail();
   const at=await clock(tx);if(at>=uint(actual.retry_until_ms))fail();
   const changed=(await tx.query(`UPDATE listening_v2.outbox SET state='published',completed_at_ms=$3,delete_after_ms=$4
    WHERE environment=$1 AND job_id=$2 AND state='dead' AND payload=$5::jsonb AND claim_epoch=$6 RETURNING job_id`,
    [coordinator,jobID,at,plus(at,DAY),json(payload),uint(observed.claim_epoch)])).rows;
   if(changed.length!==1)fail();
   const next=randomUUID();
   // A successor must be this exact new row with the original envelope.
   // A conflict is rollback, never coalescing into a reset retry era.
   const inserted=(await tx.query(`INSERT INTO listening_v2.outbox
    (environment,job_id,job_key,kind,payload,created_at_ms,due_at_ms,retry_until_ms)
    VALUES($1,$2,$3,'privacy_dependency',$4::jsonb,$5,$6,$7) RETURNING job_id`,
    [coordinator,next,`privacy-dependency:${next}`,json(payload),uint(actual.created_at_ms),uint(actual.due_at_ms),uint(actual.retry_until_ms)])).rows;
   if(inserted.length!==1)fail();return freeze({jobID:next});
  });
 });}
 const phases=['rooms','grants-host','grants-guest','grants-approver','events','receipts','assets','complete'];
 const grantPhases=Object.freeze({
  'grants-host':{first:`SELECT * FROM listening_v2.returning_grants WHERE environment=$1 AND host_persona_id=$2 ORDER BY grant_id LIMIT 100`,
   next:`SELECT * FROM listening_v2.returning_grants WHERE environment=$1 AND host_persona_id=$2 AND (host_persona_id,grant_id)>($2::uuid,$3::uuid) ORDER BY grant_id LIMIT 100`,side:'host'},
  'grants-guest':{first:`SELECT * FROM listening_v2.returning_grants WHERE environment=$1 AND guest_persona_id=$2 ORDER BY grant_id LIMIT 100`,
   next:`SELECT * FROM listening_v2.returning_grants WHERE environment=$1 AND guest_persona_id=$2 AND (guest_persona_id,grant_id)>($2::uuid,$3::uuid) ORDER BY grant_id LIMIT 100`,side:'guest'},
  'grants-approver':{first:`SELECT * FROM listening_v2.returning_grants WHERE environment=$1 AND approver_persona_id=$2 ORDER BY grant_id LIMIT 100`,
   next:`SELECT * FROM listening_v2.returning_grants WHERE environment=$1 AND approver_persona_id=$2 AND (approver_persona_id,grant_id)>($2::uuid,$3::uuid) ORDER BY grant_id LIMIT 100`,side:'approver'}
 });
 function covered(p,g){return uint(g)===p.privacy_generation-1||p.private_transfer_from_generation!==null&&uint(g)===p.private_transfer_from_generation;}
 async function phaseRows(tx,payload,p){
  const {environment:env,personaID:pid,phase,cursor}=payload;
  if(phase==='rooms')return {rows:(await tx.query(`SELECT *,octet_length(state::text) AS state_bytes FROM listening_v2.rooms
   WHERE environment=$1 AND ARRAY[environment::text] @> ARRAY[$1::text] AND privacy_persona_ids @> ARRAY[$2::uuid]
   ${cursor?'AND session_id>$3::uuid':''} ORDER BY session_id LIMIT 1`,[env,pid,...(cursor?[cursor]:[])])).rows};
  if(Object.hasOwn(grantPhases,phase))return {rows:(await tx.query(grantPhases[phase][cursor?'next':'first'],[env,pid,...(cursor?[cursor]:[])])).rows};
  if(phase==='events')return {rows:(await tx.query(`SELECT * FROM listening_v2.semantic_events
   WHERE environment=$1 AND actor_persona_id=$2 ${cursor?'AND (actor_persona_id,session_id,seq)>($2::uuid,$3::uuid,$4::integer)':''}
   ORDER BY session_id,seq LIMIT 100`,[env,pid,...(cursor??[])])).rows};
  if(phase==='receipts')return {rows:(await tx.query(`SELECT * FROM listening_v2.command_receipts
   WHERE environment=$1 AND actor_persona_id=$2 ${cursor?'AND (actor_persona_id,session_id,principal_binding COLLATE "C",key_binding COLLATE "C",command_id)>($2::uuid,$3::uuid,$4::text COLLATE "C",$5::text COLLATE "C",$6::uuid)':''}
   ORDER BY session_id,principal_binding COLLATE "C",key_binding COLLATE "C",command_id LIMIT 100`,[env,pid,...(cursor??[])])).rows};
  if(phase==='assets'){
   // Old retained generations must be migrated into the terminal-generation
   // index before its typed cursor can seek. Each consumed row leaves this
   // catch-up predicate; this is not restart-at-first100 without progress.
   const generations=[...new Set([p.privacy_generation-1,p.private_transfer_from_generation].filter(x=>x!==null))].sort((a,b)=>a-b);
   const rows=[];
   for(const generation of generations){if(rows.length===100)break;
    rows.push(...(await tx.query(`SELECT * FROM listening_v2.private_profile_assets
     WHERE environment=$1 AND persona_id=$2 AND privacy_generation=$3 ORDER BY asset_generation,asset_id LIMIT $4`,
     [env,pid,generation,100-rows.length])).rows);}
   if(rows.length)return {rows,migrating:true};
   return {rows:(await tx.query(`SELECT * FROM listening_v2.private_profile_assets
    WHERE environment=$1 AND persona_id=$2 AND privacy_generation=$3
    ${cursor?'AND (persona_id,privacy_generation,asset_generation,asset_id)>($2::uuid,$3::bigint,$4::bigint,$5::uuid)':''}
    ORDER BY asset_generation,asset_id LIMIT 100`,[env,pid,payload.privacyGeneration,...(cursor?[cursor[2],cursor[3]]:[])])).rows,migrating:false};
  }
  if(phase==='complete')return {rows:[]};
  fail();
 }
 async function lockPhaseRows(tx,payload,observed){
  const env=payload.environment,phase=payload.phase,rows=observed.rows;
  // Rooms precede event/receipt locks, even though actor redaction takes no
  // positive authority over the other participants or source credentials.
  const roomIDs=sorted(phase==='rooms'?rows.map(r=>r.session_id):['events','receipts'].includes(phase)?rows.filter(r=>phase==='events'||r.room_id!==null).map(r=>r.session_id):[]);
  const lockedRooms=new Map();
  for(const roomID of roomIDs){const r=(await tx.query(`SELECT *,octet_length(state::text) AS state_bytes FROM listening_v2.rooms
   WHERE environment=$1 AND session_id=$2 FOR UPDATE`,[env,roomID])).rows[0];if(!r)fail();lockedRooms.set(roomID,r);}
  if(phase==='rooms'){
   for(const row of rows)if(!equal(lockedRooms.get(row.session_id),row))fail();return rows;
  }
  const order=Object.hasOwn(grantPhases,phase)?[...rows].sort((a,b)=>Buffer.compare(Buffer.from(a.host_install_scope),Buffer.from(b.host_install_scope))||Buffer.compare(Buffer.from(a.grant_id),Buffer.from(b.grant_id))):rows;
  for(const row of order){let query,args;
   if(Object.hasOwn(grantPhases,phase)){query='SELECT * FROM listening_v2.returning_grants WHERE environment=$1 AND grant_id=$2 FOR UPDATE';args=[env,row.grant_id];}
   else if(phase==='events'){query='SELECT * FROM listening_v2.semantic_events WHERE environment=$1 AND session_id=$2 AND seq=$3 FOR UPDATE';args=[env,row.session_id,row.seq];}
   else if(phase==='receipts'){query=`SELECT * FROM listening_v2.command_receipts WHERE environment=$1 AND session_id=$2
    AND principal_binding=$3 AND key_binding=$4 AND command_id=$5 FOR UPDATE`;args=[env,row.session_id,row.principal_binding,row.key_binding,row.command_id];}
   else if(phase==='assets'){query='SELECT * FROM listening_v2.private_profile_assets WHERE environment=$1 AND asset_id=$2 FOR UPDATE';args=[env,row.asset_id];}
   else fail();
   const actual=(await tx.query(query,args)).rows[0];if(!actual||!equal(actual,row))fail();
  }
  return rows;
 }
 function checkScrubPersona(p,payload,jobID){
  if(p.environment!==payload.environment||p.persona_id!==payload.personaID||p.status!=='withdrawn'||
   p.privacy_generation!==payload.privacyGeneration||p.withdrawn_at_ms!==payload.withdrawnAtMS||p.scrub_due_at_ms!==payload.scrubDueAtMS||
   p.scrub_cursor!==privacyScrubMarker(jobID,payload.phase))fail();
 }
 function admissionProjection(raw,room,p){
  let s;
  if(raw.privacyRedaction===undefined)s=structuredClone(restoreAdmissionState(json(raw)));
  else {
   // A separate NEGATIVE representation. Never pass it as a hydrated positive
   // admission state. Root must explicitly consume this closed postimage.
   closed(raw,['version','environment','sessionID','status','createdAtMS','updatedAtMS','expiresAtMS','inviteGeneration',
    'originalHost','settings','stateVersion','membershipRevision','lifetimeRequestCount','lifetimeMemberCount','members','pending','privacyRedaction']);
   if(raw.privacyRedaction!==2||raw.version!==2||!Array.isArray(raw.members)||raw.members.length>25||!Array.isArray(raw.pending)||raw.pending.length>10)fail();
   s=structuredClone(raw);
   for(const m of s.members){closed(m,['id','install','persona','profileReference','profileRevision','roomConsentRevision','status','leaseVersion','firstJoinOrdinal','joinedAtMS','endedAtMS']);
    if(!uuid(m.id)||!['active','left','removed','ended'].includes(m.status))fail();
    if(m.persona===null){
     if(m.install!==null||m.profileReference!==null||m.profileRevision!==null||m.roomConsentRevision!==null||m.status==='active'||
      !Number.isSafeInteger(m.endedAtMS)||m.endedAtMS<m.joinedAtMS||m.endedAtMS>s.updatedAtMS)fail();
    }
    else {closed(m.persona,['id','generation']);if(!uuid(m.persona.id))fail();uint(m.persona.generation);}
   }
   for(const r of s.pending){if(!r.persona||!uuid(r.persona.id))fail();}
   closed(s.originalHost,['install','persona','memberID','scope']);
   const witness=structuredClone(s);delete witness.privacyRedaction;
   for(const m of witness.members)if(m.persona===null){
    m.install={principalID:'redacted:'+m.id,keyID:'redacted-key:'+m.id,bundleID:'redacted',audience:'redacted',attestEnvironment:'development'};
    m.persona={id:m.id,generation:0};m.profileReference='redacted';m.profileRevision=0;m.roomConsentRevision=1;
   }
   if(s.originalHost.persona===null){
    if(s.originalHost.install!==null||!s.members.length||s.members[0].persona!==null||s.members[0].status!=='ended'||s.status!=='ended')fail();
    if(s.settings.title!=='')fail();witness.settings.title='Private session';
    witness.originalHost.install=structuredClone(witness.members[0].install);witness.originalHost.persona=structuredClone(witness.members[0].persona);
    witness.members[0].status='active';witness.members[0].endedAtMS=null;
   }else if(s.members[0]?.status==='ended')fail();
   restoreAdmissionState(json(witness));
  }
  if(s.environment!==room.environment||s.sessionID!==room.session_id||s.status!==room.status||s.originalHost.scope!==room.host_install_scope||
   uint(s.inviteGeneration)!==uint(room.invite_generation)||uint(s.settings.revision)!==uint(room.settings_revision))fail();
  for(const item of [...s.members,...s.pending])if(item.persona?.id===p.persona_id&&!covered(p,item.persona.generation))fail();
  const host=s.originalHost.persona?.id===p.persona_id;
  if(host&&!covered(p,s.originalHost.persona.generation))fail();
  const redact=m=>{
   m.install=null;m.persona=null;m.profileReference=null;m.profileRevision=null;m.roomConsentRevision=null;
   if(m.status==='active'){m.status=host&&m.id===s.originalHost.memberID?'ended':'removed';m.leaseVersion=increment(m.leaseVersion);m.endedAtMS=Math.max(p.withdrawn_at_ms,m.joinedAtMS);}
  };
  for(const m of s.members)if(m.persona?.id===p.persona_id)redact(m);
  s.pending=s.pending.filter(r=>r.persona?.id!==p.persona_id);
  if(host){s.originalHost.install=null;s.originalHost.persona=null;s.settings.title='';s.settings.revision=increment(s.settings.revision);s.status='ended';
   // End closes every still-pending invitation. Do not carry those requests
   // into a new invite generation or relabel them as fresh authorization.
   // Lifetime counts and conservative persona indexes remain for independent
   // cleanup. No guest membership/removal or ordinary event credit is minted.
   s.pending=[];
  }
  s.privacyRedaction=2;s.stateVersion=increment(s.stateVersion);s.membershipRevision=increment(s.membershipRevision);
  return {state:s,host};
 }
 async function scrubRoom(tx,row,p,at){
  if(row.state_bytes>262144||row.state_bytes<0||!row.privacy_persona_ids.includes(p.persona_id))fail();
  const state=structuredClone(row.state);closed(state,state.admission===undefined?['occurrences','visits']:['occurrences','visits','admission','admissionStore']);
  // b88 has NO closed persisted nonempty occurrence/visit room encoding.
  // Do not recursively guess at recording/profile fields. Retain responsibility
  // until Root supplies its actual writer representation (precise objection).
  if(!Array.isArray(state.occurrences)||!Array.isArray(state.visits)||state.occurrences.length||state.visits.length)fail();
  let host=row.host_persona_id===p.persona_id;
  if(host&&!covered(p,row.host_privacy_generation))fail();
  if(state.admission!==undefined){
   closed(state.admissionStore,['version','miscCount','reservedEvents','reservedReceipts','storefront']);
   const meta=state.admissionStore;
   if(meta.version!==1||uint(meta.miscCount)>1000||uint(meta.reservedEvents)>uint(row.reserved_semantic_events)||
    uint(meta.reservedReceipts)>uint(row.reserved_receipts)||typeof meta.storefront!=='string'||!/^[a-zA-Z0-9-]{1,16}$/.test(meta.storefront))fail();
   const projected=admissionProjection(state.admission,row,p);if(projected.host!==host)fail();state.admission=projected.state;
  }
  const ending=host&&row.status==='active',endedAt=ending?Math.max(p.withdrawn_at_ms,uint(row.created_at_ms)):row.ended_at_ms===null?null:uint(row.ended_at_ms);
  const stateVersion=increment(row.state_version),sessionRevision=increment(row.session_revision),authority=ending?increment(row.authority_epoch):uint(row.authority_epoch);
  const invite=ending?increment(row.invite_generation):uint(row.invite_generation),share=ending?increment(row.share_generation):uint(row.share_generation);
  const eventSeq=ending?increment(row.event_seq):uint(row.event_seq);if(eventSeq>30001)fail();
  if(state.admission){state.admission.updatedAtMS=at;state.admission.inviteGeneration=invite;}
  // All room safety/lifetime credit counters, guard capsules and provider state
  // are untouched. End consumes its independent event lane, not semantic cap.
  const changed=(await tx.query(`UPDATE listening_v2.rooms SET state=$3::jsonb,privacy_persona_ids=array_remove(privacy_persona_ids,$4::uuid),
   host_persona_id=CASE WHEN $5 THEN NULL ELSE host_persona_id END,host_privacy_generation=CASE WHEN $5 THEN NULL ELSE host_privacy_generation END,
   status=CASE WHEN $6 THEN 'ended' ELSE status END,ended_at_ms=$7,
   event_delete_after_ms=CASE WHEN $6 THEN $8 ELSE event_delete_after_ms END,
   receipt_delete_after_ms=CASE WHEN $6 THEN $9 ELSE receipt_delete_after_ms END,
   state_version=$10,session_revision=$11,authority_epoch=$12,invite_generation=$13,share_generation=$14,
   transition_revision=CASE WHEN $6 THEN transition_revision+1 ELSE transition_revision END,
   settings_revision=$15,event_seq=$16,updated_at_ms=$17
   WHERE environment=$1 AND session_id=$2 AND state_version=$18 AND state=$19::jsonb RETURNING session_id`,
   [row.environment,row.session_id,json(state),p.persona_id,host,ending,endedAt,
    ending?plus(endedAt,DAY):row.event_delete_after_ms,ending?plus(endedAt,30*DAY):row.receipt_delete_after_ms,
    stateVersion,sessionRevision,authority,invite,share,state.admission?state.admission.settings.revision:uint(row.settings_revision),eventSeq,at,row.state_version,json(row.state)])).rows;
  if(changed.length!==1)fail();
  if(ending)await tx.query(`INSERT INTO listening_v2.semantic_events
   (environment,session_id,event_id,seq,lane,lane_seq,state_version,type,payload,server_at_ms,delete_after_ms)
   VALUES($1,$2,$3,$4,'end',1,$5,'session.ended',$6::jsonb,$7,$8)`,
   [row.environment,row.session_id,randomUUID(),eventSeq,stateVersion,json({reason:'privacy_withdrawn'}),at,plus(at,DAY)]);
  // Check the actual SQL normalized postimage, not an estimated JS encoding.
  const size=(await tx.query('SELECT octet_length(state::text) AS bytes FROM listening_v2.rooms WHERE environment=$1 AND session_id=$2',[row.environment,row.session_id])).rows[0].bytes;
  if(size>262144)fail();
 }
 async function scrubGrant(tx,g,p,phase,at){
  const side=grantPhases[phase].side;
  if(g[side+'_persona_id']!==p.persona_id||!covered(p,g[side+'_privacy_generation']))fail();
  const gen=g.status==='active'?increment(g.grant_generation):uint(g.grant_generation),revoked=g.status==='active'?p.withdrawn_at_ms:uint(g.revoked_at_ms);
  // Only these three internal literals can select the side; no request column.
  const assignments={host:'host_persona_id=NULL,host_privacy_generation=NULL',guest:'guest_persona_id=NULL,guest_privacy_generation=NULL',approver:'approver_persona_id=NULL,approver_privacy_generation=NULL'};
  const changed=(await tx.query(`UPDATE listening_v2.returning_grants SET ${assignments[side]},status='revoked',
   grant_generation=$3,revoked_at_ms=$4,updated_at_ms=$5 WHERE environment=$1 AND grant_id=$2
   AND grant_generation=$6 AND ${side}_persona_id=$7 AND ${side}_privacy_generation=$8 RETURNING grant_id`,
   [g.environment,g.grant_id,gen,revoked,at,uint(g.grant_generation),p.persona_id,uint(g[side+'_privacy_generation'])])).rows;
  if(changed.length!==1)fail();
 }
 function eventPayload(e){
  const p=e.payload;
  switch(e.type){
  case 'session.created':case 'trust.forgotten':closed(p,[]);return {};
  case 'admission.requested':closed(p,['admissionID']);if(!uuid(p.admissionID))fail();return p;
  case 'member.joined':case 'member.left':closed(p,['memberID']);if(!uuid(p.memberID))fail();return p;
  case 'settings.changed':closed(p,['settingsRevision']);uint(p.settingsRevision);return p;
  case 'session.ended':closed(p,['reason']);if(!['privacy_withdrawn','host_ended','expired'].includes(p.reason))fail();return p;
  case 'admission.terminal':{
   const allowed=['version','status','pairDigest','memberID','memberLeaseVersion','decidedByMemberID'];
   if(!p||typeof p!=='object'||Object.keys(p).some(k=>!allowed.includes(k))||p.version!==2||
    !['admitted','denied','cancelled','expired'].includes(p.status)||!digest(p.pairDigest))fail();
   if(p.status==='admitted'){if(!uuid(p.memberID)||uint(p.memberLeaseVersion)<1)fail();}
   else if(p.memberID!==undefined||p.memberLeaseVersion!==undefined)fail();
   if(p.decidedByMemberID!==undefined&&!uuid(p.decidedByMemberID))fail();return p;
  }
  default:fail(); // Never erase guessed JSON for an unknown event contract.
  }
 }
 async function scrubEvent(tx,e,p){
  if(!covered(p,e.actor_privacy_generation))fail();const payload=eventPayload(e);
  const changed=(await tx.query(`UPDATE listening_v2.semantic_events SET actor_persona_id=NULL,actor_privacy_generation=NULL,payload=$4::jsonb
   WHERE environment=$1 AND session_id=$2 AND seq=$3 AND actor_persona_id=$5 AND actor_privacy_generation=$6 AND payload=$7::jsonb RETURNING seq`,
   [e.environment,e.session_id,e.seq,json(payload),p.persona_id,uint(e.actor_privacy_generation),json(e.payload)])).rows;
  if(changed.length!==1)fail();
 }
 const receiptActions=new Set(['create','restart','join','admission.request','admission.decide','admission.cancel','leave',
  'settings.update','remembered.forget','privacy.erase','end']);
 async function scrubReceipt(tx,r,p){
  if(!covered(p,r.actor_privacy_generation)||!receiptActions.has(r.action))fail();
  if(r.action==='privacy.erase'){
   if(r.actor_persona_id!==p.persona_id||r.actor_persona_id!==r.session_id||r.room_id!==null||r.status!=='accepted')fail();
   closed(r.result,['privacyGeneration']);
   if(typeof r.result.privacyGeneration!=='number'||!Number.isSafeInteger(r.result.privacyGeneration)||
    r.result.privacyGeneration!==increment(r.actor_privacy_generation))fail();
   const changed=(await tx.query(`UPDATE listening_v2.command_receipts SET actor_persona_id=NULL,actor_privacy_generation=NULL
    WHERE environment=$1 AND session_id=$2 AND principal_binding=$3 AND key_binding=$4 AND command_id=$5
    AND actor_persona_id=$6 AND actor_privacy_generation=$7 AND result=$8::jsonb RETURNING command_id`,
    [r.environment,r.session_id,r.principal_binding,r.key_binding,r.command_id,p.persona_id,uint(r.actor_privacy_generation),json(r.result)])).rows;
   if(changed.length!==1)fail();return;
  }
  const changed=(await tx.query(`UPDATE listening_v2.command_receipts SET actor_persona_id=NULL,actor_privacy_generation=NULL,
   result='{"version":2,"redacted":true}'::jsonb WHERE environment=$1 AND session_id=$2 AND principal_binding=$3 AND key_binding=$4
   AND command_id=$5 AND actor_persona_id=$6 AND actor_privacy_generation=$7 AND result=$8::jsonb RETURNING command_id`,
   [r.environment,r.session_id,r.principal_binding,r.key_binding,r.command_id,p.persona_id,uint(r.actor_privacy_generation),json(r.result)])).rows;
  if(changed.length!==1)fail();
 }
 async function scrubAsset(tx,a,p,at){
  if(uint(a.privacy_generation)!==p.privacy_generation&&!covered(p,a.privacy_generation))fail();
  let withdrawn,due,backup;
  if(a.state==='staged'||a.state==='current'){withdrawn=p.withdrawn_at_ms;due=p.scrub_due_at_ms;backup=plus(withdrawn,30*DAY);}
  else {withdrawn=uint(a.withdrawn_at_ms);due=uint(a.delete_due_at_ms);backup=uint(a.backup_delete_due_at_ms);
   if(withdrawn>p.withdrawn_at_ms||due>p.scrub_due_at_ms)fail();}
  const changed=(await tx.query(`UPDATE listening_v2.private_profile_assets SET privacy_generation=$3,
   state=CASE WHEN state IN ('staged','current') THEN 'revoked' ELSE state END,
   withdrawn_at_ms=$4,delete_due_at_ms=$5,backup_delete_due_at_ms=$6
   WHERE environment=$1 AND asset_id=$2 AND persona_id=$7 AND privacy_generation=$8 AND asset_generation=$9
   AND state=$10 AND object_key IS NOT DISTINCT FROM $11 RETURNING asset_id`,
   [a.environment,a.asset_id,p.privacy_generation,withdrawn,due,backup,p.persona_id,uint(a.privacy_generation),uint(a.asset_generation),a.state,a.object_key])).rows;
  if(changed.length!==1)fail();
  if(a.state!=='deleted'){
   const jobID=randomUUID(),jobKey=`privacy-asset:${a.asset_id}:${p.privacy_generation}`;
   const payload={version:2,environment:a.environment,personaID:p.persona_id,privacyGeneration:p.privacy_generation,
    assetID:a.asset_id,assetGeneration:uint(a.asset_generation),withdrawnAtMS:withdrawn,deleteDueAtMS:due,backupDeleteDueAtMS:backup};
   const added=(await tx.query(`INSERT INTO listening_v2.outbox(environment,job_id,job_key,kind,persona_id,asset_id,privacy_generation,
    payload,created_at_ms,due_at_ms,retry_until_ms) VALUES($1,$2,$3,'asset_delete',$4,$5,$6,$7::jsonb,$8,$8,$9)
    ON CONFLICT DO NOTHING RETURNING job_id`,[a.environment,jobID,jobKey,p.persona_id,a.asset_id,p.privacy_generation,json(payload),at,
     Math.min(plus(at,DAY),Math.max(at,due))])).rows;
   if(!added.length){const existing=(await tx.query(`${outboxSQL} WHERE environment=$1 AND job_key=$2`,[a.environment,jobKey])).rows[0];
    if(!existing||existing.kind!=='asset_delete'||existing.persona_id!==p.persona_id||existing.asset_id!==a.asset_id||
     uint(existing.privacy_generation)!==p.privacy_generation||!equal(existing.payload,payload))fail();}
  }
  // No object adapter, DELETE, object_key clearing, backup receipt or ACK-as-
  // completion exists here. Its original deadline responsibility stays durable.
 }
 function phaseCursor(phase,rows,payload){
  const last=rows.at(-1);
  if(phase==='rooms')return last.session_id;
  if(Object.hasOwn(grantPhases,phase))return last.grant_id;
  if(phase==='events')return [last.session_id,uint(last.seq)];
  if(phase==='receipts')return [last.session_id,last.principal_binding,last.key_binding,last.command_id];
  if(phase==='assets')return [payload.personaID,payload.privacyGeneration,uint(last.asset_generation),last.asset_id];
  fail();
 }
 async function processScrub(handle){return safe(async()=>{
  const c=claimValue(handle,'privacy_scrub');
  const outcome=await transaction(async tx=>{
   const payload=c.payload;
   const raw=(await tx.query(`${candidateSelect} WHERE environment=$1 AND persona_id=$2`,[payload.environment,payload.personaID])).rows[0];
   if(!raw)fail();const p=decodePersona(raw);checkScrubPersona(p,payload,c.row.job_id);
   const observed=await phaseRows(tx,payload,p);
   if(payload.phase==='rooms'?observed.rows.length>1:observed.rows.length>100)fail();
   const scope=await discoverScope(tx,[p],{kind:'indexed-sweep'});await lockScope(tx,scope);
   const current=(await tx.query(`${candidateSelect} WHERE environment=$1 AND persona_id=$2 FOR UPDATE`,[p.environment,p.persona_id])).rows[0];
   if(!current||!equal(decodePersona(current).tuple,p.tuple))fail();
   await lockPhaseRows(tx,payload,observed);
   const at=await lockClaim(tx,c);
   for(const r of observed.rows){
    switch(payload.phase){
    case 'rooms':await scrubRoom(tx,r,p,at);break;
    case 'grants-host':case 'grants-guest':case 'grants-approver':await scrubGrant(tx,r,p,payload.phase,at);break;
    case 'events':await scrubEvent(tx,r,p);break;
    case 'receipts':await scrubReceipt(tx,r,p);break;
    case 'assets':await scrubAsset(tx,r,p,at);break;
    default:fail();
    }
   }
   let next={...payload};
   if(observed.rows.length){
    next.cursor=observed.migrating?null:phaseCursor(payload.phase,observed.rows,payload);
   }else if(payload.phase!=='complete'){
    // Catch an earlier key written after a previous cursor. Actual writers are
    // separately required to deny all terminal-generation late attachment.
    const first=await phaseRows(tx,{...payload,cursor:null},p);
    if(first.rows.length&&(payload.phase!=='assets'||first.migrating))next.cursor=null;
    else {next.phase=phases[phases.indexOf(payload.phase)+1];next.cursor=null;}
   }
   next=decodePrivacyScrub(json(next)).payload;
   const marker=privacyScrubMarker(c.row.job_id,next.phase);
   const changed=(await tx.query(`UPDATE listening_v2.privacy_personas SET scrub_cursor=$6,updated_at_ms=$7
    WHERE environment=$1 AND persona_id=$2 AND privacy_generation=$3 AND status='withdrawn'
    AND withdrawn_at_ms=$4 AND scrub_due_at_ms=$5 AND scrub_cursor=$8 RETURNING persona_id`,
    [p.environment,p.persona_id,p.privacy_generation,p.withdrawn_at_ms,p.scrub_due_at_ms,marker,Math.max(at,p.updated_at_ms),p.scrub_cursor])).rows;
   if(changed.length!==1)fail();
   const fresh=await clock(tx);if(fresh>=uint(c.row.claim_until_ms)||fresh>=uint(c.row.retry_until_ms))fail();
   await advance(tx,c,next,'pending',fresh);
   // "complete" is a phase, NOT proof of object/backup adapter receipts. There
   // is deliberately no path to publish a privacy_scrub or erase the persona.
   return freeze({status:payload.phase==='complete'?'unavailable':'pending',processed:observed.rows.length,
    phase:next.phase,reason:next.phase==='complete'?'object_backup_qualification_required':null});
  });claims.delete(handle);return outcome;
 });}
 return Object.freeze({
  prepareCredentialClosure:(tx,value)=>safe(()=>prepare(tx,{kind:'credential',value},'closure')),
  prepareCredentialExpiry:(tx,value)=>safe(()=>prepare(tx,{kind:'credential',value},'expiry')),
  prepareGuestKeyClosure:(tx,value)=>safe(()=>prepare(tx,{kind:'guest-key',value},'closure')),
  prepareGuestUserClosure:(tx,value)=>safe(()=>prepare(tx,{kind:'guest-user',value},'closure')),
  prepareAppleControllerClosure:(tx,value)=>safe(()=>prepare(tx,{kind:'apple-controller',value},'closure')),
  prepareAppleEpochAdvance:(tx,value)=>safe(()=>prepare(tx,{kind:'apple-controller',value},'epoch')),
  persistSourceClosure,repairSourceClosure,ensureSweep,
  claimDependency:()=>claim('privacy_dependency'),claimScrub:()=>claim('privacy_scrub'),
  processDependency,processScrub,retry,replaceDeadDependency
 });
}
