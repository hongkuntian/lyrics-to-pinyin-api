import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {SongLibraryStore} from '../../api/utils/song-library/store.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {revokeSessions} from '../../api/utils/app-auth/admin.js';
import {createPrivatePersonaService} from '../../api/utils/listening-v2/private-persona-service.js';
import {createPrivacyLifecycle} from '../../api/utils/listening-v2/privacy-lifecycle.js';
import {decodePersonaTuple,decodePrivacyScrub,decodePrivacyUInt as uint,PRIVACY_CODEC_FIELDS,privacyScrubMarker} from '../../api/utils/listening-v2/privacy-codec.js';
import {migrationNames} from '../../scripts/library-migrations.js';

// SEALED BEFORE IMPLEMENTATION; NOT EXECUTED BY THIS SOURCE WORKER.
// Actual AppAuth challenge/register/session/authenticate, actual SQL/DDL/codec.
// Only attestation/assertion cryptography is an external-success fixture.
// One PGlite connection cannot prove multi-client blocking or wall-clock edges.
const env='test',coordinator='preview:persona-coordinator',DAY=86400000,MAX=9007199254740991;
const policy={audience:'persona-tests',environment:'development',prefix:'ABCDEFGHIJ',bundles:['test.lyrica']};
const bundleID=policy.bundles[0],key=n=>Buffer.alloc(32,n).toString('base64');
const hash=x=>createHash('sha256').update(x).digest('hex');
const binding={version:1,secret:Buffer.alloc(32,11)},ticket={id:'t1',secret:Buffer.alloc(32,12)};
let sql,db,library,auth,engine,service,actor,trace,intercept,boundaryAgeMS;
const one=async(q,args=[],tx=sql)=>(await tx.query(q,args)).rows[0];
const scalar=async(q,args=[],tx=sql)=>Object.values(await one(q,args,tx))[0];
const now=()=>scalar('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text').then(uint);
const count=t=>scalar('SELECT count(*)::int FROM listening_v2.'+t);
const persona=id=>one('SELECT * FROM listening_v2.privacy_personas WHERE environment=$1 AND persona_id=$2',[env,id]);
const reject=(p,code)=>assert.rejects(p,e=>e.code===code&&e.message===code&&!e.cause);
function options(environment=env){return {db,environment,coordinatorEnvironment:coordinator,policy,
 bindingKeys:[binding],activeBindingKeyVersion:1,ticketKeys:[ticket],activeTicketKeyID:ticket.id,
 receiptKeyPolicy:{environment,keys:[{version:1,verificationHash:createHmac('sha256',binding.secret)
 .update(JSON.stringify(['sessions-v2.receipt-key-check',1,environment])).digest('hex')}]}};}
const retainRaw=JSON.stringify({version:2,action:'privacy.retain',payload:{scope:'my_sessions_persona',confirmed:true}});
const retain=(s=service,a=actor)=>s.retain({bearer:a.bearer,rawIntent:retainRaw});
const command=(p,extra={})=>JSON.stringify({version:2,action:'privacy.erase',sessionID:p.id,commandID:randomUUID(),
 expected:{privacyGeneration:p.generation},payload:{scope:'my_sessions_persona',confirmed:true},...extra});
const erase=(raw,a=actor,s=service)=>s.erase({bearer:a.bearer,rawCommand:raw});
async function enroll(id='G',kind='guest',n=1){
 const token='credential-'+id;await library.createUser(id,token);
 await sql.query('UPDATE public.library_users SET access_kind=$2 WHERE id=$1',[id,kind]);
 await sql.query("UPDATE public.library_tokens SET expires_at=clock_timestamp()+interval '89 days' WHERE digest=$1",[hash(token)]);
 const k=key(n),challenge=await auth.challenge(token,{keyID:k,bundleID,purpose:'register'});
 await auth.register(token,{keyID:k,bundleID,challenge:challenge.challenge,attestation:'Zml4dHVyZQ=='});
 const a={id,kind,token,keyID:k,counter:0};await renew(a);
 const authenticated=await auth.authenticate(a.bearer);
 assert.deepEqual(authenticated,{id,keyID:k,bundleID,credentialDigest:hash(token)});return a;
}
async function renew(a){const c=await auth.challenge(a.token,{keyID:a.keyID,bundleID,purpose:'session'});
 a.bearer=(await auth.session(a.token,{keyID:a.keyID,bundleID,challenge:c.challenge,
 assertion:Buffer.from(String(++a.counter)).toString('base64')})).token;return a.bearer;}
async function state(){const result={};for(const t of ['privacy_personas','outbox','command_receipts','rooms','output_guards',
 'returning_grants','semantic_events','private_profile_assets'])
 result[t]=(await sql.query(`SELECT to_jsonb(t)::text AS row FROM listening_v2.${t} t ORDER BY to_jsonb(t)::text`)).rows;
 result.users=(await sql.query('SELECT id,disabled,sessions_privacy_epoch::text AS epoch FROM public.library_users ORDER BY id COLLATE "C"')).rows;
 result.tokens=(await sql.query('SELECT digest,revoked,expires_at::text FROM public.library_tokens ORDER BY digest')).rows;
 return result;}
async function closure(kind,a=actor){return db.transaction(async tx=>{
 await tx.query('SELECT id FROM public.library_users WHERE id=$1 FOR NO KEY UPDATE',[a.id]);
 await tx.query('SELECT digest FROM public.library_tokens WHERE digest=$1 FOR UPDATE',[hash(a.token)]);
 await tx.query('SELECT key_id FROM public.app_attest_keys WHERE key_id=$1 FOR UPDATE',[a.keyID]);
 const target=kind==='credential'?hash(a.token):kind==='guest-key'?a.keyID:a.id;
 const method={credential:'prepareCredentialClosure','guest-key':'prepareGuestKeyClosure',
 'guest-user':'prepareGuestUserClosure','apple-controller':'prepareAppleEpochAdvance'}[kind];
 const plan=await engine[method](tx,target);
 if(kind==='credential')await tx.query('UPDATE public.library_tokens SET revoked=true WHERE digest=$1',[target]);
 else if(kind==='guest-key')await tx.query('UPDATE public.app_attest_keys SET revoked=true WHERE key_id=$1',[target]);
 else if(kind==='guest-user')await tx.query('UPDATE public.library_users SET disabled=true WHERE id=$1',[target]);
 else await tx.query('UPDATE public.library_users SET sessions_privacy_epoch=sessions_privacy_epoch+1 WHERE id=$1',[target]);
 return engine.persistSourceClosure(tx,plan);
 });}
async function reactivate(kind,a=actor){
 // Credential case exercises the actual same-owner createUser. Key/user reset
 // models an operator reactivation boundary; it is NOT execution of Root hooks.
 if(kind==='credential')await library.createUser(a.id,a.token);
 else if(kind==='guest-key')await sql.query('UPDATE public.app_attest_keys SET revoked=false WHERE key_id=$1',[a.keyID]);
 else if(kind==='guest-user')await sql.query('UPDATE public.library_users SET disabled=false WHERE id=$1',[a.id]);
 if(kind!=='apple-controller')await renew(a);
}
async function process(){await sql.query("UPDATE listening_v2.outbox SET due_at_ms=created_at_ms WHERE state='pending'");
 const c=await engine.claimDependency();assert.ok(c);return engine.processDependency(c);}
function tuple(r){return PRIVACY_CODEC_FIELDS.personaTuple.map(k=>r[k]!==null&&[
 'privacy_generation','guest_credential_expires_at_ms','withdrawn_at_ms','scrub_due_at_ms','created_at_ms','updated_at_ms',
 'controller_privacy_epoch','private_transfer_from_generation'].includes(k)?uint(r[k]):r[k]);}
async function visible(p){return Number(await scalar(`WITH c AS MATERIALIZED (SELECT clock_timestamp() AS at)
 SELECT count(*)::int FROM listening_v2.privacy_personas p JOIN public.library_users u ON u.id=p.controller_principal_id
 LEFT JOIN public.library_tokens t ON t.digest=p.guest_credential_digest
 LEFT JOIN public.app_attest_keys k ON k.key_id=p.original_key_id CROSS JOIN c
 WHERE p.environment=$1 AND p.persona_id=$2 AND p.status='live' AND p.privacy_generation=$3 AND NOT u.disabled
 AND ((p.controller_kind='apple' AND u.access_kind='apple' AND p.controller_privacy_epoch=u.sessions_privacy_epoch)
 OR (p.controller_kind='guest' AND u.access_kind='guest' AND NOT k.revoked AND k.user_id=p.original_principal_id
 AND NOT t.revoked AND t.user_id=p.original_principal_id AND t.expires_at>c.at
 AND p.guest_credential_expires_at_ms>floor(extract(epoch FROM c.at)*1000)))`,[env,p.id,p.generation]));}
