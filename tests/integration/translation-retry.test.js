import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {libraryDB,source} from '../helpers/library-db.js';
import {requestBody,parseTranslation,reservationMicros} from '../../api/utils/song-library/translation.js';
import {retryTranslation} from '../../api/utils/song-library/translation-retry.js';
const request={userID:'reader-a',documentID:source.id,target:'en',recipe:'fixture',reservedMicros:30_000};
async function fixture(t,{known=true}={}){const f=await libraryDB();t.after(()=>f.db.close());await f.store.saveDocument(source);const r=await f.store.reserve(request);const claimed=await f.store.claim(r.job.id);await f.store.fail(r.job.id,'provider_incomplete',known?8610:null,{id:'first-provider'});return {...f,id:r.job.id,claimed};}
const args=id=>({jobID:id,expectedAttempt:1,requestKey:'owner-recovery',actor:'operator',reason:'Increase output budget after known exhaustion'});
test('owner retry keeps cached job identity and retains each attempt charge and immutable request',async t=>{
 const {db,store,id,claimed}=await fixture(t);
 const preview=await retryTranslation(db,{...args(id),dryRun:true});assert.equal(preview.maxOutputTokens,32768);assert.equal((await store.job(id)).state,'failed');assert.equal(Number((await store.usage()).jobs),1);
 const retried=await retryTranslation(db,args(id));assert.equal(retried.jobID,id);assert.equal(retried.attempt,2);
 assert.deepEqual(await retryTranslation(db,args(id)),retried);
 assert.equal(Number((await store.usage()).jobs),2);assert.equal(Number((await store.usage()).accounted_micros),8610+reservationMicros(requestBody(source)));
 const second=await store.claim(id);assert.equal(second.attempt,2);assert.equal(second.generation_request.max_output_tokens,32768);
 // An old worker cannot settle or fail a newly admitted attempt.
 await store.fail(id,'late_old_response',1,null,claimed.attempt);assert.equal((await store.job(id)).state,'running');
 await store.complete(id,parseTranslation(JSON.stringify({translations:{L0001:'Make a song of today.'},sourceNotes:[]}),source),2000,{id:'second-provider'},second.attempt);
 assert.equal((await store.job(id)).state,'ready');assert.equal((await store.translation(source.id,'en')).id,id);
 const ledger=(await db.query('SELECT state,accounted_micros,provider_id FROM library_spend_operations WHERE generation_job_id=$1 ORDER BY generation_attempt',[id])).rows;
 assert.deepEqual(ledger.map(r=>[r.state,Number(r.accounted_micros),r.provider_id]),[['settled',8610,'first-provider'],['settled',2000,'second-provider']]);
 assert.equal((await db.query('SELECT count(*) AS n FROM translation_attempt_history WHERE job_id=$1',[id])).rows[0].n,2);
 await assert.rejects(db.query('UPDATE translation_attempt_history SET error_code=NULL WHERE job_id=$1',[id]),/translation_revision_immutable/);
 await assert.rejects(db.query(`INSERT INTO library_spend_operations(id,operation_key,kind,generation_job_id,state,reserved_micros,accounted_micros)
   VALUES($1,'malformed-generation','generation',$2,'reserved',1,1)`,[randomUUID(),id]),/generation_attempt_required/);
 await assert.rejects(retryTranslation(db,{...args(id),reason:'Different request'}),{code:'retry_key_conflict'});
});
test('unknown cost, disabled generation, stale attempts and exhausted budgets cannot be retried',async t=>{
 const f=await fixture(t,{known:false});await assert.rejects(retryTranslation(f.db,args(f.id)),{code:'retry_requires_known_failure'});
 const g=await fixture(t);await assert.rejects(retryTranslation(g.db,{...args(g.id),expectedAttempt:2}),{code:'retry_attempt_superseded'});
 await g.store.configure({enabled:false,dailyMicros:0,monthlyMicros:0});await assert.rejects(retryTranslation(g.db,args(g.id)),{code:'generation_disabled'});
 await g.store.configure({enabled:true,dailyMicros:8611,monthlyMicros:8611});await assert.rejects(retryTranslation(g.db,args(g.id)),{code:'budget_exhausted'});
 assert.equal(Number((await g.store.usage()).jobs),1);
});
test('retry admission counts as a fresh user attempt and is serialized under concurrent owner requests',async t=>{
 const {db,store,id}=await fixture(t);await store.configure({enabled:true,dailyMicros:1_000_000,monthlyMicros:5_000_000,userDaily:1,userMonthly:50});
 await assert.rejects(retryTranslation(db,args(id)),{code:'generation_allowance_exhausted'});
 await store.configure({enabled:true,dailyMicros:1_000_000,monthlyMicros:5_000_000,userDaily:2,userMonthly:50});
 const r=await Promise.allSettled([retryTranslation(db,args(id)),retryTranslation(db,{...args(id),requestKey:'other-recovery'})]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.find(x=>x.status==='rejected').reason.code,'retry_attempt_superseded');
 assert.equal(Number((await store.usage()).jobs),2);
});
