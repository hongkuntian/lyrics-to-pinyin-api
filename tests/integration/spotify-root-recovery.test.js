import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fixture,user} from '../helpers/spotify.js';
import {revokeSpotifyInTransaction} from '../../api/utils/spotify/revocation.js';

test('a result after poll lease expiry retries the predecessor instead of acknowledging a dead chain',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();await f.arm(credential);
 const predecessor=f.next(),playback=f.provider.playback;
 f.provider.playback=async()=>{f.advance(10001);return playback();};
 await assert.rejects(f.service.tick(predecessor),{code:'spotify_poll_lease_expired'});
 const interrupted=await f.store.read(credential.connectionID);
 assert.equal(interrupted.tickOrdinal,0);assert(interrupted.pollLease.until<f.now);
 assert.equal([...f.messages.values()].filter(row=>row.message.kind==='tick').length,1);
 f.provider.playback=playback;
 await f.restart().tick(predecessor);
 assert.equal((await f.store.read(credential.connectionID)).tickOrdinal,1);
 assert.equal(f.next().ordinal,1);assert(f.next('acquire'));
 assert.equal((await f.store.pending(credential.connectionID)).length,0);
});

const run=promisify(execFile),helper=new URL('../helpers/spotify.js',import.meta.url).href;
for(const boundary of ['enrollmentProved','enrollmentAdopted'])test(`process death at ${boundary} recovers adoption and terminal publication before status ACK`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'spotify-adoption-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const program=`
  import fs from 'node:fs/promises';
  import {randomUUID} from 'node:crypto';
  import {fixture,user} from ${JSON.stringify(helper)};
  const [directory,mode,boundary]=process.argv.slice(1),queuePath=directory+'/queue.json';
  let queue=[];try{queue=JSON.parse(await fs.readFile(queuePath,'utf8'));}catch{}
  const enqueue=async(kind,message,options)=>{if(!queue.some(row=>row.id===options.idempotencyKey)){queue.push({id:options.idempotencyKey,kind,message});await fs.writeFile(queuePath,JSON.stringify(queue));}return {messageId:options.idempotencyKey};};
  const f=await fixture({after(){}},{path:directory+'/postgres',overrides:{enqueue}});
  if(mode==='crash'){
   const old=await f.enroll();await f.arm(old.credential);f.advance(1);
   const enrollmentID=randomUUID();await fs.writeFile(directory+'/identity.json',JSON.stringify({oldID:old.credential.connectionID,enrollmentID}));
   f.restart({crash:async point=>{if(point===boundary){await f.db.exec('CHECKPOINT');process.exit(73);}}});
   await f.service.enrollment(user,{enrollmentID,refreshToken:'fixture-refresh'});throw Error('expected crash');
  }else{
   const {oldID,enrollmentID}=JSON.parse(await fs.readFile(directory+'/identity.json','utf8'));
   f.provider.refresh=async()=>{throw Error('recovery must not rotate a proven grant');};
   const recovered=await f.service.status(user,{enrollmentID});
   const old=await f.store.read(oldID),first=JSON.stringify(recovered),again=await f.service.status(user,{enrollmentID});
   console.log(JSON.stringify({status:recovered.status,ack:recovered.credential.refreshOwnershipAcknowledged,oldStatus:old.status,oldRefreshCleared:old.refresh===null,ended:Object.values(old.consumers).every(s=>s.status==='ended'),cleanup:queue.filter(row=>row.message.kind==='cleanup').length,pending:(await f.store.pending(oldID)).length,idempotent:first===JSON.stringify(again)}));
   await f.db.close();
  }
 `;
 await assert.rejects(run(process.execPath,['--input-type=module','-e',program,directory,'crash',boundary]),error=>error.code===73);
 const {stdout}=await run(process.execPath,['--input-type=module','-e',program,directory,'recover',boundary]);
 assert.deepEqual(JSON.parse(stdout.trim()),{status:'connected',ack:true,oldStatus:'disconnected',oldRefreshCleared:true,ended:true,cleanup:1,pending:0,idempotent:true});
 const queue=await readFile(join(directory,'queue.json'),'utf8');assert(!queue.includes('fixture-refresh'));assert(!queue.includes('fixture-access'));
});

test('concurrent proven enrollments adopt one deterministic winner and cannot retire each other',async t=>{
 const f=await fixture(t),ids=[randomUUID(),randomUUID()];let entered=0,ready,release;
 const both=new Promise(resolve=>ready=resolve),gate=new Promise(resolve=>release=resolve);
 f.restart({crash:async point=>{if(point==='enrollmentProved'){if(++entered===2)ready();await gate;}}});
 const first=f.service.enrollment(user,{enrollmentID:ids[0],refreshToken:'first'});
 // Persist the first candidate before assigning the second candidate a newer order.
 for(let attempt=0;!await f.store.enrollment(user,ids[0]);attempt++){
  assert(attempt<1000,'first enrollment did not persist');await new Promise(resolve=>setImmediate(resolve));
 }
 f.advance(1);const second=f.service.enrollment(user,{enrollmentID:ids[1],refreshToken:'second'});
 await both;release();const replies=await Promise.all([first,second]);
 assert.deepEqual(replies.map(reply=>reply.status),['disconnected','connected']);
 const rows=(await f.db.query("SELECT data FROM spotify_connections WHERE data->>'status'='connected'")).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].data.enrollmentID,ids[1]);
});

test('a connected status cannot ACK while an older grant cleanup publication is unresolved',async t=>{
 const f=await fixture(t),old=await f.enroll();await f.arm(old.credential);f.advance(1);
 const enrollmentID=randomUUID(),enqueue=f.options.enqueue;
 f.restart({enqueue:async(kind,message,options)=>{if(message.kind==='cleanup')throw Error('cleanup queue unavailable');return enqueue(kind,message,options);}});
 await assert.rejects(f.service.enrollment(user,{enrollmentID,refreshToken:'newer'}),/cleanup queue unavailable/);
 await assert.rejects(f.service.status(user,{enrollmentID}),/cleanup queue unavailable/);
 const closed=await f.store.read(old.credential.connectionID);assert.equal(closed.status,'disconnected');assert.equal((await f.store.pending(closed.id)).filter(row=>row.kind==='cleanup').length,1);
 f.restart({enqueue});const reply=await f.service.status(user,{enrollmentID});
 assert.equal(reply.credential.refreshOwnershipAcknowledged,true);assert.equal((await f.store.pending(closed.id)).length,0);assert(f.next('cleanup'));
});

test('adopting a proven older grant preserves a newer pending grant until its proof succeeds',async t=>{
 const f=await fixture(t),olderID=randomUUID(),newerID=randomUUID();let olderReady,releaseOlder,newerReady,releaseNewer;
 const olderStarted=new Promise(resolve=>olderReady=resolve),olderGate=new Promise(resolve=>releaseOlder=resolve);
 const newerStarted=new Promise(resolve=>newerReady=resolve),newerGate=new Promise(resolve=>releaseNewer=resolve);
 const refresh=f.provider.refresh;
 f.provider.refresh=async token=>{if(token==='newer'){newerReady();await newerGate;}return refresh(token);};
 f.restart({crash:async point=>{if(point==='enrollmentProved'){const older=await f.store.enrollment(user,olderID);if(older?.status==='connected'&&!await f.store.enrollment(user,newerID)){olderReady();await olderGate;}}}});
 const older=f.service.enrollment(user,{enrollmentID:olderID,refreshToken:'older'});await olderStarted;
 f.advance(1);const newer=f.service.enrollment(user,{enrollmentID:newerID,refreshToken:'newer'});await newerStarted;
 releaseOlder();assert.equal((await older).status,'connected');assert.equal((await f.store.enrollment(user,newerID)).status,'pending');
 releaseNewer();assert.equal((await newer).status,'connected');assert.equal((await f.store.enrollment(user,olderID)).status,'disconnected');
});

test('adoption cannot retire another configured environment or Spotify client',async t=>{
 const f=await fixture(t),original=await f.enroll(),prior=await f.store.read(original.credential.connectionID);
 for(const config of [{...f.options.config,environment:'production'},{...f.options.config,clientID:'b'.repeat(32)}]){
  f.advance(1);await f.restart({config}).enrollment(user,{enrollmentID:randomUUID(),refreshToken:'newer'});
  assert.deepEqual(await f.store.read(prior.id),prior);
 }
});

test('delivery exhaustion cannot close a foreign environment/client or a replaced epoch',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();await f.arm(credential);const message=f.next(),before=await f.store.read(credential.connectionID);
 for(const config of [{...f.options.config,environment:'production'},{...f.options.config,clientID:'b'.repeat(32)}]){
  await assert.rejects(f.restart({config}).exhaust(message),{code:'spotify_environment_mismatch'});
  assert.deepEqual(await f.store.read(before.id),before);
 }
 f.restart({config:{...f.options.config,environment:before.environment,clientID:before.clientID}});
 await f.service.exhaust({...message,connectionEpoch:randomUUID()});assert.deepEqual(await f.store.read(before.id),before);
});

test('owner revocation locks attested keys before connection rows even before any grant exists',async()=>{
 const queries=[],db={query:async(sql,args)=>{queries.push({sql,args});return {rows:sql.includes('to_regclass')?[{name:'spotify_connections'}]:[]};}};
 assert.deepEqual(await revokeSpotifyInTransaction(db,{ownerID:user.id,keyID:user.keyID,credentialDigest:user.credentialDigest}),[]);
 const key=queries.findIndex(row=>row.sql.includes('FROM app_attest_keys')&&row.sql.includes('FOR UPDATE'));
 const connection=queries.findIndex(row=>row.sql.includes('FROM spotify_connections')&&row.sql.includes('FOR UPDATE'));
 assert(key>=0&&connection>key);assert.match(queries[key].sql,/ORDER BY key_id FOR UPDATE/);assert.match(queries[connection].sql,/ORDER BY id FOR UPDATE/);
 assert.deepEqual(queries[key].args,[user.id,user.keyID]);assert.deepEqual(queries[connection].args,[user.id,user.keyID,user.credentialDigest]);
});