// visible() audits the canonical SQL predicate, not a claim that Root's other
// private/public read consumers have been wired or qualified.
before(async()=>{
 sql=new PGlite();
 // Actual migrations see the roles at creation time; no test-only grant repair.
 await sql.exec('CREATE ROLE lyra_runtime_v1; CREATE ROLE lyra_account_v1;');
 for(const name of migrationNames)await sql.exec(await readFile(new URL('../../db/'+name,import.meta.url),'utf8'));
 for(const name of ['030-listening-v2-schema.sql','031-listening-v2-lifecycle-support.sql','033-listening-v2-lifecycle-composition.sql'])
 await sql.exec(await readFile(new URL('../../db/'+name,import.meta.url),'utf8'));
 db={query:(...args)=>sql.query(...args),transaction:fn=>sql.transaction(async real=>fn({query:async(q,args=[])=>{
  trace.push({q,args:structuredClone(args)});
  if(intercept)await intercept('before',q,args,real);
  // Synthetic boundary-clock seam ONLY in exact-S freshness SQL. Derives its
  // sample from persisted S expiry; never a wall-clock precision receipt.
  let statement=q;
  if(boundaryAgeMS!==null&&q.includes(' AS fresh')&&q.includes("interval '15 minutes'"))
   statement=q.replaceAll('clock_timestamp()',`($9::timestamptz-interval '15 minutes'+interval '${boundaryAgeMS} milliseconds')`);
  const result=await real.query(statement,args);
  if(intercept)await intercept('after',q,args,real,result);return result;
 }}))};library=new SongLibraryStore(db);
 auth=new AppAuthStore(db,{policy,attestFn:()=>({publicKey:'external-crypto-fixture',receipt:Buffer.from('fixture')}),
 assertionFn:({assertion})=>Number(assertion.toString())});
});
after(()=>sql?.close());
beforeEach(async()=>{
 trace=[];intercept=null;boundaryAgeMS=null;
 await sql.exec('TRUNCATE listening_v2.command_receipts,listening_v2.semantic_events,listening_v2.outbox,listening_v2.private_profile_assets,listening_v2.returning_grants,listening_v2.rooms,listening_v2.privacy_personas,listening_v2.output_guards;TRUNCATE public.library_users CASCADE;');
 engine=createPrivacyLifecycle({db,coordinatorEnvironment:coordinator});service=createPrivatePersonaService(options());actor=await enroll();trace=[];
});

test('pure construction on schema-absent adapter has zero IO and exposes only frozen actual methods',()=>{
 let io=0;const absent={query(){io++;throw Error('no schema');},transaction(){io++;throw Error('no schema');}};
 const s=createPrivatePersonaService({...options(),db:absent});assert.equal(io,0);assert.ok(Object.isFrozen(s));
 assert.deepEqual(Object.keys(s).sort(),['erase','retain']);assert.equal(typeof s.retain,'function');assert.equal(typeof s.erase,'function');
 for(const extra of [{authorize:()=>true},{permit:{}},{negative:true},{now:()=>0},{requestEnvironment:env},{capacity:1}])
 assert.throws(()=>createPrivatePersonaService({...options(),db:absent,...extra}));assert.equal(io,0);
});

test('first retention uses real AppAuth and exact 18-tuple SQL; lost ACK reuses only same live origin',async()=>{
 const p=await retain();assert.deepEqual(Object.keys(p).sort(),['generation','id']);assert.equal(p.generation,1);
 const r=await persona(p.id);assert.equal(r.original_principal_id,actor.id);assert.equal(r.original_key_id,actor.keyID);
 assert.equal(r.controller_kind,'guest');assert.equal(r.guest_credential_digest,hash(actor.token));assert.equal(uint(r.controller_privacy_epoch),0);
 assert.equal(r.private_transfer_from_generation,null);assert.equal(uint(r.guest_credential_expires_at_ms),uint(await scalar(
 'SELECT floor(extract(epoch FROM expires_at)*1000)::text FROM public.library_tokens WHERE digest=$1',[hash(actor.token)])));
 const c=decodePersonaTuple(JSON.stringify(tuple(r)),{reserveFuture:true});assert.ok(c.futureNormalizedBytes<=512);
 assert.equal(c.normalizedBytes,await scalar(`SELECT octet_length(jsonb_build_array(${PRIVACY_CODEC_FIELDS.personaTuple.join(',')})::text) FROM listening_v2.privacy_personas WHERE persona_id=$1`,[p.id]));
 assert.deepEqual(await retain(),p);assert.equal(await count('privacy_personas'),1);assert.equal(await count('rooms'),0);assert.equal(await count('command_receipts'),0);
 const text=JSON.stringify(r);assert.doesNotMatch(text,/publicKey|displayName|photo|assetID|provider/);
});

test('real same-C normal session renewal invalidates S but never withdraws persona or queues cleanup',async()=>{
 const p=await retain(),old=actor.bearer,pre=await persona(p.id);await renew(actor);
 await reject(service.retain({bearer:old,rawIntent:retainRaw}),'unauthorized');assert.deepEqual(await retain(),p);
 assert.deepEqual(await persona(p.id),pre);assert.equal(await count('outbox'),0);
});

test('retain raw intent is closed and grants no caller identity, namespace, permit or consent proof',async()=>{
 const base=JSON.parse(retainRaw),before=await state();
 for(const v of [{...base,principalID:'A'},{...base,environment:'production'},{...base,payload:{scope:'all',confirmed:true}},
 {...base,payload:{...base.payload,confirmed:false}},{...base,payload:{...base.payload,photo:'x'}},{...base,action:'privacy.erase'}])
 await reject(service.retain({bearer:actor.bearer,rawIntent:JSON.stringify(v)}),'invalid_request');
 for(const raw of [base,Buffer.from(retainRaw),'{"version":2,"version":2,"action":"privacy.retain","payload":{"scope":"my_sessions_persona","confirmed":true}}'])
 await reject(service.retain({bearer:actor.bearer,rawIntent:raw}),'invalid_request');
 await reject(service.retain({bearer:actor.bearer,rawIntent:retainRaw,permit:{}}),'invalid_request');assert.deepEqual(await state(),before);
});

for(const kind of ['guest','apple'])test(`${kind}: finite actual C deadline required; guest <=90d, selected controller captured`,async()=>{
 if(kind==='apple')actor=await enroll('A','apple',2);
 const p=await retain(),r=await persona(p.id);assert.equal(r.controller_kind,kind);
 if(kind==='apple'){assert.equal(r.controller_principal_id,'A');assert.equal(r.controller_key_id,null);assert.equal(r.guest_credential_digest,null);}
 await sql.exec('DELETE FROM listening_v2.privacy_personas');
 for(const deadline of ['NULL',"'infinity'::timestamptz",...(kind==='guest'?["clock_timestamp()+interval '91 days'"]:[])]){
 await sql.query(`UPDATE public.library_tokens SET expires_at=${deadline} WHERE digest=$1`,[hash(actor.token)]);
 await reject(retain(),deadline.includes('infinity')?'unavailable':'unauthorized');assert.equal(await count('privacy_personas'),0);
 }
});

for(const kind of ['credential','guest-key','guest-user','apple-controller'])for(const status of ['pending','claimed','dead','successor'])
 test(`${kind}/${status}: unfinished global selector blocks new retention in another environment`,async()=>{
 if(kind==='apple-controller')actor=await enroll('A','apple',2);
 const {jobID}=await closure(kind);let target=jobID;
 if(status==='claimed'){assert.ok(await engine.claimDependency());}
 if(status==='dead'||status==='successor'){
  await sql.query('UPDATE listening_v2.outbox SET attempt_count=10 WHERE job_id=$1',[jobID]);assert.equal(await engine.claimDependency(),null);
  if(status==='successor')target=(await engine.replaceDeadDependency(jobID)).jobID;
 }
 await reactivate(kind);const before=await state();
 await reject(retain(createPrivatePersonaService(options('preview:cross-environment'))),'conflict');assert.deepEqual(await state(),before);
 assert.equal((await one('SELECT state FROM listening_v2.outbox WHERE job_id=$1',[target])).state,status==='successor'?'pending':status);
});

for(const order of ['admission-first','publication-first'])test(`${order}: actual empty final publication releases source anchors before fresh incarnation`,async()=>{
 await closure('credential');await reactivate('credential');
 if(order==='admission-first')await reject(retain(),'conflict');
 const result=await process();assert.equal(result.status,'published');const p=await retain();assert.equal(p.generation,1);
 const later=await closure('credential');const job=await one('SELECT * FROM listening_v2.outbox WHERE job_id=$1',[later.jobID]);
 assert.ok(job.payload.invalidatedAtMS>=uint((await persona(p.id)).created_at_ms));assert.equal(job.payload.cursor,null);
});

test('actual100 batch handoff still blocks earlier-sorting incarnation until separate final publication',async()=>{
 for(let n=0;n<100;n++)await retain(createPrivatePersonaService(options('preview:z'+String(n).padStart(3,'0'))));
 await closure('credential');assert.equal((await process()).processed,100);await reactivate('credential');
 const earlier=createPrivatePersonaService(options('development'));await reject(retain(earlier),'conflict');
 assert.equal((await process()).status,'published');assert.equal((await retain(earlier)).generation,1);
});

