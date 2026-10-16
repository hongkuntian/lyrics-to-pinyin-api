import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {lyricLoader} from '../../api/song-library.js';
import {makeDocument,requestKey} from '../../api/utils/song-library/document.js';
import {sourceCapsule,spotifyBinding,spotifySearchRequest,spotifyHashes} from '../../api/utils/song-library/spotify-recording.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {createSpotifyLyricsService} from '../../api/utils/spotify-lyrics.js';
import {validateDocument} from '../../api/utils/spotify/render.js';
const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'Request title',artists:['Band & Name','Guest'],duration_ms:240001}};
const song={id:'source-42',title:'Request title',artist:'Band & Name & Guest',creditedArtistNames:['Band & Name','Guest'],duration:240,source:'lrclib'};
const words=[{text:'風來了',timestamp:12.5},{text:'海在這裡',timestamp:60.125}];
function fixture({source=song,lines=words,partial=false}={}) {
  const queries=[];
  const api={name:'LRCAPI',searchSong:async(artist,title,context)=>{queries.push({artist,title,context});return source;},getLyrics:async()=>({lines,partial})};
  const service=createMusicRomanizeService({redis:null,logger:{info(){},error(){}},getAvailableAPIsFn:()=>[api],
    detectLanguageFn:async()=> 'zh',getProcessorFn:()=>({romanize:async text=>({romanized:text+'-r'})}),
    resolveCatalogAliasesFn:()=>assert.fail('Spotify must bypass Apple aliases'),lookupReviewedRecordingFn:()=>assert.fail('Spotify must bypass Apple reviews'),
    lookupListeningReviewedRecordingFn:()=>assert.fail('Spotify must bypass Apple reviews'),lookupOfficialTranscriptionFn:()=>assert.fail('Spotify must bypass Apple records')});
  return {service,queries};
}
async function call(service,body) {const res=createMockRes();await service(createMockReq({body}),res);return res;}
test('both envelopes use one V2 fingerprint and independent fallback capsule with no Apple proof',async()=>{
  const {service,queries}=fixture();
  const response=await call(service,{recording,options:{tone_style:'marks',separator:' ',case:'lower'}});
  assert.equal(response.statusCode,200);const body=response.body;
  assert.equal(body.recordingBinding.requestHash,requestKey(recording));assert.equal(body.recordingBinding.documentID,null);assert.equal(body.library,undefined);
  assert.equal(body.recordingBinding.synchronizationEligible,true);assert.equal(body.recordingBinding.source.provider,'lrclib');assert.equal(body.recordingBinding.source.itemID,'source-42');
  assert.equal(body.metadata.catalog_resolution,undefined);assert.equal(body.metadata.recording_match,undefined);
  assert.equal(queries[0].artist,'Band & Name & Guest');assert.deepEqual(queries[0].context.creditedArtistNames,recording.metadata.artists);
  assert.equal(queries[0].context.duration,240.001);assert.equal(queries[0].context.catalog_id,undefined);
  const loaded=await lyricLoader(service)(recording),doc=makeDocument(recording,loaded,SELECTION_REVISION);
  assert.equal(doc.recordingBinding.requestHash,body.recordingBinding.requestHash);assert.equal(doc.recordingBinding.documentID,doc.id);
  assert.equal(doc.recordingBinding.sourceHash,body.recordingBinding.sourceHash);assert.equal(doc.response.recordingBinding,undefined);
  assert.deepEqual(doc.sourceCapsule,sourceCapsule(body));assert.equal(doc.canonicalRecordingID,null);
});
test('Spotify mixed envelope/selectors and invalid recording fail before provider lookup',async()=>{
  const {service,queries}=fixture();
  for(const body of [{recording,artist:'X'},{recording,music_platform:'spotify'},{recording,language:'zh'},
    {recording,options:{include_metadata:true}},{recording,options:{refresh:'true'}},{recording:{...recording,token:'secret'}},
    {recording:{...recording,provider:'unknown'}},{recording:{...recording,version:1}}]) {
    const res=await call(service,body);assert.equal(res.statusCode,400);assert.equal(res.body.code,'invalid_recording');
  }
  assert.equal(queries.length,0);
});
test('partial and untimed fallback remain bound and readable but cannot claim synchronization',async()=>{
  for(const params of [{partial:true},{lines:words.map(l=>({...l,timestamp:null}))}]) {
    const {service}=fixture(params),res=await call(service,{recording});
    assert.equal(res.statusCode,200);assert.equal(res.body.recordingBinding.synchronizationEligible,false);
    if(params.partial)assert.throws(()=>makeDocument(recording,res.body,SELECTION_REVISION),{code:'source_incomplete'});
    else assert.equal(makeDocument(recording,res.body,SELECTION_REVISION).recordingBinding.synchronizationEligible,false);
  }
});
test('source conflicts reject instead of returning a binding or accepting primary-only credits',async()=>{
  for(const source of [{...song,creditedArtistNames:['Band & Name']},{...song,duration:244},{...song,title:'Request title (Live)'},
    {...song,isrc:'USABC2600002'}]) {
    const {service}=fixture({source}),r=source.isrc?{...recording,metadata:{...recording.metadata,isrc:'USABC2600001'}}:recording;
    const res=await call(service,{recording:r});assert.equal(res.statusCode,409);assert.equal(res.body.code,'recording_mismatch');
  }
});
test('wrong request, source, document or policy binding cannot make a durable document',async()=>{
  const {service}=fixture();const {body}=await call(service,{recording});
  for(const key of ['itemID','requestHash','sourceHash','documentID','selectionRevision','timingRevision']) {
    const changed=structuredClone(body);changed.recordingBinding[key]='wrong';
    assert.throws(()=>makeDocument(recording,changed,SELECTION_REVISION),{code:'recording_mismatch'});
  }
  const changed=structuredClone(body);changed.song.id='other';assert.throws(()=>makeDocument(recording,changed,SELECTION_REVISION),{code:'recording_mismatch'});
});

