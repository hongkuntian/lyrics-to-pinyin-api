import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService as createMusicRomanizeHandler} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
const song={id:1,title:'晴天',artist:'周杰伦',album:'叶惠美',duration:269};
const body={artist:song.artist,title:song.title,album:song.album,duration:269,language:'zh'};
const lyrics={lines:[{text:'你好',timestamp:0}]};
const api=(overrides={})=>({name:'Primary',searchSong:async()=>song,getLyrics:async()=>lyrics,...overrides});
const make=(apis,deps={})=>createMusicRomanizeHandler({lookupOfficialTranscriptionFn:async()=>null,lookupReviewedRecordingFn:async()=>null,resolveCatalogAliasesFn:async()=>[],redis:null,getAvailableAPIsFn:()=>apis,getProcessorFn:()=>({romanize:async t=>({romanized:t})}),logger:{info(){},error(){}},...deps});
async function invoke(handler,fields={}){const res=createMockRes();await handler(createMockReq({body:{...body,...fields}}),res);return res;}
test('repeat and simultaneous requests reuse verified results without provider work',async()=>{
 let calls=0,release;
 const handler=make([api({searchSong:async()=>{calls++;await new Promise(r=>release=r);return song;}})]);
 const a=invoke(handler),b=invoke(handler);
 while(!release) await new Promise(r=>setImmediate(r));
 release();
 const [first,joined]=await Promise.all([a,b]);
 const cached=await invoke(handler);
 assert.equal(calls,1);assert.equal(first.statusCode,200);assert.equal(joined.headers['X-Lyrics-Cache'],'COALESCED');
 assert.equal(cached.headers['X-Lyrics-Cache'],'MEMORY');
 assert.match(cached.headers['Server-Timing'],/total;dur=/);
 assert.notEqual(first.headers['X-Request-ID'],cached.headers['X-Request-ID']);
});
test('explicit refresh replaces the ordinary cache without creating a separate response identity',async()=>{
 let calls=0;
 const handler=make([api({searchSong:async()=>{calls++;return song;}})]);
 await invoke(handler,{options:{tone_style:'marks'}});
 await invoke(handler,{options:{tone_style:'marks',refresh:true}});
 const revisit=await invoke(handler,{options:{refresh:false,tone_style:'marks'}});
 assert.equal(calls,2);assert.equal(revisit.headers['X-Lyrics-Cache'],'MEMORY');
});
test('explicit refresh does not join an older ordinary lookup',async()=>{
 let calls=0;const releases=[];
 const handler=make([api({searchSong:async()=>{calls++;await new Promise(r=>releases.push(r));return song;}})]);
 const ordinary=invoke(handler),refresh=invoke(handler,{options:{refresh:true}});
 while(releases.length<2)await new Promise(r=>setImmediate(r));
 releases.forEach(r=>r());
 const results=await Promise.all([ordinary,refresh]);
 assert.equal(calls,2);assert.ok(results.every(r=>r.statusCode===200));
});
test('an older lookup finishing last cannot overwrite a completed refresh',async()=>{
 let calls=0;const releases=[];
 const handler=make([api({searchSong:async()=>{const id=++calls;await new Promise(r=>releases.push(r));return {...song,id};}})]);
 const ordinary=invoke(handler);
 while(releases.length<1)await new Promise(r=>setImmediate(r));
 const refresh=invoke(handler,{options:{refresh:true}});
 while(releases.length<2)await new Promise(r=>setImmediate(r));
 releases[1]();const fresh=await refresh;
 releases[0]();const old=await ordinary;
 assert.equal(old.body.song.id,1);assert.equal(fresh.body.song.id,2);
 assert.equal((await invoke(handler)).body.song.id,2);
});
test('canonical coalescing rechecks recording-specific source rejection for each reader',async()=>{
 let release;const titles=[];
 const handler=make([api({searchSong:async(artist,title,{album,duration})=>{
   titles.push(title);if(title==='Idol')await new Promise(r=>release=r);
   return {id:title==='Idol'?1:2,artist,title,album,duration};
 },getLyrics:async id=>({lines:[{text:id===1?'English words for the English recording':'学校へ行こう',timestamp:0}]})})],{
   resolveCatalogAliasesFn:async request=>{
     const aliases=[];aliases.resolution={canonical_recording_id:'shared-catalog-evidence',searches:[request]};return aliases;
   }
 });
 const fields={artist:'YOASOBI',duration:213.234,language:'ja'};
 const english=invoke(handler,{...fields,title:'Idol',album:'Idol - Single',catalog_id:'1688334537'});
 while(!release)await new Promise(r=>setImmediate(r));
 const japanese=invoke(handler,{...fields,title:'アイドル',album:'アイドル - Single',catalog_id:'1679278167'});
 await new Promise(r=>setImmediate(r));release();
 const [first,second]=await Promise.all([english,japanese]);
 assert.equal(first.statusCode,200);assert.equal(second.statusCode,200);
 assert.equal(second.body.lines[0].original,'学校へ行こう');assert.deepEqual(titles,['Idol','アイドル']);
});
test('a stalled primary is aborted when hedged verified timed backup wins',async()=>{
 let aborted=false;
 const primary=api({searchSong:(_,__,{signal})=>new Promise(()=>signal.addEventListener('abort',()=>{aborted=true;}))});
 const handler=make([primary,api({name:'Backup'})],{hedgeDelayMs:5,providerTimeoutMs:2000});
 const res=await invoke(handler);
 assert.equal(res.body.metadata.source,'Backup');assert.equal(aborted,true);
});
test('fast mismatched backups cannot beat verified primary, timed lyrics beat untimed',async()=>{
 const slow=api({searchSong:async()=>{await new Promise(r=>setTimeout(r,15));return song;}});
 const bad=api({name:'Cover',searchSong:async()=>({...song,artist:'Cover'})});
 assert.equal((await invoke(make([slow,bad],{hedgeDelayMs:1}))).body.metadata.source,'Primary');
 const untimed=api({getLyrics:async()=>({lines:[{text:'你好',timestamp:null}]})});
 assert.equal((await invoke(make([untimed,api({name:'Timed'})],{hedgeDelayMs:1}))).body.metadata.source,'Timed');
});
test('explicit source gets first chance and metadata changes cannot reuse cache',async()=>{
 let backupCalls=0;
 const primary=api();const backup=api({name:'Backup',searchSong:async()=>{backupCalls++;return song;}});
 const handler=make([primary,backup],{getMusicAPIFn:()=>primary,hedgeDelayMs:0});
 assert.equal((await invoke(handler,{music_platform:'primary'})).body.metadata.source,'Primary');assert.equal(backupCalls,0);
 await invoke(handler);
 assert.equal((await invoke(handler,{duration:350})).statusCode,409);
});
test('cache writes do not delay response and a hanging cache is suspended',async()=>{
 const work=[];let reads=0,writes=0;
 const redis={get:()=>{reads++;return new Promise(()=>{});},setex:async()=>{writes++;}};
 const handler=make([api()],{redis,cacheTimeoutMs:5,waitUntilFn:p=>work.push(p)});
 assert.equal((await invoke(handler)).statusCode,200);
 await Promise.all(work);
 assert.equal(reads,1);assert.equal(writes,0);
 const pending=[];
 const second=make([api()],{redis:{},getCachedFn:async()=>null,setCachedFn:()=>new Promise(()=>{}),cacheTimeoutMs:5,waitUntilFn:p=>pending.push(p)});
 assert.equal((await invoke(second)).statusCode,200);assert.equal(pending.length,1);
 await Promise.all(pending);
});
test('slow verified timing gets a bounded chance after fast plain lyrics',async()=>{
 const timed=api({getLyrics:async()=>{await new Promise(r=>setTimeout(r,600));return lyrics;}});
 const plain=api({name:'Plain',getLyrics:async()=>({lines:[{text:'你好',timestamp:null}]})});
 const res=await invoke(make([timed,plain],{hedgeDelayMs:1}));
 assert.equal(res.body.metadata.source,'Primary');
 assert.equal(res.body.lines[0].timestamp,0);
});
test('plain lyrics survive the timing grace deadline and cancel remaining work',async()=>{
 let aborted=false;
 const stalled=api({getLyrics:(_, {signal})=>new Promise(()=>signal.addEventListener('abort',()=>{aborted=true;}))});
 const plain=api({name:'Plain',getLyrics:async()=>({lines:[{text:'你好',timestamp:null}]})});
 const res=await invoke(make([stalled,plain],{hedgeDelayMs:1,untimedGraceMs:5,providerTimeoutMs:2000}));
 assert.equal(res.body.metadata.source,'Plain');
 assert.equal(res.body.quality.synced,false);
 assert.equal(aborted,true);
});
