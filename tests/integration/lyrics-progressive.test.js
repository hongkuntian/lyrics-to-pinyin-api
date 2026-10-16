import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {createSongLibraryService,lyricLoader} from '../../api/song-library.js';
import {libraryDB} from '../helpers/library-db.js';
import {LibraryError} from '../../api/utils/song-library/store.js';
import {streamResponse,frames} from '../helpers/stream-http.js';
import {createMockRes} from '../helpers/mock-http.js';
const song={id:'source-1',title:'Original song',artist:'Test artist',duration:240};
const recording={catalog_id:'123',artist:song.artist,title:song.title,duration:240};
const spotify={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:song.title,artists:[song.artist],duration_ms:240000}};
const text=[{text:'一起唱',timestamp:12},{text:'向前走',timestamp:30}];
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:(...args)=>resolve(...args)};};
const until=async predicate=>{const end=Date.now()+2000;while(!predicate()){assert.ok(Date.now()<end,'expected progressive event');await new Promise(r=>setImmediate(r));}};
function service({partial=false,instrumental=false}={}) {
 let calls=0,aborted=0;const gate=deferred();
 const apis=[{name:'LRCAPI',searchSong:async(_,__,{signal})=>{calls++;signal.addEventListener('abort',()=>aborted++);return song;},getLyrics:async()=>{await gate.promise;return {lines:text};}},
  {name:'KugouAPI',searchSong:async()=>{calls++;return song;},getLyrics:async()=>({lines:instrumental?[]:text.map(l=>({...l,timestamp:null})),partial,instrumental})}];
 const handler=createMusicRomanizeService({redis:null,logger:{info(){},error(){}},hedgeDelayMs:1,untimedGraceMs:500,resolveCatalogAliasesFn:async()=>[],lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,getAvailableAPIsFn:()=>apis,detectLanguageFn:async()=> 'zh',getProcessorFn:()=>({romanize:async t=>({romanized:t})})});
 return {handler,gate,get calls(){return calls;},get aborted(){return aborted;}};
}
test('Apple and Spotify expose plain first and retain the same acquisition through verified timing',async()=>{
 for(const provider of ['apple','spotify']) {
  const fixture=service(),res=streamResponse();
  const body=provider==='spotify'?{recording:spotify,options:{delivery:'progressive-v1'}}:{...recording,options:{delivery:'progressive-v1'}};
  const work=fixture.handler({method:'POST',body},res);await until(()=>res.chunks.length);
  assert.equal(frames(res)[0].response.quality.synced,false);assert.equal(res.ended,undefined);
  if(provider==='spotify')assert.equal(frames(res)[0].response.recordingBinding.documentID,null);
  fixture.gate.resolve();await work;
  const all=frames(res);assert.equal(all.at(-1).event,'complete');assert.equal(all.at(-1).response.quality.synced,true);
  assert.equal(new Set(all.map(f=>f.acquisitionID)).size,1);assert.equal(new Set(all.map(f=>f.deadlineAtMS)).size,1);
  assert.equal(fixture.calls,2);assert.equal(res.headers['Content-Type'],'application/x-ndjson');
  const cached=createMockRes();const legacyBody=structuredClone(body);delete legacyBody.options.delivery;
  await fixture.handler({method:'POST',body:legacyBody},cached);assert.equal(cached.body.quality.synced,true);assert.equal(fixture.calls,2);
 }
});
test('a joining progressive subscriber replays text and one disconnect cannot cancel the other',async()=>{
 const fixture=service(),body={...recording,options:{delivery:'progressive-v1'}},a=streamResponse(),b=streamResponse();
 const first=fixture.handler({method:'POST',body},a);await until(()=>a.chunks.length);
 const second=fixture.handler({method:'POST',body},b);await until(()=>b.chunks.length);a.emit('close');
 assert.equal(fixture.aborted,0);fixture.gate.resolve();await Promise.all([first,second]);assert.equal(frames(b).at(-1).event,'complete');assert.equal(fixture.calls,2);
});
test('library streams raw text without provisional persistence, then one durable document',async t=>{
 const {db,store}=await libraryDB();t.after(()=>db.close());const fixture=service();
 const handler=createSongLibraryService({store,selectionRevision:SELECTION_REVISION,loadLyrics:lyricLoader(fixture.handler)});
 const res=streamResponse(),work=handler({method:'POST',lyricaUser:{id:'reader-a'},body:{action:'lyrics',recording,delivery:'progressive-v1'}},res);
 await until(()=>res.chunks.length);assert.equal(frames(res)[0].response.library,undefined);
 assert.equal(Number((await db.query('SELECT count(*) FROM lyric_documents')).rows[0].count),0);
 fixture.gate.resolve();await work;assert.ok(frames(res).at(-1).document.id);
 assert.equal(Number((await db.query('SELECT count(*) FROM lyric_documents')).rows[0].count),1);
 assert.equal(Number((await store.usage()).jobs),0);
});
test('partial and instrumental readable sources never gain provisional library admission',async t=>{
 const {db,store}=await libraryDB();t.after(()=>db.close());
 for(const instrumental of [false,true]) {
  const raw={song:{id:'source',title:{original:song.title},artist:{original:song.artist},language:'zh',duration:240},lines:instrumental?[]:[{original:'一起唱',romanized:'一起唱',timestamp:null}],metadata:{selection_revision:SELECTION_REVISION},quality:{synced:false,partial:!instrumental,instrumental}};
  const handler=createSongLibraryService({store,selectionRevision:SELECTION_REVISION,loadLyrics:async(_,options)=>{options.delivery.publish(raw);return raw;}});
  const res=streamResponse();await handler({method:'POST',lyricaUser:{id:'reader-a'},body:{action:'lyrics',recording,delivery:'progressive-v1'}},res);
  assert.deepEqual(frames(res).map(f=>f.event),['readable','refresh_failed']);assert.equal(frames(res).at(-1).code,'source_incomplete');
 }
 assert.equal(Number((await db.query('SELECT count(*) FROM lyric_documents')).rows[0].count),0);assert.equal(Number((await store.usage()).jobs),0);
});
test('invalid delivery and unauthenticated library callers do not attach to valid streams',async t=>{
 const fixture=service(),res=streamResponse();await fixture.handler({method:'POST',body:{...recording,options:{delivery:'other'}}},res);assert.equal(res.statusCode,400);assert.equal(fixture.calls,0);
 const {db,store}=await libraryDB();t.after(()=>db.close());const handler=createSongLibraryService({store});
 const denied=streamResponse();await handler({method:'POST',body:{action:'lyrics',recording,delivery:'progressive-v1'}},denied);assert.equal(denied.statusCode,401);assert.equal(denied.chunks.length,0);
});
test('raw and library internal owners cannot join and cancel an acquisition they do not own',async()=>{
 const fixture=service(),raw=streamResponse(),body={...recording,options:{delivery:'progressive-v1'}};
 const first=fixture.handler({method:'POST',body},raw);await until(()=>raw.chunks.length);
 const controller=new AbortController(),snapshots=[],complete=createMockRes();
 const second=fixture.handler({method:'POST',body:recording,lyricDelivery:{acquisitionID:'library-owner',deadlineAtMS:Date.now()+16000,signal:controller.signal,publish:response=>snapshots.push(response)}},complete);
 await until(()=>snapshots.length);assert.equal(fixture.calls,4);raw.emit('close');fixture.gate.resolve();await Promise.all([first,second]);
 assert.equal(controller.signal.aborted,false);assert.equal(complete.body.quality.synced,true);
});
test('verified canonical aliases with different request owners cannot cross-cancel',async()=>{
 const gate=deferred();let calls=0;
 const api={name:'LRCAPI',searchSong:async()=>{calls++;return song;},getLyrics:async()=>{await gate.promise;return {lines:text};}};
 const handler=createMusicRomanizeService({redis:null,logger:{info(){},error(){}},getAvailableAPIsFn:()=>[api],detectLanguageFn:async()=> 'zh',getProcessorFn:()=>({romanize:async t=>({romanized:t})}),lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,resolveCatalogAliasesFn:async request=>{const aliases=[];aliases.resolution={canonical_recording_id:'apple:123',searches:[request]};return aliases;}});
 const a=streamResponse(),b=streamResponse();const first=handler({method:'POST',body:{...recording,storefront:'us',options:{delivery:'progressive-v1'}}},a);
 await until(()=>calls===1);const second=handler({method:'POST',body:{...recording,storefront:'ca',options:{delivery:'progressive-v1'}}},b);await until(()=>calls===2);
 a.emit('close');gate.resolve();await Promise.all([first,second]);assert.equal(frames(b).at(-1).response.quality.synced,true);
});
test('admissible stale library text is readable before a failed refresh without clearing stored content',async t=>{
 const {db,store}=await libraryDB();t.after(()=>db.close());let calls=0;
 const raw={song:{id:'source',title:{original:song.title},artist:{original:song.artist},language:'zh',duration:240},lines:[{original:'一起唱',romanized:'一起唱',timestamp:12},{original:'向前走',romanized:'向前走',timestamp:30}],metadata:{selection_revision:SELECTION_REVISION},quality:{synced:true,partial:false,instrumental:false}};
 const handler=createSongLibraryService({store,selectionRevision:SELECTION_REVISION,loadLyrics:async()=>{if(calls++)throw new LibraryError('provider_timeout',504);return raw;}});
 const request={method:'POST',lyricaUser:{id:'reader-a'},body:{action:'lyrics',recording}};
 const first=createMockRes();await handler(request,first);await db.query("UPDATE lyric_requests SET checked_at=now()-interval '2 days'");
 const res=streamResponse();await handler({...request,body:{...request.body,delivery:'progressive-v1'}},res);
 assert.deepEqual(frames(res).map(f=>f.event),['readable','refresh_failed']);assert.equal(frames(res).at(-1).code,'provider_timeout');assert.equal(frames(res)[0].response.library,undefined);
 assert.equal(Number((await db.query('SELECT count(*) FROM lyric_documents')).rows[0].count),1);assert.equal(Number((await store.usage()).jobs),0);
});
