import test from 'node:test';
import assert from 'node:assert/strict';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {createSongLibraryHandler,lyricLoader} from '../../api/song-library.js';
import {spotifySearchRequest,spotifyRequestHash,spotifyMatchEvidence,sourceCapsule,verifySpotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {recoveryCorpus,fixtureAPI} from '../helpers/artist-alias-recovery.js';
import {libraryDB} from '../helpers/library-db.js';

test('all recovery positives, existing controls and adversarial negatives retain expected source identity',async()=>{
  for(const row of recoveryCorpus().cases) {
    const {api,calls}=fixtureAPI(NeteaseAPI,row),target=spotifySearchRequest(row.recording);
    let id=null;
    try{id=String((await api.searchSong(target.artist,target.title,target))?.id??'')||null;}
    catch(error){assert.equal(error.code,'recording_mismatch',row.caseID);}
    assert.equal(id,row.expectID,row.caseID);
    assert.ok(calls.filter(c=>c.path==='/search').length<=2,row.caseID);
    if(row.role==='control')assert.equal(calls.filter(c=>c.path==='/search').length,1,row.caseID);
  }
});

test('recovered aliases survive fresh source IDs, Redis, memory and durable reopen without changing original request hashes',async t=>{
  const row=recoveryCorpus().cases.find(r=>r.caseID==='duet-complete-credits'),{db,store}=await libraryDB();t.after(()=>db.close());
  const saved=new Map(),writes=[];let searches=0;
  const deps=()=>{const f=fixtureAPI(NeteaseAPI,row);return {f,options:{redis:{},getAvailableAPIsFn:()=>[f.api],
    getCachedFn:async(_,k)=>saved.get(k)??null,setCachedFn:async(_,k,v)=>saved.set(k,structuredClone(v)),
    waitUntilFn:p=>writes.push(p),logger:{info(){},error(){}}}};};
  const first=deps(),service=createMusicRomanizeService(first.options);
  const call=async(svc,body)=>{const res=createMockRes();await svc(createMockReq({body,headers:{authorization:'Bearer lyra_s_fixture'}}),res);return res;};
  const response=await call(service,{recording:row.recording});assert.equal(response.statusCode,200);
  const candidate=spotifyMatchEvidence(response.body);assert.ok(candidate.artistAliasEvidence);
  assert.deepEqual(candidate.creditedArtistNames,row.songs[0].artists.map(p=>p.name));
  assert.equal(response.body.song.artist.original,'Invented Performer & Second Singer');
  assert.equal(response.body.recordingBinding.requestHash,spotifyRequestHash(row.recording));
  assert.ok(response.body.lines.every(l=>l.vocalTiming?.segments.length===2));
  searches=first.f.calls.length;
  const memory=await call(service,{recording:row.recording});assert.equal(memory.statusCode,200);assert.equal(first.f.calls.length,searches);
  await Promise.all(writes);
  const next=deps(),redis=await call(createMusicRomanizeService(next.options),{recording:row.recording});
  assert.equal(redis.statusCode,200);assert.equal(next.f.calls.length,0);assert.ok(spotifyMatchEvidence(redis.body).artistAliasEvidence);
  const fresh=fixtureAPI(NeteaseAPI,row),target=spotifySearchRequest(row.recording);
  const byID=await fresh.api.getRecording(row.expectID,target);assert.ok(byID.song.artistAliasEvidence);
  assert.equal(fresh.calls.filter(c=>c.path==='/search').length,0);
  const doc=makeDocument(row.recording,redis.body,SELECTION_REVISION);
  for(const change of [d=>{delete d.requestEvidence.candidate.artistAliasEvidence;},
    d=>{d.requestEvidence.candidate.artistAliasEvidence.policy='changed';}]) {
    const bad=structuredClone(doc);change(bad);
    assert.throws(()=>publicDocument(bad,row.recording),{code:'recording_mismatch'});
    await assert.rejects(()=>store.saveDocument(bad,{lookupOwner:'fixture'}),{code:'recording_mismatch'});
  }
  const handler=createSongLibraryHandler({store,loadLyrics:lyricLoader(service),
    authStore:{authenticate:async()=>({id:'reader-a'}),limit:async()=>{}},logger:{info(){},error(){}}});
  const savedDoc=await call(handler,{action:'lyrics',recording:row.recording});assert.equal(savedDoc.statusCode,200,JSON.stringify(savedDoc.body));
  const reopened=await call(handler,{action:'lyrics',recording:row.recording});assert.equal(reopened.statusCode,200);
  assert.equal(reopened.body.document.id,savedDoc.body.document.id);
  assert.deepEqual(reopened.body.document.response.lines,response.body.lines);
  verifySpotifyBinding(reopened.body.document.recordingBinding,row.recording,sourceCapsule(response.body),SELECTION_REVISION,response.body,{durable:true});
  assert.equal(Number((await store.usage()).jobs),0);
});

test('a corrupt cached recovery proof falls back to fresh acquisition instead of publishing unverified credits',async()=>{
  const row=recoveryCorpus().cases[0],disk=new Map(),pending=[];
  const fixture=fixtureAPI(NeteaseAPI,row);
  const dependencies={redis:{},getAvailableAPIsFn:()=>[fixture.api],getCachedFn:async(_,k)=>disk.get(k),
    setCachedFn:async(_,k,v)=>disk.set(k,structuredClone(v)),waitUntilFn:p=>pending.push(p),logger:{info(){},error(){}}};
  const call=async service=>{const res=createMockRes();await service(createMockReq({body:{recording:row.recording}}),res);return res;};
  assert.equal((await call(createMusicRomanizeService(dependencies))).statusCode,200);await Promise.all(pending);
  for(const value of disk.values())if(value.candidate)delete value.candidate.artistAliasEvidence;
  const before=fixture.calls.length,res=await call(createMusicRomanizeService(dependencies));
  assert.equal(res.statusCode,200);assert.ok(fixture.calls.length>before);assert.ok(spotifyMatchEvidence(res.body).artistAliasEvidence);
});
