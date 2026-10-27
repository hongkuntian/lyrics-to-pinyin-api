import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createTerminalClaims} from '../../api/utils/listening-v2/terminal-claims.js';

// SEALED BEFORE BEHAVIOR. Authoring + node --check only in this worker.
// Root must apply/run against the pinned stack. PGlite is single-connection SQL
// representation/rollback proof only; SKIP LOCKED contention needs real PG.
// No semantic store exists here: >11 successful pages/refunds are NOT tested.
const DAY=86400000,MAX=9007199254740991,coordinator='preview:terminal-claims';
const digest=n=>String(n).padStart(64,'0'),uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const migrationNames=['001-song-library.sql','003-correction-foundation.sql','005-correction-batches.sql',
 '007-correction-publication.sql','009-study-explanations.sql','012-multilingual-content.sql',
 '013-pronunciation-aids.sql','014-lyric-source-refresh.sql','015-gpt6-luna.sql',
 '016-personal-unlimited-access.sql','017-translation-reuse.sql','018-translation-attempts.sql',
 '020-catalog-recording-bindings.sql','021-app-auth.sql','022-live-lyrics-push.sql',
 '023-live-lyrics-runtime.sql','024-live-lyrics-cleanup.sql','025-memberships.sql',
 '026-spotify-recordings.sql','027-spotify-background.sql','028-selected-lyrics-learning.sql',
 '029-listening-sessions.sql','030-listening-v2-schema.sql','031-listening-v2-lifecycle-support.sql',
 '032-auth-token-row-locks.sql','033-listening-v2-lifecycle-composition.sql',
 '034-listening-v2-output-terminal-support.sql','035-listening-account-delete-privileges.sql'];
const json=JSON.stringify;
const unavailable=p=>assert.rejects(p,e=>e.code==='unavailable'&&e.message==='unavailable'&&e.status===503&&!e.cause);
const one=async(db,q,a=[])=>(await db.query(q,a)).rows[0];
const clock=async db=>Number((await one(db,'SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS n')).n);
const payload=(n=1,extra={})=>({version:2,environment:coordinator,selector:{kind:'credential',value:digest(n)},
 invalidatedAtMS:0,phase:'rooms',cursor:null,...extra});
