import test from 'node:test';
import assert from 'node:assert/strict';
import {SELECTION_REVISION} from '../../api/music-romanize.js';
import {createSongLibraryHandler,lyricLoader} from '../../api/song-library.js';
import {spotifyMatchEvidence,spotifyRequestHash} from '../../api/utils/song-library/spotify-recording.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {qqIdentityFixture} from '../helpers/qq-artist-identity.js';
import {yrcService} from '../helpers/netease-yrc.js';
import {libraryDB} from '../helpers/library-db.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

test('QQ identity proof survives memory, Redis and durable reopen without rebinding original metadata',async t=>{
 const fixture=qqIdentityFixture(),disk=new Map(),pending=[];
 fixture.legacyOnly();
 const options={getAvailableAPIsFn:()=>[fixture.api],resolveArtistIdentitiesFn:fixture.resolve,getCachedFn:async(_,key)=>disk.get(key),
  setCachedFn:async(_,key,value)=>disk.set(key,structuredClone(value)),waitUntilFn:promise=>pending.push(promise)};
 const source=yrcService(options),call=async(service,body)=>{const response=createMockRes();await service(createMockReq({body,headers:{authorization:'Bearer lyra_s_fixture'}}),response);return response;};
 const body={recording:fixture.recording,options:{lyric_sources_version:2}},first=await call(source.service,body);
 assert.equal(first.statusCode,200,JSON.stringify(first.body));
 const candidate=spotifyMatchEvidence(first.body);assert.equal(candidate.source,'qq');assert.ok(candidate.artistAliasEvidence);
 assert.deepEqual(candidate.creditedArtistMIDs,[fixture.detail.singer[0].mid]);
 assert.equal(first.body.song.artist.original,'Test');assert.equal(first.body.recordingBinding.requestHash,spotifyRequestHash(fixture.recording));
 const searches=fixture.calls.length;assert.equal((await call(source.service,body)).statusCode,200);assert.equal(fixture.calls.length,searches);
 await Promise.all(pending);
 const cached=await call(yrcService(options).service,body);assert.equal(cached.statusCode,200);assert.equal(fixture.calls.length,searches);
 assert.deepEqual(spotifyMatchEvidence(cached.body),candidate);
 const document=makeDocument(fixture.recording,cached.body,SELECTION_REVISION);
 const {db,store}=await libraryDB();t.after(()=>db.close());
 for(const mutate of [value=>{value.requestEvidence.candidate.creditedArtistMIDs=['00000000000000'];},value=>{delete value.requestEvidence.candidate.artistAliasEvidence;},value=>{value.requestEvidence.candidate.source='netease';}]) {
  const bad=structuredClone(document);mutate(bad);assert.throws(()=>publicDocument(bad,fixture.recording),{code:'recording_mismatch'});
  await assert.rejects(()=>store.saveDocument(bad,{lookupOwner:'fixture'}),{code:'recording_mismatch'});
 }
 const handler=createSongLibraryHandler({store,loadLyrics:lyricLoader(source.service),authStore:{authenticate:async()=>({id:'reader-a'}),limit:async()=>{}},logger:{info(){},error(){}}});
 const saved=await call(handler,{action:'lyrics',recording:fixture.recording});assert.equal(saved.statusCode,200,JSON.stringify(saved.body));
 const reopened=await call(handler,{action:'lyrics',recording:fixture.recording});assert.equal(reopened.body.document.id,saved.body.document.id);
 assert.deepEqual(reopened.body.document.response.lines,first.body.lines);
 for(const value of disk.values())if(value.candidate?.artistAliasEvidence)value.candidate.creditedArtistMIDs=['00000000000000'];
 const refreshed=await call(yrcService(options).service,body);assert.equal(refreshed.statusCode,200);assert.ok(fixture.calls.length>searches);
 assert.deepEqual(spotifyMatchEvidence(refreshed.body).creditedArtistMIDs,[fixture.detail.singer[0].mid]);
});
