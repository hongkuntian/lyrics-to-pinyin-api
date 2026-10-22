import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {parseYRC} from '../../api/utils/netease-yrc.js';
import {parseQRC} from '../../api/utils/qq-qrc.js';
import {verifySpotifyBinding,sourceCapsule} from '../../api/utils/song-library/spotify-recording.js';
import {SELECTION_REVISION} from '../../api/music-romanize.js';
import {createMockRes} from '../helpers/mock-http.js';
import {streamResponse,frames} from '../helpers/stream-http.js';

// Catalog metadata from the report, with original invented lyric content.
const apple={artist:'Eric Chou',title:'Unbreakable Love',album:'The Chaos After You',duration:258.264,catalog_id:'1321295664',storefront:'ca'};
const native={...apple,artist:'周興哲',title:'永不失聯的愛',album:'如果雨之後'};
const spotify={version:2,provider:'spotify',item_id:'46fURCnWErjFdNM2yBJ2c8',market:'US',metadata:{origin:'spotify',title:native.title,artists:[apple.artist],album:native.album,duration_ms:258954}};
const line=()=>({source:'netease',lines:[{text:'Invented first row',timestamp:10},{text:'Invented second row',timestamp:30}]});
const words=id=>parseYRC('[10000,2000](10000,2000,0)Invented first row\n[30000,2000](30000,2000,0)Invented second row',{songId:id});
const qrc=id=>parseQRC('<QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="[10000,2000]Invented first row(10000,2000)&#10;[30000,2000]Invented second row(30000,2000)"/></LyricInfo></QrcInfos>',{songId:id});
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function setup(provider,{localized=true,behavior='words',gate=null,protectedTiming=false}={}) {
 const values=new Map(),pending=[],queries=[],ttls=[];let upgrade=false,hints=0;
 const request=provider==='apple'?apple:{...apple,title:native.title,album:native.album,duration:258.954};
 const song=(id,local=false)=>({...request,...(local?native:{}),id,source:'netease',creditedArtistNames:[local?native.artist:apple.artist]});
 const api={name:'NeteaseAPI',supportsVocalTiming:true,searchSong:async(a,t,c)=>{
  queries.push([a,t]);
  if(provider==='spotify'&&localized)c.onVerifiedArtistCredits?.({names:[native.artist],aliases:[apple.artist]});
  const local=localized&&a===native.artist&&t===native.title;
  if(!local&&!upgrade)return song(1);
  if(gate)await gate.promise;
  if(behavior==='offline')throw new Error('offline');
  if(behavior==='missing')return null;
  return {...song(2,local),...(behavior==='mismatch'?{artist:'Wrong Singer',creditedArtistNames:['Wrong Singer']}:{})};
 },getLyrics:async id=>id===1?line():words(id),getRecording:async()=>{hints++;return {song:song(1),lyrics:line()};}};
 const nativeAPI={name:'QQMusicAPI',supportsVocalTiming:true,searchSong:async(a,t,c)=>{
  if(!localized||a!==native.artist)return null;
  const found=await api.searchSong(a,t,c);return found&&{...found,source:'qq'};
 },getLyrics:async id=>qrc(id)};
 const aliases=async()=>{
  const searches=[apple,...(localized?[native]:[])],aliases=searches.slice(1);
  Object.defineProperty(aliases,'resolution',{value:{version:'catalog-recording-1',method:'same_catalog_id',requested:{catalog_id:apple.catalog_id,storefront:apple.storefront},canonical_recording_id:'apple:'+apple.catalog_id,canonical_context:{artist:apple.artist,title:apple.title},accepted_request:apple,catalog_items:[{catalog_id:apple.catalog_id,storefront:'ca',provenance:'itunes'}],searches}});
  return aliases;
 };
 const deps={redis:{},getCachedFn:async(_,k)=>values.get(k),setCachedFn:async(_,k,v,ttl)=>{values.set(k,structuredClone(v));ttls.push({k,ttl});},waitUntilFn:p=>pending.push(p),
  getAvailableAPIsFn:()=>provider==='spotify'?[api,nativeAPI]:[api],speculativeDiscovery:false,resolveCatalogAliasesFn:aliases,
  lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  applyTimingCorrectionFn:async c=>protectedTiming?{...c,timingCorrection:{status:'replacement',id:'fixture-review'}}:c,
  logger:{info(){},error(){}}};
 const service=createMusicRomanizeService(deps);
 const body=options=>provider==='apple'?{...apple,options:{lyric_sources_version:2,...options}}:{recording:spotify,options:{lyric_sources_version:2,...options}};
 const call=async(options={},extra={})=>{const res=createMockRes();await service({method:'POST',body:body(options),...extra},res);await Promise.all(pending);return res;};
 return {api,service,body,call,queries,ttls,values,setUpgrade:()=>{upgrade=true;},get hints(){return hints;}};
}

