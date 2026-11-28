import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createMusicRomanizeService as createMusicRomanizeHandler,RESPONSE_VERSION,SELECTION_REVISION} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
import {createAppleCatalog} from '../../api/utils/apple-catalog.js';
import {frames,streamResponse} from '../helpers/stream-http.js';
const request={artist:'Eric Chou',title:'Unbreakable Love',duration:258.264,catalog_id:'1321295664'};
const localized={artist:'周興哲',title:'永不失聯的愛',album:'如果雨之後',duration:258.264,catalog_id:'1321295664'};

test('Teens Edge reaches timed Chinese lyrics and returns the original request proof',async()=>{
 const request={catalog_id:'1597707697',storefront:'us',artist:'Your Woman Sleep with Others',title:'Teens Edge',album:'Stolen Childhood - Single',duration:347.058};
 const en={kind:'song',trackId:1597707697,artistName:request.artist,trackName:request.title,collectionName:request.album,trackTimeMillis:347058};
 const zh={...en,artistName:'老王樂隊',trackName:'我還年輕 我還年輕',collectionName:'吾十有五而志於學 - Single'};
 const fetchFn=async url=>({ok:true,json:async()=>({results:[new URL(url).searchParams.get('country')==='us'?en:zh]})});
 const queries=[];
 const api={name:'Fixture',searchSong:async(artist,title)=>{
  queries.push({artist,title});
  return artist===zh.artistName&&title===zh.trackName?{id:10374984,artist,title,album:'吾十有五而志於學',duration:347}:null;
 },getLyrics:async()=>({lines:[{text:'一起唱',timestamp:15},{text:'听这首歌',timestamp:20}]})};
 const handler=createMusicRomanizeHandler({redis:null,getAvailableAPIsFn:()=>[api],lookupReviewedRecordingFn:async()=>null,
  lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  resolveCatalogAliasesFn:(r,c)=>resolveCatalogAliases(r,{...c,fetchFn,appleCatalog:null}),logger:{info(){},error(){}}});
 const res=createMockRes();await handler(createMockReq({body:request}),res);
 assert.equal(res.statusCode,200);
 assert.equal(res.body.quality.synced,true);
 assert.equal(res.body.song.id,10374984);
 assert.equal(res.body.metadata.catalog_resolution.canonical_recording_id,'apple:1597707697');
 assert.equal(res.body.metadata.recording_match.method,'catalog_alias');
 assert.equal(res.body.metadata.recording_match.artist,request.artist);
 assert.equal(res.body.metadata.recording_match.title,request.title);
 assert.equal(res.body.metadata.recording_match.duration,request.duration);
 assert.ok(queries.some(q=>q.artist===zh.artistName&&q.title===zh.trackName));
});
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
test('localized owners spend one bounded original probe and reuse canonical cache with their own anchor',async()=>{
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
 // Different request owners cannot join a promise without subscriber/cancel
 // accounting. Canonical content reuse after completion remains available.
 assert.equal(calls,3);
 for(let i=0;i<results.length;i++){
  assert.equal(results[i].statusCode,200);
  assert.equal(results[i].body.metadata.catalog_resolution.requested.storefront,inputs[i].storefront);
 }
 const cached=await run({...inputs[1],storefront:'hk'});assert.equal(cached.statusCode,200);assert.equal(calls,3);
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

test('a failed optional timing upgrade preserves the original plain response',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 for(const behavior of ['missing','mismatch','offline','timeout','instrumental']) {
  let began;const optionalStarted=new Promise(resolve=>{began=resolve;});
  const api={name:'Fixture',searchSong:async(artist,title)=>{
    if(title===request.title)return {...request,id:1};
    if(behavior==='missing')return null;
    if(behavior==='mismatch')return {...localized,artist:'Different Performer',id:2};
    if(behavior==='offline')throw new Error('offline');
    if(behavior==='timeout'){began();return new Promise(()=>{});}
    return {...localized,id:2};
  },getLyrics:async id=>id===1?{lines:[{text:'一起唱',timestamp:null}]}:{instrumental:true,lines:[]}};
  const work=run(api,request,{providerTimeoutMs:10});
  if(behavior==='timeout'){await optionalStarted;t.mock.timers.tick(10);}
  const res=await work;
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

test('Heroine repairs a cached instrumental result through its verified Japanese title',async()=>{
 const request={artist:'back number',title:'Heroine',album:'Heroine - EP',duration:270.04,catalog_id:'1451566361',storefront:'ca'};
 const localized={...request,title:'ヒロイン',album:'ヒロイン - EP',storefront:'jp'};
 const lyrics={lines:[{text:'これはテストの歌です',timestamp:12},{text:'ここでもう一度歌う',timestamp:20}]};
 const queries=[];
 const lrclib={name:'LRCAPI',searchSong:async(_,title)=>{
  queries.push(title);
  return title===request.title?{...request,id:25176047}:null;
 },getLyrics:async()=>({instrumental:true,lines:[]})};
 const netease={name:'NeteaseAPI',searchSong:async(_,title)=>title===localized.title?{...localized,id:1345494884}:null,
  getLyrics:async()=>lyrics};
 const appleCatalog={lookup:async(_,country)=>[{...(country==='jp'?localized:request),storefront:country,provenance:'apple_music',has_lyrics:true}]};
 const stale={song:{id:25176047},quality:{instrumental:true,synced:false,partial:false},lines:[],
  metadata:{version:RESPONSE_VERSION,selection_revision:SELECTION_REVISION,timestamp:new Date().toISOString(),
   lyric_structure:{version:'lyric-annotations-3',sourceRows:[],speakers:[],occurrences:[]}}};
 let cacheReads=0;
 const handler=createMusicRomanizeHandler({redis:{},getCachedFn:async()=>{cacheReads++;return stale;},setCachedFn:async()=>{},waitUntilFn:()=>{},
  getContextFn:async()=>null,setContextFn:async()=>{},getAvailableAPIsFn:()=>[lrclib,netease],
  lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  resolveCatalogAliasesFn:(r,c)=>resolveCatalogAliases(r,{...c,appleCatalog}),logger:{info(){},error(){}}});
 const res=streamResponse();
 await handler(createMockReq({body:{...request,options:{delivery:'progressive-v1'}}}),res);
 assert.equal(cacheReads,1);
 assert.deepEqual(queries,[request.title,localized.title]);
 const delivery=frames(res);
 assert.deepEqual(delivery.map(f=>f.event),['readable','complete']);
 for(const {response} of delivery) {
  assert.equal(response.song.id,1345494884);
  assert.equal(response.metadata.source,'NeteaseAPI');
  assert.equal(response.quality.instrumental,false);
  assert.equal(response.quality.synced,true);
  assert.deepEqual(response.lines.map(line=>line.timestamp),[12,20]);
  assert.deepEqual(response.metadata.catalog_resolution.requested,{catalog_id:request.catalog_id,storefront:'ca'});
  assert.equal(response.metadata.catalog_resolution.catalog_has_lyrics,undefined);
  assert.equal(response.metadata.recording_match.title,request.title);
 }
});

test('explicit refresh fetches updated lyrics evidence through the Apple adapter',async()=>{
 let hasLyrics=false,songFetches=0;
 const recording={artist:'back number',title:'Heroine',album:'Heroine - EP',duration:270.04,catalog_id:'1451566361',storefront:'ca'};
 const native={...recording,title:'ヒロイン',album:'ヒロイン - EP'};
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const appleCatalog=createAppleCatalog({teamID:'fixture',keyID:'fixture',privateKey:privateKey.export({type:'pkcs8',format:'pem'}),
  fetchFn:async url=>{
   const path=new URL(url).pathname;
   if(path.includes('/storefronts/'))return {ok:true,json:async()=>({data:[{attributes:{defaultLanguageTag:'en-US'}}]})};
   songFetches++;
   const {title,artist,album}=path.includes('/catalog/jp/')?native:recording;
   return {ok:true,json:async()=>({data:[{id:recording.catalog_id,type:'songs',
    attributes:{name:title,artistName:artist,albumName:album,durationInMillis:270040,hasLyrics}}]})};
  }});
 const api={name:'LRCAPI',searchSong:async(_,title)=>title===native.title?{...native,id:2}:{...recording,id:1},
  getLyrics:async id=>id===1?{instrumental:true,lines:[]}:{lines:[{text:'これはテストの歌です',timestamp:12}]}};
 const handler=createMusicRomanizeHandler({redis:null,getAvailableAPIsFn:()=>[api],
  lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  resolveCatalogAliasesFn:(r,c)=>resolveCatalogAliases(r,{...c,appleCatalog}),logger:{info(){},error(){}}});
 const initial=createMockRes();
 await handler(createMockReq({body:recording}),initial);
 assert.equal(initial.body.quality.instrumental,true);
 const firstFetches=songFetches;
 hasLyrics=true;
 const refreshed=createMockRes();
 await handler(createMockReq({body:{...recording,options:{refresh:true}}}),refreshed);
 assert.ok(songFetches>firstFetches);
 assert.equal(refreshed.body.song.id,2);
 assert.equal(refreshed.body.lines[0].timestamp,12);
});

for(const conflicting of [false,true]){
test(`a verified instrumental keeps the original query with ${conflicting?'conflicting':'negative'} catalog lyric evidence`,async()=>{
 const recording={artist:'back number',title:'Heroine (Instrumental)',album:'Heroine - EP',duration:270.04,catalog_id:'1451566370',storefront:'ca'};
 const japanese={...recording,title:'ヒロイン (Karaoke Mix)',album:'ヒロイン - EP'};
 const catalog={lookup:async(_,country)=>[{...(['us','jp'].includes(country)?japanese:country==='hk'?{...recording,album:'Heroine'}:recording),
  storefront:country,provenance:'apple_music',has_lyrics:conflicting&&country==='jp'}]};
 const queried=[];
 const lrclib={name:'LRCAPI',searchSong:async(_,title,{album})=>{
  queried.push(JSON.stringify([title,album]));
  return title===recording.title&&album===recording.album?{...recording,id:3013720}:null;
 },getLyrics:async()=>({instrumental:true,lines:[]})};
 const netease={name:'NeteaseAPI',searchSong:async(_,title)=>title===japanese.title?{...japanese,id:1345488797}:null,
  getLyrics:async()=>({lines:[{text:'これはテストの歌です',timestamp:12}]})};
 const fetchFn=async()=>({ok:true,json:async()=>({results:[{kind:'song',trackId:Number(recording.catalog_id),
  artistName:recording.artist,trackName:recording.title,collectionName:recording.album,trackTimeMillis:270040}]})});
 for(const catalog_id of [recording.catalog_id,undefined])for(const progressive of [false,true]) {
  const handler=createMusicRomanizeHandler({redis:null,getAvailableAPIsFn:()=>[lrclib,netease],
   lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
   resolveCatalogAliasesFn:(r,c)=>resolveCatalogAliases(r,{...c,appleCatalog:catalog,fetchFn}),logger:{info(){},error(){}}});
  const res=progressive?streamResponse():createMockRes();
  await handler(createMockReq({body:{...recording,catalog_id,options:progressive?{delivery:'progressive-v1'}:{}}}),res);
  assert.equal(res.statusCode,200);
  const responses=progressive?frames(res).map(f=>f.response):[res.body];
  assert.equal(responses.length,progressive?2:1);
  for(const response of responses) {
   assert.equal(response.song.id,3013720);
   assert.equal(response.metadata.source,'LRCAPI');
   assert.deepEqual(response.metadata.catalog_resolution.requested,{catalog_id:catalog_id??null,storefront:recording.storefront});
   assert.deepEqual(response.quality,{instrumental:true,synced:false,partial:false});
   assert.deepEqual(response.lines,[]);
   assert.equal(response.lyric_structure,undefined);
   assert.equal(response.metadata.lyric_structure,undefined);
   assert.equal(response.metadata.selection_revision,undefined);
  }
 }
 assert.deepEqual([...new Set(queried)],[JSON.stringify([recording.title,recording.album])]);
});
}

test('catalog recovery tries a literally different provider spelling for the same complete credits',async()=>{
 const recording={artist:'Fixture Artist',title:'A Song (feat. Guest)',album:'A Record',duration:270,catalog_id:'777',storefront:'ca'};
 const localized={...recording,artist:'Fixture Artist & Guest',title:'A Song'};
 const appleCatalog={lookup:async(_,country)=>[{...(country==='jp'?localized:recording),storefront:country,provenance:'apple_music',has_lyrics:true}]};
 const queries=[];
 const api={name:'LRCAPI',searchSong:async(artist,title)=>{
  queries.push([artist,title]);
  return artist===localized.artist&&title===localized.title?{...localized,id:2}:{...recording,id:1};
 },getLyrics:async id=>id===1?{instrumental:true,lines:[]}:{lines:[{text:'A test phrase',timestamp:12}]}};
 const result=await run(api,recording,{resolveCatalogAliasesFn:(r,c)=>resolveCatalogAliases(r,{...c,appleCatalog})});
 assert.equal(result.statusCode,200);
 assert.deepEqual(queries,[[recording.artist,recording.title],[localized.artist,localized.title]]);
 assert.equal(result.body.song.id,2);
 assert.equal(result.body.lines[0].timestamp,12);
});

test('a slow verified alias leaves an uncached instrumental fallback and recovers on the next ordinary request',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout']});
 const english={...request,album:'The Chaos After You',storefront:'ca'};
 const catalog={lookup:async(_,country)=>[{...(country==='tw'?localized:english),storefront:country,provenance:'apple_music',has_lyrics:true}]};
 let startOriginal,startAlias,aliasSignal,stall=true;
 const originalStarted=new Promise(resolve=>{startOriginal=resolve;});
 const aliasStarted=new Promise(resolve=>{startAlias=resolve;});
 const api={name:'LRCAPI',searchSong:async(_,title,{signal})=>{
  if(title===localized.title){
   if(!stall)return {...localized,id:2};
   aliasSignal=signal;
   startAlias();
   return new Promise(()=>{});
  }
  if(stall){
   startOriginal();
   await new Promise(resolve=>setTimeout(resolve,9000));
  }
  return {...english,id:1};
 },getLyrics:async id=>id===1?{instrumental:true,lines:[]}:{lines:[{text:'一起唱',timestamp:12}]}};
 const stored=new Map();
 const handler=createMusicRomanizeHandler({redis:{},getCachedFn:async(_,key)=>stored.get(key),
  setCachedFn:async(_,key,response)=>stored.set(key,response),waitUntilFn:()=>{},getContextFn:async()=>null,setContextFn:async()=>{},
  providerTimeoutMs:10000,speculativeDiscovery:false,getAvailableAPIsFn:()=>[api],
  lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  resolveCatalogAliasesFn:(r,c)=>resolveCatalogAliases(r,{...c,appleCatalog:catalog}),logger:{info(){},error(){}}});
 const run=async()=>{
  const res=createMockRes();
  await handler(createMockReq({body:english}),res);
  return res;
 };
 const work=run();
 await originalStarted;
 t.mock.timers.tick(9000);
 await aliasStarted;
 t.mock.timers.tick(6750);
 const res=await work;
 assert.equal(aliasSignal.aborted,true);
 assert.equal(res.statusCode,200);
 assert.equal(res.body.quality.instrumental,true);
 assert.equal(res.body.lyric_structure,undefined);
 assert.equal(res.body.metadata.selection_revision,undefined);
 assert.equal(stored.size,0);
 stall=false;
 const recovered=await run();
 assert.equal(recovered.statusCode,200);
 assert.equal(recovered.body.quality.instrumental,false);
 assert.equal(recovered.body.lines[0].timestamp,12);
 assert.equal(recovered.body.metadata.selection_revision,SELECTION_REVISION);
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
  // Independent localized acquisitions may directly match normalized source
  // labels; their full accepted catalog proof remains the request identity.
  const match=res.body.metadata.recording_match??res.body.metadata.catalog_resolution.accepted_request;
  assert.equal(match.catalog_id,body.catalog_id);
  assert.equal(match.title,body.title);
  assert.equal(match.artist,body.artist);
 }
 assert.deepEqual(calls.slice(0,2),[{artist:request.artist,title:request.title},{artist:native.artistName,title:native.trackName}]);
});
