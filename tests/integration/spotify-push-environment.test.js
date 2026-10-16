import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,user} from '../helpers/spotify.js';
import {spotifyConfiguration,vaultContext} from '../../api/utils/spotify/vault.js';
import {validateSpotifyInput} from '../../api/spotify.js';
import {revokeSpotifyInTransaction,flushSpotifyCleanup} from '../../api/utils/spotify/revocation.js';

const owner={...user,environment:'production'};
async function personalFixture(t){
 const f=await fixture(t);await f.db.query("UPDATE app_attest_keys SET environment='production' WHERE key_id=$1",[user.keyID]);
 f.store.policy={environment:'production',audience:'fixture',bundles:[user.bundleID]};
 f.restart({config:{...f.options.config,apnsEnvironment:'development'}});
 const enrollmentID=randomUUID(),reply=await f.service.enrollment(owner,{enrollmentID,refreshToken:'fixture-refresh'});
 return {f,enrollmentID,credential:reply.credential};
}

test('Spotify APNs destination is a strict server enum with production default and no caller selector',()=>{
 const env={LYRA_SPOTIFY_CLIENT_ID:'a'.repeat(32),LYRA_SPOTIFY_RATE_BUCKET:'fixture',VERCEL_ENV:'production',LYRA_SPOTIFY_VAULT_KEYRING:JSON.stringify({active:'one',keys:{one:Buffer.alloc(32,1).toString('base64')}})};
 assert.equal(spotifyConfiguration(env).apnsEnvironment,'production');
 assert.equal(spotifyConfiguration({...env,LYRA_SPOTIFY_APNS_ENVIRONMENT:'development'}).apnsEnvironment,'development');
 for(const value of ['sandbox','preview','',null])assert.throws(()=>spotifyConfiguration({...env,LYRA_SPOTIFY_APNS_ENVIRONMENT:value}),{code:'spotify_not_configured'});
 assert.throws(()=>validateSpotifyInput({version:1,action:'connection.enroll',enrollmentID:randomUUID(),refreshToken:'fixture',scopeRawValue:49152,apnsEnvironment:'development'}),{code:'invalid_request'});
});

test('production attestation remains valid for development APNs activity and widget tokens',async t=>{
 const {f,credential}=await personalFixture(t),c=await f.store.read(credential.connectionID);
 assert.equal(c.ownerEnvironment,'production');assert.equal(c.apnsEnvironment,'development');assert.equal(await f.store.ownerValid(c),true);
 assert.equal(await f.store.ownerValid({...c,ownerEnvironment:'development'}),false);
 assert.equal(await f.store.ownerValid({...c,ownerEnvironment:undefined}),false);
 const armed=await f.arm(credential);
 await f.service.snapshot(armed.snapshotCapability.token,{action:'snapshot.token',widgetToken:'cd'.repeat(32),tokenVersion:1});
 await f.service.tick(f.next());
 assert(f.sends.some(send=>send.pushType==='liveactivity'));assert(f.sends.some(send=>send.pushType==='widgets'));
 assert(f.sends.every(send=>send.environment==='development'));
 await assert.rejects(f.service.live(owner,{...credential,sessionID:armed.session.sessionID,activityID:armed.session.activityID,token:'ef'.repeat(32),tokenVersion:1},'live.token'),{code:'spotify_token_superseded'});
 assert.equal((await f.store.read(c.id)).consumers[armed.session.sessionID].tokenVersion,1);
});

test('vault authentication binds owner attestation and immutable APNs destination independently',async t=>{
 const {f,credential}=await personalFixture(t),c=await f.store.read(credential.connectionID),context={...vaultContext(c),purpose:'refresh'};
 assert.equal(f.options.config.vault.open(c.refresh,context),'fixture-refresh');assert.equal(c.refresh.version,2);
 for(const change of [{ownerEnvironment:'development'},{apnsEnvironment:'production'}])assert.throws(()=>f.options.config.vault.open(c.refresh,{...context,...change}),{code:'spotify_vault_unavailable'});
});