for(const provider of ['apple','spotify'])test(`${provider}: readable line timing continues through verified native names to complete source-owned words`,async()=>{
 const f=setup(provider),res=await f.call();
 assert.equal(res.statusCode,200);assert.equal(res.body.song.id,2);
 assert.equal(res.body.metadata.lyric_timing.source,provider==='apple'?'netease:2:yrc':'qq:2:qrc');
 assert.equal(res.body.lines.filter(l=>l.vocalTiming).length,2);
 assert.ok(f.queries.some(([a,t])=>a===native.artist&&t===native.title));
 if(provider==='spotify')verifySpotifyBinding(res.body.recordingBinding,spotify,sourceCapsule(res.body),SELECTION_REVISION,res.body);
 else assert.equal(res.body.metadata.recording_match.catalog_id,apple.catalog_id);
});

for(const provider of ['apple','spotify'])test(`${provider}: optional native-name failures preserve readable line timing`,async()=>{
 for(const behavior of ['offline','missing','mismatch']) {
  const f=setup(provider,{behavior}),res=await f.call();
  assert.equal(res.statusCode,200,behavior);assert.equal(res.body.song.id,1,behavior);
  assert.equal(res.body.quality.synced,true);assert.equal(res.body.lines.some(l=>l.vocalTiming),false);
 }
});

for(const provider of ['apple','spotify'])test(`${provider}: fresh line-only source hints publish a fallback and continue ordinary measured discovery`,async()=>{
 const f=setup(provider,{localized:false});
 assert.equal((await f.call()).body.song.id,1);f.setUpgrade();
 const candidates=[],res=await f.call({refresh:true},{lyricDelivery:{acquisitionID:'hint-upgrade',deadlineAtMS:Date.now()+5000,signal:new AbortController().signal,publish:r=>candidates.push(r)}});
 assert.equal(f.hints,1);assert.equal(res.body.song.id,2);
 assert.equal(candidates[0].song.id,1);assert.equal(candidates.at(-1).metadata.lyric_timing.source,'netease:2:yrc');
});

for(const provider of ['apple','spotify'])test(`${provider}: discovery failure after a fresh hint keeps its readable response`,async()=>{
 const f=setup(provider,{localized:false,behavior:'offline'});
 await f.call();f.setUpgrade();
 const res=await f.call({refresh:true});assert.equal(f.hints,1);
 assert.equal(res.statusCode,200);assert.equal(res.body.song.id,1);assert.equal(res.body.quality.synced,true);
});

test('Apple reviewed line timing does not trigger localized word discovery',async()=>{
 const f=setup('apple',{protectedTiming:true}),res=await f.call();
 assert.equal(res.body.song.id,1);assert.equal(f.queries.length,1);
});

for(const provider of ['apple','spotify'])test(`${provider}: progressive readable result survives while a localized measured upgrade is pending`,async()=>{
 const gate=deferred(),f=setup(provider,{gate}),res=streamResponse();
 const work=f.service({method:'POST',body:f.body({delivery:'progressive-v1'})},res);
 try {
  const end=Date.now()+2000;
  while(!frames(res).some(v=>v.event==='readable')){assert.ok(Date.now()<end);await new Promise(r=>setImmediate(r));}
  assert.equal(frames(res)[0].response.song.id,1);assert.equal(res.ended,undefined);
  gate.resolve();await work;
  assert.equal(frames(res).at(-1).response.metadata.lyric_timing.source,provider==='apple'?'netease:2:yrc':'qq:2:qrc');
 }finally{gate.resolve();await work;}
});

for(const provider of ['apple','spotify'])test(`${provider}: complete measured sources avoid repeat discovery on refresh`,async()=>{
 const f=setup(provider,{localized:false});f.setUpgrade();
 assert.equal((await f.call()).body.song.id,2);
 // Route the fresh hint to the complete selected sheet, as the real provider does.
 f.api.getRecording=async()=>({song:{...apple,title:provider==='spotify'?native.title:apple.title,album:provider==='spotify'?native.album:apple.album,duration:provider==='spotify'?258.954:apple.duration,id:2,source:'netease',creditedArtistNames:[apple.artist]},lyrics:words(2)});
 const before=f.queries.length;assert.equal((await f.call({refresh:true})).body.song.id,2);
 assert.equal(f.queries.length,before);
});