test('unrelated old credential selector does not block candidate current digest',async()=>{
 await closure('credential');const old=hash(actor.token);actor.token='new-credential';await library.createUser(actor.id,actor.token);
 await sql.query("UPDATE public.library_tokens SET expires_at=clock_timestamp()+interval '89 days' WHERE digest=$1",[hash(actor.token)]);
 await renew(actor);const p=await retain();assert.notEqual((await persona(p.id)).guest_credential_digest,old);
});

test('effectively-dead live origin never reused or reopened; new UUID only after terminal handoff',async()=>{
 const p=await retain();await closure('credential');await process();await reactivate('credential');
 await reject(retain(),'conflict');assert.equal((await process()).status,'published');const fresh=await retain();assert.notEqual(fresh.id,p.id);
 assert.equal((await persona(p.id)).status,'withdrawn');assert.equal(uint((await persona(p.id)).privacy_generation),2);
 // Old-live mismatch is a refusal even under a newly authenticated credential.
 await sql.query('UPDATE public.library_tokens SET expires_at=expires_at+interval \'1 hour\' WHERE digest=$1',[hash(actor.token)]);
 await reject(retain(),'conflict');assert.equal(await count('privacy_personas'),2);
});

for(const kind of ['guest','apple'])test(`${kind}: erase authenticates exact S once, preserves credential/account and denies canonical reads with processor stopped`,async()=>{
 if(kind==='apple')actor=await enroll('A','apple',2);
 const p=await retain();const credentials=(await sql.query('SELECT to_jsonb(t)::text AS row FROM public.library_tokens t ORDER BY digest')).rows;
 assert.equal(await visible(p),1);trace=[];const raw=command(p),result=await erase(raw);
 assert.deepEqual(result.result,{privacyGeneration:p.generation+1});assert.equal(result.replayed,false);assert.equal(await visible(p),0);
 assert.deepEqual((await sql.query('SELECT to_jsonb(t)::text AS row FROM public.library_tokens t ORDER BY digest')).rows,credentials);
 assert.equal((await one('SELECT disabled FROM public.library_users WHERE id=$1',[actor.id])).disabled,false);
 const locks=trace.filter(x=>/FOR (?:NO KEY )?UPDATE/.test(x.q));
 assert.equal(locks.filter(x=>/public\.app_auth_sessions/.test(x.q)).length,1);
 assert.equal(locks.filter(x=>/public\.app_attest_keys/.test(x.q)).length,1);
 const receipt=await one('SELECT * FROM listening_v2.command_receipts');assert.equal(receipt.room_id,null);assert.equal(receipt.actor_persona_id,p.id);
 assert.equal(uint(receipt.actor_privacy_generation),p.generation);assert.equal(uint(receipt.delete_after_ms)-uint(receipt.created_at_ms),30*DAY);
 const r=await persona(p.id);
 if(kind==='guest'){
  assert.equal(r.status,'withdrawn');assert.equal(uint(r.privacy_generation),2);assert.equal(Buffer.byteLength(r.scrub_cursor),41);
  const j=await one("SELECT * FROM listening_v2.outbox WHERE kind='privacy_scrub'");const decoded=decodePrivacyScrub(JSON.stringify(j.payload));
  assert.equal(r.scrub_cursor,privacyScrubMarker(j.job_id,'rooms'));assert.equal(decoded.payload.privacyGeneration,2);
  assert.equal(decoded.payload.withdrawnAtMS,uint(r.withdrawn_at_ms));assert.equal(decoded.payload.scrubDueAtMS-decoded.payload.withdrawnAtMS,DAY);
 }else{
  assert.equal(r.status,'live');assert.equal(uint(r.controller_privacy_epoch),0);
  assert.equal(uint(await scalar('SELECT sessions_privacy_epoch::text FROM public.library_users WHERE id=$1',[actor.id])),1);
  const j=await one("SELECT * FROM listening_v2.outbox WHERE kind='privacy_dependency'");assert.deepEqual(j.payload.selector,{kind:'apple-controller',value:actor.id});
  assert.equal(j.environment,coordinator);assert.equal(await count('outbox'),1);
 }
 const before=await state();assert.equal((await erase(raw)).replayed,true);assert.deepEqual(await state(),before);
});

test('Apple epoch immediately fences many controlled personas across environments without history UPDATE',async()=>{
 actor=await enroll('A','apple',2);const p=await retain();
 for(let n=0;n<101;n++)await retain(createPrivatePersonaService(options('preview:apple'+n)));
 trace=[];await erase(command(p));
 assert.equal(trace.filter(x=>/^UPDATE listening_v2\.privacy_personas/.test(x.q)).length,0);
 assert.equal(await scalar("SELECT count(*)::int FROM listening_v2.privacy_personas p JOIN public.library_users u ON u.id=p.controller_principal_id WHERE p.controller_kind='apple' AND p.controller_privacy_epoch=u.sessions_privacy_epoch"),0);
 assert.equal(await count('privacy_personas'),102);await reject(retain(),'conflict');
});

for(const kind of ['guest','apple'])test(`${kind}: exact saved receipt replays after freshness window under current auth; valid changed body conflicts only after ownership`,async()=>{
 if(kind==='apple')actor=await enroll('A','apple',2);const p=await retain(),raw=command(p);await erase(raw);
 // Real S remains ordinarily valid for ~13min; its inferred issuance is >121s
 // old. This UPDATE is a persisted-authority fixture, not session issuance proof.
 await sql.query("UPDATE public.app_auth_sessions SET expires_at=clock_timestamp()+interval '779 seconds' WHERE digest=$1",[hash(actor.bearer)]);
 trace=[];assert.equal((await erase(raw)).replayed,true);assert.equal(trace.filter(x=>x.q.includes(' AS fresh')).length,0);
 const changed=JSON.stringify({...JSON.parse(raw),expected:{privacyGeneration:p.generation+1}});
 await reject(erase(changed),'conflict');const other=await enroll('B','apple',3);
 await reject(erase(raw,other),'unauthorized');await reject(erase(changed,other),'unauthorized');
 const old=actor.bearer;await renew(actor);await reject(erase(raw,{...actor,bearer:old}),'unauthorized');assert.equal((await erase(raw)).replayed,true);
});

for(const kind of ['guest','apple'])for(const age of ['120000','120000.001','121000'])
 test(`${kind} freshness ${age}ms: synthetic persisted-S boundary clock, no rounding extension`,async()=>{
 if(kind==='apple')actor=await enroll('A','apple',2);const p=await retain(),raw=command(p),before=await state();boundaryAgeMS=age;
 if(age==='120000')assert.equal((await erase(raw)).status,'accepted');else {await reject(erase(raw),'expired');assert.deepEqual(await state(),before);}
});

for(const kind of ['guest','apple'])test(`${kind}: actual121-second ordinary S refuses new erase without mutation`,async()=>{
 if(kind==='apple')actor=await enroll('A','apple',2);const p=await retain();
 await sql.query("UPDATE public.app_auth_sessions SET expires_at=clock_timestamp()+interval '779 seconds' WHERE digest=$1",[hash(actor.bearer)]);
 assert.equal((await auth.authenticate(actor.bearer)).id,actor.id);const before=await state();await reject(erase(command(p)),'expired');assert.deepEqual(await state(),before);
});

test('stale generation, stale Apple epoch, overflow and foreign actor never create a receipt or advance twice',async()=>{
 let p=await retain();await reject(erase(command(p,{expected:{privacyGeneration:0}})),'conflict');assert.equal(await count('command_receipts'),0);
 actor=await enroll('A','apple',2);p=await retain();await erase(command(p));const before=await state();
 await reject(erase(command(p)),'conflict');assert.deepEqual(await state(),before);
 await sql.query('UPDATE public.library_users SET sessions_privacy_epoch=$2 WHERE id=$1',[actor.id,MAX]);
 await reject(retain(),'conflict');
});

for(const kind of ['guest','apple'])for(const stage of ['handoff','receipt','deadline'])test(`${kind}/${stage}: failure rolls persona/epoch/hints/receipt back together`,async()=>{
 if(kind==='apple')actor=await enroll('A','apple',2);
 if(stage==='deadline')await sql.query("UPDATE public.library_tokens SET expires_at=clock_timestamp()+interval '650 milliseconds' WHERE digest=$1",[hash(actor.token)]);
 // Retain through the actual method AFTER shortening C, preserving immutable
 // dependency equality; never manufacture a successful persona postimage.
 const p=await retain(),before=await state();let injected=false;
 intercept=async(phase,q,args,tx)=>{
  if(phase!=='after')return;
  if(stage==='handoff'&&/INSERT INTO listening_v2.outbox/.test(q)||stage==='receipt'&&/INSERT INTO listening_v2.command_receipts/.test(q)){
   injected=true;throw Error('synthetic transaction fault');}
  if(stage==='deadline'&&/INSERT INTO listening_v2.command_receipts/.test(q)){
   injected=true;await setTimeout(700);assert.equal(await scalar('SELECT expires_at<=clock_timestamp() AS expired FROM public.library_tokens WHERE digest=$1',[hash(actor.token)],tx),true);}
 };
 await reject(erase(command(p)),stage==='deadline'?'unauthorized':'unavailable');intercept=null;assert.equal(injected,true);assert.deepEqual(await state(),before);
});

