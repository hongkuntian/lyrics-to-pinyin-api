import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {completenessTarget,completenessCandidate,fullerCandidate} from '../helpers/lyric-completeness-fixture.js';
import {streamResponse,frames} from '../helpers/stream-http.js';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';

const bodyFor=(platform,options={})=>platform==='apple'?{...completenessTarget,options}:{recording:{version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',
 metadata:{origin:'spotify',title:completenessTarget.title,artists:[completenessTarget.artist],album:completenessTarget.album,duration_ms:240000}},options};
const serviceFor=(apis,dependencies={})=>createMusicRomanizeService({redis:null,speculativeDiscovery:false,getAvailableAPIsFn:()=>apis,
 hedgeDelayMs:1,untimedGraceMs:5,wordTimingGraceMs:0,providerTimeoutMs:100,
 resolveCatalogAliasesFn:async()=>[],lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
 getProcessorFn:()=>({romanize:async text=>({romanized:text})}),logger:{error(){},info(){},log(){}},...dependencies});
const until=async predicate=>{for(let attempt=0;attempt<100&&!predicate();attempt++)await new Promise(resolve=>setImmediate(resolve));assert.ok(predicate(),'expected lookup event');};

test('Apple catalog-validated localized targets can corroborate a fuller source',async()=>{
 const excerpt=completenessCandidate(),full=fullerCandidate(),request={...completenessTarget,catalog_id:'123456789',storefront:'us'};
 const english={kind:'song',trackId:123456789,trackName:request.title,artistName:request.artist,collectionName:request.album,trackTimeMillis:240000};
 const localized={...english,trackName:'Chanson de Test'};
 const apis=[{name:'LRCAPI',searchSong:async(artist,title)=>title===english.trackName?excerpt.song:null,getLyrics:async()=>excerpt.lyrics},
  {name:'KugouAPI',searchSong:async(artist,title)=>title===localized.trackName?{...full.song,title}:null,getLyrics:async()=>full.lyrics}];
 const fetchFn=async url=>({ok:true,json:async()=>({results:[new URL(url).searchParams.get('country')==='us'?english:localized]})});
 const service=serviceFor(apis,{resolveCatalogAliasesFn:(target,context)=>resolveCatalogAliases(target,{...context,fetchFn,appleCatalog:null})});
 const response=createMockRes();await service({method:'POST',body:request},response);
 assert.equal(response.statusCode,200,JSON.stringify(response.body));
 assert.equal(response.body.song.id,'full');
 assert.equal(response.body.metadata.recording_match.method,'catalog_alias');
 assert.equal(response.body.metadata.catalog_resolution.canonical_recording_id,'apple:123456789');
 assert.deepEqual(response.body.lines.map(line=>line.original),full.lyrics.lines.map(line=>line.text));
 assert.equal(response.body.quality.synced,false);
 assert.equal(JSON.stringify(response.body).includes('recordingTarget'),false);
});

for(const available of [true,false])test(`reviewed native title recovers the Apple recording without restoring quarantined timing: available=${available}`,async()=>{
 const request={artist:'Ikimonogakari',title:'Blue Bird',album:'Chou Ikimonobakari Tennen Kinen Members Best Selection',duration:215.707,catalog_id:'1089186523',storefront:'us'};
 const anchor={kind:'song',trackId:1089186523,trackName:request.title,artistName:request.artist,collectionName:request.album,trackTimeMillis:215707};
 const opening=Array.from({length:4},(_,index)=>`朝の光が街を照らして新しい物語を始める${index}`);
 const later=Array.from({length:4},(_,index)=>`夕方の風が窓を開いて遠い旅の続きを語り始める${index}`);
 const excerpt=completenessCandidate({target:request,lines:opening}),full=completenessCandidate({target:{...request,title:'ブルーバード'},id:468823329,lines:[...opening,...later,...opening]});
 const calls=[],apis=[{name:'LRCAPI',searchSong:async(artist,title)=>title===request.title?excerpt.song:null,getLyrics:async()=>excerpt.lyrics},
  {name:'KugouAPI',searchSong:async(artist,title)=>{calls.push({artist,title});return available&&title==='ブルーバード'?full.song:null;},getLyrics:async()=>({...full.lyrics,source:'kugou'})}];
 const fetchFn=async()=>({ok:true,json:async()=>({results:[anchor]})});
 const service=serviceFor(apis,{resolveCatalogAliasesFn:(target,context)=>resolveCatalogAliases(target,{...context,fetchFn,appleCatalog:null})});
 for(const options of [{},{refresh:true}]){
  const response=createMockRes();await service({method:'POST',body:{...request,options}},response);
  assert.equal(response.statusCode,200,JSON.stringify(response.body));
  assert.deepEqual(response.body.lines.map(line=>line.original),(available?full:excerpt).lyrics.lines.map(line=>line.text));
  assert.equal(response.body.metadata.catalog_resolution.method,'reviewed_alias');
  assert.equal(response.body.metadata.catalog_resolution.canonical_recording_id,'apple:1089186523');
  assert.equal(response.body.quality.partial,false);
  if(available){
   assert.equal(String(response.body.song.id),'468823329');
   assert.ok(response.body.lines.every(line=>line.timestamp===null&&!line.vocalTiming));
   assert.equal(response.body.quality.synced,false);
   assert.equal(response.body.metadata.timing_correction.reason,'quarantined_source');
  }else assert.equal(response.body.song.id,'excerpt');
  assert.equal(JSON.stringify(response.body).includes('recordingTarget'),false);
 }
 assert.ok(calls.some(call=>call.artist===request.artist&&call.title==='ブルーバード'));
});

