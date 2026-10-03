import test from 'node:test';
import assert from 'node:assert/strict';
import {LibraryError} from '../../api/utils/song-library/store.js';
import {digest} from '../../api/utils/song-library/store.js';
import {libraryDB} from '../helpers/library-db.js';
import {createSongLibraryService as createSongLibraryHandler} from '../../api/song-library.js';
import {lyricsFingerprint} from '../../api/utils/rejected-lyrics.js';
import {lyricSourceNeedsRefresh} from '../../api/utils/timing-corrections.js';
import {requestKey} from '../../api/utils/song-library/document.js';
const recording={catalog_id:'123',artist:'Test artist',title:'Original song',duration:15};
const response={song:{id:'source-1',title:{original:'Original song'},artist:{original:'Test artist'},language:'zh',romanization_system:'pinyin'},
  lines:[{original:'一起唱',romanized:'yī qǐ chàng',timestamp:0}],metadata:{source:'test',selection_revision:'test'},quality:{synced:true,partial:false,instrumental:false}};
const fakeGeneration=async()=>({content:{lines:[{sourceID:'L0001',lyricText:'Sing together.',text:'Sing together.',speakerID:null,startsTurn:false}],sourceNotes:[],rejectedNotes:[]},actualMicros:1000,response:{id:'test-response'}});
test('durable verified recording head binds another storefront and rejects unvalidated metadata',async t=>{
 let calls=0;
 const {call}=await setup(t,{loadLyrics:async request=>{
  calls++;if(request.artist!==recording.artist)throw new LibraryError('recording_mismatch');
  const value=structuredClone(response);
  value.metadata.catalog_resolution={version:'catalog-recording-1',method:'same_catalog_id',requested:{catalog_id:'123',storefront:request.storefront},
   canonical_recording_id:'apple:123',canonical_context:{title:recording.title,artist:recording.artist},
   accepted_request:{catalog_id:'123',artist:request.artist,title:request.title,album:request.album??null,duration:request.duration},
   catalog_items:['us','ca'].map(storefront=>({catalog_id:'123',storefront,provenance:'apple_music'}))};
  return value;
 }});
 const first=await call({action:'lyrics',recording:{...recording,storefront:'us'}});
 const canadian=await call({action:'lyrics',recording:{...recording,storefront:'ca'}});
 assert.equal(first.code,200);assert.equal(canadian.code,200);assert.equal(calls,1);
 assert.equal(canadian.body.document.id,first.body.document.id);
 assert.equal(canadian.body.document.recordingKey,digest({catalogID:'123',storefront:'ca'}));
 assert.equal(canadian.body.document.response.metadata.catalog_resolution.requested.storefront,'ca');
 assert.equal((await call({action:'lyrics',recording:{...recording,artist:'Cover Artist',storefront:'ca'}})).code,409);
 assert.equal(calls,2);
});
test('v1 storefront aliases coalesce generation and status returns the requested document metadata',async t=>{
 let release;const barrier=new Promise(resolve=>release=resolve);let calls=0;
 const {call,pending,store}=await setup(t,{generateFn:async()=>{calls++;await barrier;return fakeGeneration();}});
 const a=(await call({action:'lyrics',recording})).body.document;
 const b=(await call({action:'lyrics',recording:{...recording,storefront:'ca'}})).body.document;
 assert.notEqual(a.id,b.id);
 const first=await call({action:'translate',documentID:a.id,sourceHash:a.sourceHash});
 const joined=await call({action:'translate',documentID:b.id,sourceHash:b.sourceHash},'token-b');
 assert.equal(first.code,202);assert.equal(joined.code,202);assert.equal(joined.body.job.documentID,b.id);
 release();await Promise.all(pending);
 const status=await call({action:'status',jobID:joined.body.job.id},'token-b');
 assert.equal(status.body.version,1);assert.equal(status.body.state,'ready');assert.equal(status.body.job.id,joined.body.job.id);
 assert.equal(status.body.translation.documentID,b.id);assert.equal(status.body.translation.sourceHash,b.sourceHash);
 assert.equal((await call({action:'translate',documentID:b.id,sourceHash:b.sourceHash})).body.translation.id,status.body.translation.id);
 assert.equal(calls,1);assert.equal(Number((await store.usage()).jobs),1);
});
async function setup(t,overrides={}) {
  const {db,store}=await libraryDB();t.after(()=>db.close());const pending=[];
  const options={store,selectionRevision:'test',loadLyrics:async()=>response,generateFn:fakeGeneration,
    apiKey:'test',waitUntilFn:task=>pending.push(task),logger:{error(){}},...overrides};
  const handler=createSongLibraryHandler(options);
  const caller=target=>async(body,token='token-a')=> {
    const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await target({method:'POST',lyricaUser:await store.authenticate(token),headers:{authorization:`Bearer ${token}`},body},res);return res;
  };
  return {db,store,handler,call:caller(handler),pending,instance:changes=>caller(createSongLibraryHandler({...options,...changes}))};
}
test('fetch, translate, poll and reuse across users calls each provider only once',async t=> {
  let lyrics=0,generations=0;
  const {call,pending,store}=await setup(t,{loadLyrics:async()=>{lyrics++;return response;},generateFn:async()=>{generations++;return fakeGeneration();}});
  const first=await call({action:'lyrics',recording});assert.equal(first.code,200);
  const doc=first.body.document;
  const started=await call({action:'translate',documentID:doc.id,sourceHash:doc.sourceHash});assert.equal(started.code,202);
  await Promise.all(pending);
  const completed=await call({action:'status',jobID:started.body.job.id});assert.equal(completed.body.state,'ready');
  const reused=await call({action:'lyrics',recording},'token-b');assert.equal(reused.body.document.id,doc.id);
  const translation=await call({action:'translate',documentID:doc.id,sourceHash:doc.sourceHash},'token-b');
  assert.equal(translation.code,200);assert.equal(translation.body.translation.lines[0].text,'Sing together.');
  assert.equal(lyrics,1);assert.equal(generations,1);assert.equal(Number((await store.usage()).accounted_micros),1000);
});
test('invalid credentials cannot fetch lyrics, reserve money or call OpenAI',async t=> {
  let calls=0;const {call,store}=await setup(t,{loadLyrics:async()=>{calls++;return response;}});
  const result=await call({action:'lyrics',recording},'invented-token');assert.equal(result.code,401);
  assert.equal(calls,0);assert.equal(Number((await store.usage()).accounted_micros),0);
});
test('client cannot choose user, source contents, model or target language',async t=> {
  const {call}=await setup(t);
  for(const extra of [{userID:'reader-b'},{lyrics:'untrusted'},{model:'gpt-6-astra'},{target:'fr'}]) {
    assert.equal((await call({action:'lyrics',recording,...extra})).code,400);
  }
});
test('budget refusal performs no provider work and keeps stored lyrics readable',async t=> {
  let calls=0;const {call,store}=await setup(t,{generateFn:async()=>{calls++;return fakeGeneration();}});
  const {body:{document:doc}}=await call({action:'lyrics',recording});
  await store.configure({enabled:true,dailyMicros:1,monthlyMicros:1});
  const result=await call({action:'translate',documentID:doc.id,sourceHash:doc.sourceHash});
  assert.equal(result.code,429);assert.equal(result.body.code,'budget_exhausted');assert.equal(calls,0);
  assert.equal((await call({action:'lyrics',recording})).code,200);
});
test('source hash mismatch is rejected before generation',async t=> {
  let calls=0;const {call}=await setup(t,{generateFn:async()=>{calls++;return fakeGeneration();}});
  const {body:{document:doc}}=await call({action:'lyrics',recording});
  assert.equal((await call({action:'translate',documentID:doc.id,sourceHash:'wrong'})).code,409);assert.equal(calls,0);
});
test('concurrent cold lyric requests coalesce across handler instances',async t=> {
  let release,started;const barrier=new Promise(r=>release=r),entered=new Promise(r=>started=r);let calls=0;
  const {call,instance}=await setup(t,{loadLyrics:async()=>{calls++;started();await barrier;return response;}});
  const first=call({action:'lyrics',recording});await entered;
  const second=await instance({})({action:'lyrics',recording},'token-b');assert.equal(second.code,202);assert.equal(second.body.state,'loading_lyrics');
  release();assert.equal((await first).code,200);assert.equal(calls,1);
});
test('unchanged source can be translated after validation under new selection rules',async t=> {
  const {call,instance,pending}=await setup(t);
  const {body:{document:old}}=await call({action:'lyrics',recording});
  const updated=instance({selectionRevision:'new-policy'});
  assert.equal((await updated({action:'translate',documentID:old.id,sourceHash:old.sourceHash})).body.code,'source_revision_superseded');
  const {body:{document:current}}=await updated({action:'lyrics',recording});
  assert.equal(current.id,old.id);
  assert.equal((await updated({action:'translate',documentID:current.id,sourceHash:current.sourceHash})).code,202);
  await Promise.all(pending);
});
test('malformed job and report identifiers are client errors',async t=> {
  const {call}=await setup(t);
  assert.equal((await call({action:'status',jobID:'a'.repeat(36)})).code,400);
  assert.equal((await call({action:'report',documentID:{},sourceID:'L0001',category:'lyrics',detail:'Check.'})).code,400);
});
test('database failure fails closed without leaking details or starting paid work',async t=> {
  let calls=0;const {call}=await setup(t,{store:{authenticate:async()=>{throw new Error('postgres://secret');}},generateFn:async()=>{calls++;}});
  const result=await call({action:'lyrics',recording});assert.equal(result.code,503);assert.equal(result.body.code,'store_unavailable');
  assert.ok(!JSON.stringify(result.body).includes('secret'));assert.equal(calls,0);
});
test('report submission is linked to exact source and never invokes generation',async t=> {
  let calls=0;const {call}=await setup(t,{generateFn:async()=>{calls++;return fakeGeneration();}});
  const {body:{document:doc}}=await call({action:'lyrics',recording});
  const result=await call({action:'report',documentID:doc.id,sourceID:'L0001',category:'lyrics',detail:'Please check the words.'});
  assert.equal(result.code,200);assert.equal(result.body.report.status,'pending');assert.equal(calls,0);
});

