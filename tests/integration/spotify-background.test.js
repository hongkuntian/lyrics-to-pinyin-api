import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,user,recipe,recording,playback} from '../helpers/spotify.js';
import {LibraryError} from '../../api/utils/song-library/store.js';
import {revokeSpotifyInTransaction,flushSpotifyCleanup} from '../../api/utils/spotify/revocation.js';
const crash=()=>{throw Object.assign(new Error('crash'),{code:'simulated_crash'});};
test('durable arm bootstrap must be accepted before ACK; same UUID retries and no phantom executor',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();let once=true;
 f.restart({crash:async point=>{if(point==='armCommitted'&&once){once=false;crash();}}});
 const input={armID:randomUUID(),installationID:randomUUID(),sessionID:randomUUID(),activityID:randomUUID()};
 await assert.rejects(f.arm(credential,input),/crash/);assert.equal(f.messages.size,0);
 assert.equal((await f.store.read(credential.connectionID)).consumers[input.sessionID].status,'connecting');
 f.restart({crash:async()=>{}});const armed=await f.arm(credential,input);assert.equal(armed.status,'armed');assert(f.next());
 assert.equal(f.refreshes,1);
});
test('enrollment stages rotated secrets before proof/ACK, cancels pending UUID and fences late activation',async t=>{
 const f=await fixture(t),enrollmentID=randomUUID();let release,entered;
 const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);
 f.provider.refresh=async()=>{entered();await gate;return {accessToken:'late-access',refreshToken:'rotated-secret',expiresAtMS:f.now+3600000,scope:['app-remote-control','user-read-playback-state']};};
 const pending=f.service.enrollment(user,{enrollmentID,refreshToken:'old-secret',scopeRawValue:49152});await start;
 assert.equal((await f.service.disconnect(user,{enrollmentID})).status,'disconnected');release();assert.equal((await pending).status,'disconnected');
 assert.equal((await f.service.enrollment(user,{enrollmentID,refreshToken:'new-secret'})).status,'disconnected');
 const rows=(await f.db.query('SELECT data FROM spotify_connections')).rows;assert(!JSON.stringify(rows).includes('secret'));
});
test('distributed broker renewals single-flight and preserve omitted refresh token through actual provider adapter',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();f.advance(3600000);
 let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r),original=f.provider.refresh;
 f.provider.refresh=async token=>{entered();await gate;return original(token);};
 const first=f.service.access(user,credential);await start;
 const second=await f.restart().access(user,credential);assert.equal(second.credential.credentialVersion,1);release();assert.equal((await first).credential.credentialVersion,2);assert.equal(f.refreshes,2);
});
for(const boundary of ['tickCommitted','queueAccepted','queueReceipt'])test(`duplicate predecessor recovers ${boundary}, drains tick AND acquisition before ACK`,async t=>{
 const f=await fixture(t),{credential}=await f.enroll();await f.arm(credential);const predecessor=f.next();let once=true;
 f.restart({crash:async point=>{if(point===boundary&&once){once=false;crash();}}});await assert.rejects(f.service.tick(predecessor),/crash/);
 const after=await f.store.read(credential.connectionID);assert.equal(after.tickOrdinal,1);
 f.restart({crash:async()=>{}});await f.service.tick(predecessor);
 assert(f.next('acquire'));assert.equal(f.next().ordinal,1);assert.equal((await f.store.pending(credential.connectionID)).length,0);
 assert.equal(f.polls,2); // one enrollment probe + exactly one tick
});
test('unresolved acquisition send prevents predecessor ACK; 202 always commits a future executor',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();await f.arm(credential);const tick=f.next(),enqueue=f.options.enqueue;
 f.restart({enqueue:async(kind,...args)=>{if(kind==='acquire')throw new Error('queue unavailable');return enqueue(kind,...args);}});
 await assert.rejects(f.service.tick(tick),/queue unavailable/);
 f.restart({enqueue});await f.service.tick(tick);const acquisition=f.next('acquire');
 f.restart({acquire:async()=>({status:202,retryAfterMS:2000})});await f.service.acquireMessage(acquisition);
 const successor=f.next('acquire');assert.notEqual(successor.outboxID,acquisition.outboxID);assert.equal(successor.dueAtMS,f.now+2000);
});
test('update T then revoke T+.1 queues terminal executor in next real second after closure',async t=>{
 const f=await fixture(t),{credential}=await f.enroll(),armed=await f.arm(credential);await f.service.tick(f.next());
 const update=f.sends.at(-1);assert.equal(update.payload.aps.event,'update');f.advance(100);
 let ids;await f.sql.transaction(async db=>{ids=await revokeSpotifyInTransaction(db,{ownerID:user.id},'signedOut',f.now);await db.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[user.credentialDigest]);});
 assert.equal((await f.store.read(credential.connectionID)).status,'disconnected');
 // Crash before cleanup enqueue ACK: transaction already contains terminal intent.
 await assert.rejects(flushSpotifyCleanup(f.sql,ids,{enqueueFn:async()=>{throw new Error('offline');},now:()=>f.now}),/offline/);
 await f.service.tick(f.next());const cleanup=f.next('cleanup');assert(cleanup);assert(cleanup.dueAtMS>f.now);
 f.advance(1000);await f.service.tick(cleanup);
 const end=f.sends.at(-1);assert.equal(end.payload.aps.event,'end');assert(end.payload.aps.timestamp>update.payload.aps.timestamp);assert.equal(end.token,update.token);
 assert.equal((await f.store.read(credential.connectionID)).consumers[armed.session.sessionID].token,null);
});
test('late 410 for old token does not invalidate rebound current token; no consumers means no polling',async t=>{
 const f=await fixture(t),{credential}=await f.enroll(),armed=await f.arm(credential);const sid=armed.session.sessionID;
 let release,entered;const gate=new Promise(r=>release=r),start=new Promise(r=>entered=r);
 f.restart({send:async()=>{entered();await gate;throw new LibraryError('push_token_invalid',410);}});
 const tick=f.service.tick(f.next());await start;
 await f.service.live(user,{...credential,sessionID:sid,activityID:armed.session.activityID,token:'cd'.repeat(32),tokenVersion:2},'live.token');release();await tick;
 assert.equal((await f.store.read(credential.connectionID)).consumers[sid].status,'armed');
 f.restart({send:async()=>{}});await f.service.live(user,{...credential,sessionID:sid,reason:'user'},'live.stop');const polls=f.polls;f.advance(3000);await f.service.tick(f.next());assert.equal(f.polls,polls);
});
test('snapshot capability has read/own-widget replacement only and expires with follow',async t=>{
 const f=await fixture(t),{credential}=await f.enroll(),arm=await f.arm(credential),cap=arm.snapshotCapability;
 assert.equal(cap.expiresAtMS,arm.session.expiresAtMS);
 await f.service.snapshot(cap.token,{action:'snapshot.token',widgetToken:'cd'.repeat(32),tokenVersion:1});
 assert.equal((await f.service.snapshot(cap.token,{action:'snapshot.read'})).status,'waiting');
 await f.service.live(user,{...credential,sessionID:arm.session.sessionID,reason:'sourceChanged'},'live.stop');
 await assert.rejects(f.service.snapshot(cap.token,{action:'snapshot.read'}),e=>e.status===410);
});
test('indefinitely refreshed pause samples do not reset inactivity grace; provider failure never renews confirmation',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();await f.arm(credential);
 f.provider.playback=async()=>({status:200,body:playback(10000,false),requestStartedAt:f.now,responseReceivedAt:f.now});
 await f.service.tick(f.next());const confirmed=(await f.store.read(credential.connectionID)).observation.confirmedAt;
 f.advance(10000);f.provider.playback=async()=>{throw new LibraryError('spotify_unavailable',503);};await f.service.tick(f.next());
 assert.equal((await f.store.read(credential.connectionID)).observation.confirmedAt,confirmed);assert.equal(Object.values((await f.store.read(credential.connectionID)).consumers)[0].snapshot.state.statusReason,'updatesDelayed');
 f.advance(110000);f.provider.playback=async()=>({status:200,body:playback(10000,false),requestStartedAt:f.now,responseReceivedAt:f.now});await f.service.tick(f.next());assert(f.next('cleanup'));
});
