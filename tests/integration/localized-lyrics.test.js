import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService as createMusicRomanizeHandler} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
const request={artist:'Eric Chou',title:'Unbreakable Love',duration:258.264,catalog_id:'1321295664'};
const localized={artist:'周興哲',title:'永不失聯的愛',album:'如果雨之後',duration:258.264,catalog_id:'1321295664'};
async function run(api, body=request, deps={}) {
  const res=createMockRes();
  await createMusicRomanizeHandler({lookupOfficialTranscriptionFn:async()=>null,lookupReviewedRecordingFn:async()=>null,redis:null,getAvailableAPIsFn:()=>[api],resolveCatalogAliasesFn:async()=>[localized],logger:{error(){},info(){}},...deps})(createMockReq({body}),res);
  return res;
}
test('English catalog names do not hide Chinese text or invent its pronunciation dialect',async()=> {
  const api={name:'Fixture',searchSong:async()=>({...request,id:1}),getLyrics:async()=>({lines:[{text:'一起唱',timestamp:0},{text:'Sing with me',timestamp:4}]})};
  const res=await run(api);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.song.language,'zh');
  assert.equal(res.body.song.romanization_system,'none');
  assert.equal(res.body.lines[0].romanized,'一起唱');
  assert.equal(res.body.metadata.language_details.pronunciation_language,null);
  assert.equal(res.body.lines[1].romanized,'Sing with me');
  assert.equal(res.body.song.title.romanized,'Unbreakable Love');
});
test('verified storefront callers coalesce provider work and receive their own original anchor',async()=>{
 const english={kind:'song',trackId:1321295664,trackName:request.title,artistName:request.artist,collectionName:'The Chaos After You',trackTimeMillis:258264};
 const native={...english,trackName:localized.title,artistName:localized.artist,collectionName:localized.album};
 const fetchFn=async url=>({ok:true,json:async()=>({results:new URL(url).searchParams.get('country')==='us'?[english]:[native]})});
 let calls=0;
 const api={name:'Fixture',searchSong:async(a,t)=>{calls++;await new Promise(r=>setTimeout(r,20));return t===request.title?{...request,album:english.collectionName,id:1}:{...localized,id:1};},
  getLyrics:async()=>({lines:[{text:'一起唱',timestamp:0}]})};
 const handler=createMusicRomanizeHandler({redis:null,getAvailableAPIsFn:()=>[api],lookupReviewedRecordingFn:async()=>null,
  lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  resolveCatalogAliasesFn:(r,c)=>resolveCatalogAliases(r,{...c,fetchFn,appleCatalog:null}),logger:{info(){},error(){}}});
 const run=async body=>{const res=createMockRes();await handler(createMockReq({body}),res);return res;};
 const inputs=[{...request,album:english.collectionName,storefront:'ca'},{...localized,storefront:'jp'}];
 const results=await Promise.all(inputs.map(run));
 assert.equal(calls,1);
 for(let i=0;i<results.length;i++){
  assert.equal(results[i].statusCode,200);
  assert.equal(results[i].body.metadata.catalog_resolution.requested.storefront,inputs[i].storefront);
 }
 const cached=await run({...inputs[1],storefront:'hk'});assert.equal(cached.statusCode,200);assert.equal(calls,1);
 const wrong=await run({...inputs[1],artist:'Cover Artist'});assert.equal(wrong.statusCode,409);
});
test('verified aliases retry providers and return identity evidence for iOS',async()=> {
  const queries=[];
  const api={name:'Fixture',searchSong:async(artist,title)=>{queries.push(title);return title===localized.title ? {...localized,id:523250334}:null;},getLyrics:async()=>({lines:[{text:'一起唱',timestamp:0}]})};
  const res=await run(api);
  assert.equal(res.statusCode,200);
  assert.deepEqual(queries,[request.title,localized.title]);
  assert.equal(res.body.song.title.original,localized.title);
  assert.equal(res.body.metadata.recording_match.catalog_id,request.catalog_id);
  assert.equal(res.body.metadata.recording_match.artist,request.artist);
  assert.equal(res.body.metadata.recording_match.method,'catalog_alias');
});
test('localized retry still rejects a cover',async()=> {
  const api={name:'Fixture',searchSong:async()=>({...localized,artist:'Cover Artist',id:7})};
  assert.equal((await run(api)).statusCode,409);
});
test('localized retries retain deadlines and reject malformed catalog identity',async()=> {
  const api={name:'Fixture',searchSong:()=>new Promise(()=>{})};
  assert.equal((await run(api,request,{providerTimeoutMs:5})).statusCode,504);
  for (const fields of [{catalog_id:'library-id'},{catalog_id:123},{storefront:'CA'},{storefront:'../tw'}]) {
    assert.equal((await run(api,{...request,...fields})).statusCode,400);
  }
});
test('explicit pronunciation language remains authoritative',async()=> {
  const api={name:'Fixture',searchSong:async()=>({...request,id:1}),getLyrics:async()=>({lines:[{text:'一起唱',timestamp:0}]})};
  const res=await run(api,{...request,language:'en'});
  assert.equal(res.body.song.romanization_system,'none');
  assert.equal(res.body.lines[0].romanized,'一起唱');
});
test('legacy metadata-only requests receive album-bound evidence after verified discovery',async()=>{
 const api={name:'Fixture',searchSong:async(a,t)=>t===localized.title ? {...localized,id:1}:null,getLyrics:async()=>({lines:[{text:'一起唱',timestamp:0}]})};
 const res=await run(api,{artist:request.artist,title:request.title,duration:request.duration,album:'The Chaos After You'});
 assert.equal(res.statusCode,200);
 assert.deepEqual(res.body.metadata.recording_match,{method:'metadata_alias',catalog_id:localized.catalog_id,artist:request.artist,title:request.title,duration:request.duration,album:'The Chaos After You'});
});