async function fixture(t){
 const sql=new PGlite();t.after(()=>sql.close());
 await sql.exec('CREATE ROLE lyra_runtime_v1; CREATE ROLE lyra_account_v1;');
 for(const name of migrationNames)await sql.exec(await readFile(new URL('../../db/'+name,import.meta.url),'utf8'));
 const trace=[];let intercept=null,transactions=0;
 // Same contract as song-library/database.js: one callback/client, commit only
 // after callback resolves, rollback on rejection. No source/proof callback API.
 const db={query:(...a)=>sql.query(...a),transaction:fn=>{
  transactions++;
  return sql.transaction(tx=>fn({query:async(q,args=[])=>{
   const entry={q,args:structuredClone(args)};trace.push(entry);
   const result=await tx.query(q,args);
   if(intercept)await intercept({q,args,result,tx});
   return result;
  }}));
 }};
 const store=createTerminalClaims({db,coordinatorEnvironment:coordinator});
 return {sql,db,store,trace,setIntercept:fn=>{intercept=fn;},transactions:()=>transactions};
}
async function seed(f,n=1,changes={}){
 const at=await clock(f.sql),id=uuid(n);
 const row={environment:coordinator,job_id:id,job_key:'authority-terminal:'+id,kind:'authority_terminal',
 payload:json(payload(n)),created_at_ms:at-1000,due_at_ms:at-1000,retry_until_ms:at+3600000,...changes};
 const keys=Object.keys(row);
 await f.sql.query(`INSERT INTO listening_v2.outbox(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
 return id;
}
const row=(f,id)=>one(f.sql,'SELECT * FROM listening_v2.outbox WHERE environment=$1 AND job_id=$2',[coordinator,id]);
const image=(f,id)=>one(f.sql,'SELECT to_jsonb(o)::text AS raw FROM listening_v2.outbox o WHERE environment=$1 AND job_id=$2',[coordinator,id]);
// Owner-only fixture corruption/expired-state setup. Trigger is enabled again
// before the actual store runs. These are representations, not source closure,
// successful progress/refund, or a way a runtime/account caller can bypass DDL.
async function representation(f,id,changes){
 await f.sql.transaction(async tx=>{
  await tx.exec('ALTER TABLE listening_v2.outbox DISABLE TRIGGER outbox_terminal_protect');
  const keys=Object.keys(changes);
  await tx.query(`UPDATE listening_v2.outbox SET ${keys.map((k,i)=>k+'=$'+(i+1)).join(',')} WHERE job_id=$${keys.length+1}`,
   [...Object.values(changes),id]);
  await tx.exec('ALTER TABLE listening_v2.outbox ENABLE TRIGGER outbox_terminal_protect');
 });
}
async function expired(f,id,count=1,epoch=1){
 const old=await row(f,id);
 await representation(f,id,{state:'claimed',attempt_count:count,claim_epoch:epoch,
  claim_nonce_hash:digest(700+epoch),claim_until_ms:Number(old.created_at_ms)+1});
}
function chronology(a,b){
 for(const key of ['environment','job_id','job_key','kind','payload','created_at_ms','due_at_ms','retry_until_ms',
  'room_id','guard_id','persona_id','asset_id','privacy_generation','guard_revision','send_ordinal'])assert.deepEqual(b[key],a[key],key);
}

 test('constructor is inert, closed, captures immutable configuration, exposes only claim/failure',()=>{
 let calls=0;const db={query(){calls++;},transaction(){calls++;}};
 const options={db,coordinatorEnvironment:coordinator},s=createTerminalClaims(options);
 options.coordinatorEnvironment='production';options.db=null;
 assert.deepEqual(Object.keys(s).sort(),['claimNext','failClaim']);assert.ok(Object.isFrozen(s));assert.equal(calls,0);
 for(const extra of [{clock:()=>0},{sql:'SELECT true'},{authorize:()=>true},{onSuccess:()=>true},{leaseMS:1}])
  assert.throws(()=>createTerminalClaims({db,coordinatorEnvironment:coordinator,...extra}),{code:'unavailable'});
 assert.throws(()=>createTerminalClaims(new Proxy({}, {ownKeys(){throw Error('must not inspect');}})),{code:'unavailable'});
 assert.throws(()=>createTerminalClaims({db,get coordinatorEnvironment(){throw Error('must not read');}}),{code:'unavailable'});
 });
 test('no caller clock/transaction/source object is accepted, even on empty queue',async t=>{
 const f=await fixture(t);await unavailable(f.store.claimNext({nowMS:0}));
 await unavailable(f.store.claimNext(f.db));assert.equal(f.transactions(),0);
 assert.equal(await f.store.claimNext(),null);assert.equal(f.transactions(),1);
 });
 test('one due job only; exact chronology retained, new crypto nonce/epoch/debit; other kinds/environments isolated',async t=>{
 const f=await fixture(t),a=await seed(f,1),b=await seed(f,2);
 await seed(f,3,{environment:'test',payload:json({...payload(3),environment:'test'})});
 const before=await row(f,a),h=await f.store.claimNext(),after=await row(f,a);
 assert.ok(h);assert.equal(Object.getPrototypeOf(h),null);assert.deepEqual(Reflect.ownKeys(h),[]);assert.ok(Object.isFrozen(h));
 chronology(before,after);assert.equal(after.state,'claimed');assert.equal(after.attempt_count,1);assert.equal(Number(after.claim_epoch),1);
 assert.match(after.claim_nonce_hash,/^[0-9a-f]{64}$/);assert.ok(Number(after.claim_until_ms)>await clock(f.sql));
 assert.ok(Number(after.claim_until_ms)<=Number(after.retry_until_ms));assert.equal(after.completed_at_ms,null);assert.equal(after.delete_after_ms,null);
 assert.equal((await row(f,b)).state,'pending');
 const update=f.trace.filter(x=>/UPDATE listening_v2\.outbox/.test(x.q));assert.equal(update.length,1);
 assert.match(f.trace.find(x=>/SKIP LOCKED/.test(x.q)).q,/LIMIT 1/);
 assert.ok(f.trace.every(x=>!/(FROM|UPDATE|INTO) (public\.|listening_v2\.(rooms|output_guards|privacy_personas|semantic_events|command_receipts))/.test(x.q)));
 });
 test('not-due pending and live count10 are never selected or killed',async t=>{
 const f=await fixture(t),id=await seed(f,1),at=await clock(f.sql);
 await representation(f,id,{state:'claimed',attempt_count:10,claim_epoch:10,claim_nonce_hash:digest(5),claim_until_ms:at+600000});
 await seed(f,2,{due_at_ms:at+600000});const before=await image(f,id);
 assert.equal(await f.store.claimNext(),null);assert.deepEqual(await image(f,id),before);
 });
 test('nine actual failures retain nine; the tenth live claim remains available for future semantic store',async t=>{
 const f=await fixture(t),id=await seed(f),initial=await row(f,id);
 for(let n=1;n<=9;n++){
  const h=await f.store.claimNext();assert.ok(h);const result=await f.store.failClaim(h);assert.deepEqual(result,{status:'pending'});
  const r=await row(f,id);assert.equal(r.attempt_count,n);assert.equal(Number(r.claim_epoch),n);chronology(initial,r);
 }
 const h=await f.store.claimNext();assert.ok(h);const live=await row(f,id);
 assert.equal(live.state,'claimed');assert.equal(live.attempt_count,10);assert.equal(Number(live.claim_epoch),10);
 assert.equal(await f.store.claimNext(),null);assert.deepEqual(await row(f,id),live);
 assert.equal(f.store.succeed,undefined);assert.equal(f.store.refund,undefined);assert.equal(f.store.markSuccess,undefined);
 });
 test('ten genuine explicit failures exhaust once, retain exact debt and never reopen',async t=>{
 const f=await fixture(t),id=await seed(f),initial=await row(f,id);let last;
 for(let n=1;n<=10;n++){
  last=await f.store.claimNext();assert.ok(last);
  assert.deepEqual(await f.store.failClaim(last),{status:n===10?'dead':'pending'});
 }
 const dead=await row(f,id);chronology(initial,dead);assert.equal(dead.attempt_count,10);assert.equal(Number(dead.claim_epoch),10);
 assert.equal(dead.state,'dead');assert.equal(dead.claim_nonce_hash,null);assert.equal(dead.claim_until_ms,null);
 assert.ok(Number(dead.delete_after_ms)>=Number(dead.completed_at_ms)+DAY);
 await unavailable(f.store.failClaim(last));assert.equal(await f.store.claimNext(),null);assert.deepEqual(await row(f,id),dead);
 });
 test('expired claim charges its old debit once, new claim reserves exactly one successor debit',async t=>{
 const f=await fixture(t),id=await seed(f);await expired(f,id,1,4);const before=await row(f,id);
 const h=await f.store.claimNext();assert.ok(h);const next=await row(f,id);chronology(before,next);
 assert.equal(next.attempt_count,2);assert.equal(Number(next.claim_epoch),5);assert.notEqual(next.claim_nonce_hash,before.claim_nonce_hash);
 await f.store.failClaim(h);assert.equal((await row(f,id)).attempt_count,2);
 });
 for(const kind of ['pending-exhausted','expired-exhausted','deadline'])test(`${kind} dies without a new debit/epoch; one selection does not drain`,async t=>{
 const f=await fixture(t),id=await seed(f);
 if(kind==='pending-exhausted')await representation(f,id,{attempt_count:10,claim_epoch:10});
 if(kind==='expired-exhausted')await expired(f,id,10,10);
 if(kind==='deadline'){
  const at=await clock(f.sql);await representation(f,id,{created_at_ms:at-10000,due_at_ms:at-10000,retry_until_ms:at-1});
 }
 const nextID=await seed(f,2),before=await row(f,id);assert.equal(await f.store.claimNext(),null);
 const dead=await row(f,id);chronology(before,dead);assert.equal(dead.state,'dead');assert.equal(dead.attempt_count,before.attempt_count);
 assert.equal(dead.claim_epoch,before.claim_epoch);assert.equal((await row(f,nextID)).state,'pending');
 });
 test('explicit failure before reclaim and reclaim before delayed failure cannot double charge',async t=>{
 const f=await fixture(t),id=await seed(f),h=await f.store.claimNext();
 // Keep the exact handle's lease intact. Explicit failure wins first.
 await f.store.failClaim(h);const successor=await f.store.claimNext(),next=await row(f,id);
 await unavailable(f.store.failClaim(h));assert.deepEqual(await row(f,id),next);await f.store.failClaim(successor);
 // Reclaim-first representation: an old opaque handle cannot match a new epoch.
 const old=await f.store.claimNext();await expired(f,id,3,3);const reclaimed=await f.store.claimNext(),current=await row(f,id);
 await unavailable(f.store.failClaim(old));assert.deepEqual(await row(f,id),current);await f.store.failClaim(reclaimed);
 });
 test('changed returned chronology cannot mint a handle; the whole claim transaction rolls back',async t=>{
 const f=await fixture(t),id=await seed(f);
 const initial=await image(f,id);
 // Adversarial trusted-adapter postimage: valid SQL shape is insufficient when
 // it is not the exact postimage of this store's captured initial envelope.
 f.setIntercept(async({q,result,tx})=>{
  if(!/UPDATE listening_v2\.outbox/.test(q)||!result.rows.length)return;
  f.setIntercept(null);
  await tx.query('ALTER TABLE listening_v2.outbox DISABLE TRIGGER outbox_terminal_protect');
  const at=await clock(tx);
  await tx.query('UPDATE listening_v2.outbox SET claim_until_ms=$1,retry_until_ms=$1 WHERE job_id=$2',[at,id]);
  await tx.query('ALTER TABLE listening_v2.outbox ENABLE TRIGGER outbox_terminal_protect');
  result.rows[0]=(await tx.query('SELECT to_jsonb(o)::text AS raw_envelope FROM listening_v2.outbox o WHERE job_id=$1',[id])).rows[0];
 });
 await unavailable(f.store.claimNext());assert.deepEqual(await image(f,id),initial);
 });
 test('opaque brand: reconstructed/spread/other store/proxy handles refuse before opening a transaction',async t=>{
 const f=await fixture(t),id=await seed(f),h=await f.store.claimNext();
 const other=createTerminalClaims({db:f.db,coordinatorEnvironment:coordinator}),before=await image(f,id),count=f.transactions();
 for(const fake of [{},Object.freeze(Object.create(null)),{...h},await row(f,id),new Proxy(h,{})])await unavailable(f.store.failClaim(fake));
 await unavailable(other.failClaim(h));await unavailable(f.store.failClaim(h,{nowMS:0}));
 assert.equal(f.transactions(),count);assert.deepEqual(await image(f,id),before);await f.store.failClaim(h);
 });
 const drifts={payload:r=>json({...r.payload,cursor:['test',uuid(20)]}),
  attempt_count:r=>r.attempt_count+1,claim_epoch:r=>Number(r.claim_epoch)+1,claim_nonce_hash:()=>digest(200),
  claim_until_ms:r=>Number(r.claim_until_ms)+1,due_at_ms:r=>Number(r.due_at_ms)+1,
  created_at_ms:r=>Number(r.created_at_ms)-1,retry_until_ms:r=>Number(r.retry_until_ms)-1};
 for(const [field,change] of Object.entries(drifts))test(`stale full envelope ${field} cannot settle or mutate successor`,async t=>{
 const f=await fixture(t),id=await seed(f),h=await f.store.claimNext(),r=await row(f,id);
 await representation(f,id,{[field]:change(r)});const before=await image(f,id);
 await unavailable(f.store.failClaim(h));assert.deepEqual(await image(f,id),before);
 });
 test('all NULL references and observed completion/state drift are part of the full SQL envelope',async t=>{
 const f=await fixture(t),id=await seed(f),h=await f.store.claimNext();
 // Keep CHECK/FK-compatible successor dead metadata, then use original handle.
 const at=await clock(f.sql);await representation(f,id,{state:'dead',claim_nonce_hash:null,claim_until_ms:null,
  completed_at_ms:at,delete_after_ms:at+DAY});const before=await image(f,id);
 await unavailable(f.store.failClaim(h));assert.deepEqual(await image(f,id),before);
 // Row references cannot be introduced in this family even by the owner.
 await assert.rejects(f.sql.query('UPDATE listening_v2.outbox SET guard_revision=1 WHERE job_id=$1',[id]),{code:'23514'});
 });
 test('exact JSONB equality admits key order only, retains original selector/cursor/repair/payload',async t=>{
 const f=await fixture(t),id=await seed(f),h=await f.store.claimNext(),old=await row(f,id);
 const p=old.payload;const reordered={cursor:p.cursor,phase:p.phase,invalidatedAtMS:p.invalidatedAtMS,
  selector:{value:p.selector.value,kind:p.selector.kind},environment:p.environment,version:p.version};
 await f.sql.query('UPDATE listening_v2.outbox SET payload=$1::jsonb WHERE job_id=$2',[json(reordered),id]);
 await f.store.failClaim(h);chronology(old,await row(f,id));
 });
 test('raw result alias mutation across awaits cannot change captured evidence',async t=>{
 const f=await fixture(t),id=await seed(f);let retained;
 f.setIntercept(async({q,result})=>{if(/UPDATE listening_v2\.outbox/.test(q)){retained=result.rows[0];}});
 const h=await f.store.claimNext();f.setIntercept(null);const before=await row(f,id);
 retained.raw_envelope='{}';retained.payload={selector:{kind:'credential',value:digest(999)}};
 await f.store.failClaim(h);chronology(before,await row(f,id));
 });
 test('selection-to-final-CAS drift aborts and rolls back its complete transaction',async t=>{
 const f=await fixture(t),id=await seed(f),before=await image(f,id);
 f.setIntercept(async({q,tx})=>{
  if(!/SKIP LOCKED/.test(q))return;f.setIntercept(null);
  await tx.query('UPDATE listening_v2.outbox SET due_at_ms=due_at_ms+1 WHERE job_id=$1',[id]);
 });
 await unavailable(f.store.claimNext());assert.deepEqual(await image(f,id),before);
 });
 for(const operation of ['claim','failure'])test(`${operation} transaction rollback has no partial debit/settlement and handle is published only after COMMIT`,async t=>{
 const f=await fixture(t),id=await seed(f),h=operation==='failure'?await f.store.claimNext():null,before=await image(f,id);
 f.setIntercept(async({q})=>{if(/UPDATE listening_v2\.outbox/.test(q))throw Error('private injected write fault');});
 await unavailable(operation==='claim'?f.store.claimNext():f.store.failClaim(h));assert.deepEqual(await image(f,id),before);
 f.setIntercept(null);if(h)await f.store.failClaim(h);else assert.ok(await f.store.claimNext());
 });
 for(const code of ['40001','40P01'])test(`sanitized ${code}, exactly one attempt, no hidden retry loop`,async t=>{
 const f=await fixture(t),id=await seed(f),before=await image(f,id),count=f.transactions();
 f.setIntercept(async({q})=>{if(/UPDATE listening_v2\.outbox/.test(q))throw Object.assign(Error('secret SQL detail'),{code,detail:'private'});});
 await assert.rejects(f.store.claimNext(),e=>e.code===code&&e.message==='transaction_retry'&&Object.isFrozen(e)&&!e.cause&&!e.detail);
 assert.equal(f.transactions(),count+1);assert.deepEqual(await image(f,id),before);
 });
 test('untrusted DB errors and permission failures contain no SQL, source or credential detail',async t=>{
 const f=await fixture(t);await seed(f);
 f.setIntercept(async()=>{throw Object.assign(Error('secret'),{code:'23514',detail:'private',query:'secret SQL'});});
 await unavailable(f.store.claimNext());
 });
 test('safe uint epoch exhaustion refuses with retained pending/expired debt, no wrap',async t=>{
 const f=await fixture(t),id=await seed(f);await representation(f,id,{claim_epoch:MAX});const before=await image(f,id);
 await unavailable(f.store.claimNext());assert.deepEqual(await image(f,id),before);
 await expired(f,id,1,MAX);const expiredImage=await image(f,id);await unavailable(f.store.claimNext());assert.deepEqual(await image(f,id),expiredImage);
 });
 for(const bad of ['9007199254740992','1.5','-0','-1','"01"','"9007199254740992"'])test(`unsafe raw uint ${bad} is refused without a debit`,async t=>{
 const f=await fixture(t),id=await seed(f),before=await image(f,id);
 f.setIntercept(async({q,result})=>{if(/SKIP LOCKED/.test(q)&&result.rows.length){
  result.rows[0].raw_envelope=result.rows[0].raw_envelope.replace(/"claim_epoch":\s*0/,`"claim_epoch": ${bad}`);
 }});
 await unavailable(f.store.claimNext());assert.deepEqual(await image(f,id),before);
 });
 test('exact last SQL clock governs claim/failure at deadline, not an earlier sample or caller time',async t=>{
 const f=await fixture(t),id=await seed(f),at=await clock(f.sql);
 // Boundary representation is already at retryUntil when the final statement
 // runs; count remains zero and death metadata is database-derived.
 await representation(f,id,{retry_until_ms:at,due_at_ms:Number((await row(f,id)).created_at_ms)});
 assert.equal(await f.store.claimNext(),null);const dead=await row(f,id);assert.equal(dead.state,'dead');assert.equal(dead.attempt_count,0);
 assert.ok(Number(dead.completed_at_ms)>=at);
 const final=f.trace.filter(x=>/UPDATE listening_v2\.outbox/.test(x.q)).at(-1).q;
 assert.match(final,/clock_timestamp\(\)/);assert.match(final,/MATERIALIZED/);assert.match(final,/::numeric/);
 });
 test('restricted account cannot claim/settle; runtime can; published/dead rows never reopen',async t=>{
 const f=await fixture(t),id=await seed(f),before=await image(f,id);
 await f.sql.exec('SET ROLE lyra_account_v1');
 try{await unavailable(f.store.claimNext());}finally{await f.sql.exec('RESET ROLE');}
 assert.deepEqual(await image(f,id),before);
 await f.sql.exec('SET ROLE lyra_runtime_v1');let h;
 try{h=await f.store.claimNext();assert.ok(h);}finally{await f.sql.exec('RESET ROLE');}
 await f.sql.exec('SET ROLE lyra_account_v1');
 try{await unavailable(f.store.failClaim(h));}finally{await f.sql.exec('RESET ROLE');}
 await f.sql.exec('SET ROLE lyra_runtime_v1');
 try{await f.store.failClaim(h);}finally{await f.sql.exec('RESET ROLE');}
 const at=await clock(f.sql);await representation(f,id,{state:'published',completed_at_ms:at,delete_after_ms:at+DAY,
  payload:json({...payload(),phase:'complete'})});const published=await image(f,id);
 assert.equal(await f.store.claimNext(),null);await unavailable(f.store.failClaim(h));assert.deepEqual(await image(f,id),published);
 });
 test('account initial INSERT permission proves representation only, no source authentication or semantic authority',async t=>{
 const f=await fixture(t);await f.sql.exec('SET ROLE lyra_account_v1');
 try{await seed(f,1);}finally{await f.sql.exec('RESET ROLE');}
 const h=await f.store.claimNext();assert.ok(h);await f.store.failClaim(h);
 assert.equal((await one(f.sql,'SELECT count(*)::int AS n FROM listening_v2.semantic_events')).n,0);
 assert.equal((await one(f.sql,'SELECT count(*)::int AS n FROM listening_v2.rooms')).n,0);
 });
 test('claim race representation: two stores see the same one row, only one committed debit wins',async t=>{
 const f=await fixture(t),id=await seed(f),other=createTerminalClaims({db:f.db,coordinatorEnvironment:coordinator});
 const results=await Promise.all([f.store.claimNext(),other.claimNext()]);assert.equal(results.filter(Boolean).length,1);
 const r=await row(f,id);assert.equal(r.attempt_count,1);assert.equal(Number(r.claim_epoch),1);
 // Serialized PGlite transactions cannot prove actual lock waits/SKIP LOCKED.
 });
 test('transaction identity is private and every operation owns a fresh DB transaction',async t=>{
 const f=await fixture(t);await seed(f);const h=await f.store.claimNext();await f.store.failClaim(h);
 assert.equal(f.transactions(),2);const ids=f.trace.filter(x=>/txid_current\(\)/.test(x.q));assert.equal(ids.length,2);
 assert.deepEqual(Reflect.ownKeys(h),[]);
 });