test('current revision check is free on misses, unchanged content, updates, and disabled generation',async t=> {
  let calls=0;
  const {call,store,pending,instance}=await setup(t,{generateFn:async()=>{calls++;return fakeGeneration();}});
  const {body:{document:doc}}=await call({action:'lyrics',recording});
  const check={action:'current',documentID:doc.id,sourceHash:doc.sourceHash};
  assert.equal((await call(check)).body.state,'missing');assert.equal(calls,0);
  await call({action:'translate',documentID:doc.id,sourceHash:doc.sourceHash});await Promise.all(pending);
  const saved=await store.translation(doc.id,'en');
  assert.equal((await call({...check,revisionID:saved.id})).body.state,'unchanged');
  const updated=await store.publishRevision({expectedRevisionID:saved.id,sourceHash:doc.sourceHash,publicationKey:'handler-fixture',
    actor:'test',reason:'Check refresh.',candidate:{translations:{L0001:'Let us sing together.'},sourceNotes:[]}});
  await store.configure({enabled:false,dailyMicros:0,monthlyMicros:0});
  const changed=await instance({apiKey:undefined})({...check,revisionID:saved.id});
  assert.equal(changed.body.state,'ready');assert.equal(changed.body.translation.id,updated.id);
  assert.equal(changed.body.translation.rejectedNotes,undefined);
  assert.equal((await call({...check,sourceHash:'changed'})).body.code,'source_changed');
  assert.equal((await call({...check,revisionID:'invalid'})).code,400);
  assert.equal(calls,1);
});

