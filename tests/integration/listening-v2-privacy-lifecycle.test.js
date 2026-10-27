import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createPrivacyLifecycle} from '../../api/utils/listening-v2/privacy-lifecycle.js';
import {createAdmissionState} from '../../api/utils/listening-v2/admission.js';
import {decodePersonaTuple,decodePrivacyDependency,decodePrivacyScrub,privacyScrubMarker,PRIVACY_CODEC_FIELDS} from '../../api/utils/listening-v2/privacy-codec.js';

// SEALED BEFORE BEHAVIOR. Authored only by this worker: no imports/tests/PG run.
// Root composes actual 030 and approved 033 into db/ before running these bytes.
// This is single-connection SQL proof when run, never concurrency/deployment proof.
const coordinator='preview:lifecycle-coordinator',env='test',other='preview:other',DAY=86400000;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const hash=s=>createHash('sha256').update(String(s)).digest('hex');
const key=n=>Buffer.alloc(32,n%255).toString('base64');
let sql,db,engine,now,trace,fault;
const scalar=async(q,args=[],client=sql)=>(await client.query(q,args)).rows[0];
const value=async(q,args=[],client=sql)=>Object.values(await scalar(q,args,client))[0];
const row=async(table,where,args=[])=>scalar(`SELECT * FROM listening_v2.${table} WHERE ${where}`,args);
const job=async jid=>row('outbox','job_id=$1',[jid]);
const persona=async pid=>row('privacy_personas','persona_id=$1',[pid]);
const code=p=>assert.rejects(p,e=>e.code==='unavailable'&&e.message==='unavailable'&&!e.cause);
async function insert(table,r,tx=sql){const ks=Object.keys(r);return tx.query(`INSERT INTO listening_v2.${table} (${ks.join(',')}) VALUES (${ks.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,Object.values(r));}
async function user(n,kind='guest'){
 await sql.query('INSERT INTO library_users(id,access_kind) VALUES($1,$2) ON CONFLICT DO NOTHING',[`u${n}`,kind]);
 await sql.query(`INSERT INTO library_tokens(digest,user_id,expires_at) VALUES($1,$2,to_timestamp($3::numeric/1000)) ON CONFLICT DO NOTHING`,[hash(n),`u${n}`,now+DAY]);
 await sql.query(`INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt) VALUES($1,$2,'test','test.lyrica','development','fixture',decode('00','hex')) ON CONFLICT DO NOTHING`,[key(n),`u${n}`]);
}
async function seed(n,{environment=env,kind='guest',credential=hash(n),principal=`u${n}`,physicalKey=key(n),expires=now+DAY,created=now-1000}={}){
 await user(n,kind);
 await insert('privacy_personas',{environment,persona_id:id(n),original_principal_id:principal,original_key_id:physicalKey,
 controller_kind:kind,controller_principal_id:principal,controller_key_id:kind==='guest'?physicalKey:null,
 privacy_generation:1,guest_credential_digest:kind==='guest'?credential:null,guest_credential_expires_at_ms:kind==='guest'?expires:null,
 created_at_ms:created,updated_at_ms:created});
}
async function close(n,kind='credential',txfn=null){return db.transaction(async tx=>{
 // This helper is fixture orchestration, NOT source authentication proof.
 await tx.query('SELECT id FROM library_users WHERE id=$1 FOR NO KEY UPDATE',[`u${n}`]);
 await tx.query('SELECT digest FROM library_tokens WHERE digest=$1 FOR UPDATE',[hash(n)]);
 await tx.query('SELECT key_id FROM app_attest_keys WHERE key_id=$1 FOR UPDATE',[key(n)]);
 const prepare={credential:'prepareCredentialClosure','guest-key':'prepareGuestKeyClosure','guest-user':'prepareGuestUserClosure','apple-controller':'prepareAppleControllerClosure','epoch':'prepareAppleEpochAdvance'}[kind];
 const target=kind==='credential'?hash(n):kind==='guest-key'?key(n):`u${n}`;
 const plan=await engine[prepare](tx,target);
 if(kind==='credential')await tx.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[target]);
 else if(kind==='guest-key')await tx.query('UPDATE app_attest_keys SET revoked=true WHERE key_id=$1',[target]);
 else if(kind==='epoch')await tx.query('UPDATE library_users SET sessions_privacy_epoch=sessions_privacy_epoch+1 WHERE id=$1',[target]);
 else await tx.query('UPDATE library_users SET disabled=true WHERE id=$1',[target]);
 return txfn?txfn(tx,plan):engine.persistSourceClosure(tx,plan);
 });}
async function dependency(){const claim=await engine.claimDependency();assert.ok(claim);return engine.processDependency(claim);}
async function scrub(){const claim=await engine.claimScrub();assert.ok(claim);return engine.processScrub(claim);}
async function forceDue(){await sql.query(`UPDATE listening_v2.outbox SET due_at_ms=created_at_ms WHERE state='pending'`);}
async function snapshot(){const out={};for(const t of ['privacy_personas','rooms','returning_grants','semantic_events','command_receipts','outbox','private_profile_assets','output_guards'])out[t]=(await sql.query(`SELECT to_jsonb(t)::text AS row FROM listening_v2.${t} t ORDER BY to_jsonb(t)::text`)).rows;return out;}
async function minimalRoom(n,pid,extras={}){return insert('rooms',{environment:env,session_id:id(10000+n),host_install_scope:hash('host'+n),host_persona_id:pid,host_privacy_generation:1,
 privacy_persona_ids:[pid],provider:'appleMusic',invite_digest:hash('invite'+n),code_digest:hash('code'+n),created_at_ms:now-500,expires_at_ms:now+3600000,updated_at_ms:now-500,...extras});}
async function admissionRoom(n,pid,{guestID=null,saturated=false}={}){
 const install={principalID:`u${n}`,keyID:key(n),bundleID:'test.lyrica',audience:'test',attestEnvironment:'development'};
 const s=structuredClone(createAdmissionState({environment:env,sessionID:id(10000+n),nowMS:now-500,expiresAtMS:now+3600000,title:'Private title',
 host:{install,persona:{id:pid,generation:1},profile:{reference:'private-profile',revision:1,roomConsentRevision:1,persona:{id:pid,generation:1}},memberID:id(20000+n),scope:hash('host'+n)}}));
 if(guestID){s.members.push({id:id(21000+n),install:{...install,principalID:'u2',keyID:key(2)},persona:{id:guestID,generation:1},profileReference:'guest-photo',profileRevision:1,roomConsentRevision:1,status:'active',leaseVersion:1,firstJoinOrdinal:1,joinedAtMS:now-500,endedAtMS:null});s.lifetimeMemberCount=2;s.lifetimeRequestCount=1;}
 const meta={version:1,miscCount:0,reservedEvents:guestID?1:0,reservedReceipts:guestID?2:1,storefront:'us'};
 return minimalRoom(n,pid,{invite_generation:s.inviteGeneration,privacy_persona_ids:guestID?[pid,guestID]:[pid],state:{occurrences:[],visits:[],admission:s,admissionStore:meta},
 reserved_semantic_events:meta.reservedEvents,reserved_receipts:meta.reservedReceipts,
 semantic_event_count:saturated?20000-meta.reservedEvents:0,receipt_count:saturated?30000-meta.reservedReceipts:0,
 event_seq:saturated?30000:0});
}
before(async()=>{
 sql=new PGlite();await sql.exec('CREATE ROLE lyra_runtime_v1; CREATE ROLE lyra_account_v1;');
 for(const f of ['001-song-library.sql','021-app-auth.sql','022-live-lyrics-push.sql','025-memberships.sql','029-listening-sessions.sql','030-listening-v2-schema.sql','031-listening-v2-lifecycle-support.sql','032-auth-token-row-locks.sql','033-listening-v2-lifecycle-composition.sql'])await sql.exec(await readFile(new URL('../../db/'+f,import.meta.url),'utf8'));
 db={query:(...a)=>sql.query(...a),transaction:fn=>sql.transaction(tx=>fn({query:async(q,args=[])=>{trace.push({q,args:structuredClone(args)});const result=await tx.query(q,args);if(fault)await fault(q,args,result,tx);return result;}}))};
});
after(async()=>{await sql?.close();});
beforeEach(async()=>{
 trace=[];fault=null;await sql.exec('TRUNCATE listening_v2.command_receipts,listening_v2.semantic_events,listening_v2.outbox,listening_v2.private_profile_assets,listening_v2.returning_grants,listening_v2.rooms,listening_v2.privacy_personas,listening_v2.output_guards; TRUNCATE library_users CASCADE;');
 now=Number(await value('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text'));
 engine=createPrivacyLifecycle({db,coordinatorEnvironment:coordinator});
});

test('construction has zero IO, exact options, immutable API and rejects clock/callback/selector configuration',()=>{
 let calls=0;const d={query(){calls++;throw Error();},transaction(){calls++;throw Error();}};
 const s=createPrivacyLifecycle({db:d,coordinatorEnvironment:coordinator});assert.equal(calls,0);assert.ok(Object.isFrozen(s));
 for(const extra of [{clock:()=>0},{selector:{kind:'indexed-sweep'}},{authorize:()=>true},{environment:env}])assert.throws(()=>createPrivacyLifecycle({db:d,coordinatorEnvironment:coordinator,...extra}));
});
for(const kind of ['credential','guest-key','guest-user','apple-controller','epoch'])test(`actual ${kind} negative pre/post produces exact global031 payload and account-only insert columns`,async()=>{
 await seed(1,{kind:kind==='apple-controller'||kind==='epoch'?'apple':'guest'});
 const result=await close(1,kind);const r=await job(result.jobID);
 const p=decodePrivacyDependency(JSON.stringify(r.payload));assert.equal(p.payload.environment,coordinator);assert.equal(p.payload.cursor,null);
 assert.equal(p.payload.selector.kind,kind==='epoch'?'apple-controller':kind);assert.ok(p.payload.invalidatedAtMS<=Number(r.created_at_ms));
 assert.equal(r.job_key,`privacy-dependency:${r.job_id}`);
 for(const k of ['room_id','guard_id','persona_id','asset_id','privacy_generation','guard_revision','send_ordinal'])assert.equal(r[k],null);
 const writes=trace.filter(x=>/INSERT INTO listening_v2.outbox/.test(x.q));assert.equal(writes.length,1);assert.doesNotMatch(writes[0].q,/claim_epoch|state\s*,|room_id|guard_id/);
});
test('pre/post plan is same-client/xid, unforgeable, one-shot, refuses no negative postimage and rolls source mutation back',async()=>{
 await seed(1);await db.transaction(async tx=>{const p=await engine.prepareCredentialClosure(tx,hash(1));await code(engine.persistSourceClosure(tx,{}));await code(engine.persistSourceClosure(tx,p));});
 let plan;await db.transaction(async tx=>{plan=await engine.prepareCredentialClosure(tx,hash(1));});
 await db.transaction(async tx=>{await tx.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[hash(1)]);await code(engine.persistSourceClosure(tx,plan));});
 assert.equal(await value('SELECT count(*)::int FROM listening_v2.outbox'),0);
});
test('already-dead source without a prepared preimage is repair failure, never timestamped now',async()=>{
 await seed(1);await sql.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[hash(1)]);
 await code(db.transaction(tx=>engine.prepareCredentialClosure(tx,hash(1))));assert.equal(await value('SELECT count(*)::int FROM listening_v2.outbox'),0);
});
test('expiry uses exact retained DB deadline, not processor time or null token expiry',async()=>{
 await seed(1,{expires:now-1,created:now-1000});await sql.query('UPDATE library_tokens SET expires_at=to_timestamp($2::numeric/1000) WHERE digest=$1',[hash(1),now-1]);
 const result=await db.transaction(async tx=>engine.persistSourceClosure(tx,await engine.prepareCredentialExpiry(tx,hash(1))));
 assert.equal((await job(result.jobID)).payload.invalidatedAtMS,now-1);await dependency();assert.equal(Number((await persona(id(1))).withdrawn_at_ms),now-1);
});
test('coalescing verifies exact unfinished selector and <=incoming, never account UPDATE or fallback success',async()=>{
 await seed(1);const a=await close(1);await sql.query('UPDATE library_tokens SET revoked=false WHERE digest=$1',[hash(1)]);
 const b=await close(1);assert.equal(b.jobID,a.jobID);assert.equal(await value('SELECT count(*)::int FROM listening_v2.outbox'),1);
 assert.equal(trace.filter(x=>/UPDATE listening_v2.outbox/.test(x.q)).length,0);
});
test('earlier runtime repair CAS resets cursor only for earlier real evidence and preserves metadata/dead responsibility',async()=>{
 await seed(1);const a=await close(1);const old=await job(a.jobID);
 await sql.query(`UPDATE listening_v2.outbox SET payload=jsonb_set(payload,'{cursor}',$2::jsonb) WHERE job_id=$1`,[a.jobID,JSON.stringify([other,id(999)])]);
 await sql.query('UPDATE library_tokens SET revoked=false,expires_at=to_timestamp($2::numeric/1000) WHERE digest=$1',[hash(1),now-1]);
 await db.transaction(async tx=>{const p=await engine.prepareCredentialExpiry(tx,hash(1));await engine.repairSourceClosure(tx,p);});
 const repaired=await job(a.jobID);assert.equal(repaired.payload.cursor,null);assert.equal(repaired.payload.invalidatedAtMS,now-1);
 for(const k of ['job_id','created_at_ms','retry_until_ms','attempt_count','claim_epoch','state'])assert.equal(String(repaired[k]),String(old[k]));
});
test('account earlier-time conflict and runtime claimed repair fail closed',async()=>{
 await seed(1);await close(1);const c=await engine.claimDependency();assert.ok(c);
 await sql.query('UPDATE library_tokens SET revoked=false,expires_at=to_timestamp($2::numeric/1000) WHERE digest=$1',[hash(1),now-1]);
 await code(db.transaction(async tx=>engine.persistSourceClosure(tx,await engine.prepareCredentialExpiry(tx,hash(1)))));
 await code(db.transaction(async tx=>engine.repairSourceClosure(tx,await engine.prepareCredentialExpiry(tx,hash(1)))));
});
test('exact claim handles are instance-owned and detached from mutable inputs; forged/cross-instance handles do no SQL',async()=>{
 await seed(1);await close(1);const c=await engine.claimDependency();assert.ok(Object.isFrozen(c));const before=trace.length;
 await code(engine.processDependency({}));await code(createPrivacyLifecycle({db,coordinatorEnvironment:coordinator}).processDependency(c));assert.equal(trace.length,before);
 await engine.processDependency(c);await code(engine.processDependency(c));
});
test('claim transaction is outbox-only and releases before source/persona/job-last processing',async()=>{
 await seed(1);await close(1);trace=[];const c=await engine.claimDependency();assert.ok(c);
 assert.ok(trace.every(x=>!/(?:public\.|privacy_personas|rooms|output_guards)/.test(x.q)));
 trace=[];await engine.processDependency(c);const locks=trace.filter(x=>/FOR (?:NO KEY )?UPDATE/.test(x.q));
 assert.match(locks.at(-1).q,/listening_v2.outbox/);assert.ok(locks.findIndex(x=>/library_users/.test(x.q))<locks.findIndex(x=>/privacy_personas/.test(x.q)));
});
for(const kind of ['credential','guest-key','guest-user','apple-controller'])test(`${kind}: real first/successor global C tuple, exact100 batch, final publication separate`,async()=>{
 const apple=kind==='apple-controller';await user(1,apple?'apple':'guest');
 for(let n=1;n<=101;n++)await seed(n,{environment:`preview:page-${String(n).padStart(3,'0')}`,kind:apple?'apple':'guest',principal:'u1',physicalKey:key(1),credential:hash(1)});
 await close(1,kind);let r=await dependency();assert.equal(r.processed,100);assert.equal(r.status,'pending');
 assert.equal(await value("SELECT count(*)::int FROM listening_v2.privacy_personas WHERE status='withdrawn'"),100);
 await forceDue();r=await dependency();assert.equal(r.processed,1);await forceDue();r=await dependency();assert.equal(r.status,'published');
 const seeks=trace.filter(x=>/FROM listening_v2.privacy_personas/.test(x.q)&&/LIMIT 100/.test(x.q));assert.ok(seeks.some(x=>/COLLATE "C".*persona_id\)>/.test(x.q.replaceAll('\n',' '))));
});
test('auth unions are bounded before locks, no truncated required owner set',async()=>{
 for(let n=1;n<=65;n++)await seed(n,{expires:now-1,created:now-1000});
 await sql.query('UPDATE library_tokens SET expires_at=to_timestamp($1::numeric/1000)',[now-1]);
 await engine.ensureSweep();const r=await dependency();assert.ok(r.processed<=64&&r.processed>0);
 assert.equal(await value("SELECT count(*)::int FROM listening_v2.privacy_personas WHERE status='withdrawn'"),r.processed);
});
test('transferred live Apple is irrelevant to old C; original generation never rewithdrawn',async()=>{
 await seed(1);await user(2,'apple');await sql.query(`UPDATE listening_v2.privacy_personas SET controller_kind='apple',controller_principal_id='u2',controller_key_id=NULL,guest_credential_digest=NULL,guest_credential_expires_at_ms=NULL,privacy_generation=2,private_transfer_from_generation=1 WHERE persona_id=$1`,[id(1)]);
 await close(1);await dependency();const p=await persona(id(1));assert.equal(p.status,'live');assert.equal(Number(p.privacy_generation),2);
});
test('sweep rotates beyond first100 valid rows; missing revocation time refuses without invented withdrawal',async()=>{
 for(let n=1;n<=101;n++)await seed(n);await sql.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[hash(101)]);
 await engine.ensureSweep();const a=await dependency();assert.ok(a.processed>0);await forceDue();const c=await engine.claimDependency();await code(engine.processDependency(c));
 assert.equal((await persona(id(101))).status,'live');assert.equal(await value("SELECT count(*)::int FROM listening_v2.outbox WHERE state<>'published'"),1);
});
test('withdrawal CAS, exact 41-byte marker and typed scrub handoff/cursor commit atomically',async()=>{
 await seed(1);await close(1);await dependency();const p=await persona(id(1));assert.equal(p.status,'withdrawn');assert.equal(Number(p.privacy_generation),2);assert.equal(Buffer.byteLength(p.scrub_cursor),41);
 const s=await row('outbox',"kind='privacy_scrub'");const decoded=decodePrivacyScrub(JSON.stringify(s.payload));assert.equal(s.persona_id,p.persona_id);assert.equal(Number(s.privacy_generation),2);
 assert.equal(p.scrub_cursor,privacyScrubMarker(s.job_id,'rooms'));assert.equal(decoded.payload.scrubDueAtMS,decoded.payload.withdrawnAtMS+DAY);
 const tuple=PRIVACY_CODEC_FIELDS.personaTuple.map(k=>['privacy_generation','guest_credential_expires_at_ms','withdrawn_at_ms','scrub_due_at_ms','created_at_ms','updated_at_ms','controller_privacy_epoch','private_transfer_from_generation'].includes(k)&&p[k]!==null?Number(p[k]):p[k]);
 assert.equal(decodePersonaTuple(JSON.stringify(tuple)).normalizedBytes,Number(await value(`SELECT octet_length(jsonb_build_array(${PRIVACY_CODEC_FIELDS.personaTuple.join(',')})::text) FROM listening_v2.privacy_personas WHERE persona_id=$1`,[id(1)])));
});
test('handoff INSERT failure rolls back persona and cursor, leaving claim recoverable',async()=>{
 await seed(1);const a=await close(1);const c=await engine.claimDependency();const before=await snapshot();
 fault=q=>{if(/INSERT INTO listening_v2.outbox/.test(q))throw Error('injected');};await code(engine.processDependency(c));fault=null;assert.deepEqual(await snapshot(),before);assert.equal((await job(a.jobID)).state,'claimed');
});
test('stale epoch, payload, cursor and nonce each refuse before persona mutation',async()=>{
 for(const field of ['claim_epoch','claim_nonce_hash','payload']){
 await sql.exec('DELETE FROM listening_v2.outbox; DELETE FROM listening_v2.privacy_personas; TRUNCATE library_users CASCADE;');await seed(1);const a=await close(1);const c=await engine.claimDependency();
 if(field==='payload')await sql.query("UPDATE listening_v2.outbox SET payload=jsonb_set(payload,'{cursor}',$2::jsonb) WHERE job_id=$1",[a.jobID,JSON.stringify([other,id(2)])]);
 else await sql.query(`UPDATE listening_v2.outbox SET ${field}=${field==='claim_epoch'?'claim_epoch+1':'$2'} WHERE job_id=$1`,field==='claim_epoch'?[a.jobID]:[a.jobID,hash('stale')]);
 await code(engine.processDependency(c));assert.equal((await persona(id(1))).status,'live');
 }
});
test('dead and retry-expired hints retain responsibility; no age deletion or ACK publication',async()=>{
 await seed(1);const a=await close(1);await sql.query('UPDATE listening_v2.outbox SET attempt_count=10 WHERE job_id=$1',[a.jobID]);assert.equal(await engine.claimDependency(),null);
 const dead=await job(a.jobID);assert.equal(dead.state,'dead');assert.equal(dead.payload.invalidatedAtMS,(await job(a.jobID)).payload.invalidatedAtMS);
 assert.equal(await value('SELECT count(*)::int FROM listening_v2.outbox'),1);assert.equal((await persona(id(1))).status,'live');
});
test('dead successor atomically keeps selector/timestamp/cursor/original retry envelope and blocks era release',async()=>{
 await seed(1);const a=await close(1);await sql.query('UPDATE listening_v2.outbox SET attempt_count=10 WHERE job_id=$1',[a.jobID]);await engine.claimDependency();
 const old=await job(a.jobID);const replacement=await engine.replaceDeadDependency(a.jobID);const next=await job(replacement.jobID);
 assert.deepEqual(next.payload,old.payload);assert.equal(String(next.created_at_ms),String(old.created_at_ms));assert.equal(String(next.retry_until_ms),String(old.retry_until_ms));
 assert.equal((await job(a.jobID)).state,'published');assert.equal(next.state,'pending');assert.equal(await value("SELECT count(*)::int FROM listening_v2.outbox WHERE state<>'published' AND payload->'selector'=$1::jsonb",[JSON.stringify(old.payload.selector)]),1);
});
test('final fence restarts from first when a matching live row appears behind cursor; no resurrection publication',async()=>{
 await seed(1);const a=await close(1);await dependency();await seed(2,{environment:'development',principal:'u1',physicalKey:key(1),credential:hash(1),created:now-1000});
 await forceDue();const r=await dependency();assert.notEqual(r.status,'published');assert.equal((await job(a.jobID)).state,'pending');assert.equal((await job(a.jobID)).payload.cursor,null);
});
test('later incarnation behind old T0 fails closed instead of receiving pre-incarnation time',async()=>{
 await seed(1);await close(1);await dependency();const at=Number(await value('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text'));
 await seed(2,{environment:'development',principal:'u1',physicalKey:key(1),credential:hash(1),created:at+1});await forceDue();await dependency();await forceDue();const c=await engine.claimDependency();await code(engine.processDependency(c));assert.equal((await persona(id(2))).status,'live');
});
test('room phase rewrites at most one room and preserves row order/count/safety guards',async()=>{
 await seed(1);await minimalRoom(1,id(1));await minimalRoom(2,id(1));await close(1);await dependency();await scrub();
 assert.equal(await value('SELECT count(*)::int FROM listening_v2.rooms WHERE host_persona_id IS NULL'),1);
 const s=await row('outbox',"kind='privacy_scrub'");assert.equal(s.payload.phase,'rooms');assert.ok(s.payload.cursor);
});
test('host uses independent End lane at ordinary cap, no guest remove; redaction preserves install scope and credits',async()=>{
 await seed(1);await admissionRoom(1,id(1),{saturated:true});await close(1);await dependency();await scrub();
 const r=await row('rooms','session_id=$1',[id(10001)]);assert.equal(r.status,'ended');assert.equal(r.host_persona_id,null);assert.equal(Number(r.semantic_event_count),20000);assert.equal(Number(r.event_seq),30001);
 assert.equal(r.host_install_scope,hash('host1'));assert.equal(r.terminal_reservation_bytes,8192);assert.equal(r.receipt_count,29999);
 assert.equal(r.state.admission.originalHost.install,null);assert.equal(r.state.admission.originalHost.persona,null);assert.equal(r.state.admission.members[0].status,'ended');
 const event=await row('semantic_events',"lane='end'");assert.equal(event.type,'session.ended');assert.deepEqual(event.payload,{reason:'privacy_withdrawn'});assert.equal(event.actor_persona_id,null);
});
test('unknown room object/occurrence shape refuses atomically and retains original due responsibility',async()=>{
 await seed(1);await minimalRoom(1,id(1),{state:{occurrences:[],visits:[],unknown:{name:'private'}}});await close(1);await dependency();const c=await engine.claimScrub();const before=await snapshot();await code(engine.processScrub(c));assert.deepEqual(await snapshot(),before);
});
for(const phase of ['grants-host','grants-guest','grants-approver','events','receipts','assets','complete'])test(`${phase}: exact typed successor cursor and generation/withdrawal/deadline CAS`,async()=>{
 await seed(1);await close(1);await dependency();let s=await row('outbox',"kind='privacy_scrub'");
 await sql.query("UPDATE listening_v2.outbox SET payload=jsonb_set(payload,'{phase}',to_jsonb($2::text)) WHERE job_id=$1",[s.job_id,phase]);
 await sql.query('UPDATE listening_v2.privacy_personas SET scrub_cursor=$2 WHERE persona_id=$1',[id(1),privacyScrubMarker(s.job_id,phase)]);
 if(phase==='complete'){const result=await scrub();assert.equal(result.status,'unavailable');assert.equal((await job(s.job_id)).state,'pending');}
 else {const result=await scrub();assert.equal(result.status,'pending');s=await job(s.job_id);assert.ok(decodePrivacyScrub(JSON.stringify(s.payload)));}
});
test('full receipt suffix prevents shared-command collisions; minimal outcomes retain binding/hash/status/action',async()=>{
 await seed(1);await minimalRoom(1,id(1));for(let n=1;n<=3;n++)await insert('command_receipts',{environment:env,session_id:id(10001),room_id:id(10001),principal_binding:hash(n),key_binding:hash(99-n),command_id:id(99000),binding_key_version:1,action:'leave',canonical_body_hash:hash('body'),status:'uncertain',actor_persona_id:id(1),actor_privacy_generation:1,result:{profileReference:'private'},created_at_ms:now,delete_after_ms:now+30*DAY});
 await close(1);await dependency();let s=await row('outbox',"kind='privacy_scrub'");await sql.query("UPDATE listening_v2.outbox SET payload=jsonb_set(payload,'{phase}','\"receipts\"') WHERE job_id=$1",[s.job_id]);await sql.query('UPDATE listening_v2.privacy_personas SET scrub_cursor=$2 WHERE persona_id=$1',[id(1),privacyScrubMarker(s.job_id,'receipts')]);await scrub();
 const rows=(await sql.query('SELECT * FROM listening_v2.command_receipts ORDER BY principal_binding')).rows;assert.equal(rows.length,3);
 for(const r of rows){assert.equal(r.actor_persona_id,null);assert.deepEqual(r.result,{version:2,redacted:true});assert.equal(r.status,'uncertain');assert.equal(r.canonical_body_hash,hash('body'));assert.equal(r.action,'leave');}
});
test('assets use full original generation scope, revoke once and retain object/backup pending without fake deletion',async()=>{
 await seed(1);await insert('private_profile_assets',{environment:env,asset_id:id(50000),persona_id:id(1),privacy_generation:1,asset_generation:1,install_scope:hash('install'),state:'current',object_key:id(50001),content_hash:hash('content'),content_type:'image/png',byte_count:100,width:10,height:10,created_at_ms:now-500,stage_expires_at_ms:now+1000});
 await close(1);await dependency();let s=await row('outbox',"kind='privacy_scrub'");await sql.query("UPDATE listening_v2.outbox SET payload=jsonb_set(payload,'{phase}','\"assets\"') WHERE job_id=$1",[s.job_id]);await sql.query('UPDATE listening_v2.privacy_personas SET scrub_cursor=$2 WHERE persona_id=$1',[id(1),privacyScrubMarker(s.job_id,'assets')]);await scrub();
 const asset=await row('private_profile_assets','asset_id=$1',[id(50000)]);assert.equal(asset.state,'revoked');assert.equal(asset.object_key,id(50001));assert.equal(asset.deleted_at_ms,null);assert.equal(Number(asset.backup_delete_due_at_ms),Number(asset.withdrawn_at_ms)+30*DAY);
 assert.equal((await job(s.job_id)).state,'pending');assert.equal(await value("SELECT count(*)::int FROM listening_v2.outbox WHERE kind='asset_delete'"),1);
});
test('uncertain room-independent guard stays byte-identical, including possible-send/capsule/reservations',async()=>{
 await seed(1);await insert('output_guards',{environment:env,guard_id:id(60000),provider:'spotify',binding_key_version:1,account_binding:hash(1),connection_lineage:hash(2),output_scope:hash(3),scope_kind:'captured_output',original_install_scope:hash(4),bootstrap_state:'legacy_quarantined',lane_state:'uncertain',execution_id:id(60001),send_ordinal:1,claim_nonce_hash:hash(5),claim_until_ms:now+1000,endpoint_body_hash:hash(6),may_have_been_sent:true,reserved_visit_credits:3,safety_capsule:{observed:['exact-recording']},created_at_ms:now,updated_at_ms:now});
 const before=await row('output_guards','guard_id=$1',[id(60000)]);await minimalRoom(1,id(1));await close(1);await dependency();await scrub();assert.deepEqual(await row('output_guards','guard_id=$1',[id(60000)]),before);
});
test('account producer actually executes with limited role; no event/counter/outbox UPDATE widening',async()=>{
 await seed(1);await db.transaction(async tx=>{await tx.query('SET LOCAL ROLE lyra_account_v1');const p=await engine.prepareCredentialClosure(tx,hash(1));await tx.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[hash(1)]);await engine.persistSourceClosure(tx,p);});
 assert.equal(await value('SELECT count(*)::int FROM listening_v2.outbox'),1);
 await assert.rejects(sql.transaction(async tx=>{await tx.query('SET LOCAL ROLE lyra_account_v1');await tx.query("UPDATE listening_v2.outbox SET attempt_count=1");}),{code:'42501'});
});

for(const side of ['host','guest','approver'])test(`grant ${side} redaction revokes only exact retained generation with complete grant cursor`,async()=>{
 await seed(1);await seed(2);await insert('returning_grants',{environment:env,grant_id:id(70001),host_install_scope:hash('host'),pair_digest:hash('pair'),hmac_key_version:1,grant_generation:1,status:'active',host_persona_id:id(side==='host'?1:2),host_privacy_generation:1,guest_persona_id:id(side==='guest'?1:2),guest_privacy_generation:1,approver_persona_id:side==='approver'?id(1):null,approver_privacy_generation:side==='approver'?1:null,created_at_ms:now,updated_at_ms:now});
 await close(1);await dependency();const s=await row('outbox',"kind='privacy_scrub'");const phase='grants-'+side;
 await sql.query("UPDATE listening_v2.outbox SET payload=jsonb_set(payload,'{phase}',to_jsonb($2::text)) WHERE job_id=$1",[s.job_id,phase]);await sql.query('UPDATE listening_v2.privacy_personas SET scrub_cursor=$2 WHERE persona_id=$1',[id(1),privacyScrubMarker(s.job_id,phase)]);await scrub();
 const g=await row('returning_grants','grant_id=$1',[id(70001)]);assert.equal(g[side+'_persona_id'],null);assert.equal(g.status,'revoked');assert.equal(Number(g.grant_generation),2);
});
test('event page bounded100, full session/seq cursor and opaque payload refusal before actor mutation',async()=>{
 await seed(1);await minimalRoom(1,id(1));for(let n=1;n<=101;n++)await insert('semantic_events',{environment:env,session_id:id(10001),event_id:id(80000+n),seq:n,lane:'semantic',lane_seq:n,state_version:0,type:'member.left',actor_persona_id:id(1),actor_privacy_generation:1,payload:{memberID:id(20001)},server_at_ms:now,delete_after_ms:now+DAY});
 await close(1);await dependency();const s=await row('outbox',"kind='privacy_scrub'");await sql.query("UPDATE listening_v2.outbox SET payload=jsonb_set(payload,'{phase}','\"events\"') WHERE job_id=$1",[s.job_id]);await sql.query('UPDATE listening_v2.privacy_personas SET scrub_cursor=$2 WHERE persona_id=$1',[id(1),privacyScrubMarker(s.job_id,'events')]);await scrub();
 assert.equal(await value('SELECT count(*)::int FROM listening_v2.semantic_events WHERE actor_persona_id IS NULL'),100);assert.deepEqual((await job(s.job_id)).payload.cursor,[id(10001),100]);
});
test('unknown actor event type retains typed responsibility rather than deleting guessed JSON',async()=>{
 await seed(1);await minimalRoom(1,id(1));await insert('semantic_events',{environment:env,session_id:id(10001),event_id:id(81000),seq:1,lane:'semantic',lane_seq:1,state_version:0,type:'unknown.shape',actor_persona_id:id(1),actor_privacy_generation:1,payload:{name:'private'},server_at_ms:now,delete_after_ms:now+DAY});
 await close(1);await dependency();const s=await row('outbox',"kind='privacy_scrub'");await sql.query("UPDATE listening_v2.outbox SET payload=jsonb_set(payload,'{phase}','\"events\"') WHERE job_id=$1",[s.job_id]);await sql.query('UPDATE listening_v2.privacy_personas SET scrub_cursor=$2 WHERE persona_id=$1',[id(1),privacyScrubMarker(s.job_id,'events')]);const c=await engine.claimScrub();const before=await snapshot();await code(engine.processScrub(c));assert.deepEqual(await snapshot(),before);
});

// Review regressions: added and sealed before the corresponding source repair.
async function withdrawAndScrubRooms(n){
 const closure=await close(n);
 await sql.query("UPDATE listening_v2.outbox SET due_at_ms=retry_until_ms-1 WHERE kind='privacy_dependency' AND state='pending' AND job_id<>$1",[closure.jobID]);
 await sql.query('UPDATE listening_v2.outbox SET due_at_ms=created_at_ms WHERE job_id=$1',[closure.jobID]);
 await dependency();
 const s=await row('outbox',"kind='privacy_scrub' AND persona_id=$1",[id(n)]);
 await sql.query("UPDATE listening_v2.outbox SET due_at_ms=retry_until_ms-1 WHERE kind='privacy_scrub' AND state='pending' AND job_id<>$1",[s.job_id]);
 await sql.query('UPDATE listening_v2.outbox SET due_at_ms=created_at_ms WHERE job_id=$1',[s.job_id]);
 const claim=await engine.claimScrub();assert.ok(claim);
 return {claim,jobID:s.job_id};
}
async function pendingRoom(){
 await seed(1);await seed(2);await admissionRoom(1,id(1));
 const r=await row('rooms','session_id=$1',[id(10001)]),s=structuredClone(r.state);
 const a=s.admission;
 a.pending=[{id:id(30002),version:1,status:'pending',install:{principalID:'u2',keyID:key(2),bundleID:'test.lyrica',audience:'test',attestEnvironment:'development'},
  persona:{id:id(2),generation:1},pairDigest:hash('pending-pair'),profileReference:'pending-private-photo',profileRevision:1,
  roomConsentRevision:1,inviteGeneration:a.inviteGeneration,createdAtMS:a.createdAtMS,expiresAtMS:a.createdAtMS+120000}];
 a.lifetimeRequestCount=1;s.admissionStore.reservedEvents=3;s.admissionStore.reservedReceipts=3;
 await sql.query('UPDATE listening_v2.rooms SET state=$3,privacy_persona_ids=$4,reserved_semantic_events=3,reserved_receipts=3 WHERE environment=$1 AND session_id=$2',
  [env,r.session_id,s,[id(1),id(2)]]);
}
for(const order of [[1,2],[2,1]])test(`negative host/requester rooms round-trip in withdrawal order ${order.join('-')}`,async()=>{
 await pendingRoom();
 for(const n of order){
  const {claim,jobID}=await withdrawAndScrubRooms(n);const result=await engine.processScrub(claim);
  assert.equal(result.processed,1);assert.equal((await job(jobID)).payload.cursor,id(10001));
  const r=await row('rooms','session_id=$1',[id(10001)]);
  assert.equal(r.privacy_persona_ids.includes(id(n)),false);
  if(n===1){assert.equal(r.status,'ended');assert.equal(r.state.admission.originalHost.persona,null);}
 }
 const r=await row('rooms','session_id=$1',[id(10001)]);
 assert.equal(r.state.admission.pending.length,0);assert.deepEqual(r.privacy_persona_ids,[]);
 assert.equal(r.state.admission.lifetimeRequestCount,1);assert.equal(r.state.admission.lifetimeMemberCount,1);
 assert.equal(r.state.admission.members[0].status,'ended');assert.equal(r.state.admission.privacyRedaction,2);
 assert.equal(Number(await value("SELECT count(*)::int FROM listening_v2.semantic_events WHERE lane='end'")),1);
});
for(const [label,bad] of [['string','0'],['null',null],['before-join',-1],['after-update',Number.MAX_SAFE_INTEGER],['structured',{private:'must refuse'}]])
 test(`negative host ${label} terminal timestamp refuses atomically without scrub progress`,async()=>{
  await seed(1);await seed(2);await admissionRoom(1,id(1),{guestID:id(2)});
  const h=await withdrawAndScrubRooms(1);await engine.processScrub(h.claim);
  const r=await row('rooms','session_id=$1',[id(10001)]),state=structuredClone(r.state);
  state.admission.members[0].endedAtMS=bad;
  await sql.query('UPDATE listening_v2.rooms SET state=$3 WHERE environment=$1 AND session_id=$2',[env,r.session_id,state]);
  const p=await withdrawAndScrubRooms(2),before=await snapshot();
  await code(engine.processScrub(p.claim));assert.deepEqual(await snapshot(),before);
 });

// PPS-INT-01 scrub validation: actual claims and phase processing; deliberately
// seeded erase row tests scrub representation, not private-service acceptance.
async function receiptFixture(result,changes={}){
 await seed(1);await insert('command_receipts',{environment:env,session_id:id(1),principal_binding:hash('p'),key_binding:hash('k'),
  command_id:id(99100),binding_key_version:1,room_id:null,action:'privacy.erase',canonical_body_hash:hash('body'),status:'accepted',
  actor_persona_id:id(1),actor_privacy_generation:1,result,created_at_ms:now,delete_after_ms:now+30*DAY,...changes});
 await close(1);await dependency();
 for(let n=0;n<5;n++){await forceDue();await scrub();}
 const jobRow=await row('outbox',"kind='privacy_scrub'");assert.equal(jobRow.payload.phase,'receipts');
 await forceDue();const claim=await engine.claimScrub();assert.ok(claim);return claim;
}
test('erase scrub clears both actor references and preserves exact minimal result and every other field',async()=>{
 const claim=await receiptFixture({privacyGeneration:2}),before=await row('command_receipts','session_id=$1',[id(1)]);
 await engine.processScrub(claim);const after=await row('command_receipts','session_id=$1',[id(1)]);
 assert.deepEqual(after,{...before,actor_persona_id:null,actor_privacy_generation:null});
});
for(const result of [{privacyGeneration:3},{privacyGeneration:0},{privacyGeneration:'2'},{privacyGeneration:2,extra:true},{version:2,redacted:true}])
 test(`erase scrub refuses result ${JSON.stringify(result)} without progress`,async()=>{
 const claim=await receiptFixture(result),before=await snapshot();await code(engine.processScrub(claim));assert.deepEqual(await snapshot(),before);
});
for(const change of [{status:'refused'},{session_id:id(2)},{action:'privacy.erase',actor_privacy_generation:0}])
 test(`erase scrub refuses inconsistent row ${JSON.stringify(change)} without progress`,async()=>{
 const claim=await receiptFixture({privacyGeneration:2},change),before=await snapshot();await code(engine.processScrub(claim));assert.deepEqual(await snapshot(),before);
});

// PPS-INT-01 R2 AMENDMENT: complete test bytes sealed before any further
// corrective production behavior; no retroactive claim about R1 execution.
const otherReceiptActions=['create','restart','join','admission.request','admission.decide','admission.cancel',
 'leave','settings.update','remembered.forget','end'];
for(const action of otherReceiptActions)test(`R2 ${action}: all actual earlier phases retain original non-erase receipt scrub postimage`,async()=>{
 await seed(1);await minimalRoom(1,id(1));
 const receipt={environment:env,session_id:id(10001),room_id:id(10001),principal_binding:hash('r2-principal'),key_binding:hash('r2-key'),
 command_id:id(99500),binding_key_version:1,action,canonical_body_hash:hash('r2-body'),status:'accepted',actor_persona_id:id(1),
 actor_privacy_generation:1,result:{profileReference:'must disappear',privacyGeneration:2},created_at_ms:now,
 ticket_expires_at_ms:['create','restart'].includes(action)?now+600000:null,delete_after_ms:now+30*DAY};
 await insert('command_receipts',receipt);const before=await row('command_receipts','command_id=$1',[receipt.command_id]);
 await close(1);await dependency();const phases=[];
 for(let step=0;step<14;step++){
  const j=await row('outbox',"kind='privacy_scrub'");
  assert.notEqual(j.payload.phase,'assets','receipt must have been scrubbed before assets');
  if(phases.at(-1)!==j.payload.phase)phases.push(j.payload.phase);
  await forceDue();await scrub();
  if((await row('command_receipts','command_id=$1',[receipt.command_id])).actor_persona_id===null)break;
 }
 assert.deepEqual(phases,['rooms','grants-host','grants-guest','grants-approver','events','receipts']);
 assert.deepEqual(await row('command_receipts','command_id=$1',[receipt.command_id]),
 {...before,actor_persona_id:null,actor_privacy_generation:null,result:{version:2,redacted:true}});
});
for(const [label,statement] of [
 ['actor UUID alone','actor_persona_id=NULL'],['actor generation alone','actor_privacy_generation=NULL'],
 ['non-create ticket','ticket_expires_at_ms=created_at_ms+1'],['shortened retention','delete_after_ms=delete_after_ms-1']
])test(`R2 erase ${label}: unchanged actual CHECK refuses instead of a bypassed malformed scrub fixture`,async()=>{
 const claim=await receiptFixture({privacyGeneration:2}),before=await snapshot();
 await assert.rejects(sql.query('UPDATE listening_v2.command_receipts SET '+statement),{code:'23514'});
 assert.deepEqual(await snapshot(),before);await engine.processScrub(claim);
 const r=await row('command_receipts','session_id=$1',[id(1)]);
 assert.equal(r.actor_persona_id,null);assert.equal(r.actor_privacy_generation,null);assert.deepEqual(r.result,{privacyGeneration:2});
});
