import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {libraryDB,source} from '../helpers/library-db.js';
import {reserveExplanation,claimExplanation,finishExplanation} from '../../api/utils/song-library/study-store.js';

const reservation={userID:'reader-a',documentID:source.id,target:'en',recipe:'access-test',reservedMicros:30_000};
async function fixture(t) {
  const f=await libraryDB();t.after(()=>f.db.close());await f.store.saveDocument(source);return f;
}
async function settle(store,job) {
  await store.claim(job.id);await store.complete(job.id,{lines:[],sourceNotes:[]},1000,{});
}

test('personal unlimited access bypasses zero daily/monthly quotas and budgets, with full accounting',async t=> {
  const {store,db}=await fixture(t);
  await store.configureUserAccess('reader-a',{unlimitedGeneration:true});
  await store.configure({enabled:true,dailyMicros:0,monthlyMicros:0,userDaily:0,userMonthly:0});
  const result=await store.reserve(reservation);assert.equal(result.kind,'created');
  assert.equal(Number((await store.budget()).held),30_000);
  await settle(store,result.job);
  assert.equal(Number((await store.budget()).daily),1000);
  assert.equal(Number((await store.usage()).accounted_micros),1000);
  assert.ok((await db.query('SELECT * FROM library_spend_events')).rows.length>=3);
  await store.saveDocument({...source,id:'doc-two',requestKey:'request-two',response:{...source.response,song:{...source.response.song,title:{original:'A different song'}}}});
  assert.equal((await store.reserve({...reservation,documentID:'doc-two'})).kind,'created');
  // A reader joins already-admitted shared work instead of paying again.
  assert.equal((await store.reserve({...reservation,documentID:'doc-two',userID:'reader-b'})).kind,'pending');
});

test('unlimited access is personal and revoking it restores existing allowances',async t=> {
  const {store}=await fixture(t);
  await store.configureUserAccess('reader-a',{unlimitedGeneration:true});
  await store.configure({enabled:true,dailyMicros:0,monthlyMicros:0,userDaily:0,userMonthly:0});
  await assert.rejects(store.reserve({...reservation,userID:'reader-b'}),{code:'generation_allowance_exhausted'});
  await store.configure({enabled:true,dailyMicros:0,monthlyMicros:0});
  await assert.rejects(store.reserve({...reservation,userID:'reader-b'}),{code:'budget_exhausted'});
  await store.configureUserAccess('reader-a',{unlimitedGeneration:false});
  await assert.rejects(store.reserve(reservation),{code:'budget_exhausted'});
});

test('non-expiring codes retain personal access through rotation, with older codes revoked',async t=> {
  const {store,db}=await fixture(t);
  await store.configureUserAccess('reader-a',{unlimitedGeneration:true});
  await db.query("UPDATE library_tokens SET created_at=now()-interval '100 years' WHERE user_id='reader-a'");
  assert.equal((await store.authenticate('token-a')).id,'reader-a');
  await store.createUser('reader-a','new-personal-code');
  assert.equal(await store.authenticate('token-a'),null);
  assert.equal((await store.authenticate('new-personal-code')).id,'reader-a');
  await store.configure({enabled:true,dailyMicros:0,monthlyMicros:0,userDaily:0,userMonthly:0});
  assert.equal((await store.reserve(reservation)).kind,'created');
});

test('unlimited access preserves disable switches, authorization and in-flight protection',async t=> {
  const {store,db}=await fixture(t);
  await store.configureUserAccess('reader-a',{unlimitedGeneration:true});
  await store.configure({enabled:false,dailyMicros:0,monthlyMicros:0});
  await assert.rejects(store.reserve(reservation),{code:'generation_disabled'});
  await store.configure({enabled:true,dailyMicros:0,monthlyMicros:0});
  await db.query("UPDATE library_users SET disabled=true WHERE id='reader-a'");
  assert.equal(await store.authenticate('token-a'),null);
  await assert.rejects(store.reserve(reservation),{code:'unauthorized'});
  await db.query("UPDATE library_users SET disabled=false WHERE id='reader-a'");
  await store.reserve(reservation);
  await store.saveDocument({...source,id:'doc-two',requestKey:'request-two',response:{...source.response,song:{...source.response.song,title:{original:'A different song'}}}});
  await assert.rejects(store.reserve({...reservation,documentID:'doc-two'}),{code:'user_busy'});
});

test('database admission enforces personal budget access even when application checks are skipped',async t=> {
  const {store,db}=await fixture(t);
  await store.configureUserAccess('reader-a',{unlimitedGeneration:true});
  await store.configure({enabled:true,dailyMicros:0,monthlyMicros:0});
  const insert=(id,user)=>db.query(`INSERT INTO translation_jobs(id,document_id,target,recipe,user_id,state,reserved_micros,accounted_micros)
    VALUES($1,$2,'en','direct',$3,'queued',30000,30000)`,[id,source.id,user]);
  await assert.rejects(insert(randomUUID(),'reader-b'),/budget_exhausted/);
  await insert(randomUUID(),'reader-a');
  assert.equal(Number((await store.budget()).daily),30_000);
});

test('Study explanations share unlimited personal access and retain their spend ledger',async t=> {
  const {store}=await fixture(t);
  await store.configureUserAccess('reader-a',{unlimitedGeneration:true});
  await store.configure({enabled:true,dailyMicros:0,monthlyMicros:0,userDaily:0,userMonthly:0});
  const request={key:'unlimited-explanation',doc:source,translation:null,
    selection:{sourceID:'L0001',lower:0,upper:1,studyText:{kind:'source'},textHash:'hash'},
    recipe:'access-test',userID:'reader-a',amount:20_000,generationRequest:{}};
  await assert.rejects(reserveExplanation(store.db,{...request,userID:'reader-b'}),{code:'generation_allowance_exhausted'});
  const result=await reserveExplanation(store.db,request);assert.equal(result.created,true);
  assert.equal(Number((await store.budget()).held),20_000);
  assert.equal(await claimExplanation(store.db,result.row.id),true);
  await finishExplanation(store.db,result.row.id,{content:{meaning:'Test meaning'},actualMicros:2000,response:{id:'test'}});
  assert.equal(Number((await store.budget()).daily),2000);
  assert.equal(Number((await store.budget()).held),0);
  assert.equal((await reserveExplanation(store.db,{...request,userID:'reader-b'})).created,false);
  assert.equal((await store.reserve(reservation)).kind,'created');
});

test('access administration rejects ambiguous flags and unknown users',async t=> {
  const {store}=await fixture(t);
  await assert.rejects(store.configureUserAccess('reader-a',{unlimitedGeneration:'true'}),{code:'invalid_user_access'});
  await assert.rejects(store.configureUserAccess('unknown',{unlimitedGeneration:true}),{code:'user_not_found'});
});