test('v1 duplicate report receipt stays compatible without resetting its assessment',async t=> {
  const {call,db}=await setup(t);
  const {body:{document:doc}}=await call({action:'lyrics',recording});
  const input={action:'report',documentID:doc.id,sourceID:'L0001',category:'lyrics',detail:'Same report.'};
  const original=await call(input);
  await db.query("UPDATE correction_reports SET status='accepted' WHERE id=$1",[original.body.report.id]);
  assert.deepEqual((await call(input)).body,original.body);
  assert.equal((await db.query('SELECT status FROM correction_reports')).rows[0].status,'accepted');
  for(const action of ['publish','rollback','reserveReview','configureReviews']) assert.equal((await call({action})).code,400);
});

test('pronunciation annotations persist independently, reject stale sources and never reserve translation spend',async t=>{
  const {annotationFor}=await import('../../api/utils/pronunciation-aids.js');
  let generated=0;
  const japanese=structuredClone(response);japanese.song.language='ja';japanese.lines=[{original:'君が好き',romanized:'old placeholder',timestamp:0}];
  const {call,db,instance}=await setup(t,{loadLyrics:async()=>japanese,pronunciationFn:async(...args)=>{generated++;return annotationFor(...args);}});
  const {body:{document:doc}}=await call({action:'lyrics',recording});
  const query={action:'pronunciation',documentID:doc.id,sourceHash:doc.sourceHash,profileID:'ja-hepburn'};
  assert.equal((await call({...query,sourceHash:'wrong'})).body.code,'source_changed');
  assert.equal((await call({...query,profileID:'ko-revised'})).body.code,'unsupported_pronunciation_direction');
  assert.equal((await call({...query,profileID:'ja-mandarin-hints'})).code,422);
  assert.equal(generated,0);
  const first=await call(query);assert.equal(first.code,200);assert.equal(first.body.pronunciation.lines[0].text,'kimi ga suki');
  assert.deepEqual((await call(query,'token-b')).body,first.body);assert.equal(generated,1);
  const kana=await call({...query,profileID:'ja-kana'});assert.equal(kana.body.pronunciation.lines[0].text,'きみがすき');
  assert.notEqual(kana.body.pronunciation.id,first.body.pronunciation.id);
  assert.deepEqual((await call({action:'lyrics',recording})).body.document,doc);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM translation_jobs')).rows[0].n),0);
  assert.equal((await instance({pronunciationProfiles:()=>[]})(query)).code,422);
});

