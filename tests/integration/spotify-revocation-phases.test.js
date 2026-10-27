import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,user,recipe} from '../helpers/spotify.js';
import {lockAuthWriter} from '../../api/utils/song-library/store.js';
import {closeConnection} from '../../api/utils/spotify/service.js';
import * as revocation from '../../api/utils/spotify/revocation.js';

const invalid={code:'spotify_revocation_invalid',status:409};
const unavailable={code:'spotify_revocation_unavailable',status:503};
const writes=/^\s*(?:UPDATE|DELETE|INSERT)\s/i;
const locks=/\bFOR\s+(?:NO\s+KEY\s+UPDATE|KEY\s+SHARE|UPDATE|SHARE)\b/i;
function api(){
 assert.equal(typeof revocation.prepareSpotifyRevocationInTransaction,'function');
 assert.equal(typeof revocation.persistSpotifyRevocationInTransaction,'function');
 return {prepare:revocation.prepareSpotifyRevocationInTransaction,persist:revocation.persistSpotifyRevocationInTransaction};
}
// These observers always execute actual fixture SQL. Faults/drift are injected
// around real results; no fabricated positive query or transaction identifier.
function observe(tx,entries,{before,after}={}){
 return {async query(sql,args){entries.push({sql,args});await before?.(sql,args);
  const result=await tx.query(sql,args);await after?.(sql,args,result);return result;}};
}
async function anchors(tx){
 // The existing Spotify fixture has no session relation or sessions; its
 // complete required auth union is this actual owner, both tokens and all keys.
 return lockAuthWriter(tx,{userIDs:[user.id],allTokens:true,allKeys:true});
}
async function setup(t){
 api();const f=await fixture(t);
 await f.db.exec("CREATE TEMP TABLE revocation_phase_marker(id text PRIMARY KEY,value integer NOT NULL); INSERT INTO revocation_phase_marker VALUES('lower',0)");
 return f;
}
async function seed(f,id='connection',overrides={}){
 const sessionID='session-'+id,epoch='epoch-'+id;
 const c={id,epoch,enrollmentID:randomUUID(),ownerID:user.id,keyID:user.keyID,credentialDigest:user.credentialDigest,
  bundleID:user.bundleID,ownerEnvironment:user.environment,clientID:f.options.config.clientID,environment:f.options.config.environment,
  status:'connected',access:{ciphertext:'private-access'},refresh:{ciphertext:'private-refresh'},stage:{ciphertext:'private-stage'},
  refreshLease:{id:'refresh'},pollLease:{id:'poll'},document:{private:'document'},observation:{private:'observation'},
  consumers:{[sessionID]:{sessionID,activityID:'activity-'+id,status:'armed',generation:3,tokenVersion:2,token:{ciphertext:'private-token'},
   vaultEpoch:epoch,recipe,sequence:1,lastTimestamp:Math.floor(f.now/1000),expiresAt:f.now+600000}},...overrides};
 await f.store.create(c);await f.store.addCapability('cap-'+id,id,sessionID,f.now+600000);return c;
}
async function snapshot(db){
 const result={};
 for(const [table,key] of [['spotify_connections','id'],['spotify_snapshot_capabilities','digest'],['spotify_outbox','id']])
  result[table]=(await db.query(`SELECT row_to_json(r)::text AS image FROM (SELECT * FROM ${table} ORDER BY ${key} COLLATE "C") r`)).rows;
 return result;
}
function semantic(value){
 // closeConnection deliberately mints a random epoch on every invocation.
 const c=structuredClone(value);c.epoch='<new epoch>';return c;
}

test('revocation phases expose the closed internal API',()=>{api();});

test('prepare locks C-sorted actual rows without mutation; persist follows a real lower lock and adds no locking SELECT',async t=>{
 const {prepare,persist}=api(),f=await setup(t);
 for(const id of ['é','a','Z'])await seed(f,id);
 const before=await snapshot(f.db),entries=[],xids=[];let ids;
 await f.sql.transaction(async tx=>{
  const db=observe(tx,entries,{after(sql,args,result){if(/^\s*SELECT pg_current_xact_id\(\)::text AS transaction_id\b/.test(sql))xids.push(result.rows[0]?.transaction_id);}});
  await anchors(db);const handle=await prepare(db,{ownerID:user.id},'signedOut',f.now);
  assert(Object.isFrozen(handle));assert.deepEqual(Reflect.ownKeys(handle),[]);assert.equal(JSON.stringify(handle),'{}');
  assert.deepEqual(await snapshot(tx),before);
  const selection=entries.find(e=>/FROM spotify_connections/.test(e.sql)&&locks.test(e.sql));
  assert(selection);assert.match(selection.sql,/ORDER BY id COLLATE "C" FOR UPDATE/);
  assert(!entries.some(e=>writes.test(e.sql)));
  await db.query("SELECT id FROM revocation_phase_marker WHERE id='lower' FOR UPDATE");
  await db.query("UPDATE revocation_phase_marker SET value=1 WHERE id='lower'");
  const at=entries.length;ids=await persist(db,handle);
  assert(!entries.slice(at).some(e=>locks.test(e.sql)));
 });
 assert.deepEqual(ids,['Z','a','é']);assert(xids.length>=3);assert(xids.every(id=>typeof id==='string'&&id===xids[0]));
 assert.equal((await f.db.query('SELECT value FROM revocation_phase_marker')).rows[0].value,1);
 for(const id of ids){assert.equal((await f.store.read(id)).status,'disconnected');assert.equal(await f.store.capability('cap-'+id),null);}
});