test('verified plain lyrics remain a fallback while a catalog alias upgrades timing',async()=>{
 const calls=[];
 const api={name:'Fixture',searchSong:async(artist,title)=>{calls.push(title);return {...(title===localized.title?localized:request),id:title===localized.title?2:1};},
   getLyrics:async id=>({lines:[{text:'一起唱',timestamp:id===2?4:null}]})};
 const res=await run(api);
 assert.equal(res.statusCode,200);assert.deepEqual(calls,[request.title,localized.title]);
 assert.equal(res.body.quality.synced,true);assert.equal(res.body.lines[0].timestamp,4);
 assert.equal(res.body.metadata.recording_match.catalog_id,request.catalog_id);
});

test('a failed optional timing upgrade preserves the original plain response',async()=>{
 for(const behavior of ['missing','mismatch','offline','timeout','instrumental']) {
  const api={name:'Fixture',searchSong:async(artist,title)=>{
    if(title===request.title)return {...request,id:1};
    if(behavior==='missing')return null;
    if(behavior==='mismatch')return {...localized,artist:'Different Performer',id:2};
    if(behavior==='offline')throw new Error('offline');
    if(behavior==='timeout')return new Promise(()=>{});
    return {...localized,id:2};
  },getLyrics:async id=>id===1?{lines:[{text:'一起唱',timestamp:null}]}:{instrumental:true,lines:[]}};
  const res=await run(api,request,{providerTimeoutMs:10});
  assert.equal(res.statusCode,200,behavior);assert.equal(res.body.song.id,1,behavior);
  assert.equal(res.body.quality.synced,false);assert.equal(res.body.lines[0].original,'一起唱');
  assert.equal(res.body.metadata.recording_match,undefined);
 }
});

test('catalog evidence failure cannot suppress a timed or instrumental result',async()=>{
 for(const lyrics of [{lines:[{text:'一起唱',timestamp:0}]},{instrumental:true,lines:[]}]) {
  const api={name:'Fixture',searchSong:async()=>({...request,id:1}),getLyrics:async()=>lyrics};
  const res=await run(api,request,{resolveCatalogAliasesFn:()=>assert.fail('no optional lookup needed')});
  assert.equal(res.statusCode,200);
 }
});

test('the reported Douyin recording resolves through its Traditional Chinese catalog spelling',async()=>{
 const request={artist:'Zihao Zhang',title:'可不可以 (抖音热歌)',album:'可不可以 (抖音热歌) - Single',duration:240.889,catalog_id:'1441957721',storefront:'us'};
 const english={kind:'song',trackId:1441957721,trackName:request.title,artistName:request.artist,collectionName:request.album,trackTimeMillis:240889};
 const native={...english,trackName:'可不可以 (抖音熱歌)',artistName:'張紫豪',collectionName:'可不可以 (抖音熱歌) - Single'};
 const fetchFn=async url=>({ok:true,json:async()=>({results:new URL(url).searchParams.get('country')==='us'?[english]:[native]})});
 const calls=[];
 const api={name:'Fixture',searchSong:async(artist,title)=>{
  calls.push({artist,title});
  return artist==='張紫豪'?{id:553755659,title:'可不可以',artist:'张紫豪',album:'可不可以',duration:240.889}:null;
 },getLyrics:async()=>({lines:[{text:'一起唱',timestamp:16.56},{text:'听这首歌',timestamp:19.97}]})};
 const handler=createMusicRomanizeHandler({redis:null,getAvailableAPIsFn:()=>[api],lookupReviewedRecordingFn:async()=>null,
  lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  resolveCatalogAliasesFn:(r,c)=>resolveCatalogAliases(r,{...c,fetchFn,appleCatalog:null}),logger:{info(){},error(){}}});
 for(const body of [request,{...request,artist:native.artistName,title:native.trackName,album:native.collectionName,storefront:'hk'}]) {
  const res=createMockRes();await handler(createMockReq({body}),res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.quality.synced,true);
  assert.equal(res.body.lines.length,2);
  assert.equal(res.body.metadata.catalog_resolution.canonical_recording_id,'apple:1441957721');
  assert.equal(res.body.metadata.recording_match.catalog_id,body.catalog_id);
  assert.equal(res.body.metadata.recording_match.title,body.title);
  assert.equal(res.body.metadata.recording_match.artist,body.artist);
 }
 assert.deepEqual(calls.slice(0,2),[{artist:request.artist,title:request.title},{artist:native.artistName,title:native.trackName}]);
});