for(const provider of ['apple','spotify'])test(`${provider}: line-only and sparse measured positives retry sooner than complete word timing`,async()=>{
 for(const kind of ['line','sparse','complete']) {
  const f=setup(provider,{localized:false});
  if(kind!=='line')f.setUpgrade();
  if(kind==='sparse')f.api.getLyrics=async id=>{const result=words(id);delete result.lines[1].vocalTiming;return result;};
  assert.equal((await f.call()).statusCode,200);
  const writes=f.ttls.filter(({k})=>k.startsWith('romanize:')||k.startsWith('spotify:lyrics:'));
  assert.equal(writes.length,1);assert.equal(writes[0].ttl,kind==='complete'?86400:300,kind);
 }
});

for(const provider of ['apple','spotify'])test(`${provider}: cancellation after readable localized fallback cannot publish or cache late words`,async()=>{
 const gate=deferred(),f=setup(provider,{gate}),controller=new AbortController(),readable=deferred(),candidates=[];
 const work=f.call({}, {lyricDelivery:{acquisitionID:'cancel-localization',deadlineAtMS:Date.now()+5000,signal:controller.signal,publish:r=>{candidates.push(r);readable.resolve();}}});
 await readable.promise;controller.abort();gate.resolve();await work;
 assert.deepEqual(candidates.map(c=>c.song.id),[1]);
 assert.equal([...f.values.keys()].some(k=>k.startsWith('romanize:')||k.startsWith('spotify:lyrics:')),false);
});

test('Apple Sunny Day localization completes a whitespace-padded QRC without exhausting later aliases',async()=>{
 const request={artist:'Jay Chou',title:'Sunny Day',album:'Yeh, Hwei-Mei',duration:269.747,catalog_id:'1721464906',storefront:'us'};
 const localized={...request,artist:'周杰倫',title:'晴天',album:'葉惠美'},queries=[];
 // The reported source has Latin sung tokens ending in a provider space.
 // All content here is invented; ranges/times reproduce that source shape.
 const lyrics=parseQRC('<QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="[10000,2000]Alpha (10000,500)beta (10600,500)&#10;[30000,2000]Gamma (30000,500)delta (30600,500)"/></LyricInfo></QrcInfos>',{songId:97773,duration:269,durationResolution:1});
 const api={name:'QQMusicAPI',supportsVocalTiming:true,searchSong:async(a,t)=>{
  queries.push([a,t]);
  if(a===localized.artist&&t===localized.title)return {...localized,id:97773,duration:269,source:'qq'};
  return null;
 },getLyrics:async()=>lyrics};
 const aliases=Object.assign([localized],{resolution:{version:'catalog-recording-1',method:'same_catalog_id',
  requested:{catalog_id:request.catalog_id,storefront:'us'},canonical_recording_id:'apple:'+request.catalog_id,
  canonical_context:{artist:request.artist,title:request.title},accepted_request:request,
  catalog_items:[{catalog_id:request.catalog_id,storefront:'us',provenance:'itunes'}],searches:[request,localized,{...localized,artist:'Other localized name'}]}});
 const service=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[api],speculativeDiscovery:false,
  resolveCatalogAliasesFn:async()=>aliases,lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,
  lookupOfficialTranscriptionFn:async()=>null,getDefaultRomanizationSystemFn:()=> 'none',logger:{info(){},error(){}}});
 const res=streamResponse();
 await service({method:'POST',body:{...request,options:{lyric_sources_version:2,delivery:'progressive-v1'}}},res);
 const final=frames(res).at(-1);
 assert.equal(final.event,'complete');
 assert.deepEqual(queries,[[request.artist,request.title],[localized.artist,localized.title]]);
 const response=final.response;
 assert.equal(response.metadata.lyric_timing.source,'qq:97773:qrc');
 assert.equal(response.metadata.lyric_timing.recordingID,request.catalog_id);
 assert.equal(response.metadata.lyric_timing.durationResolution,1);
 assert.equal(response.metadata.recording_match.duration,269.747);
 assert.equal(response.metadata.recording_match.artist,request.artist);
 assert.deepEqual(response.lines.map(l=>l.original),['Alpha beta','Gamma delta']);
 assert.deepEqual(response.lines.map(l=>l.vocalTiming.segments.map(s=>[s.text,s.start,s.end])),[
  [['Alpha ',10,10.5],['beta',10.6,11.1]],[['Gamma ',30,30.5],['delta',30.6,31.1]]
 ]);
});
