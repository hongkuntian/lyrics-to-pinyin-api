import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeHandler} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
const request={artist:'Eric Chou',title:'Unbreakable Love',duration:258.264,catalog_id:'1321295664'};
const localized={artist:'周興哲',title:'永不失聯的愛',album:'如果雨之後',duration:258.264,catalog_id:'1321295664'};
async function run(api, body=request, deps={}) {
  const res=createMockRes();
  await createMusicRomanizeHandler({lookupOfficialTranscriptionFn:async()=>null,lookupReviewedRecordingFn:async()=>null,redis:null,getAvailableAPIsFn:()=>[api],resolveCatalogAliasesFn:async()=>[localized],logger:{error(){},info(){}},...deps})(createMockReq({body}),res);
  return res;
}
test('English catalog names do not suppress Chinese pronunciation',async()=> {
  const api={name:'Fixture',searchSong:async()=>({...request,id:1}),getLyrics:async()=>({lines:[{text:'一起唱',timestamp:0},{text:'Sing with me',timestamp:4}]})};
  const res=await run(api);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.song.language,'zh');
  assert.equal(res.body.song.romanization_system,'pinyin');
  assert.equal(res.body.lines[0].romanized,'yì qǐ chàng');
  assert.equal(res.body.lines[1].romanized,'Sing with me');
  assert.equal(res.body.song.title.romanized,'Unbreakable Love');
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

test('timed and explicit instrumental results do not trigger optional alias discovery',async()=>{
 for(const lyrics of [{lines:[{text:'一起唱',timestamp:0}]},{instrumental:true,lines:[]}]) {
  const api={name:'Fixture',searchSong:async()=>({...request,id:1}),getLyrics:async()=>lyrics};
  const res=await run(api,request,{resolveCatalogAliasesFn:()=>assert.fail('no optional lookup needed')});
  assert.equal(res.statusCode,200);
 }
});