test('retention final SQL rejects exact C deadline crossing and rolls new persona back',async()=>{
 await sql.query("UPDATE public.library_tokens SET expires_at=clock_timestamp()+interval '650 milliseconds' WHERE digest=$1",[hash(actor.token)]);
 const before=await state();let crossed=false;intercept=async(phase,q)=>{if(phase==='after'&&/INSERT INTO listening_v2.privacy_personas/.test(q)){crossed=true;await setTimeout(700);}};
 await reject(retain(),'unauthorized');intercept=null;assert.equal(crossed,true);assert.deepEqual(await state(),before);
});

test('guest erase rollback on actual typed scrub INSERT failure never loses old generation or source',async()=>{
 const p=await retain(),before=await state();intercept=async(phase,q)=>{if(phase==='after'&&/INSERT INTO listening_v2.outbox/.test(q))throw Error('handoff fault');};
 await reject(erase(command(p)),'unavailable');intercept=null;assert.deepEqual(await state(),before);
 assert.equal((await erase(command(p))).result.privacyGeneration,2);
});

test('actor ID shares UUID with ended/capped real room: erase never reads or touches that room or borrows reserve',async()=>{
 const p=await retain(),at=await now();await sql.query(`INSERT INTO listening_v2.rooms(environment,session_id,host_install_scope,provider,invite_digest,code_digest,
 status,created_at_ms,expires_at_ms,updated_at_ms,ended_at_ms,event_delete_after_ms,receipt_delete_after_ms,receipt_count,reserved_receipts)
 VALUES($1,$2,$3,'appleMusic',$4,$5,'ended',$6,$7,$6,$6,$8,$9,30000,0)`,[env,p.id,hash('host'),hash('invite'),hash('code'),at,at+1,at+DAY,at+90*DAY]);
 const room=await one('SELECT to_jsonb(r)::text AS row FROM listening_v2.rooms r');trace=[];await erase(command(p));
 assert.deepEqual(await one('SELECT to_jsonb(r)::text AS row FROM listening_v2.rooms r'),room);
 assert.equal(trace.filter(x=>/FROM listening_v2.rooms|UPDATE listening_v2.rooms/.test(x.q)).length,0);
 assert.equal((await one('SELECT room_id FROM listening_v2.command_receipts')).room_id,null);
});

for(const kind of ['guest','apple'])test(`${kind}: actual codec reserves chosen-controller terminal512 and refuses overflow before INSERT`,async()=>{
 const at=await now();let vector;
 for(let n=1;n<=128&&!vector;n++)for(let m=1;m<=110&&!vector;m++){
  const principal='P'.repeat(n),namespace='preview:b'+('x'.repeat(m));
  const t=[namespace,randomUUID(),principal,key(8),kind,principal,kind==='guest'?key(8):null,1,'live',kind==='guest'?hash('x'):null,kind==='guest'?at+89*DAY:null,null,null,null,at,at,0,null];
  try {const d=decodePersonaTuple(JSON.stringify(t),{reserveFuture:true});if(d.futureNormalizedBytes===512)vector={principal,namespace};}catch{}
 }
 assert.ok(vector,'exact512 vector must exist');const a=await enroll(vector.principal,kind,8),s=createPrivatePersonaService(options(vector.namespace)),p=await retain(s,a);
 const r=await one('SELECT * FROM listening_v2.privacy_personas WHERE persona_id=$1',[p.id]);const d=decodePersonaTuple(JSON.stringify(tuple(r)),{reserveFuture:true});assert.equal(d.futureNormalizedBytes,512);
 const terminal=tuple(r);terminal[7]++;terminal[8]='withdrawn';terminal[11]=MAX;terminal[12]=MAX;terminal[13]=privacyScrubMarker(randomUUID(),'rooms');terminal[15]=MAX;
 assert.equal(await scalar('SELECT octet_length($1::jsonb::text)::int',[JSON.stringify(terminal)]),512);
 const larger=await enroll(vector.principal+'Q',kind,9);await reject(retain(createPrivatePersonaService(options(vector.namespace)),larger),'invalid_request');
 assert.equal(await scalar('SELECT count(*)::int FROM listening_v2.privacy_personas WHERE original_principal_id=$1',[larger.id]),0);
});

test('uncertain guard, safety capsule, bootstrap, credits and all account auth bytes remain unchanged',async()=>{
 const p=await retain(),at=await now();await sql.query(`INSERT INTO listening_v2.output_guards(environment,guard_id,provider,binding_key_version,
 account_binding,connection_lineage,output_scope,scope_kind,original_install_scope,bootstrap_state,lane_state,execution_id,send_ordinal,
 claim_nonce_hash,claim_until_ms,endpoint_body_hash,may_have_been_sent,reserved_visit_credits,safety_capsule,created_at_ms,updated_at_ms)
 VALUES($1,$2,'spotify',1,$3,$4,$5,'captured_output',$6,'legacy_quarantined','uncertain',$7,1,$8,$9,$10,true,3,$11,$12,$12)`,
 [env,randomUUID(),hash('a'),hash('b'),hash('c'),hash('d'),randomUUID(),hash('n'),at+1000,hash('body'),{observed:['exact-recording'],credits:[1,2,3]},at]);
 const guards=(await sql.query('SELECT to_jsonb(g)::text AS row FROM listening_v2.output_guards g')).rows;
 const rows=async()=>({keys:(await sql.query('SELECT to_jsonb(k)::text AS row FROM public.app_attest_keys k')).rows,
 sessions:(await sql.query('SELECT to_jsonb(s)::text AS row FROM public.app_auth_sessions s')).rows});const before=await rows();
 await erase(command(p));assert.deepEqual((await sql.query('SELECT to_jsonb(g)::text AS row FROM listening_v2.output_guards g')).rows,guards);assert.deepEqual(await rows(),before);
});

// PPS-R1B-01: actual service, actual AppAuth, actual SQL and the existing
// receipt gateway. The test-only adapter faults the precise SQL operation;
// transaction snapshots are read only after the adapter has rolled back.
function privateSQLFault(code){return Object.assign(new Error('private SQL message sentinel'),{code,
 detail:'private detail sentinel',hint:'private hint sentinel',query:'private query sentinel',constraint:'private constraint sentinel'});}
function boundedPublic(error,code){assert.equal(error.code,code);assert.equal(error.message,code);
 assert.equal(error.cause,undefined);assert.doesNotMatch(JSON.stringify(error),/40001|40P01|XX000|private .* sentinel/);return true;}
async function faultedErase({kind='guest',point='auth',code='40001',failures=1,replaceSession=false}){
 if(kind==='apple')actor=await enroll('A','apple',2);
 const p=await retain(),raw=command(p),parsed=JSON.parse(raw),bearer=actor.bearer,before=await state();
 const originalTransaction=db.transaction;let attempts=0,hits=0,armed=true;const rolledBack=[];
 intercept=async(phase,q,args)=>{
  const match=point==='auth'?phase==='before'&&q==='SELECT id FROM public.library_users WHERE id=$1 FOR UPDATE':
   phase==='before'&&q.includes('INSERT INTO listening_v2.outbox')&&q.includes("'privacy_dependency'");
  if(armed&&match){hits++;if(hits<=failures)throw privateSQLFault(code);}
 };
 db.transaction=async work=>{
  attempts++;
  try{return await originalTransaction(work);}
  catch(error){
   rolledBack.push(await state());
   if(replaceSession&&attempts===1){armed=false;db.transaction=originalTransaction;await renew(actor);db.transaction=wrapped;armed=true;}
   throw error;
  }
 };
 const wrapped=db.transaction;
 const actual=createPrivatePersonaService(options());
 try{
  let result,error;try{result=await actual.erase({bearer,rawCommand:raw});}catch(e){error=e;}
  return {p,raw,parsed,bearer,before,result,error,attempts,hits,rolledBack};
 }finally{db.transaction=originalTransaction;intercept=null;}
}
for(const code of ['40001','40P01'])for(const kind of ['guest','apple'])for(const point of (kind==='apple'?['auth','hint']:['auth']))
 test(`actual ${kind} erase retries ${code} at ${point} in a fresh transaction`,async()=>{
  const x=await faultedErase({kind,point,code});assert.equal(x.error,undefined);assert.equal(x.attempts,2);assert.equal(x.hits,2);
  assert.deepEqual(x.rolledBack,[x.before]);assert.equal(x.result.commandID,x.parsed.commandID);
  assert.equal(x.result.sessionID,x.parsed.sessionID);assert.deepEqual(x.result.result,{privacyGeneration:x.p.generation+1});
  assert.equal(x.result.replayed,false);assert.equal(await count('command_receipts'),1);
  const receipt=await one('SELECT command_id,session_id,action FROM listening_v2.command_receipts');
  assert.equal(receipt.command_id,x.parsed.commandID);assert.equal(receipt.session_id,x.parsed.sessionID);assert.equal(receipt.action,'privacy.erase');
  if(kind==='guest'){assert.equal((await persona(x.p.id)).status,'withdrawn');assert.equal(await count('outbox'),1);}
  else{assert.equal(uint(await scalar('SELECT sessions_privacy_epoch::text FROM public.library_users WHERE id=$1',[actor.id])),1);
   assert.equal(await scalar("SELECT count(*)::int FROM listening_v2.outbox WHERE kind='privacy_dependency'"),1);}
 });