test('same-item fingerprints stay separate and cached upgrades retain matching source evidence',async()=>{
  const {service,queries}=fixture();
  const one=await call(service,{recording});const hit=await call(service,{recording});
  assert.equal(queries.length,1);assert.equal(hit.body.recordingBinding.sourceHash,one.body.recordingBinding.sourceHash);
  const variant={...recording,market:'US',metadata:{...recording.metadata,explicit:false}};
  const two=await call(service,{recording:variant});assert.equal(two.statusCode,200);assert.equal(queries.length,2);
  assert.notEqual(one.body.recordingBinding.requestHash,two.body.recordingBinding.requestHash);
  assert.equal(one.body.recordingBinding.recordingKey,two.body.recordingBinding.recordingKey);
  const doc=makeDocument(recording,hit.body,SELECTION_REVISION);assert.deepEqual(doc.requestEvidence.candidate.creditedArtistNames,recording.metadata.artists);
  assert.equal(hit.body.candidate,undefined);assert.equal(hit.body.requestEvidence,undefined);
});
test('late ordinary acquisition cannot replace a newer refresh or contaminate its source capsule',async()=>{
  let started,finish;const active=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>finish=resolve);let count=0;
  const api={name:'LRCAPI',searchSong:async()=>{
    if(++count===1){started();await gate;return {...song,id:'older'};}
    return {...song,id:'newer'};
  },getLyrics:async()=>({lines:words})};
  const service=createMusicRomanizeService({redis:null,logger:{info(){},error(){}},getAvailableAPIsFn:()=>[api],detectLanguageFn:async()=> 'en'});
  const old=call(service,{recording});await active;
  const fresh=await call(service,{recording,options:{refresh:true}});assert.equal(fresh.body.song.id,'newer');
  finish();assert.equal((await old).body.song.id,'older');
  const cached=await call(service,{recording});assert.equal(cached.body.song.id,'newer');
  assert.equal(cached.body.recordingBinding.source.itemID,'newer');assert.equal(count,2);
});
test('Redis restoration revalidates the complete source candidate before returning its binding',async()=>{
  let entry,searches=0;const writes=[];
  const api={name:'LRCAPI',searchSong:async()=>{searches++;return song;},getLyrics:async()=>({lines:words})};
  const dependencies={redis:{},logger:{info(){},error(){}},getAvailableAPIsFn:()=>[api],detectLanguageFn:async()=> 'en',
    getCachedFn:async()=>entry,setCachedFn:async(redis,key,value)=>{entry=structuredClone(value);},waitUntilFn:p=>writes.push(p)};
  const first=await call(createMusicRomanizeService(dependencies),{recording});await Promise.all(writes);assert.equal(first.statusCode,200);
  const restored=await call(createMusicRomanizeService(dependencies),{recording});assert.equal(restored.statusCode,200);assert.equal(searches,1);
  assert.deepEqual(makeDocument(recording,restored.body,SELECTION_REVISION).requestEvidence.candidate.creditedArtistNames,recording.metadata.artists);
  entry.candidate.creditedArtistNames=['Band','Name','Guest'];
  const checked=await call(createMusicRomanizeService(dependencies),{recording});assert.equal(checked.statusCode,200);assert.equal(searches,2);
});
test('Spotify rejects fresh Redis credit leaks and persists only clean independent source rows',async()=>{
  const credits=['男声：单色凌','戏腔：单色凌','和声：曾婕'];let searches=0,entry;const writes=[];
  const api={name:'LRCAPI',searchSong:async()=>{searches++;return song;},getLyrics:async()=>({lines:[...credits.map((text,i)=>({text,timestamp:i+1})),...words]})};
  const deps={redis:{},logger:{info(){}},getAvailableAPIsFn:()=>[api],detectLanguageFn:async()=> 'zh',
    getProcessorFn:()=>({romanize:async text=>({romanized:text})}),getCachedFn:async()=>entry,
    setCachedFn:async(redis,key,value)=>{entry=structuredClone(value);},waitUntilFn:p=>writes.push(p)};
  const first=await call(createSpotifyLyricsService(deps),{recording});await Promise.all(writes);
  assert.equal(first.statusCode,200);assert.deepEqual(first.body.lines.map(l=>l.original),words.map(l=>l.text));
  assert.equal(first.body.song_details.credits.length,3);
  const doc=makeDocument(recording,first.body,SELECTION_REVISION);
  assert.deepEqual(doc.sourceCapsule.lines,first.body.lines);
  assert.ok(!JSON.stringify(doc.structure).includes('单色凌'));
  entry.response.lines.unshift(...credits.map((original,i)=>({original,romanized:'credit',timestamp:i+1})));
  delete entry.response.metadata.lyric_structure;
  entry.response.recordingBinding=spotifyBinding(recording,sourceCapsule(entry.response),SELECTION_REVISION,entry.response);
  const refreshed=await call(createSpotifyLyricsService(deps),{recording});await Promise.all(writes);
  assert.equal(refreshed.statusCode,200);assert.equal(searches,2);
  assert.deepEqual(refreshed.body.lines,first.body.lines);
  await call(createSpotifyLyricsService(deps),{recording});assert.equal(searches,2);
});

