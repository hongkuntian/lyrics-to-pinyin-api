import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,user,recipe,recording,playback,documentFor} from '../helpers/spotify.js';
import {leadSeconds} from '../../api/utils/spotify/render.js';
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
test('unknown APNs outcome reuses immutable bytes and timestamp; superseded recipe cannot be restamped',async t=>{
 const f=await fixture(t),{credential}=await f.enroll(),armed=await f.arm(credential);let once=true;const accepted=[];
 f.restart({send:async request=>{accepted.push(structuredClone(request));if(once){once=false;throw new LibraryError('push_unavailable',503);}}});
 const predecessor=f.next();await assert.rejects(f.service.tick(predecessor),{code:'push_unavailable'});f.advance(1000);await f.restart().tick(predecessor);
 assert.deepEqual(accepted[1].payload,accepted[0].payload);assert.equal(f.polls,2);
 await f.service.live(user,{...credential,sessionID:armed.session.sessionID,recipe:{...recipe,alignment:'centered'}},'live.preferences');
 assert.equal((await f.store.read(credential.connectionID)).consumers[armed.session.sessionID].recipeRevision,2);
});
test('uncertain refresh death resumes persisted returned stage without second provider rotation',async t=>{
 const f=await fixture(t),enrollmentID=randomUUID();let once=true;
 f.restart({crash:async point=>{if(point==='refreshStaged'&&once){once=false;crash();}}});
 await assert.rejects(f.service.enrollment(user,{enrollmentID,refreshToken:'fixture-refresh'}),/crash/);
 f.advance(10001);const reply=await f.restart({crash:async()=>{}}).status(user,{enrollmentID});assert.equal(reply.status,'connected');assert.equal(f.refreshes,1);
});
test('two remote-refresh uncertainties suspend/reconnect rather than looping forever',async t=>{
 const f=await fixture(t),enrollmentID=randomUUID();f.provider.refresh=async()=>{throw new LibraryError('spotify_refresh_uncertain',503);};
 for(let i=0;i<2;i++)await assert.rejects(f.service.enrollment(user,{enrollmentID,refreshToken:'fixture-refresh'}),{code:'spotify_refresh_uncertain'});
 assert.equal((await f.service.status(user,{enrollmentID})).status,'reconnectRequired');
});
test('follow lifetime uses actual creation across offline delay and active-key rotation reencrypts without OAuth refresh',async t=>{
 const f=await fixture(t),{credential}=await f.enroll(),created=f.now-60000,arm=await f.arm(credential,{activityCreatedAtMS:created});assert.equal(arm.session.expiresAtMS,created+28500000);
 const {createVault}=await import('../../api/utils/spotify/vault.js');
 f.restart({config:{...f.options.config,vault:createVault({active:'two',keys:{one:Buffer.alloc(32,1).toString('base64'),two:Buffer.alloc(32,2).toString('base64')}})}});
 const updated=await f.service.access(user,credential);assert.equal(updated.credential.credentialVersion,2);assert.equal(f.refreshes,1);
 const current=await f.store.read(credential.connectionID);assert.equal(current.refresh.keyID,'two');assert.equal(current.consumers[arm.session.sessionID].token.keyID,'two');
});
test('new enrollment cannot race a completed owner/key move even if authentication happened earlier',async t=>{
 const f=await fixture(t);await f.db.query("INSERT INTO library_users(id) VALUES('new-owner')");await f.db.query("UPDATE app_attest_keys SET user_id='new-owner' WHERE key_id=$1",[user.keyID]);
 await assert.rejects(f.enroll(),{code:'app_access_revoked'});assert.equal(f.refreshes,0);assert.equal((await f.db.query('SELECT count(*) AS n FROM spotify_connections')).rows[0].n,0);
});
test('entitlement removal after committed observation suppresses update and drains a durable terminal executor before ACK',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();await f.arm(credential);let removed=false;
 f.restart({eligible:async()=>{},admit:async()=>{if(removed)throw new LibraryError('plus_required',403);},crash:async point=>{if(point==='tickCommitted')removed=true;}});
 await f.service.tick(f.next());assert.equal(f.sends.length,0);assert(f.next('cleanup'));assert.equal((await f.store.pending(credential.connectionID)).length,0);
 assert.equal(Object.values((await f.store.read(credential.connectionID)).consumers)[0].status,'ended');
});
test('real Song Library 202 lookup contention keeps an acquisition retry executor and never admits AI work',async t=>{
 const {libraryDB}=await import('../helpers/library-db.js'),{createSongLibraryService}=await import('../../api/song-library.js'),{createAcquirer}=await import('../../api/utils/spotify/runtime.js'),{requestKey}=await import('../../api/utils/song-library/document.js');
 const library=await libraryDB();t.after(()=>library.db.close());const f=await fixture(t),{credential}=await f.enroll();await f.arm(credential);await f.service.tick(f.next());
 const owner=await library.store.claimLookup(requestKey(recording),'fixture-selection');let loads=0;
 const acquirer=createAcquirer(createSongLibraryService({store:library.store,selectionRevision:'fixture-selection',apiKey:null,loadLyrics:async()=>{loads++;throw Error('must not run provider during contention');}}));
 f.restart({acquire:acquirer});const original=f.next('acquire');await f.service.acquireMessage(original);assert.equal(loads,0);assert.notEqual(f.next('acquire').outboxID,original.outboxID);
 assert.equal((await library.db.query('SELECT count(*) AS n FROM translation_jobs')).rows[0].n,0);await library.store.releaseLookup(requestKey(recording),'fixture-selection',owner);
});
test('absent/mismatched acquisition leaves explicit unavailable status while later observations still execute',async t=>{
 const f=await fixture(t),{credential}=await f.enroll(),arm=await f.arm(credential);await f.service.tick(f.next());f.restart({acquire:async()=>({status:404,code:'lyrics_absent'})});await f.service.acquireMessage(f.next('acquire'));f.advance(2000);await f.service.tick(f.next());
 const snapshot=(await f.store.read(credential.connectionID)).consumers[arm.session.sessionID].snapshot;assert.equal(snapshot.state.phase,'unavailable');assert.equal(snapshot.state.statusReason,'lyrics_absent');assert(f.next().ordinal>=2);
});
test('preview/production and configured Client ID cannot use or mutate each other\'s persisted grants',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();await f.arm(credential);const before=await f.store.read(credential.connectionID),polls=f.polls;
 for(const config of [{...f.options.config,environment:'production'},{...f.options.config,clientID:'b'.repeat(32)}]){
  f.restart({config});await assert.rejects(f.service.access(user,credential),{code:'spotify_environment_mismatch'});await assert.rejects(f.service.tick(f.next()),{code:'spotify_environment_mismatch'});
 }
 assert.equal(f.polls,polls);assert.deepEqual(await f.store.read(credential.connectionID),before);
});
// Cue changes between polls. The fake sleep advances the fake clock, so each test
// reads the exact moment a publication was decided.
const lead=leadSeconds*1000,line=request=>request.payload.aps['content-state'].original;
async function following(t,{lines,phase=400,arm={}}={}){
 const f=await fixture(t,{overrides:lines?{acquire:async r=>({status:200,document:documentFor(r,lines)})}:{}}),{credential}=await f.enroll(),armed=await f.arm(credential,arm);
 await f.service.tick(f.next());await f.service.acquireMessage(f.next('acquire'));
 const slept=[];f.restart({sleep:async ms=>{slept.push(ms);f.advance(ms);}});
 // Each poll reports `at` milliseconds into the song. `phase` places polls inside their wall second.
 const poll=async(at,{advance=2000,playing=true}={})=>{f.advance(advance);f.provider.playback=async()=>({status:200,body:playback(at,playing),requestStartedAt:f.now-10,responseReceivedAt:f.now});const from=f.sends.length,started=f.now;await f.service.tick(f.next());return {started,sent:f.sends.slice(from)};};
 f.advance(phase);
 return {f,credential,armed,slept,poll,consumer:async()=>(await f.store.read(credential.connectionID)).consumers[armed.session.sessionID],cues:async()=>(await f.db.query("SELECT state,receipt,data FROM spotify_outbox WHERE kind='publication' AND data->>'cue'='true' ORDER BY due_at_ms")).rows};
}
test('a line between polls is published at its own start less the head start, inside the poll\'s lease, once',async t=>{
 const {f,credential,poll,slept,consumer,cues}=await following(t),send=f.options.send;let met=0;
 // Mid-send, another invocation's drain finds nothing of this line to collide with.
 f.restart({send:async request=>{if(line(request)==='Next original'){assert.deepEqual(await f.store.pending(credential.connectionID),[]);await f.service.drain(credential.connectionID);met++;}return send(request);}});
 const first=await poll(18500);assert.equal(met,1);
 assert.deepEqual(first.sent.map(line),['Fixture original','Next original']);
 const [atPoll,atCue]=first.sent;
 assert(Math.abs(f.now-first.started-(1500-lead))<=2);assert.equal(slept.length,1);
 assert.equal(atCue.payload.aps.timestamp,Math.floor(f.now/1000));assert(atCue.payload.aps.timestamp>atPoll.payload.aps.timestamp);
 // Same confirmation and deadline as the poll it extrapolates: the lease is never extended.
 assert.equal(atCue.payload.aps['stale-date'],atPoll.payload.aps['stale-date']);assert.equal(atCue.payload.aps['content-state'].confirmedAt,atPoll.payload.aps['content-state'].confirmedAt);
 assert.equal(atCue.payload.aps['content-state'].sequence,atPoll.payload.aps['content-state'].sequence+1);assert.equal(atCue.priority,10);assert.equal(atCue.pushType,'liveactivity');
 const rows=await cues();assert.equal(rows.length,1);assert.equal(rows[0].state,'published');assert.equal(rows[0].receipt,'accepted');assert.deepEqual(rows[0].data.payload,atCue.payload);
 const s=await consumer();assert.equal(s.sendLease,null);assert.equal(s.snapshot.state.original,'Next original');
 assert.equal((await f.store.pending(credential.connectionID)).length,0);
 // The next poll agrees with what is shown and publishes nothing.
 assert.deepEqual((await poll(20500,{advance:2000-(f.now-first.started)})).sent,[]);
});
test('a newer poll takes over a pending line and a slightly earlier estimate never steps the card back',async t=>{
 const {f,credential,armed,poll}=await following(t);let inner=false,woke=0;
 // A hint makes the server poll at once, as the app does when it notices a change.
 const wake=async at=>{const from=f.sends.length;f.provider.playback=async()=>({status:200,body:playback(at),requestStartedAt:f.now-10,responseReceivedAt:f.now});await f.service.live(user,{...credential,sessionID:armed.session.sessionID},'live.hint');woke++;await f.service.tick(f.next('wake'));return f.sends.slice(from);};
 // While the first poll's timer waits, Spotify reports 0.3 s less than that poll implied.
 f.restart({sleep:async ms=>{if(inner){f.advance(ms);return;}inner=true;f.advance(400);await wake(18600);}});
 const first=await poll(18500);assert.equal(woke,1);
 assert.deepEqual(first.sent.map(line),['Fixture original','Next original']);
 // Published once, by the newer observation, on its own timeline: 18.6 s at +400 ms.
 assert(Math.abs(f.now-first.started-(400+1400-lead))<=2);
 // A sample 0.3 s behind the line already shown holds it; nothing steps back.
 f.advance(300);assert.deepEqual(await wake(19050),[]);
 // A real seek back is followed.
 f.advance(300);assert.deepEqual((await wake(5000)).map(line),['Fixture original']);
});
test('a line due in the second of the previous publication waits for the next real second',async t=>{
 const {f,poll}=await following(t,{phase:0}),first=await poll(18500);
 assert.deepEqual(first.sent.map(line),['Fixture original','Next original']);
 assert.equal(Math.floor((first.started+1500-lead)/1000),first.sent[0].payload.aps.timestamp);
 assert.equal(f.now,(first.sent[0].payload.aps.timestamp+1)*1000);assert.equal(first.sent[1].payload.aps.timestamp,first.sent[0].payload.aps.timestamp+1);
});
test('paused playback, a line beyond the follow window and a service without a timer publish only at polls',async t=>{
 const {f,poll,slept}=await following(t);
 assert.deepEqual((await poll(19000,{playing:false})).sent.map(line),['Fixture original']);
 assert.deepEqual((await poll(14000)).sent.map(line),['Fixture original']);assert.deepEqual(slept,[]);
 f.restart({sleep:null});assert.deepEqual((await poll(19000)).sent,[]);assert.deepEqual((await poll(20500)).sent.map(line),['Next original']);
});
test('a failed line send is recorded, frees the publisher and is published again by the next poll',async t=>{
 const {f,poll,consumer,cues}=await following(t),send=f.options.send;let failed=false;
 f.restart({send:async request=>{if(line(request)==='Next original'&&!failed){failed=true;throw new LibraryError('push_unavailable',503);}return send(request);}});
 const first=await poll(18500);assert(failed);assert.deepEqual(first.sent.map(line),['Fixture original']);
 const rows=await cues();assert.equal(rows[0].state,'cancelled');assert.equal(rows[0].receipt,'push_unavailable');assert.equal((await consumer()).sendLease,null);
 assert.deepEqual((await poll(20500,{advance:2000-(f.now-first.started)})).sent.map(line),['Next original']);
});
test('entitlement removed before a line ends the activity instead of publishing it',async t=>{
 const {f,poll,consumer}=await following(t);let removed=false;
 f.restart({admit:async(c,input)=>{if(removed)throw new LibraryError('membership_required',403);},eligible:async()=>{},sleep:async ms=>{f.advance(ms);removed=true;}});
 const first=await poll(18500);assert.deepEqual(first.sent.map(line),['Fixture original']);
 const s=await consumer();assert.equal(s.status,'ended');assert.equal(s.sendLease,null);assert(f.next('cleanup'));
});
test('a token replaced while a line waits is not sent to; the next poll publishes the line to the new token',async t=>{
 const {f,credential,armed,poll,cues}=await following(t),session={...credential,sessionID:armed.session.sessionID,activityID:armed.session.activityID};
 // The app registers a rotated token just after the line is staged for the old one.
 const read=f.store.read.bind(f.store);let rotate=true;
 f.store.read=async id=>{if(rotate&&(await read(id)).consumers[session.sessionID].sendLease){rotate=false;await f.store.mutate(id,current=>{const s=current.consumers[session.sessionID];s.token=f.service.seal(current,'cd'.repeat(32),'activity:'+s.sessionID);s.tokenVersion=2;s.pendingPublication=null;});}return read(id);};
 const first=await poll(18500);assert.equal(rotate,false);assert.deepEqual(first.sent.map(line),['Fixture original']);
 assert.equal((await cues())[0].receipt,'superseded');
 const next=await poll(20500,{advance:2000-(f.now-first.started)});assert.deepEqual(next.sent.map(request=>[line(request),request.token]),[['Next original','cd'.repeat(32)]]);
});
test('an invalid token met by a line ends that activity through the ordinary terminal path',async t=>{
 const {f,poll,consumer,cues}=await following(t),send=f.options.send;
 f.restart({send:async request=>{if(line(request)==='Next original')throw new LibraryError('push_token_invalid',410);return send(request);}});
 await poll(18500);const s=await consumer();assert.equal(s.status,'ended');assert.equal(s.reason,'tokenInvalid');assert.equal(s.sendLease,null);assert(f.next('cleanup'));assert.equal((await cues())[0].receipt,'push_token_invalid');
});
test('the poll is acknowledged before its lines are followed, and following is handed to the platform to keep alive',async t=>{
 const {f,poll}=await following(t);let handed,release;const waiting=new Promise(resolve=>release=resolve);
 f.restart({defer:work=>{handed=work;},sleep:async ms=>{await waiting;f.advance(ms);}});
 const first=await poll(18500);assert.deepEqual(first.sent.map(line),['Fixture original']);assert.equal(f.now,first.started);assert(handed);
 release();await handed;assert.deepEqual(f.sends.slice(-1).map(line),['Next original']);assert(Math.abs(f.now-first.started-(1500-lead))<=2);
});
test('a line published late in a lease is renewed before that lease ends, not four seconds later',async t=>{
 const {f,poll}=await following(t),first=await poll(16500);
 // The line is published 2.85 s into an eight-second lease.
 assert.deepEqual(first.sent.map(line),['Fixture original','Next original']);assert(Math.abs(f.now-first.started-(3500-lead))<=2);
 assert.deepEqual((await poll(20000,{advance:150})).sent,[]);
 const renewal=await poll(22000);assert.deepEqual(renewal.sent.map(line),['Next original']);assert.equal(renewal.sent[0].priority,10);
 assert(renewal.sent[0].payload.aps['stale-date']>first.sent[1].payload.aps['stale-date']);assert(renewal.started-f.now<=0&&renewal.started-(first.started+3500-lead)<4000);
});
for(const [name,third,expected] of [['no keep-alive is spent when the next line will renew the card in time',25.5,[['Third original',10]]],['a keep-alive is still sent when the next line would come too late for the deadline',27,[['Next original',10],['Third original',10]]]])test(name,async t=>{
 // This phase puts the deadline on a whole second, where the card and the lease agree.
 const {f,poll}=await following(t,{phase:910,lines:[{original:'Fixture original',romanized:'',timestamp:0},{original:'Next original',romanized:'',timestamp:20},{original:'Third original',romanized:'',timestamp:third}]}),first=await poll(18500),origin=first.started,timer=f.options.sleep;
 assert.deepEqual(first.sent.map(line),['Fixture original','Next original']);
 assert.deepEqual((await poll(20500,{advance:origin+2000-f.now})).sent,[]);
 // This poll's own timer is cut short by the next poll, as when polls arrive on time.
 f.restart({sleep:null});assert.deepEqual((await poll(22500)).sent,[]);f.restart({sleep:timer});
 // The last publication is five seconds old, 1.99 s before its deadline.
 const due=await poll(24500);assert.deepEqual(due.sent.map(request=>[line(request),request.priority]),expected);
 assert(Math.abs(f.now-due.started-((third-24.5)*1000-lead))<=2);
});
test('a keep-alive counts the deadline as the card does: on the whole second its stale date names',async t=>{
 // The lease ends 7.99 s after this poll, but its stale date is that time rounded down, 0.89 s sooner.
 const {f,poll}=await following(t,{phase:800}),first=await poll(18500),stale=first.sent[1].payload.aps['stale-date']*1000;
 assert.deepEqual(first.sent.map(line),['Fixture original','Next original']);assert.equal(first.started+7990-stale,890);
 assert.deepEqual((await poll(20500,{advance:first.started+2000-f.now})).sent,[]);
 // 3.1 s remain on the card, 3.99 s on the lease: waiting for the next poll would leave 1.1 s.
 const renewal=await poll(22500);assert.equal(stale-renewal.started,3100);
 assert.deepEqual(renewal.sent.map(request=>[line(request),request.priority]),[['Next original',10]]);assert(renewal.sent[0].payload.aps['stale-date']*1000>stale);
});
test('with frequent updates off a keep-alive stays at the priority of the line changes around it',async t=>{
 const {poll}=await following(t,{arm:{frequentPushesEnabled:false}}),first=await poll(18500);
 assert.deepEqual(first.sent.map(request=>[line(request),request.priority]),[['Fixture original',5],['Next original',5]]);
 assert.deepEqual((await poll(20500)).sent,[]);assert.deepEqual((await poll(22500)).sent.map(request=>[line(request),request.priority]),[['Next original',5]]);
});
