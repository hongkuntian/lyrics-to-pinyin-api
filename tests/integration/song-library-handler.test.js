import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB} from '../helpers/library-db.js';
import {createSongLibraryHandler} from '../../api/song-library.js';
const recording={catalog_id:'123',artist:'Test artist',title:'Original song',duration:15};
const response={song:{id:'source-1',title:{original:'Original song'},artist:{original:'Test artist'},language:'zh',romanization_system:'pinyin'},
  lines:[{original:'一起唱',romanized:'yī qǐ chàng',timestamp:0}],metadata:{source:'test',selection_revision:'test'},quality:{synced:true,partial:false,instrumental:false}};
const fakeGeneration=async()=>({content:{lines:[{sourceID:'L0001',lyricText:'Sing together.',text:'Sing together.',speakerID:null,startsTurn:false}],sourceNotes:[],rejectedNotes:[]},actualMicros:1000,response:{id:'test-response'}});
async function setup(t,overrides={}) {
  const {db,store}=await libraryDB();t.after(()=>db.close());const pending=[];
  const options={store,selectionRevision:'test',loadLyrics:async()=>response,generateFn:fakeGeneration,
    apiKey:'test',waitUntilFn:task=>pending.push(task),logger:{error(){}},...overrides};
  const handler=createSongLibraryHandler(options);
  const caller=target=>async(body,token='token-a')=> {
    const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await target({method:'POST',headers:{authorization:`Bearer ${token}`},body},res);return res;
  };
  return {store,handler,call:caller(handler),pending,instance:changes=>caller(createSongLibraryHandler({...options,...changes}))};
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
