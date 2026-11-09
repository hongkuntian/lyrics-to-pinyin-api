import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,user} from '../helpers/spotify.js';
import {validateSpotifyInput} from '../../api/spotify.js';

const identity=credential=>({connectionID:credential.connectionID,connectionEpoch:credential.connectionEpoch});

test('release returns the grant to the app, ends Live Lyrics and closes the broker connection',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();
 const armed=await f.arm(credential);assert.equal(armed.status,'armed');
 const releaseID=randomUUID(),reply=await f.service.release(user,{...identity(credential),releaseID});
 assert.deepEqual(reply,{version:1,status:'released',grant:{accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAtMS:credential.expiresAtMS}});
 const closed=await f.store.read(credential.connectionID);
 assert.equal(closed.status,'disconnected');assert.equal(closed.reason,'released');
 assert.equal(closed.refresh,null);assert.equal(closed.access,null);assert.notEqual(closed.epoch,credential.connectionEpoch);
 assert(Object.values(closed.consumers).every(s=>s.status==='ended'),'every Live Lyrics consumer ends');
 assert(!JSON.stringify(closed).includes('fixture-refresh'),'the kept copy is sealed');
 await assert.rejects(f.service.access(user,identity(credential)),{code:'spotify_connection_replaced'});
});

test('a lost release reply is answered again for the same releaseID only, then purged',async t=>{
 const f=await fixture(t),{credential}=await f.enroll(),releaseID=randomUUID();
 const first=await f.service.release(user,{...identity(credential),releaseID});
 assert.deepEqual(await f.restart().release(user,{...identity(credential),releaseID}),first);
 await assert.rejects(f.service.release(user,{...identity(credential),releaseID:randomUUID()}),{code:'spotify_connection_replaced'});
 f.advance(86400000+1);
 await assert.rejects(f.service.release(user,{...identity(credential),releaseID}),{code:'spotify_reconnect_required'});
 await f.store.maintenance(f.now);
 // The fixture clock is past the 30-day retention for closed rows, so the row itself may be gone.
 const row=await f.store.read(credential.connectionID);assert(row===null||row.released===null);
});

test('release waits for an in-flight refresh and never hands out a grant that is mid-rotation',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();f.advance(3600000);
 let finish,entered;const gate=new Promise(r=>finish=r),started=new Promise(r=>entered=r),original=f.provider.refresh;
 f.provider.refresh=async token=>{entered();await gate;return original(token);};
 const renewal=f.service.access(user,identity(credential));await started;
 await assert.rejects(f.service.release(user,{...identity(credential),releaseID:randomUUID()}),{code:'spotify_refresh_busy'});
 finish();const renewed=(await renewal).credential;
 const reply=await f.service.release(user,{...identity(renewed),releaseID:randomUUID()});
 assert.equal(reply.grant.refreshToken,'fixture-refresh');assert.equal(reply.grant.expiresAtMS,renewed.expiresAtMS);
});

test('only the owner can release, and a closed connection has nothing to return',async t=>{
 const f=await fixture(t),{credential}=await f.enroll();
 await assert.rejects(f.service.release({...user,credentialDigest:'other'},{...identity(credential),releaseID:randomUUID()}),{code:'spotify_connection_not_found'});
 await f.service.disconnect(user,identity(credential));
 const closed=await f.store.read(credential.connectionID);
 await assert.rejects(f.service.release(user,{connectionID:credential.connectionID,connectionEpoch:closed.epoch,releaseID:randomUUID()}),{code:'spotify_reconnect_required'});
});

test('release requests carry exactly the connection identity and a UUID releaseID',()=>{
 const base={version:1,action:'connection.release',connectionID:'c',connectionEpoch:'e',releaseID:randomUUID()};
 assert.equal(validateSpotifyInput(base),base);
 const {releaseID,...missing}=base;assert.throws(()=>validateSpotifyInput(missing),{code:'invalid_request'});
 for(const bad of [{releaseID:'not-a-uuid'},{refreshToken:'caller-chosen'},{enrollmentID:randomUUID()}])
  assert.throws(()=>validateSpotifyInput({...base,...bad}),{code:'invalid_request'},JSON.stringify(bad));
});
