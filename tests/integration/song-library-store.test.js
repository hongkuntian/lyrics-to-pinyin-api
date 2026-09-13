import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {libraryDB,source} from '../helpers/library-db.js';
const reservation={userID:'reader-a',documentID:source.id,target:'en',recipe:'song-clause-4',reservedMicros:30_000};
async function fixture(t) {
  const f=await libraryDB();t.after(()=>f.db.close());await f.store.saveDocument(source);return f;
}
test('stored lyrics and translations survive a database close and reopen',async t=> {
  const path=await mkdtemp(join(tmpdir(),'lyra-library-'));t.after(()=>rm(path,{recursive:true,force:true}));
  let f=await libraryDB(path);await f.store.saveDocument(source);
  const job=await f.store.reserve(reservation);assert.equal(job.kind,'created');
  assert.ok(await f.store.claim(job.job.id));
  await f.store.complete(job.job.id,{lines:[{sourceID:'L0001',text:'Make a song of today.'}],sourceNotes:[],rejectedNotes:[]},8_000,{id:'response-test'});
  await f.db.close();f=await libraryDB(path);t.after(()=>f.db.close());
  assert.equal((await f.store.documentForRequest(source.requestKey,source.selectionRevision)).response.lines[0].original,source.response.lines[0].original);
  assert.equal((await f.store.translation(source.id,'en')).lines[0].text,'Make a song of today.');
  const cached=await f.store.reserve({...reservation,userID:'reader-b',recipe:'future-recipe'});
  assert.equal(cached.kind,'ready');assert.equal(Number((await f.store.usage()).accounted_micros),8000);
});
test('concurrent users join one durable generation job and reserve only once',async t=> {
  const {store}=await fixture(t);
  const attempts=await Promise.all(Array.from({length:20},(_,i)=>store.reserve({...reservation,userID:i%2?'reader-a':'reader-b'})));
  assert.equal(attempts.filter(x=>x.kind==='created').length,1);
  assert.equal(new Set(attempts.map(x=>x.job.id)).size,1);
  assert.equal(Number((await store.usage()).accounted_micros),30_000);
  const claims=await Promise.all(attempts.map(x=>store.claim(x.job.id)));
  assert.equal(claims.filter(Boolean).length,1);
});
test('concurrent distinct jobs cannot overspend the remaining global budget',async t=> {
  const {store}=await fixture(t);await store.configure({enabled:true,dailyMicros:45_000,monthlyMicros:45_000});
  await store.saveDocument({...source,id:'doc-two',requestKey:'request-two'});
  const results=await Promise.allSettled([store.reserve(reservation),store.reserve({...reservation,userID:'reader-b',documentID:'doc-two'})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(results.find(x=>x.status==='rejected').reason.code,'budget_exhausted');
  assert.equal(Number((await store.usage()).accounted_micros),30_000);
});
test('monthly budget also stops new work when daily allowance remains',async t=> {
  const {store}=await fixture(t);await store.configure({enabled:true,dailyMicros:1_000_000,monthlyMicros:25_000});
  await assert.rejects(store.reserve(reservation),{code:'budget_exhausted'});
});
test('per-user active limits survive token rotation',async t=> {
  const {store}=await fixture(t);await store.saveDocument({...source,id:'doc-two',requestKey:'request-two'});
  const job=await store.reserve(reservation);
  await assert.rejects(store.reserve({...reservation,documentID:'doc-two'}),{code:'user_busy'});
  await store.claim(job.job.id);await store.fail(job.job.id,'provider_timeout',null);
  await store.createUser('reader-a','rotated-token');
  assert.equal((await store.authenticate('rotated-token')).id,'reader-a');
  assert.equal(await store.authenticate('token-a'),null);
  await assert.rejects(store.reserve({...reservation,documentID:'doc-two'}),{code:'user_busy'});
  assert.equal(Number((await store.usage()).accounted_micros),30_000);
});
test('per-user daily and monthly attempt allowances include completed work',async t=> {
  const {store,db}=await fixture(t);
  const job=await store.reserve(reservation);await store.claim(job.job.id);
  await store.complete(job.job.id,{lines:[],sourceNotes:[]},1000,{});
  await store.saveDocument({...source,id:'doc-two',requestKey:'request-two'});
  await store.configure({enabled:true,dailyMicros:1_000_000,monthlyMicros:5_000_000,userDaily:1,userMonthly:50});
  await assert.rejects(store.reserve({...reservation,documentID:'doc-two'}),{code:'generation_allowance_exhausted'});
  await store.configure({enabled:true,dailyMicros:1_000_000,monthlyMicros:5_000_000,userDaily:10,userMonthly:1});
  await assert.rejects(store.reserve({...reservation,documentID:'doc-two'}),{code:'generation_allowance_exhausted'});
  // The allowance resets in a later UTC month; token rotation alone cannot reset it.
  await db.query("UPDATE translation_jobs SET created_at=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-interval '1 second'");
  assert.equal((await store.reserve({...reservation,documentID:'doc-two'})).kind,'created');
});
test('unexpected provider configuration retains the reservation and disables generation',async t=> {
  const {store}=await fixture(t);const job=await store.reserve(reservation);await store.claim(job.job.id);
  await store.fail(job.job.id,'provider_configuration_changed',null);
  assert.equal(Number((await store.usage()).accounted_micros),30_000);
  await store.saveDocument({...source,id:'doc-two',requestKey:'request-two'});
  await assert.rejects(store.reserve({...reservation,documentID:'doc-two',userID:'reader-b'}),{code:'generation_disabled'});
});
test('timeouts keep reservations and do not cause automatic paid retries',async t=> {
  const {store}=await fixture(t);const job=await store.reserve(reservation);await store.claim(job.job.id);
  await store.fail(job.job.id,'provider_timeout',null);
  const result=await store.reserve({...reservation,userID:'reader-b'});
  assert.equal(result.kind,'unknown');assert.equal(result.job.id,job.job.id);
  assert.equal(Number((await store.usage()).accounted_micros),30_000);
});
test('known failed outputs charge usage once and cannot be retried by refresh',async t=> {
  const {store}=await fixture(t);const job=await store.reserve(reservation);await store.claim(job.job.id);
  await store.fail(job.job.id,'invalid_translation_coverage',7_000);
  await store.fail(job.job.id,'invalid_translation_coverage',7_000);
  assert.equal((await store.reserve(reservation)).kind,'failed');
  assert.equal(Number((await store.usage()).accounted_micros),7_000);
  assert.equal(await store.translation(source.id,'en'),null);
});
test('reports are deduplicated proposals and never replace published text or create jobs',async t=> {
  const {store}=await fixture(t);const report={userID:'reader-a',documentID:source.id,sourceID:'L0001',category:'translation',detail:'This meaning seems wrong.'};
  const a=await store.report(report),b=await store.report(report);
  assert.equal(a.id,b.id);assert.equal(a.status,'pending');
  assert.equal(Number((await store.usage()).accounted_micros),0);
  await assert.rejects(store.report({...report,sourceID:'L9999'}),{code:'invalid_report'});
});
test('disabled generation still serves saved translations',async t=> {
  const {store}=await fixture(t);const job=await store.reserve(reservation);await store.claim(job.job.id);
  await store.complete(job.job.id,{lines:[{sourceID:'L0001',text:'Saved.'}],sourceNotes:[],rejectedNotes:[]},1000,{});
  await store.configure({enabled:false,dailyMicros:0,monthlyMicros:0});
  assert.equal((await store.reserve(reservation)).kind,'ready');
  await store.saveDocument({...source,id:'doc-two',requestKey:'request-two'});
  await assert.rejects(store.reserve({...reservation,documentID:'doc-two'}),{code:'generation_disabled'});
});
test('source revision changes keep old translations separate',async t=> {
  const {store}=await fixture(t);const job=await store.reserve(reservation);await store.claim(job.job.id);
  await store.complete(job.job.id,{lines:[{sourceID:'L0001',text:'Old version.'}],sourceNotes:[],rejectedNotes:[]},1000,{});
  await store.saveDocument({...source,id:'doc-revised',sourceHash:'new-hash',selectionRevision:'new-selection'});
  assert.equal((await store.documentForRequest(source.requestKey,'new-selection')).id,'doc-revised');
  assert.equal(await store.translation('doc-revised','en'),null);
  assert.equal((await store.translation(source.id,'en')).lines[0].text,'Old version.');
});
