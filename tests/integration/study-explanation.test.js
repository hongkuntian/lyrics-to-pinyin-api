import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB,source} from '../helpers/library-db.js';
import {createSongLibraryService as createSongLibraryHandler} from '../../api/song-library.js';
const content={meaning:'turn into through singing',context:'The day becomes a song.',grammar:'成 marks a result.',uncertainty:'',sourceQuote:'唱成'};
async function fixture(t,overrides={}) {
 const {db,store}=await libraryDB();t.after(()=>db.close());const pending=[];let calls=0;
 const handler=createSongLibraryHandler({store,selectionRevision:'test',apiKey:'test',loadLyrics:async()=>source.response,
 generateFn:async()=>({content:{lines:[{sourceID:'L0001',text:'Turn today into a song.',lyricText:'Turn today into a song.',speakerID:null,startsTurn:false}],sourceNotes:[]},actualMicros:1000,response:{id:'translation'}}),
 explainFn:async()=>{calls++;return {content,actualMicros:2000,response:{id:'explanation'}};},waitUntilFn:p=>pending.push(p),logger:{error(){}},...overrides});
 const call=async(body,token='token-a')=>{const res={code:200,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};await handler({method:'POST',lyricaUser:await store.authenticate(token),headers:{authorization:`Bearer ${token}`},body},res);return res;};
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
test('read-only explanation lookup never admits provider work and reuses completed content',async t=>{
 const f=await fixture(t);
 const before=Number((await f.store.budget()).daily);
 const missing=await f.call({...f.request,readOnly:true});
 assert.equal(missing.code,200);assert.equal(missing.body.state,'missing');assert.equal(f.calls(),0);
 assert.equal(Number((await f.store.budget()).daily),before);
 await f.call(f.request);await Promise.all(f.pending);
 assert.equal((await f.call({...f.request,readOnly:true},'token-b')).body.explanation.meaning,content.meaning);
 assert.equal(f.calls(),1);
});
test('resume-only lookup cannot reserve work, and read-only lookup distinguishes a pending explanation',async t=>{
 const f=await fixture(t);
 const before=Number((await f.store.budget()).daily);
 assert.equal((await f.call({...f.request,resumeOnly:true})).body.state,'missing');
 assert.equal(f.calls(),0);assert.equal(Number((await f.store.budget()).daily),before);
 // A paused worker has been admitted but not dispatched.
 await f.db.query('UPDATE library_settings SET enabled=false');
 const {reserveExplanation}=await import('../../api/utils/song-library/study-store.js');
 const {selectionFor,explanationKey,explanationRecipe}=await import('../../api/utils/song-library/study-explanation.js');
 const doc=await f.store.document(f.request.documentID),translation=await f.store.translation(doc.id,'en');
 const selection=selectionFor(doc,f.request),key=explanationKey(doc,translation,selection,'en');
 await f.db.query('UPDATE library_settings SET enabled=true');
 await reserveExplanation(f.store.db,{key,doc,translation,selection,recipe:explanationRecipe(selection,'en'),userID:'reader-a',amount:100000});
 const read=await f.call({...f.request,readOnly:true});
 assert.equal(read.body.state,'preparing');assert.equal(read.body.phase,'queued');assert.equal(f.calls(),0);
 await Promise.all([f.call({...f.request,resumeOnly:true}),f.call({...f.request,resumeOnly:true})]);
 await Promise.all(f.pending);assert.equal(f.calls(),1);
 assert.equal((await f.call({...f.request,resumeOnly:true})).body.state,'ready');
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM study_explanations')).rows[0].n),1);
});
test('interrupted Study stops waiting, restores membership allowance and never regenerates the same passage',async t=>{
 let release;const barrier=new Promise(resolve=>release=resolve);
 const f=await fixture(t,{explainFn:async()=>{await barrier;return {content,actualMicros:2000,response:{id:'late'}};}});
 await f.db.query("UPDATE library_users SET access_kind='apple' WHERE id='reader-a'");
 const {MembershipStore}=await import('../../api/utils/membership/store.js');
 const membership=new MembershipStore(f.store.db);await membership.claimStarter('reader-a');
 await f.call({...f.request,allowGeneration:true});
 // Wait for the actual atomic claim, then simulate the expired server execution window.
 for(let i=0;i<20;i++) {
  if((await f.db.query('SELECT state FROM study_explanations')).rows[0]?.state==='running')break;
  await new Promise(resolve=>setImmediate(resolve));
 }
 await f.db.query("UPDATE library_spend_operations SET submitted_at=now()-interval '7 minutes' WHERE kind='study_explanation'");
 assert.equal((await membership.snapshot('reader-a')).allowances.study.remaining,9);
 const result=await f.call({...f.request,readOnly:true});
 assert.equal(result.body.state,'unknown');assert.equal(result.body.code,'worker_interrupted');
 assert.equal((await membership.snapshot('reader-a')).allowances.study.remaining,10);
 assert.equal((await f.call({...f.request,resumeOnly:true})).body.state,'unknown');
 assert.ok(Number((await f.store.budget()).held)>0);
 release();await Promise.all(f.pending);
 assert.equal((await f.call({...f.request,readOnly:true})).body.state,'unknown');
 assert.equal((await membership.snapshot('reader-a')).allowances.study.remaining,10);
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