for(const code of ['40001','40P01'])for(const point of ['auth','hint'])
 test(`actual Apple ${point} ${code} exhaustion is exactly three rolled-back attempts`,async()=>{
  const x=await faultedErase({kind:'apple',point,code,failures:3});assert.ok(x.error);boundedPublic(x.error,'conflict');
  assert.equal(x.attempts,3);assert.equal(x.hits,3);assert.deepEqual(x.rolledBack,[x.before,x.before,x.before]);
  assert.deepEqual(await state(),x.before);
 });
for(const point of ['auth','hint'])test(`unknown SQLSTATE at ${point} is unavailable without retry or partial effects`,async()=>{
 const x=await faultedErase({kind:'apple',point,code:'XX000'});boundedPublic(x.error,'unavailable');
 assert.equal(x.attempts,1);assert.equal(x.hits,1);assert.deepEqual(x.rolledBack,[x.before]);assert.deepEqual(await state(),x.before);
});
test('semantic unauthorized at the actual auth lock remains nonretryable',async()=>{
 const p=await retain(),raw=command(p),before=await state(),originalTransaction=db.transaction;let attempts=0;
 db.transaction=async fn=>{attempts++;return originalTransaction(fn);};
 intercept=async(phase,q)=>{if(phase==='before'&&q==='SELECT id FROM public.library_users WHERE id=$1 FOR UPDATE'){
  const {SessionV2Error}=await import('../../api/utils/listening-v2/errors.js');throw new SessionV2Error('unauthorized');}};
 const s=createPrivatePersonaService(options());try{await assert.rejects(s.erase({bearer:actor.bearer,rawCommand:raw}),e=>boundedPublic(e,'unauthorized'));
  assert.equal(attempts,1);assert.deepEqual(await state(),before);
 }finally{db.transaction=originalTransaction;intercept=null;}
});
test('retry after replacement of the exact submitted S denies instead of borrowing the new S',async()=>{
 const x=await faultedErase({code:'40001',replaceSession:true});boundedPublic(x.error,'unauthorized');
 assert.equal(x.attempts,2);assert.equal(x.hits,1);assert.notEqual(actor.bearer,x.bearer);
 assert.deepEqual(x.rolledBack[0],x.before);assert.equal(await count('command_receipts'),0);assert.equal(await count('outbox'),0);
 assert.equal((await persona(x.p.id)).status,'live');
});
test('public retain bounds recognized transaction errors without exposing the retry signal',async()=>{
 intercept=async(phase,q)=>{if(phase==='before'&&q==='SELECT id FROM public.library_users WHERE id=$1 FOR UPDATE')throw privateSQLFault('40001');};
 try{await assert.rejects(retain(),e=>boundedPublic(e,'unavailable'));}finally{intercept=null;}
});
test('failed negative persist retires its plan even if a caller attempts reuse',async()=>{
 actor=await enroll('A','apple',2);let oldPlan,signal;
 await assert.rejects(db.transaction(async tx=>{
  await tx.query('SELECT id FROM public.library_users WHERE id=$1 FOR UPDATE',[actor.id]);
  oldPlan=await engine.prepareAppleEpochAdvance(tx,actor.id);
  await tx.query('UPDATE public.library_users SET sessions_privacy_epoch=sessions_privacy_epoch+1 WHERE id=$1',[actor.id]);
  intercept=async(phase,q)=>{if(phase==='before'&&q.includes('INSERT INTO listening_v2.outbox')&&q.includes("'privacy_dependency'"))throw privateSQLFault('40001');};
  try{await engine.persistSourceClosure(tx,oldPlan);}catch(e){signal=e;throw e;}
 }));intercept=null;
 assert.equal(signal.code,'40001');assert.equal(signal.message,'transaction_retry');assert.equal(signal.cause,undefined);
 await db.transaction(async tx=>{await assert.rejects(engine.persistSourceClosure(tx,oldPlan),e=>boundedPublic(e,'unavailable'));});
 assert.equal(uint(await scalar('SELECT sessions_privacy_epoch::text FROM public.library_users WHERE id=$1',[actor.id])),0);
});

// PPS-INT-01: actual service/engine phases. SQL fault injections below operate
// inside the transaction and roll back; they are not multi-client race proof.
async function actualReceiptScrub(kind){
 if(kind==='apple')actor=await enroll('A','apple',2);
 const p=await retain(),raw=command(p),accepted=await erase(raw);
 assert.deepEqual(accepted.result,{privacyGeneration:p.generation+1});
 if(kind==='apple'){await process();assert.equal((await persona(p.id)).status,'withdrawn');}
 const phases=[];
 for(let n=0;n<9;n++){
  const job=await one("SELECT * FROM listening_v2.outbox WHERE kind='privacy_scrub' AND persona_id=$1",[p.id]);
  assert.ok(job);if(job.payload.phase==='assets')break;
  phases.push(job.payload.phase);await sql.query('UPDATE listening_v2.outbox SET due_at_ms=created_at_ms WHERE job_id=$1',[job.job_id]);
  const claim=await engine.claimScrub();assert.ok(claim);await engine.processScrub(claim);
 }
 assert.deepEqual(phases,['rooms','grants-host','grants-guest','grants-approver','events','receipts','receipts']);
 const r=await one('SELECT * FROM listening_v2.command_receipts WHERE session_id=$1',[p.id]);
 assert.equal(r.actor_persona_id,null);assert.equal(r.actor_privacy_generation,null);
 assert.deepEqual(r.result,{privacyGeneration:p.generation+1});
 return {p,raw,r};
}
for(const kind of ['guest','apple'])test(`${kind}: actual erase then every scrub phase through receipts replays without state change`,async()=>{
 const {p,raw,r}=await actualReceiptScrub(kind),before=await state();trace=[];
 const replay=await erase(raw);assert.equal(replay.replayed,true);assert.deepEqual(replay.result,{privacyGeneration:p.generation+1});
 assert.deepEqual(await state(),before);assert.equal(await count('command_receipts'),1);
 assert.equal(uint(r.delete_after_ms)-uint(r.created_at_ms),30*DAY);
 const locks=trace.filter(x=>/FOR (?:NO KEY )?UPDATE/.test(x.q));
 assert.equal(locks.filter(x=>/public\.app_auth_sessions/.test(x.q)).length,1);
 assert.equal(locks.filter(x=>/public\.app_attest_keys/.test(x.q)).length,1);
 assert.equal(trace.filter(x=>x.q.includes(' AS fresh')).length,0);
});
for(const kind of ['guest','apple'])test(`${kind}: replay before scrub and after scrub retain the same result`,async()=>{
 if(kind==='apple')actor=await enroll('A','apple',2);const p=await retain(),raw=command(p);await erase(raw);
 const before=await state();assert.deepEqual((await erase(raw)).result,{privacyGeneration:p.generation+1});assert.deepEqual(await state(),before);
 if(kind==='apple')await process();
 for(let n=0;n<7;n++){const j=await one("SELECT * FROM listening_v2.outbox WHERE kind='privacy_scrub' AND persona_id=$1",[p.id]);
  await sql.query('UPDATE listening_v2.outbox SET due_at_ms=created_at_ms WHERE job_id=$1',[j.job_id]);const claim=await engine.claimScrub();assert.ok(claim);await engine.processScrub(claim);}
 const post=await state();assert.deepEqual((await erase(raw)).result,{privacyGeneration:p.generation+1});assert.deepEqual(await state(),post);
});
for(const kind of ['guest','apple'])test(`${kind}: compacted receipt authenticates exact S before changed-body conflict`,async()=>{
 const {p,raw}=await actualReceiptScrub(kind);const altered=JSON.stringify({...JSON.parse(raw),expected:{privacyGeneration:p.generation+1}});
 const before=await state();await reject(erase(altered),'conflict');assert.deepEqual(await state(),before);
 const old=actor.bearer;await renew(actor);await reject(erase(altered,{...actor,bearer:old}),'unauthorized');
 assert.equal((await erase(raw)).replayed,true);
 await sql.query('UPDATE public.app_auth_sessions SET expires_at=clock_timestamp()-interval \'1 second\' WHERE digest=$1',[hash(actor.bearer)]);
 await reject(erase(altered),'unauthorized');
});
for(const result of [{privacyGeneration:3},{privacyGeneration:0},{privacyGeneration:'2'},{privacyGeneration:2,extra:true},{version:2,redacted:true}])
 test(`compacted erase refuses tampered result ${JSON.stringify(result)} without writes`,async()=>{
  const {raw}=await actualReceiptScrub('guest');await sql.query('UPDATE listening_v2.command_receipts SET result=$1::jsonb',[JSON.stringify(result)]);
  const before=await state();await assert.rejects(erase(raw));assert.deepEqual(await state(),before);
 });