test('reviewed Spotify language guards reject fresh and cached wrong-language sources',async()=>{
  const r={version:2,provider:'spotify',item_id:'7ovUcF5uHTBRzUpB6ZOmvt',metadata:{origin:'spotify',title:'Idol',artists:['YOASOBI'],duration_ms:213234}};
  const source={id:'reviewed-test',title:'Idol',artist:'YOASOBI',duration:213.234};
  let searches=0,lines=[{text:'An English version.',timestamp:12},{text:'A second English line.',timestamp:60}];
  const api={name:'LRCAPI',searchSong:async()=>{searches++;return source;},getLyrics:async()=>({lines})};
  const dependencies={redis:null,getAvailableAPIsFn:()=>[api],detectLanguageFn:async()=> 'ja',getDefaultRomanizationSystemFn:()=> 'none',logger:{info(){}}};
  const rejected=await call(createSpotifyLyricsService(dependencies),{recording:r});assert.equal(rejected.statusCode,409);
  lines=[{text:'君の声が聞こえる',timestamp:12},{text:'風が吹いている',timestamp:60}];
  const good=await call(createSpotifyLyricsService(dependencies),{recording:r});assert.equal(good.statusCode,200);
  const stale=structuredClone(good.body);stale.lines=stale.lines.map(l=>({...l,original:'An English version.',romanized:'An English version.'}));
  delete stale.metadata.lyric_structure;
  stale.recordingBinding=spotifyBinding(r,sourceCapsule(stale),SELECTION_REVISION,stale);
  assert.throws(()=>makeDocument(r,stale,SELECTION_REVISION),{code:'recording_mismatch'});
  const hashes=spotifyHashes(r,sourceCapsule(stale),SELECTION_REVISION);
  const oldDocument={...hashes,id:hashes.documentID,selectionRevision:SELECTION_REVISION,response:stale,
    recordingBinding:spotifyBinding(r,sourceCapsule(stale),SELECTION_REVISION,stale,{durable:true})};
  assert.throws(()=>validateDocument(oldDocument,r),{code:'recording_mismatch'});
  searches=0;
  const restored=await call(createSpotifyLyricsService({...dependencies,redis:{},getCachedFn:async()=>({response:stale,candidate:source}),setCachedFn:async()=>{},waitUntilFn:p=>p.catch(()=>{})}),{recording:r});
  assert.equal(restored.statusCode,200);assert.equal(searches,1);
  assert.equal(restored.body.lines[0].original,'君の声が聞こえる');
});
