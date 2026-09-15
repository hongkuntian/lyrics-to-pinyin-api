import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB,source} from '../helpers/library-db.js';
import {createSongLibraryHandler} from '../../api/song-library.js';
const content={meaning:'turn into through singing',context:'The day becomes a song.',grammar:'成 marks a result.',uncertainty:'',sourceQuote:'唱成'};
async function fixture(t,overrides={}) {
 const {db,store}=await libraryDB();t.after(()=>db.close());const pending=[];let calls=0;
 const handler=createSongLibraryHandler({store,selectionRevision:'test',apiKey:'test',loadLyrics:async()=>source.response,
 generateFn:async()=>({content:{lines:[{sourceID:'L0001',text:'Turn today into a song.',lyricText:'Turn today into a song.',speakerID:null,startsTurn:false}],sourceNotes:[]},actualMicros:1000,response:{id:'translation'}}),
 explainFn:async()=>{calls++;return {content,actualMicros:2000,response:{id:'explanation'}};},waitUntilFn:p=>pending.push(p),logger:{error(){}},...overrides});
 const call=async(body,token='token-a')=>{const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handler({method:'POST',headers:{authorization:`Bearer ${token}`},body},res);return res;};
 const doc=(await call({action:'lyrics',recording:{catalog_id:'123',artist:'Test artist',title:'Original test song',duration:12}})).body.document;
 await call({action:'translate',documentID:doc.id,sourceHash:doc.sourceHash});await Promise.all(pending);
 const translation=(await call({action:'translate',documentID:doc.id,sourceHash:doc.sourceHash})).body.translation;
 const request={action:'explain',documentID:doc.id,sourceHash:doc.sourceHash,translationID:translation.id,sourceID:'L0001',lower:'3',upper:'5'};
 return {db,store,call,request,pending,calls:()=>calls};
}
test('explanations coalesce, settle once and are reused by another reader',async t=>{
 const f=await fixture(t);
 const first=await f.call(f.request);assert.equal(first.code,202);
 await Promise.all(f.pending);
 const cached=await f.call(f.request,'token-b');assert.equal(cached.code,200);assert.equal(cached.body.explanation.meaning,content.meaning);
 assert.equal(cached.body.explanation.translationID,f.request.translationID);assert.equal(f.calls(),1);
 assert.equal(Number((await f.store.budget()).daily),3000);assert.equal(Number((await f.store.budget()).review_daily),0);
});
test('authorization, stale revisions and invalid selections issue no explanation request',async t=>{
 const f=await fixture(t);
 assert.equal((await f.call(f.request,'bad-token')).code,401);
 for(const patch of [{sourceHash:'old'},{translationID:'old'},{sourceID:'L9999'},{lower:'-1'},{upper:'500'}]) assert.notEqual((await f.call({...f.request,...patch})).code,200);
 assert.equal(f.calls(),0);
});
test('global and combined per-user budgets apply before explanation generation',async t=>{
 const f=await fixture(t);
 await f.store.configure({enabled:true,dailyMicros:1_000_000,monthlyMicros:5_000_000,userDaily:1,userMonthly:1});
 assert.equal((await f.call(f.request)).body.code,'generation_allowance_exhausted');
 await f.store.configure({enabled:true,dailyMicros:1,monthlyMicros:1});
 assert.equal((await f.call(f.request)).body.code,'budget_exhausted');assert.equal(f.calls(),0);
});
test('uncertain provider failure holds money and does not dispatch again',async t=>{
 let calls=0;const f=await fixture(t,{explainFn:async()=>{calls++;throw new Error('network');}});
 await f.call(f.request);await Promise.all(f.pending);
 const held=Number((await f.store.budget()).held);assert.ok(held>0);
 assert.equal((await f.call(f.request)).code,409);assert.equal(calls,1);assert.equal(Number((await f.store.budget()).held),held);
});
