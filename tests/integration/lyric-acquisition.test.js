import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {streamResponse,frames} from '../helpers/stream-http.js';
import {createMockRes} from '../helpers/mock-http.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {LYRIC_SELECTION_REVISION} from '../../api/utils/lyric-annotations.js';
const request={catalog_id:'123',storefront:'us',artist:'Artist',title:'Song',album:'Album',duration:240,language:'zh'};
const song={id:42,artist:'Artist',title:'Song',album:'Album',duration:240,source:'lrclib'};
const words={lines:[{text:'一起唱',timestamp:12},{text:'向前走',timestamp:30}]};
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
const until=async predicate=>{const deadline=Date.now()+2000;while(!predicate()){assert.ok(Date.now()<deadline,'expected acquisition stage');await tick();}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function proof(r){return {version:'catalog-recording-1',method:'same_catalog_id',requested:{catalog_id:r.catalog_id,storefront:r.storefront??null},canonical_recording_id:'apple:123',accepted_request:{catalog_id:r.catalog_id,artist:r.artist,title:r.title,album:r.album??null,duration:r.duration},catalog_items:[{catalog_id:r.catalog_id,storefront:r.storefront??'us',provenance:'apple_music'}],genres:[],searches:[{catalog_id:r.catalog_id,artist:r.artist,title:r.title,album:r.album,duration:r.duration}]};}
function fixture(extra={}){
 const values=new Map(),pending=[],stats={catalog:0,search:0,id:0,lyrics:0,active:0,peak:0};let now=1000;
 const count=async(kind,work)=>{stats[kind]++;stats.active++;stats.peak=Math.max(stats.peak,stats.active);try{return await work();}finally{stats.active--;}};
 const api={name:'LRCAPI',searchSong:async()=>count('search',async()=>({...song})),getLyrics:async()=>count('lyrics',async()=>structuredClone(words)),getRecording:async()=>count('id',async()=>({song:{...song},lyrics:structuredClone(words)}))};
 const deps={redis:{},getCachedFn:async(_,key)=>values.get(key)??null,setCachedFn:async(_,key,value)=>values.set(key,structuredClone(value)),waitUntilFn:p=>pending.push(p),logger:{info(){},error(){}},contextNow:()=>now,contextTTLms:1000,speculativeDiscovery:false,getAvailableAPIsFn:()=>[api],detectLanguageFn:async()=> 'zh',getProcessorFn:()=>({romanize:async text=>({romanized:text})}),lookupListeningReviewedRecordingFn:async()=>null,lookupReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,resolveCatalogAliasesFn:async r=>{stats.catalog++;const aliases=[];Object.defineProperty(aliases,'resolution',{value:proof(r)});return aliases;},...extra};
 const drain=async()=>{let n=0;while(n<pending.length){const end=pending.length;await Promise.all(pending.slice(n,end));n=end;}};
 const call=async(handler,body={...request},res=createMockRes())=>{await handler({method:'POST',body},res);await drain();return res;};
 const contexts=()=>[...values].filter(([key])=>key.startsWith('lyrics:verified-context:'));
 const clearContent=()=>{for(const key of values.keys())if(!key.startsWith('lyrics:verified-context:'))values.delete(key);};
 const reset=()=>{for(const key of Object.keys(stats))stats[key]=0;};
 return {api,deps,stats,values,contexts,clearContent,reset,call,drain,make:()=>createMusicRomanizeService(deps),advance:ms=>now+=ms,count};
}
test('verified catalog and fresh LRCLIB ID survive a new function instance without caching provider words in the hint',async()=>{
 const f=fixture(),first=await f.call(f.make());assert.equal(first.statusCode,200);f.clearContent();f.reset();
 const before=f.contexts()[0][1];assert.equal(before.hints[0].signature.lyricsData,undefined);assert.equal(before.resolution.searches[0].title,'Song');
 f.api.getRecording=async()=>{f.stats.id++;return {song:{...song},lyrics:{lines:[{text:'新鲜歌词',timestamp:12}]}};};
 const second=await f.call(f.make(),{...request,romanization_system:'none'});assert.equal(second.statusCode,200);assert.deepEqual(second.body.lines.map(l=>l.original),['新鲜歌词']);
 assert.equal(f.stats.catalog,0);assert.equal(f.stats.search,0);assert.equal(f.stats.id,1);assert.equal(f.stats.lyrics,0);
 assert.equal(second.body.metadata.catalog_resolution.requested.storefront,'us');const after=f.contexts()[0][1];assert.equal(after.verifiedAtMS,before.verifiedAtMS);assert.equal(after.expiresAtMS,before.expiresAtMS);
});
test('expired, malformed and old-policy context fall back to catalog and ordinary discovery; refresh bypasses hints',async()=>{
 for(const mutation of [x=>delete x.aliases,x=>x.resolution.searches=[null],x=>x.hints=[null],x=>delete x.hints[0].target,x=>x.policy.selection='old',x=>x.expiresAtMS=999]){
  const f=fixture();await f.call(f.make());f.clearContent();const [key,value]=f.contexts()[0];mutation(value);f.values.set(key,value);f.reset();
  const res=await f.call(f.make());assert.equal(res.statusCode,200);assert.equal(f.stats.catalog,1);assert.equal(f.stats.search,1);assert.equal(f.stats.id,0);
 }
 const f=fixture();await f.call(f.make());f.clearContent();f.reset();const refresh=await f.call(f.make(),{...request,options:{refresh:true}});assert.equal(refresh.statusCode,200);assert.equal(f.stats.catalog,1);assert.equal(f.stats.search,1);assert.equal(f.stats.id,0);
});
test('fresh source metadata drift and rejected words use ordinary discovery without publishing the bad hint',async()=>{
 for(const changed of [{artist:'Cover artist'},{title:'Song (Live)'},{title:'Song (Remastered)'},{album:'Other album'},{duration:244},{id:43},{isrc:'USABC2600002'},{explicit:true},{creditedArtistNames:['Unverified guest']}]){
  const f=fixture();f.api.searchSong=async()=>{f.stats.search++;return {...song,isrc:'USABC2600001',explicit:false,creditedArtistNames:['Artist']};};await f.call(f.make());f.clearContent();f.reset();
  f.api.getRecording=async()=>{f.stats.id++;return {song:{...song,isrc:'USABC2600001',explicit:false,creditedArtistNames:['Artist'],...changed},lyrics:{lines:[{text:'错误歌词',timestamp:12}]}};};
  const res=streamResponse();await f.call(f.make(),{...request,options:{delivery:'progressive-v1'}},res);assert.equal(f.stats.id,1);assert.equal(f.stats.search,1);assert.ok(frames(res).every(frame=>frame.response?.lines.every(l=>l.original!=='错误歌词')));
 }
 const f=fixture({rejectRecordingLyricsFn:lines=>lines.some(l=>l.text==='错误歌词')});await f.call(f.make());f.clearContent();f.reset();f.api.getRecording=async()=>{f.stats.id++;return {song:{...song},lyrics:{lines:[{text:'错误歌词',timestamp:12}]}};};
 const res=await f.call(f.make());assert.equal(res.statusCode,200);assert.equal(f.stats.id,1);assert.equal(f.stats.search,1);assert.deepEqual(res.body.lines.map(l=>l.original),words.lines.map(l=>l.text));
});
test('fresh hints reapply current timing corrections before any readable publication',async()=>{
 let corrections=0;const f=fixture({applyTimingCorrectionFn:async(candidate)=>{corrections++;return {...candidate,lyrics:{...candidate.lyrics,lines:candidate.lyrics.lines.map(l=>({...l,timestamp:20}))}};}});await f.call(f.make());f.clearContent();corrections=0;
 const res=streamResponse();await f.call(f.make(),{...request,options:{delivery:'progressive-v1'}},res);assert.ok(corrections>0);assert.ok(frames(res).every(frame=>frame.response.lines.every(l=>l.timestamp===20)));
});
test('slow ID hint stays in its existing hedge slot and does not defer a second provider',async()=>{
 const f=fixture({sourceHintBudgetMs:30,hedgeDelayMs:1,providerTimeoutMs:100});await f.call(f.make());f.clearContent();f.reset();let aborted=0,secondStarted=false;
 f.api.getRecording=async(_,context)=>f.count('id',()=>new Promise((resolve,reject)=>context.signal.addEventListener('abort',()=>{aborted++;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));},{once:true})));
 const other={name:'KugouAPI',searchSong:async()=>{secondStarted=true;assert.equal(f.stats.id,1);return {...song,id:99};},getLyrics:async()=>structuredClone(words)};f.deps.getAvailableAPIsFn=()=>[f.api,other];
 // The catalog/hint cache is independent of provider ordering, while the public
 // content cache is deliberately cleared before this new instance.
 const res=await f.call(f.make());assert.equal(res.statusCode,200);assert.equal(secondStarted,true);assert.equal(aborted,1);assert.equal(f.stats.search,0);assert.ok(f.stats.peak<=2);
});
test('failed hint recovers in the same provider deadline rather than restarting a full lookup budget',async()=>{
 const f=fixture({sourceHintBudgetMs:20,providerTimeoutMs:40});await f.call(f.make());f.clearContent();f.reset();let cancelled=0;
 f.api.getRecording=async(_,context)=>f.count('id',()=>new Promise((resolve,reject)=>context.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true})));
 f.api.searchSong=async(_,__,context)=>f.count('search',()=>new Promise((resolve,reject)=>context.signal.addEventListener('abort',()=>{cancelled++;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));},{once:true})));
 const start=Date.now(),res=await f.call(f.make());assert.equal(res.statusCode,504);assert.equal(f.stats.id,1);assert.equal(f.stats.search,1);assert.equal(cancelled,1);assert.ok(Date.now()-start<150);assert.equal(f.stats.peak,1);
});
test('one original probe overlaps catalog but words wait for verified metadata and reviewed precedence',async()=>{
 const catalog=gate(),review=gate();let sourceComplete=false;const f=fixture({speculativeDiscovery:true,resolveCatalogAliasesFn:async r=>{f.stats.catalog++;await catalog.promise;const aliases=[];Object.defineProperty(aliases,'resolution',{value:proof(r)});return aliases;},lookupReviewedRecordingFn:async()=>{await review.promise;return null;}});
 f.api.searchSong=async()=>{f.stats.search++;sourceComplete=true;return {...song};};const res=streamResponse(),work=f.call(f.make(),{...request,options:{delivery:'progressive-v1'}},res);
 await until(()=>sourceComplete);assert.equal(res.chunks.length,0);catalog.resolve();await tick();assert.equal(res.chunks.length,0);review.resolve();await work;assert.equal(f.stats.search,1);assert.equal(frames(res).at(-1).event,'complete');
});
test('expired speculative discovery cannot obtain a new provider deadline after slow catalog',async()=>{
 const catalog=gate();const f=fixture({speculativeDiscovery:true,providerTimeoutMs:15,resolveCatalogAliasesFn:async r=>{f.stats.catalog++;await catalog.promise;const aliases=[];Object.defineProperty(aliases,'resolution',{value:proof(r)});return aliases;}});
 f.api.searchSong=async()=>{f.stats.search++;return {...song};};const work=f.call(f.make());await until(()=>f.stats.search===1);await wait(25);catalog.resolve();const res=await work;assert.equal(res.statusCode,504);assert.equal(f.stats.search,1);assert.equal(f.stats.lyrics,0);
});
test('policy-equivalent storefront aliases share one owned source and retain each caller proof after first cancellation',async()=>{
 const format=gate();let formatting=false,sourceAborted=false;const f=fixture({getProcessorFn:()=>({romanize:async text=>{formatting=true;await format.promise;return {romanized:text};}})});
 f.api.searchSong=async(_,__,context)=>{f.stats.search++;context.signal.addEventListener('abort',()=>sourceAborted=true);return {...song};};const service=f.make(),a=streamResponse(),b=streamResponse();const one=f.call(service,{...request,options:{delivery:'progressive-v1'}},a);await until(()=>formatting);
 const two=f.call(service,{...request,storefront:'ca',options:{delivery:'progressive-v1'}},b);await until(()=>f.stats.catalog===2);await tick();a.emit('close');assert.equal(sourceAborted,false);format.resolve();await Promise.all([one,two]);assert.equal(f.stats.search,1);assert.equal(frames(b).at(-1).response.metadata.catalog_resolution.requested.storefront,'ca');assert.equal(frames(b).at(-1).response.metadata.recording_match,undefined);
});
test('different catalog policies, normalization entities and localized metadata remain independent owners',async()=>{
 for(const variant of ['catalog','entities','genres','searches','localized']){
  const lyrics=gate();const f=fixture({resolveCatalogAliasesFn:async r=>{f.stats.catalog++;const aliases=[],p=proof(r);if(r.storefront==='ca'){if(variant==='entities')p.artist_entities=[{id:'entity',name:'Artist'}];if(variant==='genres')p.genres=['C-pop'];if(variant==='searches')p.searches=[{...p.searches[0],album:'Alternate Album'}];}Object.defineProperty(aliases,'resolution',{value:p});return aliases;}});
  f.api.getLyrics=async()=>{await lyrics.promise;return structuredClone(words);};const service=f.make(),a=f.call(service),second={...request,storefront:'ca',...(variant==='catalog'?{catalog_id:'124'}:{}),...(variant==='localized'?{title:'Song Song'}:{})};f.api.searchSong=async(_,title)=>{f.stats.search++;return {...song,title};};const b=f.call(service,second);await until(()=>f.stats.search===2);lyrics.resolve();await Promise.all([a,b]);assert.equal(f.stats.search,2,variant);
 }
});
test('cold simultaneous aliases may each probe before proof, but the joined source never repeats either original query',async()=>{
 const firstCatalog=gate(),secondCatalog=gate(),lyrics=gate();const f=fixture({speculativeDiscovery:true,resolveCatalogAliasesFn:async r=>{f.stats.catalog++;await(r.storefront==='us'?firstCatalog:secondCatalog).promise;const aliases=[];Object.defineProperty(aliases,'resolution',{value:proof(r)});return aliases;}});
 f.api.getLyrics=async()=>f.count('lyrics',async()=>{await lyrics.promise;return structuredClone(words);});const service=f.make(),a=f.call(service),b=f.call(service,{...request,storefront:'ca'});await until(()=>f.stats.search===2);firstCatalog.resolve();await until(()=>f.stats.lyrics===1);secondCatalog.resolve();await tick();lyrics.resolve();const result=await Promise.all([a,b]);assert.ok(result.every(r=>r.statusCode===200));assert.equal(f.stats.search,2);assert.ok(f.stats.peak<=2);
});
test('admitted metadata with empty words retains lyrics_absent diagnostic',async()=>{
 const f=fixture();f.api.getLyrics=async()=>({lines:[]});const res=await f.call(f.make());assert.equal(res.statusCode,404);assert.equal(res.body.code,'lyrics_absent');
});
test('Spotify fresh ID recovery revalidates words and retains trusted match evidence for durable admission',async()=>{
 const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'Song',artists:['Artist'],duration_ms:240000}};
 const f=fixture({rejectRecordingLyricsFn:lines=>lines.some(l=>l.text==='错误歌词')});const first=await f.call(f.make(),{recording});assert.equal(first.statusCode,200);f.clearContent();f.reset();f.api.getRecording=async()=>{f.stats.id++;return {song:{...song},lyrics:{lines:[{text:'错误歌词',timestamp:12}]}};};
 const second=await f.call(f.make(),{recording});assert.equal(second.statusCode,200);assert.equal(f.stats.search,1);assert.equal(f.stats.id,1);assert.equal(f.stats.catalog,0);const doc=makeDocument(recording,second.body,LYRIC_SELECTION_REVISION);assert.equal(doc.recordingBinding.documentID,doc.id);assert.equal(doc.requestEvidence.candidate.id,'42');
});
test('catalog alias preceding original cancels the reserved probe before two-source hedge and never repeats it',async()=>{
 let originalAborted=0;const queries=[];const f=fixture({speculativeDiscovery:true,hedgeDelayMs:1,resolveCatalogAliasesFn:async r=>{await tick();const aliases=[],p=proof(r);p.searches=[{...p.searches[0],title:'Alias Song'},p.searches[0]];Object.defineProperty(aliases,'resolution',{value:p});return aliases;}});
 f.api.searchSong=async(_,title,context)=>f.count('search',()=>{queries.push('first:'+title);if(title==='Song')return new Promise((resolve,reject)=>context.signal.addEventListener('abort',()=>{originalAborted++;reject(Object.assign(new Error('cancel'),{name:'AbortError'}));},{once:true}));return null;});
 const second={name:'KugouAPI',searchSong:async(_,title)=>f.count('search',async()=>{queries.push('second:'+title);return title==='Song'?{...song}:null;}),getLyrics:async()=>structuredClone(words)};f.deps.getAvailableAPIsFn=()=>[f.api,second];
 const res=await f.call(f.make());assert.equal(res.statusCode,200);assert.equal(originalAborted,1);assert.equal(queries.filter(v=>v==='first:Song').length,1);assert.ok(f.stats.peak<=2);assert.ok(queries.includes('second:Song'));
});
test('known reviewed catalog IDs perform no generic speculative lookup before reviewed-source selection',async()=>{
 const r={...request,catalog_id:'1887583861'},f=fixture({speculativeDiscovery:true,lookupListeningReviewedRecordingFn:async target=>({song:{...song},lyrics:structuredClone(words),api:{name:'LRCAPI'},target})});
 const res=await f.call(f.make(),r);assert.equal(res.statusCode,200);assert.equal(f.stats.search,0);assert.equal(f.stats.id,0);
});
test('last canonical reader cancellation aborts held source work without a fallback lookup',async()=>{
 const f=fixture();let aborted=0;f.api.getLyrics=async(_,context)=>{f.stats.lyrics++;return new Promise((resolve,reject)=>context.signal.addEventListener('abort',()=>{aborted++;reject(Object.assign(new Error('cancel'),{name:'AbortError'}));},{once:true}));};
 const res=streamResponse(),work=f.call(f.make(),{...request,options:{delivery:'progressive-v1'}},res);await until(()=>f.stats.lyrics===1);res.emit('close');await work;assert.equal(aborted,1);assert.equal(f.stats.search,1);assert.equal(f.stats.lyrics,1);
});
for(const progressive of [false,true])for(const failure of ['timeout','outage','discarded'])test(`later admitted original retains ${failure} classification without repeating its probe (${progressive?'progressive':'legacy'})`,async()=>{
 const queries=[];const f=fixture({speculativeDiscovery:true,providerTimeoutMs:10,resolveCatalogAliasesFn:async r=>{await wait(failure==='timeout'?20:1);const aliases=[],p=proof(r);p.searches=[{...p.searches[0],title:'Alias Song'},p.searches[0]];Object.defineProperty(aliases,'resolution',{value:p});return aliases;}});
 f.api.searchSong=async(_,title,context)=>{queries.push(title);if(title!=='Song')return null;if(failure==='outage')throw new Error('offline');return new Promise((resolve,reject)=>context.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true}));};
 const res=progressive?streamResponse():createMockRes();await f.call(f.make(),{...request,...(progressive?{options:{delivery:'progressive-v1'}}:{})},res);
 assert.equal(queries.filter(q=>q==='Song').length,1);assert.equal(res.statusCode,failure==='timeout'?504:failure==='outage'?502:404);if(progressive)assert.equal(res.chunks.length,0);
});