for(const selector of [{ownerID:user.id},{keyID:user.keyID},{credentialDigest:user.credentialDigest},
 {ownerID:user.id,keyID:user.keyID,credentialDigest:user.credentialDigest},{ownerID:'absent'},
 {ownerID:user.id,keyID:'other-key',credentialDigest:user.credentialDigest},{}])
test('split and legacy wrapper preserve conjunctive nullable selector '+JSON.stringify(selector),async t=>{
 const {prepare,persist}=api(),f=await setup(t);
 await f.db.query("INSERT INTO library_tokens(digest,user_id) VALUES('other-digest',$1)",[user.id]);
 await f.db.query("INSERT INTO app_attest_keys(key_id,user_id,bundle_id,environment) VALUES('other-key',$1,$2,$3)",[user.id,user.bundleID,user.environment]);
 const originals=[await seed(f,'a'),await seed(f,'b',{keyID:'other-key'}),await seed(f,'c',{credentialDigest:'other-digest'})];
 const expected=originals.filter(c=>(selector.ownerID==null||c.ownerID===selector.ownerID)&&(selector.keyID==null||c.keyID===selector.keyID)&&(selector.credentialDigest==null||c.credentialDigest===selector.credentialDigest)).map(c=>c.id);
 let split,splitRows,splitJobs;
 // SAVEPOINT rollback permits a same-source comparison while every SQL result
 // still comes from the actual migration-backed database.
 await f.sql.transaction(async tx=>{
  await anchors(tx);await tx.query('SAVEPOINT comparison');
  split=await persist(tx,await prepare(tx,selector,'keyRevoked',f.now));
  splitRows=(await tx.query('SELECT data FROM spotify_connections ORDER BY id COLLATE "C"')).rows.map(r=>semantic(r.data));
  splitJobs=(await tx.query('SELECT id,connection_id,kind,due_at_ms,data,expires_at FROM spotify_outbox ORDER BY id COLLATE "C"')).rows;
  await tx.query('ROLLBACK TO SAVEPOINT comparison');
  const wrapped=await revocation.revokeSpotifyInTransaction(tx,selector,'keyRevoked',f.now);
  assert.deepEqual(wrapped,split);assert.deepEqual(wrapped,expected);
  assert.deepEqual((await tx.query('SELECT data FROM spotify_connections ORDER BY id COLLATE "C"')).rows.map(r=>semantic(r.data)),splitRows);
  assert.deepEqual((await tx.query('SELECT id,connection_id,kind,due_at_ms,data,expires_at FROM spotify_outbox ORDER BY id COLLATE "C"')).rows,splitJobs);
 });
});

test('existing closeConnection postimage, cleanup identities, leases, due times and retained terminal fields are preserved',async t=>{
 const {prepare,persist}=api(),f=await setup(t),c=await seed(f);
 const sid=Object.keys(c.consumers)[0];c.consumers[sid].sendLease={id:'sent',until:f.now+7500};
 c.consumers.old={sessionID:'old',status:'ended',generation:8,reason:'already-ended',token:{ciphertext:'old-private'}};
 await f.db.query('UPDATE spotify_connections SET data=$2 WHERE id=$1',[c.id,JSON.stringify(c)]);
 const expected=structuredClone(c),jobs=[];
 closeConnection(expected,'accountDeleted',f.now,(kind,id,data,due)=>jobs.push({kind,id,data,due}));
 await f.sql.transaction(async tx=>{await anchors(tx);await persist(tx,await prepare(tx,{ownerID:user.id},'accountDeleted',f.now));});
 const closed=await f.store.read(c.id);assert.deepEqual(semantic(closed),semantic(expected));assert.notEqual(closed.epoch,c.epoch);
 const rows=await f.store.pending(c.id);assert.equal(rows.length,jobs.length);
 assert.deepEqual(rows.map(({id,kind,data,due})=>({id,kind,data,due})),jobs);
 assert(rows.every(row=>row.epoch===closed.epoch));
 assert.equal(rows[0].due,f.now+7500);assert.equal(await f.store.capability('cap-'+c.id),null);
});

