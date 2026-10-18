import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSpotifyHandler,validateSpotifyInput} from '../../api/spotify.js';
import {createMockRes} from '../helpers/mock-http.js';
import {manifest} from '../../scripts/build-output.mjs';
test('frozen broker request shapes reject extra access authority and disconnect uses exactly one identity form',()=>{
 const enrollmentID=randomUUID(),base={version:1,action:'connection.enroll',enrollmentID,refreshToken:'fixture',scopeRawValue:49152};
 assert.equal(validateSpotifyInput(base),base);
 for(const extra of [{accessToken:'not-authority'},{expiresAtMS:1},{clientID:'caller-chosen'}])assert.throws(()=>validateSpotifyInput({...base,...extra}),{code:'invalid_request'});
 assert.doesNotThrow(()=>validateSpotifyInput({version:1,action:'connection.disconnect',enrollmentID}));
 assert.doesNotThrow(()=>validateSpotifyInput({version:1,action:'connection.disconnect',connectionID:'c',connectionEpoch:'e'}));
 assert.throws(()=>validateSpotifyInput({version:1,action:'connection.disconnect',enrollmentID,connectionID:'c',connectionEpoch:'e'}));
 assert.doesNotThrow(()=>validateSpotifyInput({version:1,action:'live.token',connectionID:'c',connectionEpoch:'e',sessionID:randomUUID(),activityID:'activity',token:'ab'.repeat(32),tokenVersion:2,frequentPushesEnabled:false}));
});
test('narrow snapshot token cannot call account, enrollment or arbitrary widget target actions',async()=>{
 let calls=0;const handler=createSpotifyHandler({runtime:{snapshot:async()=>{calls++;return {version:1,status:'registered',tokenVersion:3};}},authStore:{authenticate:async()=>{throw Error('must not authenticate capability');}},logger:{error(){}}});
 const res=createMockRes();await handler({method:'POST',headers:{authorization:'Bearer lyra_w_fixturecapability'},body:{version:1,action:'snapshot.token',widgetToken:'ab'.repeat(32),tokenVersion:3}},res);
 assert.equal(res.statusCode,200);assert.deepEqual(res.body,{version:1,status:'registered',tokenVersion:3});assert.equal(calls,1);
 for(const body of [{version:1,action:'snapshot.token',widgetToken:'ab'.repeat(32),tokenVersion:3,sessionID:randomUUID()},{version:1,action:'connection.status',enrollmentID:randomUUID()}]){const r=createMockRes();await handler({method:'POST',headers:{authorization:'Bearer lyra_w_fixturecapability'},body},r);assert([400,401].includes(r.statusCode));}
});
test('explicit packaging lists eleven canonical routes and three private topic subscriptions within twelve functions',()=>{
 assert.equal(manifest.entries.length,12);assert.equal(manifest.routes.length,11);assert.deepEqual(manifest.crons,[{path:'/api/review-reports',schedule:'0 8 * * *'}]);
 assert.equal(manifest.entries.filter(x=>x.experimentalTriggers).length,3);
 for(const entry of manifest.entries.filter(x=>x.experimentalTriggers))assert(!manifest.routes.some(r=>r.dest===entry.entry.replace(/\.js$/,'')));
 assert.equal(manifest.entries.flatMap(x=>x.experimentalTriggers??[]).length,3);
 assert.equal(manifest.entries.find(x=>x.entry==='api/song-library.js').maxDuration,300);assert.equal(manifest.entries.find(x=>x.entry==='api/live-lyrics.js').maxDuration,15);
});
test('arm requires persisted actual activity creation time, rejecting missing/future/expired values',()=>{
 const now=Date.now(),base={version:1,action:'live.arm',connectionID:'c',connectionEpoch:'e',armID:randomUUID(),installationID:randomUUID(),sessionID:randomUUID(),activityID:'activity',activityGeneration:1,token:'ab'.repeat(32),tokenVersion:1,frequentPushesEnabled:false,recipe:{},recording:{}};
 for(const activityCreatedAtMS of [undefined,now+2001,now-28500000,1.5])assert.throws(()=>validateSpotifyInput({...base,activityCreatedAtMS},now));
 assert.doesNotThrow(()=>validateSpotifyInput({...base,activityCreatedAtMS:now-10000},now));
});