for(const field of ['delete','replace','canonical_body_hash','result','created_at_ms','delete_after_ms','principal_binding','key_binding','binding_key_version','status'])
 test(`compacted replay aborts on transactional SQL ${field} fault between discovery and gateway lock`,async()=>{
  const {raw}=await actualReceiptScrub('guest'),before=await state();let hit=false;
  intercept=async(phase,q,args,tx)=>{
   if(hit||phase!=='before'||!q.includes('ORDER BY session_id,principal_binding,key_binding,command_id FOR UPDATE'))return;
   hit=true;
   if(field==='delete')await tx.query('DELETE FROM listening_v2.command_receipts');
   else if(field==='replace'){
    const row=await one('SELECT * FROM listening_v2.command_receipts',[],tx);await tx.query('DELETE FROM listening_v2.command_receipts');
    const cols=Object.keys(row);row.delete_after_ms=String(uint(row.delete_after_ms)+1);
    await tx.query(`INSERT INTO listening_v2.command_receipts(${cols.join(',')}) VALUES(${cols.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
   }else{
    const update={canonical_body_hash:"canonical_body_hash='"+hash('changed')+"'",result:"result='{\"privacyGeneration\":3}'::jsonb",
     created_at_ms:'created_at_ms=created_at_ms-1',delete_after_ms:'delete_after_ms=delete_after_ms+1',
     principal_binding:"principal_binding='"+hash('other-principal')+"'",key_binding:"key_binding='"+hash('other-key')+"'",
     binding_key_version:'binding_key_version=2',status:"status='refused'"}[field];
    await tx.query('UPDATE listening_v2.command_receipts SET '+update);
   }
  };
  try{await assert.rejects(erase(raw));}finally{intercept=null;}
  assert.equal(hit,true);assert.deepEqual(await state(),before);
 });
test('future persona compaction representation: remove only the fixture job and persona, then replay the actual scrubbed receipt',async()=>{
 const {p,raw}=await actualReceiptScrub('guest');
 // Explicit fixture cleanup; this is not scrub completion, object deletion or backup proof.
 await sql.query("DELETE FROM listening_v2.outbox WHERE kind='privacy_scrub' AND persona_id=$1",[p.id]);
 await sql.query('DELETE FROM listening_v2.privacy_personas WHERE persona_id=$1',[p.id]);
 const before=await state();assert.deepEqual((await erase(raw)).result,{privacyGeneration:p.generation+1});assert.deepEqual(await state(),before);
});
test('actor CHECK rejects mixed null pair with schema constraints enabled',async()=>{
 const {p}=await actualReceiptScrub('guest');await assert.rejects(sql.query('UPDATE listening_v2.command_receipts SET actor_persona_id=$1',[p.id]));
 await assert.rejects(sql.query('UPDATE listening_v2.command_receipts SET actor_privacy_generation=1'));
});
async function anotherKey(a,n){
 const keyID=key(n),c=await auth.challenge(a.token,{keyID,bundleID,purpose:'register'});
 await auth.register(a.token,{keyID,bundleID,challenge:c.challenge,attestation:'Zml4dHVyZQ=='});
 const other={...a,keyID,counter:0};await renew(other);return other;
}
test('same Apple controller on another physical key does not inherit a compacted receipt',async()=>{
 const {raw}=await actualReceiptScrub('apple'),other=await anotherKey(actor,8),before=await state();
 await assert.rejects(erase(raw,other));assert.deepEqual(await state(),before);
});
for(const owner of ['A','B'])test(`current ${owner} cannot inherit old G receipt on a moved physical key (SQL ownership fixture)`,async()=>{
 const {raw}=await actualReceiptScrub('guest'),original=actor;
 const target=await enroll(owner,'apple',owner==='A'?4:5);
 // Models only an already moved key; it does not claim execution of signIn.
 await sql.query('UPDATE public.app_attest_keys SET user_id=$2 WHERE key_id=$1',[original.keyID,target.id]);
 const moved={...target,keyID:original.keyID,counter:original.counter};await renew(moved);
 const before=await state();await assert.rejects(erase(raw,moved));assert.deepEqual(await state(),before);
});
test('A receipt does not follow its physical key to B (SQL ownership fixture)',async()=>{
 const {raw}=await actualReceiptScrub('apple'),original=actor,target=await enroll('B','apple',7);
 await sql.query('UPDATE public.app_attest_keys SET user_id=$2 WHERE key_id=$1',[original.keyID,target.id]);
 const moved={...target,keyID:original.keyID,counter:original.counter};await renew(moved);
 const before=await state();await assert.rejects(erase(raw,moved));assert.deepEqual(await state(),before);
});
test('retained original binding version among four is used without rebinding or receipt duplication',async()=>{
 const {p,raw}=await actualReceiptScrub('guest'),bindings=[binding,...[2,3,4].map(version=>({version,secret:Buffer.alloc(32,10+version)}))];
 const receiptKeyPolicy={environment:env,keys:bindings.map(k=>({version:k.version,verificationHash:createHmac('sha256',k.secret)
  .update(JSON.stringify(['sessions-v2.receipt-key-check',k.version,env])).digest('hex')}))};
 const rotated=createPrivatePersonaService({...options(),bindingKeys:bindings,activeBindingKeyVersion:4,receiptKeyPolicy});
 const before=await state();assert.deepEqual((await erase(raw,actor,rotated)).result,{privacyGeneration:p.generation+1});
 assert.deepEqual(await state(),before);assert.equal(uint((await one('SELECT binding_key_version FROM listening_v2.command_receipts')).binding_key_version),1);
});
test('after receipt purge an old command cannot erase a freshly retained incarnation',async()=>{
 const {p,raw}=await actualReceiptScrub('guest');
 // Future-retention fixture, not a claim that current scrub completed.
 await sql.query('DELETE FROM listening_v2.command_receipts WHERE session_id=$1',[p.id]);
 await sql.query("DELETE FROM listening_v2.outbox WHERE kind='privacy_scrub' AND persona_id=$1",[p.id]);
 const fresh=await retain();assert.notEqual(fresh.id,p.id);const before=await state();
 await assert.rejects(erase(raw));assert.deepEqual(await state(),before);
});
test('changed body conflict is not preempted by comparison with a valid positive saved result',async()=>{
 const {p,raw}=await actualReceiptScrub('guest');await sql.query("UPDATE listening_v2.command_receipts SET result='{\"privacyGeneration\":3}'::jsonb");
 const altered=JSON.stringify({...JSON.parse(raw),expected:{privacyGeneration:p.generation+1}}),before=await state();
 await reject(erase(altered),'conflict');await assert.rejects(erase(raw));assert.deepEqual(await state(),before);
});
for(const field of ['delete','result','delete_after_ms'])test(`commit release checks durable row after gateway lock: transactional ${field} fault`,async()=>{
 const {raw}=await actualReceiptScrub('guest'),before=await state();let hit=false;
 intercept=async(phase,q,args,tx)=>{
  if(hit||phase!=='after'||!q.includes('ORDER BY session_id,principal_binding,key_binding,command_id FOR UPDATE'))return;
  hit=true;
  if(field==='delete')await tx.query('DELETE FROM listening_v2.command_receipts');
  else if(field==='result')await tx.query("UPDATE listening_v2.command_receipts SET result='{\"privacyGeneration\":3}'::jsonb");
  else await tx.query('UPDATE listening_v2.command_receipts SET delete_after_ms=delete_after_ms+1');
 };
 try{await assert.rejects(erase(raw));}finally{intercept=null;}
 assert.equal(hit,true);assert.deepEqual(await state(),before);
});
test('ordinary current authentication suffices for compacted replay after the new-erase freshness window',async()=>{
 const {raw}=await actualReceiptScrub('guest');await sql.query("UPDATE public.app_auth_sessions SET expires_at=clock_timestamp()+interval '779 seconds' WHERE digest=$1",[hash(actor.bearer)]);
 const before=await state();trace=[];assert.equal((await erase(raw)).replayed,true);assert.deepEqual(await state(),before);
 assert.equal(trace.filter(x=>x.q.includes(' AS fresh')).length,0);
});

// PPS-INT-01 R2 AMENDMENT. Seal these complete test bytes before any R2
// corrective production behavior. R1 chronology remains in its frozen artifact.
// Every interleaving here uses real SQL and rollback on ONE connection. It is
// a synthetic statement order, never multi-client PostgreSQL concurrency proof.
const gatewayRead=q=>q.includes('ORDER BY session_id,principal_binding,key_binding,command_id FOR UPDATE');
const durableReceipt=async(tx=sql)=>one('SELECT * FROM listening_v2.command_receipts',[],tx);
async function receiptIdentity(tx=sql){return one(`SELECT xmin::text AS xmin,ctid::text AS ctid
 FROM listening_v2.command_receipts`,[],tx);}
function noReplayMutation(start=0){
 const tail=trace.slice(start);
 assert.equal(tail.filter(x=>/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(x.q)).length,0,'no service write or new receipt');
 // The fixed reducer's first SQL reads its persona; no such read may follow
 // this failed locked-receipt check. This is a source-bound entry discriminator.
 assert.equal(tail.filter(x=>/FROM listening_v2\.privacy_personas/.test(x.q)).length,0,'no reducer entry');
}
async function replayFault(raw,change,{databaseRefusal=null,timing='before'}={}){
 const before=await state();let hits=0,start=-1,actualRefusal=null;
 trace=[];intercept=async(phase,q,args,tx)=>{
  if(phase!==timing||!gatewayRead(q))return;
  assert.equal(++hits,1,'no internal retry of changed durable receipt');start=trace.length-1;
  try{await change(tx);}catch(error){actualRefusal=error;throw error;}
 };
 try{await reject(erase(raw),'unavailable');}finally{intercept=null;}
 assert.equal(hits,1);assert.ok(start>=0);noReplayMutation(start);
 if(databaseRefusal)assert.equal(actualRefusal?.code,databaseRefusal,'actual unchanged DDL must refuse this isolated field');
 else assert.equal(actualRefusal,null,'fault must reach the actual locked read');
 assert.deepEqual(await state(),before,'fault and all candidate effects rolled back');
}
for(const timing of ['before','after'])test(`R2 identical ordinary fields delete/reinsert changes only physical row identity ${timing} gateway lock`,async()=>{
 const {raw}=await actualReceiptScrub('guest');
 await replayFault(raw,async tx=>{
  const before=await durableReceipt(tx),identity=await receiptIdentity(tx),columns=Object.keys(before);
  await tx.query('DELETE FROM listening_v2.command_receipts');
  await tx.query(`INSERT INTO listening_v2.command_receipts(${columns.join(',')})
   VALUES(${columns.map((_,n)=>'$'+(n+1)).join(',')})`,Object.values(before));
  assert.deepEqual(await durableReceipt(tx),before,'all ordinary columns are identical');
  assert.notDeepEqual(await receiptIdentity(tx),identity,'actual physical row replacement');
 },{timing});
});
test('R2 actual 030/031 runtime-role populated SELECT and FOR UPDATE include xmin/ctid without added grants',async()=>{
 const {r}=await actualReceiptScrub('guest');
 await sql.transaction(async tx=>{
  await tx.query('SET LOCAL ROLE lyra_runtime_v1');
  assert.equal(await scalar('SELECT current_user',[],tx),'lyra_runtime_v1');
  for(const suffix of ['', ' FOR UPDATE']){
   const selected=await one(`SELECT *,xmin::text AS _receipt_xmin,ctid::text AS _receipt_ctid
    FROM listening_v2.command_receipts WHERE environment=$1 AND session_id=$2
    AND principal_binding=$3 AND key_binding=$4 AND command_id=$5${suffix}`,
    [r.environment,r.session_id,r.principal_binding,r.key_binding,r.command_id],tx);
   assert.ok(selected);const {_receipt_xmin:xmin,_receipt_ctid:ctid,...ordinary}=selected;
   assert.match(xmin,/^\d+$/);assert.match(ctid,/^\(\d+,\d+\)$/);assert.deepEqual(ordinary,r);
  }
 });
 // Any 42501/unsupported-system-column error is an unresolved gate, never an
 // expected pass or a reason to broaden grants. Root retains its exact refusal.
});
const singleFieldFaults=[
 ['environment',"environment='development'"],['namespace',"session_id='00000000-0000-4000-8000-000000009991'"],
 ['command',"command_id='00000000-0000-4000-8000-000000009992'"],
 ['principalBinding',`principal_binding='${hash('r2-other-principal')}'`],['keyBinding',`key_binding='${hash('r2-other-key')}'`],
 ['version','binding_key_version=2'],['action',"action='create'",'23514'],
 ['hash',`canonical_body_hash='${hash('r2-other-body')}'`],['status',"status='refused'"],
 ['result',"result='{\"privacyGeneration\":3}'::jsonb"],
 ['actorPersona',"actor_persona_id=session_id",'23514'],['actorGeneration','actor_privacy_generation=1','23514'],
 ['room','room_id=session_id'],['created','created_at_ms=created_at_ms-1'],
 ['ticket','ticket_expires_at_ms=created_at_ms+1','23514'],['delete','delete_after_ms=delete_after_ms+1'],
 ['retention','delete_after_ms=delete_after_ms-1','23514']
];
for(const timing of ['before','after'])for(const [label,assignment,databaseRefusal] of singleFieldFaults)
 test(`R2 ${timing} lock isolated immutable ${label}: actual SQL change or exact CHECK refusal, no outcome/reducer`,async()=>{
  const {p,raw}=await actualReceiptScrub('guest');
  if(label==='room'){
   const at=await now();await sql.query(`INSERT INTO listening_v2.rooms(environment,session_id,host_install_scope,provider,
    invite_digest,code_digest,created_at_ms,expires_at_ms,updated_at_ms)
    VALUES($1,$2,$3,'appleMusic',$4,$5,$6,$7,$6)`,[env,p.id,hash('r2-room-host'),hash('r2-invite'),hash('r2-code'),at,at+3600000]);
  }
  await replayFault(raw,async tx=>{
   const before=await durableReceipt(tx);await tx.query('UPDATE listening_v2.command_receipts SET '+assignment);
   const after=await durableReceipt(tx),changed=Object.keys(before).filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k]));
   assert.equal(changed.length,1,'fault changes one ordinary persisted field only');
  },{databaseRefusal,timing});
 });

async function readyForReceiptScrub(kind,{currentActor=false}={}){
 if(kind==='apple'&&!currentActor)actor=await enroll('A','apple',2);
 const p=await retain(),raw=command(p),accepted=await erase(raw);
 if(kind==='apple'){assert.equal((await process()).processed,1);}
 const phases=[];
 for(let n=0;n<5;n++){
  const j=await one("SELECT * FROM listening_v2.outbox WHERE kind='privacy_scrub' AND persona_id=$1",[p.id]);
  phases.push(j.payload.phase);await sql.query('UPDATE listening_v2.outbox SET due_at_ms=created_at_ms WHERE job_id=$1',[j.job_id]);
  const c=await engine.claimScrub();assert.ok(c);await engine.processScrub(c);
 }
 assert.deepEqual(phases,['rooms','grants-host','grants-guest','grants-approver','events']);
 const j=await one("SELECT * FROM listening_v2.outbox WHERE kind='privacy_scrub' AND persona_id=$1",[p.id]);
 assert.equal(j.payload.phase,'receipts');
 return {p,raw,accepted,j,r:await durableReceipt()};
}
async function scrubReadyReceipt(j){
 await sql.query('UPDATE listening_v2.outbox SET due_at_ms=created_at_ms WHERE job_id=$1',[j.job_id]);
 const c=await engine.claimScrub();assert.ok(c);const result=await engine.processScrub(c);
 assert.equal(result.processed,1);assert.equal((await durableReceipt()).actor_persona_id,null);return result;
}
for(const kind of ['guest','apple'])test(`R2 ${kind}: genuine scrub SQL rewrite after discovery aborts; committed actual engine scrub then fresh auth replays`,async()=>{
 const {p,raw,r,j,accepted}=await readyForReceiptScrub(kind);
 assert.equal(r.actor_persona_id,p.id);assert.equal(uint(r.actor_privacy_generation),p.generation);
 await replayFault(raw,async tx=>{
  // The actual engine's erase-only UPDATE and full predicate, injected in the
  // old attempt on this connection; real row changes, real gateway read.
  const changed=await tx.query(`UPDATE listening_v2.command_receipts SET actor_persona_id=NULL,actor_privacy_generation=NULL
   WHERE environment=$1 AND session_id=$2 AND principal_binding=$3 AND key_binding=$4 AND command_id=$5
   AND actor_persona_id=$6 AND actor_privacy_generation=$7 AND result=$8::jsonb RETURNING command_id`,
   [r.environment,r.session_id,r.principal_binding,r.key_binding,r.command_id,p.id,p.generation,JSON.stringify(r.result)]);
  assert.equal(changed.rows.length,1);assert.deepEqual(await durableReceipt(tx),{...r,actor_persona_id:null,actor_privacy_generation:null});
 });
 assert.deepEqual(await durableReceipt(),r,'old attempt scrub fault was rolled back');
 await scrubReadyReceipt(j);const old=actor.bearer;await renew(actor);assert.notEqual(actor.bearer,old);
 const before=await state();trace=[];const replay=await erase(raw);
 assert.equal(replay.replayed,true);assert.deepEqual(replay.result,accepted.result);
 assert.deepEqual(replay.result,{privacyGeneration:p.generation+1});assert.deepEqual(await state(),before);
});
for(const label of ['actorPersona','actorGeneration'])test(`R2 unredacted ${label} valid-shape single-field change cannot release old outcome`,async()=>{
 const {raw}=await readyForReceiptScrub('guest');let alternate;
 if(label==='actorPersona'){const a=await enroll('other-guest','guest',6);alternate=await retain(service,a);}
 await replayFault(raw,tx=>tx.query(label==='actorPersona'?
  'UPDATE listening_v2.command_receipts SET actor_persona_id=$1':
  'UPDATE listening_v2.command_receipts SET actor_privacy_generation=actor_privacy_generation+1',label==='actorPersona'?[alternate.id]:[]));
});
for(const kind of ['guest','apple'])for(const shape of ['unredacted','scrubbed'])
 test(`R2 ${kind}/${shape}: same-body positive integer tamper refuses and valid changed-body conflict stays ordered`,async()=>{
  const x=shape==='unredacted'?await readyForReceiptScrub(kind):await actualReceiptScrub(kind);
  const before=await state(),changed=JSON.stringify({...JSON.parse(x.raw),expected:{privacyGeneration:x.p.generation+1}});
  await reject(erase(changed),'conflict');assert.deepEqual(await state(),before);
  await sql.query('UPDATE listening_v2.command_receipts SET result=$1::jsonb',[JSON.stringify({privacyGeneration:x.p.generation+2})]);
  const tampered=await state();await reject(erase(x.raw),'unavailable');assert.deepEqual(await state(),tampered);
  if(shape==='scrubbed'){await reject(erase(changed),'conflict');assert.deepEqual(await state(),tampered);}
 });
for(const kind of ['guest','apple'])for(const invalidation of ['replacement','expiry','revocation'])
 test(`R2 ${kind}: exact S ${invalidation} denies before changed-body conflict after actual scrub`,async()=>{
  const {p,raw}=await actualReceiptScrub(kind),submitted=actor.bearer;
  if(invalidation==='replacement')await renew(actor);
  else if(invalidation==='expiry')await sql.query("UPDATE public.app_auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE digest=$1",[hash(submitted)]);
  else await revokeSessions(db,actor.id);
  const before=await state(),changed=JSON.stringify({...JSON.parse(raw),expected:{privacyGeneration:p.generation+1}});
  trace=[];await reject(erase(changed,{...actor,bearer:submitted}),'unauthorized');assert.deepEqual(await state(),before);
  assert.equal(trace.filter(x=>/FROM listening_v2.command_receipts/.test(x.q)).length,0,'auth failure before receipt/conflict disclosure');
 });

function actualAccounts(subject){return new AccountStore(db,{policy,
 attestFn:()=>({publicKey:'external-crypto-fixture',receipt:Buffer.from('fixture')}),
 apple:{authenticate:async()=>({subjectHash:hash(subject),refreshTokenEncrypted:'external-apple-crypto-fixture'}),revoke:async()=>{}}});}
async function actualGuest(n=9){
 await sql.query('UPDATE public.membership_settings SET public_access_enabled=true WHERE id=1');
 const accounts=actualAccounts('unused'),keyID=key(n),token='lyra_g_'+Buffer.alloc(32,n).toString('base64url');
 const challenge=await accounts.challenge({purpose:'guest',bundleID,keyID},null,'127.0.0.1');
 await accounts.guest({...challenge,bundleID,keyID,credential:token,attestation:'Zml4dHVyZQ=='});
 const a={token,keyID,counter:0,kind:'guest'};await renew(a);
 a.id=(await auth.authenticate(a.bearer)).id;assert.match(a.id,/^guest-/);return a;
}
async function actualSignIn(a,subject){
 const accounts=actualAccounts(subject),source=await auth.authenticate(a.bearer),old=a.bearer,counter=a.counter;
 const prepared=await accounts.prepareWriterAuthentication(old);
 const {challenge}=await accounts.challenge({purpose:'apple',bundleID},source);
 const moved=await accounts.signIn(source,{bundleID,challenge,identityToken:'fixture',authorizationCode:'fixture'},prepared);
 await assert.rejects(auth.authenticate(old),{code:'session_expired'});
 const current={id:moved.userID,kind:'apple',token:moved.credential,keyID:a.keyID,counter};
 // New current S is issued by real challenge/session with the persisted K
 // assertion counter+1, using the actual server-minted C2 from signIn.
 await renew(current);assert.equal(current.counter,counter+1);
 assert.deepEqual(await auth.authenticate(current.bearer),{id:moved.userID,keyID:a.keyID,bundleID,credentialDigest:hash(moved.credential)});
 assert.equal(uint(await scalar('SELECT sign_count FROM public.app_attest_keys WHERE key_id=$1',[a.keyID])),counter+1);
 return current;
}
test('R2 actual AccountStore G->A->B on same K never inherits the original compacted G receipt',async()=>{
 actor=await actualGuest();const {raw,j}=await readyForReceiptScrub('guest');await scrubReadyReceipt(j);
 const original=actor,receipt=await durableReceipt();actor=await actualSignIn(original,'apple-A');
 for(const subject of ['apple-A','apple-B']){
  if(subject==='apple-B')actor=await actualSignIn(actor,subject);
  const before=await state();trace=[];await reject(erase(raw),'unauthorized');assert.deepEqual(await state(),before);
  assert.deepEqual(await durableReceipt(),receipt,'no G principal/key HMAC rebinding');
 }
});
test('R2 actual Apple A erase receipt stays with exact A/K across A->B and another A key cannot inherit',async()=>{
 const guest=await actualGuest();actor=await actualSignIn(guest,'apple-A');
 const {raw,j}=await readyForReceiptScrub('apple',{currentActor:true});await scrubReadyReceipt(j);
 const a=actor,receipt=await durableReceipt(),other=await actualSignIn(await actualGuest(8),'apple-A');
 assert.equal((await auth.authenticate(other.bearer)).id,a.id);assert.notEqual(other.keyID,a.keyID);
 // A owns the terminal persona, so a new command under another key reaches
 // the existing terminal-generation conflict; it never inherits K's outcome.
 let before=await state();await reject(erase(raw,other),'conflict');assert.deepEqual(await state(),before);
 actor=await actualSignIn(a,'apple-B');before=await state();await reject(erase(raw),'unauthorized');assert.deepEqual(await state(),before);
 assert.deepEqual(await durableReceipt(),receipt,'A receipt keeps original ownership/version/hash/retention');
 assert.equal((await auth.authenticate(other.bearer)).id,a.id,'other A key has its own still-valid C/S');
});

for(const kind of ['guest','apple'])test(`R2 ${kind}: retain/erase/all prior actual phases preserve possible-sent guard bytes and replay changes no epoch/gen/job/receipt`,async()=>{
 if(kind==='apple')actor=await enroll('A','apple',2);
 const at=await now();await sql.query(`INSERT INTO listening_v2.output_guards(environment,guard_id,provider,binding_key_version,
 account_binding,connection_lineage,output_scope,scope_kind,original_install_scope,bootstrap_state,lane_state,execution_id,
 send_ordinal,claim_nonce_hash,claim_until_ms,endpoint_body_hash,may_have_been_sent,reserved_visit_credits,safety_capsule,created_at_ms,updated_at_ms)
 VALUES($1,$2,'spotify',1,$3,$4,$5,'captured_output',$6,'legacy_quarantined','uncertain',$7,1,$8,$9,$10,true,3,$11,$12,$12)`,
 [env,randomUUID(),hash('r2-account'),hash('r2-lineage'),hash('r2-output'),hash('r2-install'),randomUUID(),hash('r2-nonce'),at+1000,
 hash('r2-body'),{possibleSent:[1],credits:[1,2,3],observed:['exact-recording'],bootstrap:'legacy-quarantined'},at]);
 const guards=(await state()).output_guards,{p,raw,j,r}=await readyForReceiptScrub(kind,{currentActor:true});
 assert.deepEqual((await state()).output_guards,guards);await scrubReadyReceipt(j);
 assert.deepEqual(await durableReceipt(),{...r,actor_persona_id:null,actor_privacy_generation:null});
 let before=await state(),replay=await erase(raw);assert.equal(replay.replayed,true);
 assert.deepEqual(replay.result,{privacyGeneration:p.generation+1});assert.deepEqual(await state(),before);
 // Separate future-compaction representation fixture. Reaching receipts does
 // NOT mean object/backup completion; only this fixture removes its job/persona.
 await sql.query('DELETE FROM listening_v2.outbox WHERE job_id=$1',[j.job_id]);
 await sql.query('DELETE FROM listening_v2.privacy_personas WHERE persona_id=$1',[p.id]);
 before=await state();replay=await erase(raw);assert.equal(replay.replayed,true);
 assert.deepEqual(replay.result,{privacyGeneration:p.generation+1});assert.deepEqual(await state(),before);
 assert.deepEqual((await state()).output_guards,guards);
});