test('stale plain documents upgrade with an immutable revision and fence old generation',async t=>{
  let calls=0;
  const plain={...response,lines:response.lines.map(l=>({...l,timestamp:null})),quality:{...response.quality,synced:false}};
  const {call,db,store}=await setup(t,{loadLyrics:async(_,options)=>{assert.equal(options.refresh,true);return ++calls===1?plain:response;}});
  const old=(await call({action:'lyrics',recording})).body.document;
  await db.query("UPDATE lyric_requests SET checked_at=now()-interval '6 minutes'");
  const current=(await call({action:'lyrics',recording})).body.document;
  assert.notEqual(current.id,old.id);assert.equal(current.response.quality.synced,true);
  assert.equal((await store.document(old.id)).response.quality.synced,false);
  assert.equal((await call({action:'translate',documentID:old.id,sourceHash:old.sourceHash})).body.code,'source_revision_superseded');
  assert.equal(calls,2);
});
test('explicit reload bypasses fresh head and failed refresh preserves the stored source',async t=>{
  let calls=0;
  const {call,instance,store}=await setup(t,{loadLyrics:async()=>{calls++;return response;}});
  const first=(await call({action:'lyrics',recording})).body.document;
  const reload=await call({action:'lyrics',recording,refresh:'true'});
  assert.equal(reload.body.document.id,first.id);assert.equal(calls,2);
  const failed=await instance({loadLyrics:async()=>{throw new LibraryError('provider_timeout',504);}})({action:'lyrics',recording,refresh:true});
  assert.equal(failed.body.code,'provider_timeout');
  assert.equal((await store.documentForRequest(first.requestKey??(await import('../../api/utils/song-library/document.js')).requestKey(recording),'test')).id,first.id);
});