test('cleanup is postcommit, loss is retryable, a second closure adds no duplicate cleanup, and the actual consumer scrubs once',async t=>{
 const {prepare,persist}=api(),f=await setup(t),{credential}=await f.enroll(),arm=await f.arm(credential);
 const sid=arm.session.sessionID;let ids;
 await f.sql.transaction(async tx=>{await anchors(tx);ids=await persist(tx,await prepare(tx,{ownerID:user.id},'signedOut',f.now));});
 assert.equal(f.sends.length,0);
 const pending=(await f.store.pending(credential.connectionID)).filter(r=>r.kind==='cleanup');assert.equal(pending.length,1);
 await assert.rejects(revocation.flushSpotifyCleanup(f.sql,ids,{enqueueFn:async()=>{throw new Error('fixture queue loss');},now:()=>f.now}),/fixture queue loss/);
 assert.equal((await f.store.outbox(pending[0].id)).state,'pending');
 await f.sql.transaction(async tx=>{await anchors(tx);await revocation.revokeSpotifyInTransaction(tx,{ownerID:user.id},'signedOut',f.now);});
 assert.equal((await f.store.pending(credential.connectionID)).filter(r=>r.kind==='cleanup').length,1);
 await revocation.flushSpotifyCleanup(f.sql,ids,{enqueueFn:f.options.enqueue,now:()=>f.now});
 const message=f.next('cleanup');assert.equal(message.outboxID,pending[0].id);
 assert.equal((await f.store.outbox(message.outboxID)).state,'published');
 // Advance only by the actual terminal due time; no sleep, retry or DB clock override.
 f.advance(Math.max(0,message.dueAtMS-f.now));await f.service.tick(message);await f.service.tick(message);
 assert.equal(f.sends.length,1);assert.equal(f.sends[0].payload.aps.event,'end');
 const consumer=(await f.store.read(credential.connectionID)).consumers[sid];
 for(const field of ['token','widgetToken','capability','capabilityDigest','snapshot','terminalPayload'])assert.equal(consumer[field],null);
 assert.deepEqual(consumer.cleanupComplete,[message.outboxID]);
});

test('forged handles and cross-client aliases refuse before SQL; the genuine cross-client scope is retired',async t=>{
 const {prepare,persist}=api(),f=await setup(t);await seed(f);const before=await snapshot(f.db),entries=[];
 await f.sql.transaction(async tx=>{
  const db=observe(tx,entries);await anchors(db);const handle=await prepare(db,{ownerID:user.id});
  for(const forged of [Object.freeze({}),Object.freeze({...handle}),JSON.parse(JSON.stringify(handle))]){
   const n=entries.length;await assert.rejects(persist(db,forged),invalid);assert.equal(entries.length,n);
  }
  let calls=0;const alias={query(...args){calls++;return tx.query(...args);}};
  await assert.rejects(persist(alias,handle),invalid);assert.equal(calls,0);
  const n=entries.length;await assert.rejects(persist(db,handle),invalid);assert.equal(entries.length,n);
 });assert.deepEqual(await snapshot(f.db),before);
});

test('success consumes a handle synchronously; concurrent or subsequent reuse issues no SQL',async t=>{
 const {prepare,persist}=api(),f=await setup(t);await seed(f);const entries=[];
 await f.sql.transaction(async tx=>{
  let pause=false,release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);
  const db=observe(tx,entries,{async after(sql){if(pause&&/pg_current_xact_id/.test(sql)){entered();await gate;}}});
  await anchors(db);const handle=await prepare(db,{ownerID:user.id});pause=true;
  const first=persist(db,handle);await start;
  try{const n=entries.length;await assert.rejects(persist(db,handle),invalid);assert.equal(entries.length,n);}
  finally{pause=false;release();}
  await first;const done=entries.length;await assert.rejects(persist(db,handle),invalid);assert.equal(entries.length,done);
 });
});