for(const platform of ['apple','spotify'])for(const order of ['excerpt-first','full-first'])for(const available of [true,false])test(`${platform} corroborated completeness: ${order}, fuller available=${available}`,async()=>{
 const excerpt=completenessCandidate(),full=fullerCandidate(),calls=[];
 const provider=(name,candidate)=>({name,searchSong:async()=>{calls.push(name);return candidate?.song??null;},getLyrics:async()=>candidate.lyrics});
 const short=provider('LRCAPI',excerpt),long=provider('KugouAPI',available?full:null);
 const service=createMusicRomanizeService({redis:null,speculativeDiscovery:false,getAvailableAPIsFn:()=>order==='excerpt-first'?[short,long]:[long,short],
  hedgeDelayMs:1,untimedGraceMs:5,wordTimingGraceMs:0,providerTimeoutMs:100,
  resolveCatalogAliasesFn:async()=>[],lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  getProcessorFn:()=>({romanize:async text=>({romanized:text})}),logger:{error(){},info(){},log(){}}});
 const body=platform==='apple'?completenessTarget:{recording:{version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',
  title:completenessTarget.title,artists:[completenessTarget.artist],album:completenessTarget.album,duration_ms:240000}}};
 for(const options of [{},{},{refresh:true},{}]) {
  const response=createMockRes();await service(createMockReq({body:{...body,options}}),response);
  assert.equal(response.statusCode,200,JSON.stringify(response.body));
  assert.deepEqual(response.body.lines.map(line=>line.original),(available?full:excerpt).lyrics.lines.map(line=>line.text));
  assert.equal(response.body.quality.synced,!available);
  assert.equal(response.body.quality.partial,false);
  assert.equal(response.body.metadata.selection_revision,'lyrics-selection-2026-09-30-storefront-1');
 }
 assert.ok(calls.includes('KugouAPI'));
});

for(const platform of ['apple','spotify'])test(`${platform}: progressive discovery never publishes a corroborated excerpt or quarantined timing`,async()=>{
 const excerpt=completenessCandidate(),full=fullerCandidate();let release,started=false;
 const gate=new Promise(resolve=>{release=resolve;});
 const apis=[{name:'LRCAPI',searchSong:async()=>excerpt.song,getLyrics:async()=>excerpt.lyrics},
  {name:'KugouAPI',searchSong:async()=>{started=true;await gate;return {...full.song,id:468823329};},
   getLyrics:async()=>({...full.lyrics,source:'kugou',lines:full.lyrics.lines.map((line,index)=>({...line,timestamp:10+index*10}))})}];
 const service=serviceFor(apis),response=streamResponse(),work=service({method:'POST',body:bodyFor(platform,{delivery:'progressive-v1'})},response);
 try {
  await until(()=>started);assert.deepEqual(frames(response),[]);release();await work;
  assert.equal(frames(response).at(-1).event,'complete');
  for(const frame of frames(response)) {
   assert.equal(String(frame.response.song.id),'468823329');
   assert.deepEqual(frame.response.lines.map(line=>line.original),full.lyrics.lines.map(line=>line.text));
   assert.ok(frame.response.lines.every(line=>line.timestamp===null&&!line.vocalTiming));
   assert.equal(frame.response.quality.synced,false);
   assert.equal(frame.response.metadata.timing_correction.reason,'quarantined_source');
  }
 }finally{release();await work;}
});

for(const platform of ['apple','spotify'])test(`${platform}: ordinary refresh and persistent caches retain the fuller source`,async()=>{
 const excerpt=completenessCandidate(),full=fullerCandidate(),values=new Map(),pending=[],writes=[];
 let fuller=false,searches=0;
 const api={name:'LRCAPI',searchSong:async()=>{searches++;return fuller?full.song:excerpt.song;},
  getLyrics:async id=>id==='full'?full.lyrics:excerpt.lyrics};
 const dependencies={redis:{},getCachedFn:async(_,key)=>values.get(key),setCachedFn:async(_,key,value,ttl)=>{values.set(key,structuredClone(value));writes.push({key,ttl});},
  waitUntilFn:work=>pending.push(work)};
 const call=async(service,options={})=>{const response=createMockRes();await service({method:'POST',body:bodyFor(platform,options)},response);await Promise.all(pending);assert.equal(response.statusCode,200);return response.body;};
 const service=serviceFor([api],dependencies);
 assert.equal((await call(service)).song.id,'excerpt');fuller=true;
 assert.equal((await call(service,{refresh:true})).song.id,'full');assert.equal(searches,2);
 assert.equal((await call(serviceFor([api],dependencies))).song.id,'full');assert.equal(searches,2);
 assert.ok(writes.some(write=>write.ttl===300));
});

for(const platform of ['apple','spotify'])test(`${platform}: wrong-recording fuller text cannot displace the readable fallback`,async()=>{
 const excerpt=completenessCandidate(),full=fullerCandidate();
 const apis=[{name:'LRCAPI',searchSong:async()=>excerpt.song,getLyrics:async()=>excerpt.lyrics},
  {name:'KugouAPI',searchSong:async()=>({...full.song,artist:'Different Singer'}),getLyrics:async()=>full.lyrics}];
 const response=createMockRes();await serviceFor(apis)({method:'POST',body:bodyFor(platform)},response);
 assert.equal(response.statusCode,200);assert.equal(response.body.song.id,'excerpt');assert.equal(response.body.quality.partial,false);
});
