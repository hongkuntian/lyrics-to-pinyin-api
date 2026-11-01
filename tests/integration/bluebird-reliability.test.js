import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {createSongLibraryService,lyricLoader} from '../../api/song-library.js';
import {parseKRC} from '../../api/utils/kugou-krc.js';
import {annotationFor} from '../../api/utils/pronunciation-aids.js';
import {makeDocument,requestKey} from '../../api/utils/song-library/document.js';
import {sourceCapsule,spotifyBinding,verifySpotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {libraryDB} from '../helpers/library-db.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

const recording={title:'ブルーバード',artist:'Ikimonogakari',album:'Chou Ikimonobakari Tennen Kinen Members Best Selection',duration:215.707,catalog_id:'1089186523',storefront:'us'};
const spotify={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',market:'US',metadata:{origin:'spotify',title:recording.title,artists:[recording.artist],album:recording.album,duration_ms:215707}};
const texts=['飛翔いたら','遊迷','共鳴けて'];
const raw=starts=>texts.map((text,index)=>`[${starts[index]},2000]<0,2000,0>${text}`).join('\n');
const ordinary=raw([10000,60000,120000]);
const collapsed='[20,20]<0,10,0>合成された短い歌の一行目\n[60,20]<0,10,0>合成された短い歌の二行目\n[100,20]<0,10,0>合成された短い歌の三行目';
function fixture(platform,{sourceID='468823329',alternative=false,rawLyrics=ordinary,album=false,cached=null}={}){
 const queries=[],values=new Map(),ttls=[],pending=[];
 const song=identifier=>({id:identifier,source:'kugou',title:recording.title,artist:recording.artist,duration:215,...(album?{album:recording.album}:{})});
 const api={name:'KugouAPI',supportsVocalTiming:true,searchSong:async()=>{queries.push('kugou');return song(sourceID);},
  getLyrics:async()=>parseKRC(rawLyrics,{songId:sourceID,duration:215})};
 const alternate={name:'NeteaseAPI',supportsVocalTiming:true,searchSong:async()=>{queries.push('netease');return alternative?{...song('42'),source:'netease'}:null;},
  getLyrics:async()=>({source:'netease',songId:'42',lines:texts.map((text,index)=>({text,timestamp:[10,60,120][index]}))})};
 const service=createMusicRomanizeService({redis:{},getCachedFn:async(_,key)=>values.get(key)??cached,setCachedFn:async(_,key,value,ttl)=>{values.set(key,structuredClone(value));ttls.push(ttl);},waitUntilFn:promise=>pending.push(promise),
  getAvailableAPIsFn:()=>[api,alternate],hedgeDelayMs:0,speculativeDiscovery:false,resolveCatalogAliasesFn:async()=>[],
  lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  logger:{info(){},error(){}}});
 const call=async(options={})=>{const response=createMockRes();await service({method:'POST',body:{...(platform==='apple'?recording:{recording:spotify}),options:{lyric_sources_version:2,...options}}},response);await Promise.all(pending);return response;};
 return {service,call,queries,ttls,values};
}
for(const platform of ['apple','spotify']){
 test(`${platform}: quarantined complete Kugou cues become readable untimed lyrics and keep discovery open`,async()=>{
  const target=fixture(platform),response=await target.call();
  assert.equal(response.statusCode,200,JSON.stringify(response.body));
  assert.ok(target.queries.includes('netease'));
  assert.equal(response.body.quality.synced,false);
  assert.equal(response.body.metadata.lyric_timing,undefined);
  assert.equal(response.body.metadata.timing_correction.reason,'quarantined_source');
  assert.deepEqual(response.body.lines.map(line=>line.original),texts);
  assert.ok(response.body.lines.every(line=>line.timestamp===null&&!line.vocalTiming));
  assert.equal(response.body.song.album,null);
  assert.deepEqual(response.body.lines.map(line=>line.romanized),['habataitara','yume','azukete']);
  assert.ok(target.ttls.every(ttl=>ttl<=300));
  if(platform==='spotify')verifySpotifyBinding(response.body.recordingBinding,spotify,sourceCapsule(response.body),SELECTION_REVISION,response.body);
 });
 test(`${platform}: a valid alternative beats quarantined complete cues`,async()=>{
  const response=await fixture(platform,{alternative:true}).call();
  assert.equal(response.statusCode,200);assert.equal(String(response.body.song.id),'42');
  assert.equal(response.body.quality.synced,true);
  assert.deepEqual(response.body.lines.map(line=>line.timestamp),[10,60,120]);
 });
 test(`${platform}: generic collapsed rows are sanitized without a source blacklist hit`,async()=>{
  const response=await fixture(platform,{sourceID:'468823330',rawLyrics:collapsed}).call();
  assert.equal(response.statusCode,200,JSON.stringify(response.body));
  assert.equal(response.body.metadata.timing_correction.reason,'collapsed_lyric_rows');
  assert.equal(response.body.quality.synced,false);
  assert.ok(response.body.lines.every(line=>line.timestamp===null&&!line.vocalTiming));
 });
 test(`${platform}: ordinary timing from the neighboring source is retained`,async()=>{
  const response=await fixture(platform,{sourceID:'468823330'}).call();
  assert.equal(response.statusCode,200);assert.equal(response.body.quality.synced,true);
  assert.ok(response.body.lines.every(line=>line.vocalTiming));
 });
 test(`${platform}: ordinary cache cannot resurrect quarantined complete timing`,async()=>{
  const seed=fixture(platform,{sourceID:'468823330'}),oldResponse=(await seed.call()).body;
  oldResponse.song.id='468823329';oldResponse.song_details.source_id='468823329';
  oldResponse.metadata.lyric_timing.source='kugou:468823329:krc';
  let cached=oldResponse;
  if(platform==='spotify'){
   oldResponse.recordingBinding=spotifyBinding(spotify,sourceCapsule(oldResponse),SELECTION_REVISION,oldResponse);
   cached=structuredClone([...seed.values.values()].find(value=>value.response));
   cached.response=oldResponse;cached.candidate.id='468823329';
  }
  const target=fixture(platform,{cached}),response=await target.call();
  assert.equal(response.statusCode,200);assert.ok(target.queries.includes('kugou'));
  assert.equal(response.body.quality.synced,false);
  assert.equal(response.body.metadata.timing_correction.reason,'quarantined_source');
 });
 test(`${platform}: durable quarantined source refresh preserves immutable document history`,async context=>{
  const {db,store}=await libraryDB();context.after(()=>db.close());
  const oldResponse=(await fixture(platform,{sourceID:'468823330'}).call()).body;
  oldResponse.song.id='468823329';oldResponse.song_details.source_id='468823329';
  oldResponse.metadata.lyric_timing.source='kugou:468823329:krc';
  if(platform==='spotify')oldResponse.recordingBinding=spotifyBinding(spotify,sourceCapsule(oldResponse),SELECTION_REVISION,oldResponse);
  const request=platform==='apple'?recording:spotify,old=makeDocument(request,oldResponse,SELECTION_REVISION);
  const lookupOwner=await store.claimLookup(old.requestKey,SELECTION_REVISION);
  try {await store.saveDocument(old,{lookupOwner});}finally{await store.releaseLookup(old.requestKey,SELECTION_REVISION,lookupOwner);}
  const original=await store.document(old.id);
  const fixed=fixture(platform),load=lyricLoader(fixed.service);let loads=0;
  const service=createSongLibraryService({store,selectionRevision:SELECTION_REVISION,loadLyrics:async(...args)=>{loads++;return load(...args);},logger:{info(){},error(){}}});
  const req=createMockReq({body:{action:'lyrics',recording:request}});req.lyricaUser=await store.authenticate('token-a');
  const response=createMockRes();await service(req,response);
  assert.equal(response.statusCode,200,JSON.stringify(response.body));assert.equal(loads,1);
  assert.equal(response.body.document.response.quality.synced,false);
  assert.notEqual(response.body.document.id,old.id);
  assert.deepEqual((await store.document(old.id)).response,original.response);
  assert.deepEqual((await store.document(old.id)).structure,original.structure);
  assert.equal((await store.documentForRequest(requestKey(request),SELECTION_REVISION)).id,response.body.document.id);
  const annotation=await annotationFor(original,'ja-kana');
  assert.equal(annotation.documentID,old.id);assert.equal(annotation.sourceHash,old.sourceHash);
  assert.deepEqual(annotation.lines.map(line=>line.text),['はばたいたら','ゆめ','あずけて']);
 });
}