test('credits and provider translation persist outside lyric document source arrays',async t=>{
  const {cleanLyrics}=await import('../../api/utils/lyric-quality.js');
  const normalized=cleanLyrics({source:'fixture',lines:[{text:'键盘：Test musician',timestamp:0},
    {text:'春天来了^Spring arrives',timestamp:2},{text:'一起唱歌^Sing together',timestamp:3},
    {text:'等待明天^Await tomorrow',timestamp:4},{text:'天空很蓝^The sky is blue',timestamp:5}]});
  const fresh={...response,lines:normalized.lines.map(l=>({original:l.text,romanized:'reading',timestamp:l.timestamp})),
    metadata:{...response.metadata,lyric_structure:normalized.lyricStructure},
    song_details:{catalog_id:'123',source_id:'source-1',source:'fixture',credits:normalized.credits},provider_translation:normalized.providerTranslation};
  const {call,db}=await setup(t,{loadLyrics:async()=>fresh});
  const doc=(await call({action:'lyrics',recording})).body.document;
  assert.equal(doc.response.song_details.credits[0].role,'键盘');assert.equal(doc.response.provider_translation.lines.length,4);
  const stored=(await db.query('SELECT response,structure FROM lyric_documents')).rows[0];
  assert.ok(!JSON.stringify(stored).includes('Test musician'));assert.ok(!JSON.stringify(stored).includes('Spring arrives'));
  assert.equal((await db.query('SELECT song_details FROM lyric_document_extras')).rows[0].song_details.credits.length,1);
});

test('fresh cached note placeholders refresh without an explicit reload',async t=>{
 let calls=0;
 const old={...response,lines:[{original:'♪',romanized:'♪',timestamp:0},...response.lines.map(l=>({...l,timestamp:4}))]};
 const {call,store}=await setup(t,{loadLyrics:async()=>++calls===1?old:response});
 const first=(await call({action:'lyrics',recording})).body.document;
 const second=(await call({action:'lyrics',recording})).body.document;
 assert.notEqual(second.id,first.id);assert.equal(calls,2);
 assert.deepEqual(second.response.lines,response.lines);
 assert.equal((await store.document(first.id)).response.lines[0].original,'♪');
});
test('known bad cached timing yields to readable fallback and cannot masquerade as valid on an outage',async t=>{
 const plain={...response,lines:response.lines.map(l=>({...l,timestamp:null})),quality:{...response.quality,synced:false}};
 const {call,instance,store}=await setup(t);
 const first=(await call({action:'lyrics',recording})).body.document;
 const invalid=value=>value.quality.synced;
 const failed=await instance({lyricSourceNeedsRefreshFn:invalid,loadLyrics:async()=>{throw new LibraryError('provider_timeout',504);}})({action:'lyrics',recording});
 assert.equal(failed.code,504);assert.equal((await store.document(first.id)).response.quality.synced,true);
 const fallback=await instance({lyricSourceNeedsRefreshFn:invalid,loadLyrics:async()=>plain})({action:'lyrics',recording});
 assert.equal(fallback.code,200);assert.equal(fallback.body.document.response.quality.synced,false);
 assert.deepEqual(fallback.body.document.response.lines,plain.lines);
 assert.notEqual(fallback.body.document.id,first.id);
});
test('wrong-version cached words refresh immediately and never survive as an outage fallback',async t=>{
 const reviews=[{catalogIDs:[recording.catalog_id],lyricsSha256:lyricsFingerprint(response.lines.map(l=>({text:l.original})))}];
 const needsRefresh=(value,request)=>lyricSourceNeedsRefresh(value,request,{recordingRejections:reviews});
 const {call,instance,store}=await setup(t,{lyricSourceNeedsRefreshFn:()=>false});
 const old=(await call({action:'lyrics',recording})).body.document;
 const failed=await instance({lyricSourceNeedsRefreshFn:needsRefresh,loadLyrics:async()=>{throw new LibraryError('provider_timeout',504);}})({action:'lyrics',recording});
 assert.equal(failed.code,504);
 const corrected={...response,lines:[{original:'更正的测试文字',romanized:'corrected fixture',timestamp:null}],quality:{...response.quality,synced:false}};
 const current=await instance({lyricSourceNeedsRefreshFn:needsRefresh,loadLyrics:async()=>corrected})({action:'lyrics',recording});
 assert.equal(current.code,200);assert.notEqual(current.body.document.id,old.id);
 assert.deepEqual(current.body.document.response.lines,corrected.lines);
 assert.equal((await store.documentForRequest(requestKey(recording),'test')).id,current.body.document.id);
 // Immutable historical evidence survives; it is no longer the served head.
 assert.deepEqual((await store.document(old.id)).response.lines,response.lines);
});