for(const finish of ['COMMIT','ROLLBACK'])test('same client cannot carry a handle across actual '+finish+' to a different xid',async t=>{
 const {prepare,persist}=api(),f=await setup(t);await seed(f);const before=await snapshot(f.db),entries=[];
 const db=observe(f.db,entries);let active=false;
 try{
  await f.db.exec('BEGIN');active=true;await anchors(db);const handle=await prepare(db,{ownerID:user.id});
  await f.db.exec(finish);active=false;await f.db.exec('BEGIN');active=true;
  const n=entries.length;await assert.rejects(persist(db,handle),invalid);
  assert(!entries.slice(n).some(e=>writes.test(e.sql)||locks.test(e.sql)));
  const retired=entries.length;await assert.rejects(persist(db,handle),invalid);assert.equal(entries.length,retired);
  await f.db.exec('ROLLBACK');active=false;
 }finally{if(active)await f.db.exec('ROLLBACK');}
 assert.deepEqual(await snapshot(f.db),before);
});

test('autocommit query client does not produce a usable prepared transaction',async t=>{
 const {prepare}=api(),f=await setup(t);await seed(f);const before=await snapshot(f.db);
 await assert.rejects(prepare(f.db,{ownerID:user.id}),invalid);assert.deepEqual(await snapshot(f.db),before);
});

test('selector and returned SQL rows are captured before later awaits; opaque handle exposes no private fields',async t=>{
 const {prepare,persist}=api(),f=await setup(t);await seed(f,'a');await seed(f,'b');
 const selector={ownerID:user.id,keyID:user.keyID,credentialDigest:user.credentialDigest};let savedRows,changed=false;
 await f.sql.transaction(async tx=>{
  const entries=[],db=observe(tx,entries,{after(sql,args,result){
   if(/to_regclass/.test(sql)){selector.ownerID='different';selector.keyID='different';selector.credentialDigest='different';}
   if(/FROM spotify_connections/.test(sql)&&locks.test(sql))savedRows=result.rows;
   else if(savedRows&&!changed&&/pg_current_xact_id/.test(sql)){
    changed=true;savedRows[0].id='injected';savedRows[0].source_data='{}';
   }
  }});
  await anchors(db);const handle=await prepare(db,selector,'signedOut',f.now);
  assert.deepEqual(Reflect.ownKeys(handle),[]);assert.equal(JSON.stringify(handle),'{}');
  assert.deepEqual(await persist(db,handle),['a','b']);
 });assert(changed);assert.equal((await f.store.read('a')).reason,'signedOut');
});

for(const drift of ['data','column','deleted','new-match'])test('preheld source '+drift+' divergence refuses before revocation writes and rolls back the whole caller',async t=>{
 const {prepare,persist}=api(),f=await setup(t);await seed(f,'a');await seed(f,'b');const before=await snapshot(f.db),entries=[];
 let client,handle,at;
 await assert.rejects(f.sql.transaction(async tx=>{
  client=observe(tx,entries);await anchors(client);handle=await prepare(client,{ownerID:user.id},'signedOut',f.now);
  await tx.query("UPDATE revocation_phase_marker SET value=1 WHERE id='lower'");
  if(drift==='data')await tx.query("UPDATE spotify_connections SET data=jsonb_set(data,'{status}','\"changed\"') WHERE id='b'");
  if(drift==='column')await tx.query("UPDATE spotify_connections SET enrollment_id='changed' WHERE id='b'");
  if(drift==='deleted')await tx.query("DELETE FROM spotify_connections WHERE id='b'");
  if(drift==='new-match')await tx.query("INSERT INTO spotify_connections(id,owner_id,key_id,credential_digest,enrollment_id,data) SELECT 'new',owner_id,key_id,credential_digest,'new',jsonb_set(data,'{id}','\"new\"') FROM spotify_connections WHERE id='a'");
  at=entries.length;await persist(client,handle);
 }),invalid);
 assert(!entries.slice(at).some(e=>writes.test(e.sql)||locks.test(e.sql)));
 const n=entries.length;await assert.rejects(persist(client,handle),invalid);assert.equal(entries.length,n);
 assert.deepEqual(await snapshot(f.db),before);assert.equal((await f.db.query('SELECT value FROM revocation_phase_marker')).rows[0].value,0);
});

test('CAS catches same-client post-revalidation divergence before capability/outbox writes; rollback restores all rows',async t=>{
 const {prepare,persist}=api(),f=await setup(t);await seed(f);const before=await snapshot(f.db),entries=[];let injected=false;
 await assert.rejects(f.sql.transaction(async tx=>{
  const db=observe(tx,entries,{async before(sql){
   if(!injected&&/^UPDATE spotify_connections/.test(sql)){
    injected=true;await tx.query("UPDATE spotify_connections SET data=jsonb_set(data,'{reason}','\"drift\"') WHERE id='connection'");
   }
  }});
  await anchors(db);await persist(db,await prepare(db,{ownerID:user.id}));
 }),invalid);
 assert(injected);assert(!entries.some(e=>/^DELETE FROM spotify_snapshot_capabilities|^INSERT INTO spotify_outbox/.test(e.sql)));
 assert.deepEqual(await snapshot(f.db),before);
});