test('owner revocation still closes production-attested personal follow and ends it in original APNs environment',async t=>{
 const {f,credential}=await personalFixture(t),arm=await f.arm(credential);await f.service.tick(f.next());f.advance(100);
 let ids;await f.sql.transaction(async db=>{ids=await revokeSpotifyInTransaction(db,{ownerID:owner.id,keyID:owner.keyID},'ownerChanged',f.now);await db.query('UPDATE app_attest_keys SET revoked=true WHERE key_id=$1',[owner.keyID]);});
 await flushSpotifyCleanup(f.sql,ids,{enqueueFn:f.options.enqueue,now:()=>f.now});f.advance(1000);await f.service.tick(f.next('cleanup'));
 const terminal=f.sends.at(-1);assert.equal(terminal.payload.aps.event,'end');assert.equal(terminal.environment,'development');
 const c=await f.store.read(credential.connectionID);assert.equal(c.status,'disconnected');assert.equal(c.ownerEnvironment,'production');assert.equal(c.apnsEnvironment,'development');assert.equal(c.consumers[arm.session.sessionID].token,null);assert.equal(await f.store.ownerValid(c),false);
});

test('server APNs switch retires old grants and tokens without redirecting even terminal cleanup',async t=>{
 const {f,enrollmentID,credential}=await personalFixture(t),arm=await f.arm(credential);await f.service.tick(f.next());const original=await f.store.read(credential.connectionID),oldTick=f.next(),oldAcquire=f.next('acquire');
 f.restart({config:{...f.options.config,apnsEnvironment:'production'}});
 assert.equal((await f.service.status(owner,{enrollmentID})).status,'reconnectRequired');
 const closed=await f.store.read(original.id);assert.equal(closed.reason,'pushEnvironmentChanged');assert.notEqual(closed.epoch,original.epoch);assert.equal(closed.apnsEnvironment,'development');assert.equal(closed.ownerEnvironment,'production');assert.equal(closed.access,null);assert.equal(closed.refresh,null);assert.equal(closed.consumers[arm.session.sessionID].tokenVersion,1);
 await assert.rejects(f.service.access(owner,credential),{code:'spotify_connection_replaced'});
 await assert.rejects(f.service.snapshot(arm.snapshotCapability.token,{action:'snapshot.read'}),error=>error.status===410);
 const before=f.sends.length,polls=f.polls;await f.service.tick(oldTick);await f.service.acquireMessage(oldAcquire);assert.equal(f.sends.length,before);assert.equal(f.polls,polls);
 f.advance(1000);await f.service.tick(f.next('cleanup'));const terminal=f.sends.at(-1);assert.equal(terminal.payload.aps.event,'end');assert.equal(terminal.environment,'development');
 f.advance(1);const fresh=await f.service.enrollment(owner,{enrollmentID:randomUUID(),refreshToken:'new-grant'});await f.arm(fresh.credential,{token:'ef'.repeat(32)});await f.service.tick(f.next());
 assert(f.sends.filter(send=>send.token==='ab'.repeat(32)).every(send=>send.environment==='development'));
 assert(f.sends.filter(send=>send.token==='ef'.repeat(32)).every(send=>send.environment==='production'));
 assert.equal((await f.store.read(fresh.credential.connectionID)).apnsEnvironment,'production');
});

test('cancellation by enrollment or connection remains idempotent across a push configuration change',async t=>{
 for(const mode of ['enrollment','connection']){
  const {f,enrollmentID,credential}=await personalFixture(t);f.restart({config:{...f.options.config,apnsEnvironment:'production'}});
  const input=mode==='enrollment'?{enrollmentID}:credential;
  assert.equal((await f.service.disconnect(owner,input)).status,'disconnected');assert.equal((await f.service.disconnect(owner,input)).status,'disconnected');
  assert.equal((await f.service.status(owner,{enrollmentID})).status,'disconnected');assert.equal((await f.store.read(credential.connectionID)).apnsEnvironment,'development');
 }
});
