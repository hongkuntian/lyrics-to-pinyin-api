import test from 'node:test';
import assert from 'node:assert/strict';
import {createVault} from '../../api/utils/spotify/vault.js';
import {observePlayback,requestFingerprint,observedRecording} from '../../api/utils/spotify/observation.js';
import {renderState,immutablePush} from '../../api/utils/spotify/render.js';
const time=1800000000000;
test('background catalog observations retain complete artist IDs and never invent a partial contributor mapping',()=>{
 const ids=['1123456789ABCDEFGHIJKL','2123456789ABCDEFGHIJKL'];
 const item={type:'track',id:'0123456789ABCDEFGHIJKL',name:'Synthetic',artists:[{id:ids[0],name:'A'},{id:ids[1],name:'Guest'}],duration_ms:240000};
 const complete=observedRecording(item);assert.deepEqual(complete.metadata.artist_ids,ids);
 const without=structuredClone(item);delete without.artists[1].id;
 const partial=observedRecording(without);assert.equal(partial.metadata.artist_ids,undefined);assert.deepEqual(partial.metadata.artists,['A','Guest']);
 assert.notEqual(requestFingerprint(complete),requestFingerprint(partial));
 without.artists[1].id=ids[0];assert.equal(observedRecording(without).metadata.artist_ids,undefined);
});
test('Spotify vault binds ciphertext to owner/key/epoch/environment and supports bounded key rotation',()=>{
 const context={ownerID:'a',keyID:'k',connectionID:'c',epoch:'e',clientID:'public',environment:'preview'};
 const old=createVault({active:'old',keys:{old:Buffer.alloc(32,1).toString('base64')}});
 const sealed=old.seal('fixture-secret',context);
 assert(!JSON.stringify(sealed).includes('fixture-secret'));
 assert.notDeepEqual(old.seal('fixture-secret',context),sealed);
 const rotated=createVault({active:'new',keys:{old:Buffer.alloc(32,1).toString('base64'),new:Buffer.alloc(32,2).toString('base64')}});
 assert.equal(rotated.open(sealed,context),'fixture-secret');
 assert.throws(()=>rotated.open(sealed,{...context,epoch:'other'}));
 assert.throws(()=>createVault({active:'x',keys:{x:'invalid'}}));
});
const playback=(progress=10000)=>({timestamp:time-60000,is_playing:true,progress_ms:progress,device:{id:'device',name:'Fixture speaker'},item:{type:'track',id:'0123456789ABCDEFGHIJKL',name:'Independent fixture',duration_ms:240000,artists:[{name:'A & B'},{name:'Guest'}],album:{name:'Album'},is_local:false}});
test('Spotify observation uses receipt clock, equal provider timestamps advance, regression/slow samples abstain',()=>{
 const a=observePlayback({status:200,body:playback(),requestStartedAt:time,responseReceivedAt:time+100},null,1);
 assert.equal(a.confirmedAt,time);assert.equal(a.positionMS,10000);
 const b=observePlayback({status:200,body:playback(12000),requestStartedAt:time+2000,responseReceivedAt:time+2100},a,2);
 assert.equal(b.positionMS,12000);assert.equal(b.playbackOccurrence,a.playbackOccurrence);
 const back=observePlayback({status:200,body:playback(500),requestStartedAt:time+4000,responseReceivedAt:time+4100},b,3);
 assert.notEqual(back.playbackOccurrence,b.playbackOccurrence);
 assert.equal(observePlayback({status:200,body:playback(),requestStartedAt:time,responseReceivedAt:time+8000},null,1).phase,'unavailable');
 assert.equal(observePlayback({status:204,requestStartedAt:time,responseReceivedAt:time+1},a,2).recording,null);
 assert.notEqual(requestFingerprint(a.recording),requestFingerprint({...a.recording,metadata:{...a.recording.metadata,artists:['A','B','Guest']}}));
});
test('immutable publication keeps real timestamps/freshness, no lyric survives stale or wrong binding',()=>{
 const observation=observePlayback({status:200,body:playback(),requestStartedAt:time,responseReceivedAt:time+1},null,1);
 const consumer={sessionID:'session',generation:1,sequence:0,recipe:{version:1,reading:'sourceDefault',showPronunciation:true,showTranslation:false,pronunciationAbove:true,alignment:'leading'}};
 const state=renderState({observation,consumer,now:time+100,document:null});
 const push=immutablePush({state,consumer,now:time+100});
 assert.equal(push.payload.aps.timestamp,Math.floor((time+100)/1000));
 assert.equal(push.payload.aps['stale-date'],Math.floor((time+8000)/1000));
 assert.equal(renderState({observation,consumer,now:time+8001,document:null}).original,'');
 assert.equal(renderState({observation,consumer,now:time+8001,document:null}).statusReason,'updatesDelayed');
 assert.throws(()=>immutablePush({state,consumer:{...consumer,lastTimestamp:Math.floor(time/1000)},now:time+100}),/publication_coalesced/);
});
import {createSpotifyProvider} from '../../api/utils/spotify/provider.js';
import {documentFor,recording,recipe} from '../helpers/spotify.js';
import {validateDocument} from '../../api/utils/spotify/render.js';
test('actual recording helper rejects wrong source/revisions/document/request and preserves own timing correction',()=>{
 const doc=documentFor(),valid=validateDocument(doc,recording);assert.equal(valid.documentID,doc.id);
 for(const mutate of [d=>d.response.lines[0].original='poisoned',d=>d.response.metadata.source='KugouAPI',d=>d.timingRevision='a'.repeat(64),d=>d.id='b'.repeat(64),d=>d.recordingBinding.requestHash='c'.repeat(64),d=>d.response.metadata.selection_revision='other']){const changed=structuredClone(doc);mutate(changed);assert.throws(()=>validateDocument(changed,recording));}
 const observation={confirmedAt:time,recording,requestHash:requestFingerprint(recording),positionMS:21000,playing:false,phase:'loading'};
 const correction={recordingKey:doc.recordingKey,sourceHash:doc.sourceHash,timingRevision:doc.timingRevision,correctionRevision:'explicit-1',offsetSeconds:2};
 const consumer={generation:1,sequence:0,recipe:{...recipe,timingCorrection:correction},validatedCorrection:true};
 assert.equal(renderState({observation,document:doc,consumer,now:time}).original,'Fixture original');
 assert.equal(renderState({observation,document:doc,consumer:{...consumer,recipe:{...consumer.recipe,timingCorrection:{...correction,timingRevision:'different'}}},now:time}).original,'Next original');
});
test('PKCE refresh sends only server public client ID, validates returned scopes and retains omitted refresh secret',async()=>{
 let request;const adapter=createSpotifyProvider({clientID:'a'.repeat(32),now:()=>time,fetchFn:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({access_token:'fixture-access',expires_in:3600,scope:'app-remote-control user-read-playback-state'})};}});
 const result=await adapter.refresh('fixture-refresh');assert.equal(result.refreshToken,'fixture-refresh');assert.equal(result.expiresAtMS,time+3600000);
 assert.deepEqual(Object.fromEntries(request.options.body),{grant_type:'refresh_token',refresh_token:'fixture-refresh',client_id:'a'.repeat(32)});assert.equal(request.options.headers.Authorization,undefined);
 const bad=createSpotifyProvider({clientID:'a'.repeat(32),fetchFn:async()=>({ok:true,json:async()=>({access_token:'fixture',expires_in:3600,scope:'app-remote-control'})})});await assert.rejects(bad.refresh('fixture'),{code:'spotify_scope_required'});
});
test('provider account quota circuit differs from short-term Retry-After and never treats provider change time as sample age',async()=>{
 for(const [body,header,code,delay] of [[{error:{reason:'QUOTA_EXCEEDED'}},'2','spotify_quota_exceeded',300000],[{error:{message:'rolling rate'}},'17','spotify_rate_limited',17000]]){
  const adapter=createSpotifyProvider({now:()=>time,fetchFn:async()=>({status:429,ok:false,headers:{get:()=>header},json:async()=>body})});await assert.rejects(adapter.playback('fixture'),e=>e.code===code&&e.notBefore===time+delay);
 }
});
test('forward seek creates a new playback occurrence while normal equal-timestamp progress stays in its occurrence',()=>{
 const sample=progress=>({status:200,body:playback(progress),requestStartedAt:time,responseReceivedAt:time+100});
 const first=observePlayback(sample(10000),null,1),normal=observePlayback({...sample(12000),requestStartedAt:time+2000,responseReceivedAt:time+2100},first,2),seek=observePlayback({...sample(100000),requestStartedAt:time+4000,responseReceivedAt:time+4100},normal,3);
 assert.equal(first.playbackOccurrence,normal.playbackOccurrence);assert.notEqual(normal.playbackOccurrence,seek.playbackOccurrence);
});
import {QueueClient,parseRawCallback} from '@vercel/queue';
import {callbackOptions} from '../../api/utils/spotify/queue.js';
import {createConsumer} from '../../api/utils/spotify/consumer.js';
test('pinned Queue Node adapter parses opaque messages; consumer exhausts durable work with bounded retry',async()=>{
 const message={version:1,kind:'tick',connectionID:'c',connectionEpoch:'e',outboxID:'o',ordinal:1,dueAtMS:time};
 const parsed=parseRawCallback(message,{'ce-type':'com.vercel.queue.v2beta','ce-source':'/queues/spotify-background','ce-id':'fixture','ce-vqsmessageid':'fixture','ce-vqsqueuename':'spotify-background','ce-vqsconsumergroup':'fixture-group','ce-vqsreceipthandle':'fixture-receipt','content-type':'application/json'});
 assert.deepEqual(parsed.parsedPayload,message);assert.equal(typeof new QueueClient({region:'iad1'}).handleNodeCallback(async()=>{}),'function');
 let exhausted=0;const consume=createConsumer('tick',{client:{handleNodeCallback:(handler,options)=>{assert.equal(options.visibilityTimeoutSeconds,30);return handler;}},runtimeFactory:()=>({tick:async()=>{throw new Error('persistent failure');},exhaust:async()=>exhausted++})});
 await assert.rejects(consume(message,{deliveryCount:1}),/persistent failure/);await consume(message,{deliveryCount:120});assert.equal(exhausted,1);
 for(const deliveryCount of [1,2,120]){const retry=callbackOptions.retry(new Error(),{deliveryCount,messageId:'fixture'});assert(retry.afterSeconds>=2&&retry.afterSeconds<=300);}
});
test('payload sizing never truncates a performed grapheme or exceeds either 4KB boundary',()=>{
 const consumer={sessionID:'00000000-0000-4000-8000-000000000001',generation:1,sequence:0,lastTimestamp:0,recipe};
 const state=renderState({observation:{confirmedAt:time,recording,phase:'loading',deviceName:'声'.repeat(200)},consumer,now:time});state.original='a'+'\u0301'.repeat(3000);state.phase='lyrics';
 const publication=immutablePush({state,consumer,now:time});assert.equal(publication.payload.aps['content-state'].original,'');assert.equal(publication.payload.aps['content-state'].statusReason,'lyricSegmentTooLarge');assert(Buffer.byteLength(JSON.stringify(publication.payload))<=4096);assert(Buffer.byteLength(JSON.stringify(state.observedDeviceName))<=256);
});