for(const boundary of ['UPDATE spotify_connections','DELETE FROM spotify_snapshot_capabilities','INSERT INTO spotify_outbox'])
test('actual SQL failure after '+boundary+' retires the handle, bounds the error and atomically rolls back',async t=>{
 const {prepare,persist}=api(),f=await setup(t);await seed(f);const before=await snapshot(f.db),entries=[];
 let client,handle,error;
 await assert.rejects(f.sql.transaction(async tx=>{
  client=observe(tx,entries,{after(sql){if(sql.startsWith(boundary))throw new Error('private-access private-refresh private-token digest owner');}});
  await anchors(client);handle=await prepare(client,{ownerID:user.id});
  try{await persist(client,handle);}catch(e){error=e;throw e;}
 }),unavailable);
 assert.equal(error.message,'spotify_revocation_unavailable');assert.equal(error.cause,undefined);
 assert.deepEqual(Object.keys(error).sort(),['code','status']);
 const n=entries.length;await assert.rejects(persist(client,handle),invalid);assert.equal(entries.length,n);
 assert.deepEqual(await snapshot(f.db),before);
});

test('failure in caller final checks rolls back connections, capabilities, outbox and lower writes together',async t=>{
 const {prepare,persist}=api(),f=await setup(t);await seed(f);const before=await snapshot(f.db);
 await assert.rejects(f.sql.transaction(async tx=>{
  await anchors(tx);const handle=await prepare(tx,{ownerID:user.id});
  await tx.query("UPDATE revocation_phase_marker SET value=1 WHERE id='lower'");
  await persist(tx,handle);throw new Error('fixture final privacy/auth refusal');
 }),/fixture final privacy\/auth refusal/);
 assert.deepEqual(await snapshot(f.db),before);assert.equal((await f.db.query('SELECT value FROM revocation_phase_marker')).rows[0].value,0);
});

test('malformed source JSON identity cannot mutate a different unplanned connection',async t=>{
 const {prepare}=api(),f=await setup(t);await seed(f,'a');await seed(f,'b');
 await f.db.query("UPDATE spotify_connections SET data=jsonb_set(data,'{id}','\"b\"') WHERE id='a'");
 const before=await snapshot(f.db);
 await assert.rejects(f.sql.transaction(async tx=>{await anchors(tx);await prepare(tx,{ownerID:user.id});}),invalid);
 assert.deepEqual(await snapshot(f.db),before);
});

test('schema absence is an actual supported no-effect transaction for split and legacy wrapper',async t=>{
 const {prepare,persist}=api(),f=await setup(t);
 await f.db.exec('DROP TABLE spotify_snapshot_capabilities,spotify_outbox,spotify_connections,spotify_provider_circuits');
 const entries=[];
 await f.sql.transaction(async tx=>{
  const db=observe(tx,entries);await anchors(db);const start=entries.length;
  assert.deepEqual(await persist(db,await prepare(db,{ownerID:user.id})),[]);
  assert.deepEqual(await revocation.revokeSpotifyInTransaction(db,{ownerID:user.id}),[]);
  assert(!entries.slice(start).some(e=>writes.test(e.sql)||locks.test(e.sql)||/\blistening_v2\b/.test(e.sql)));
 });
});

test('omitted reason and Date.now argument retain existing closure defaults without granting clock authority',async t=>{
 const {prepare,persist}=api(),f=await setup(t);await seed(f);const start=Date.now();
 await f.sql.transaction(async tx=>{await anchors(tx);await persist(tx,await prepare(tx,{ownerID:user.id}));});
 const c=await f.store.read('connection');assert.equal(c.reason,'ownerRevoked');assert(c.closedAt>=start&&c.closedAt<=Date.now());
});

test('caller objects cannot supply mutable reasons, clocks, callbacks or extra authority fields',async t=>{
 const {prepare}=api(),f=await setup(t),entries=[],db=observe(f.db,entries);
 for(const [selector,reason,now] of [[{ownerID:user.id}, {reason:'signedOut'},f.now],
  [{ownerID:user.id},'signedOut',new Date(f.now)],[{ownerID:user.id,callback:()=>true},'signedOut',f.now],
  [{ownerID:{id:user.id}},'signedOut',f.now]])await assert.rejects(prepare(db,selector,reason,now),invalid);
 assert.equal(entries.length,0);
});
