import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB,source} from '../helpers/library-db.js';
import {parseTranslation} from '../../api/utils/song-library/translation.js';
import {ReviewQueue,runReviewQueue} from '../../api/utils/song-library/review-queue.js';
import {REVIEW_POLICY,VERIFICATION_RESERVATION} from '../../api/utils/song-library/review-assessment.js';
import {createReviewReportsHandler} from '../../api/review-reports.js';
async function fixture(t,{report=true,second=false}={}) {
  const f=await libraryDB();t.after(()=>f.db.close());const db={query:(...a)=>f.db.query(...a),transaction:fn=>f.db.transaction(fn)};
  await f.store.configureReviews({enabled:true,dailyMicros:250_000,monthlyMicros:1_000_000,maxDaily:5});
  const ids=[];
  for(const doc of second?[source,{...source,id:'doc-two',requestKey:'request-two'}]:[source]) {
    await f.store.saveDocument(doc);
    const j=await f.store.reserve({userID:'reader-a',documentID:doc.id,target:'en',recipe:'fixture',reservedMicros:30_000});
    await f.store.claim(j.job.id);await f.store.complete(j.job.id,parseTranslation(JSON.stringify({translations:{L0001:'Make a song of today.'},sourceNotes:[]}),doc),1000,{id:'test'});
    ids.push(j.job.id);
    if(report)await f.store.report({userID:'reader-a',documentID:doc.id,translationID:j.job.id,category:'translation',sourceID:'L0001',detail:'Check the meaning.'});
  }
  const provider={uploads:0,submits:0,gets:0,remote:null,text:'',
    async upload(){this.uploads++;return 'file-test';},
    async findUpload(){return 'file-test';},
    async submit(local){this.submits++;this.remote={id:`batch-test-${this.submits}`,status:'in_progress',endpoint:'/v1/responses',input_file_id:local.input_file_id,
      metadata:{lyra_batch_id:local.id,request_hash:local.request_hash,policy_version:local.policy_version}};return this.remote;},
    async findBatch(){return this.remote;},async get(){this.gets++;return this.remote;},async file(){return this.text;}
  };
  return {...f,database:db,ids,provider,run:()=>runReviewQueue({db,provider}),queue:()=>new ReviewQueue(db)};
}
const record=(id,decision='keep')=>({custom_id:id,response:{status_code:200,body:{id:'response-test',model:'gpt-5.6-luna',service_tier:'default',status:'completed',usage:{input_tokens:1000,output_tokens:1000},
  output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({decision,summary:'The imagery is clear.',changes:decision==='correct'?[{sourceID:'L0001',sourceQuote:source.structure.occurrences[0].sourceText,replacement:'Turn today into a song.',reason:'Preserve the original image.'}]:[]})}]}]}}});
async function complete(f,decision='keep') {
  const items=(await f.db.query("SELECT * FROM correction_batch_items WHERE batch_id=(SELECT id FROM correction_batches WHERE state NOT IN ('completed','cancelled')) ORDER BY operation_id")).rows;
  f.provider.remote.status='completed';f.provider.remote.output_file_id='file-output';
  f.provider.text=items.map(i=>JSON.stringify(record(i.operation_id,decision))).reverse().join('\n');return items;
}
test('empty queues make no provider requests; report arrival only enqueues and coalesces',async t=> {
  const f=await fixture(t,{report:false});assert.equal((await f.run()).state,'empty');assert.equal(f.provider.uploads,0);
  for(let n=0;n<20;n++)await f.store.report({userID:'reader-a',documentID:source.id,translationID:f.ids[0],category:'translation',sourceID:'L0001',detail:`Different report ${n}`});
  assert.equal((await f.db.query('SELECT count(*) FROM correction_review_queue')).rows[0].count,1);
  assert.equal((await f.db.query('SELECT count(*) FROM translation_reviews')).rows[0].count,0);
  assert.equal((await f.run()).state,'processing');assert.equal(f.provider.submits,1);
  const item=(await f.db.query('SELECT * FROM correction_batch_items')).rows[0];
  assert.equal(item.report_snapshot.length,2);assert.equal(JSON.parse(item.request_body.input[0].content).reports.length,2);
});
test('concurrent cron invocations submit once and repeated reads do not reserve again',async t=> {
  const f=await fixture(t);const results=await Promise.all(Array.from({length:6},()=>f.run()));
  assert.equal(results.filter(r=>r.state==='processing').length,1);assert.equal(f.provider.submits,1);
  const held=Number((await f.store.budget()).held);assert.ok(held>VERIFICATION_RESERVATION);
  await f.run();assert.equal(Number((await f.store.budget()).held),held);assert.equal(f.provider.submits,1);
});
test('lost submission response is recovered by metadata, never a second POST',async t=> {
  const f=await fixture(t),submit=f.provider.submit;
  f.provider.submit=async function(local){await submit.call(this,local);throw new Error('connection lost');};
  await f.run();assert.equal((await f.db.query('SELECT state FROM correction_batches')).rows[0].state,'submitting');
  assert.equal((await f.run()).state,'processing');assert.equal(f.provider.submits,1);
});
test('uncertain submission without a matching remote batch holds funds across future runs',async t=> {
  const f=await fixture(t);f.provider.submit=async function(){this.submits++;throw new Error('lost');};
  await f.run();const held=Number((await f.store.budget()).held);
  assert.equal((await f.run()).state,'submission_reconciliation_required');await f.run();
  assert.equal(f.provider.submits,1);assert.equal(Number((await f.store.budget()).held),held);
});
test('upload uncertainty reconciles the existing file without uploading twice',async t=> {
  const f=await fixture(t);f.provider.upload=async function(){this.uploads++;throw new Error('lost');};
  await f.run();assert.equal((await f.run()).state,'processing');assert.equal(f.provider.uploads,1);assert.equal(f.provider.submits,1);
});
test('reordered completed results settle once, release unused verification, and never publish',async t=> {
  const f=await fixture(t,{second:true});await f.run();await complete(f);assert.equal((await f.run()).state,'assessed');
  assert.equal(Number((await f.store.budget()).held),0);assert.equal(Number((await f.store.budget()).daily),3450);
  await f.run();assert.equal(Number((await f.store.budget()).daily),3450);assert.equal(f.provider.submits,1);
  assert.equal((await f.db.query("SELECT count(*) FROM correction_review_queue WHERE state='kept'")).rows[0].count,2);
  assert.equal((await f.db.query("SELECT count(*) FROM correction_reports WHERE status='rejected'")).rows[0].count,2);
  assert.equal((await f.store.revisions(source.id,'en')).length,1);
});
test('a correction candidate retains its verification reservation but leaves the current translation intact',async t=> {
  const f=await fixture(t);await f.run();await complete(f,'correct');assert.equal((await f.run()).state,'assessed');
  assert.equal(Number((await f.store.budget()).held),VERIFICATION_RESERVATION);
  assert.equal((await f.store.translation(source.id,'en')).id,f.ids[0]);
  const item=(await f.db.query('SELECT result FROM correction_batch_items')).rows[0];assert.equal(item.result.candidate.translations.L0001,'Turn today into a song.');
});
test('partial expiration settles successful and explicitly unexecuted requests without retrying either',async t=> {
  const f=await fixture(t,{second:true});await f.run();const items=await complete(f);
  f.provider.remote.status='expired';f.provider.text=JSON.stringify(record(items[0].operation_id))+'\n'+JSON.stringify({custom_id:items[1].operation_id,response:null,error:{code:'batch_expired'}});
  assert.equal((await f.run()).state,'assessed');assert.equal(Number((await f.store.budget()).held),0);
  assert.equal(Number((await f.store.budget()).daily),2725);await f.run();assert.equal(f.provider.submits,1);
});
test('missing or unpriced results retain reservations, reconcile later and settle known siblings once',async t=> {
  const f=await fixture(t,{second:true});await f.run();const items=await complete(f);
  const all=f.provider.text;f.provider.text=JSON.stringify(record(items[0].operation_id));
  assert.equal((await f.run()).state,'reconciliation_required');assert.ok(Number((await f.store.budget()).held)>0);
  f.provider.text=all;assert.equal((await f.run()).state,'assessed');assert.equal(Number((await f.store.budget()).daily),3450);
});
test('duplicate output identities cannot settle any operation',async t=> {
  const f=await fixture(t);await f.run();await complete(f);f.provider.text+='\n'+f.provider.text;
  assert.equal((await f.run()).state,'batch_result_identity_conflict');assert.ok(Number((await f.store.budget()).held)>VERIFICATION_RESERVATION);
});
test('budget exhaustion leaves work pending and reserves neither stage',async t=> {
  const f=await fixture(t);await f.store.configureReviews({enabled:true,dailyMicros:100,monthlyMicros:100,maxDaily:5});
  assert.equal((await f.run()).state,'review_budget_exhausted');assert.equal(f.provider.uploads,0);
  assert.equal((await f.db.query('SELECT count(*) FROM translation_reviews')).rows[0].count,0);
  assert.equal((await f.db.query('SELECT state FROM correction_review_queue')).rows[0].state,'pending');
});
test('disabling admission still reconciles already submitted work',async t=> {
  const f=await fixture(t);await f.run();await complete(f);await f.db.query('UPDATE library_settings SET review_enabled=false');
  assert.equal((await f.run()).state,'assessed');assert.equal((await f.run()).state,'review_disabled');assert.equal(f.provider.submits,1);
});
test('a stale prepared batch releases both reservations before any paid submission',async t=> {
  const f=await fixture(t),q=f.queue();await q.acquire();const {batch}=await q.prepare();await q.release('fixture');
  await f.store.publishRevision({expectedRevisionID:f.ids[0],sourceHash:source.sourceHash,publicationKey:'changed',actor:'test',reason:'changed',candidate:{translations:{L0001:'Turn today into a song.'},sourceNotes:[]}});
  await f.run();assert.equal(f.provider.submits,0);assert.equal(Number((await f.store.budget()).held),0);
  assert.equal((await f.db.query('SELECT state FROM correction_batches WHERE id=$1',[batch.id])).rows[0].state,'cancelled');
});
test('expired lease owners cannot mutate batch state after takeover',async t=> {
  const f=await fixture(t),old=f.queue(),fresh=f.queue();await old.acquire();const {batch}=await old.prepare();
  await f.db.query("UPDATE correction_worker SET lease_until=now()-interval '1 second'");assert.equal(await fresh.acquire(),true);
  await assert.rejects(old.transition(batch.id,'prepared','uploading'),{code:'worker_lease_lost'});await fresh.release('fixture');
});
test('cron requires production, an owner secret, GET and no user-selected payload',async()=> {
  let calls=0;const secret='s'.repeat(40),env={VERCEL_ENV:'production',CRON_SECRET:secret,OPENAI_API_KEY:'fixture'};
  const invoke=async(e,req)=> {const res={setHeader(){},status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
    await createReviewReportsHandler({env:e,db:{},alerts:async()=>{},run:async()=>{calls++;return {state:'empty'};}})(req,res);return res;};
  const req={method:'GET',headers:{authorization:`Bearer ${secret}`}};
  assert.equal((await invoke(env,{...req,headers:{}})).code,401);
  assert.equal((await invoke({...env,VERCEL_ENV:'preview'},req)).code,503);
  assert.equal((await invoke(env,{...req,method:'POST'})).code,405);
  assert.equal((await invoke(env,{...req,query:{model:'astra'}})).code,400);
  assert.equal((await invoke(env,req)).code,200);assert.equal(calls,1);
});

test('a transaction failure rolls back both result persistence and settlement, then reconciles safely',async t=> {
  const f=await fixture(t);await f.run();await complete(f);
  const held=Number((await f.store.budget()).held);let fail=true;
  const database={...f.database,transaction:fn=>f.database.transaction(tx=>fn({query:async(sql,args)=> {
    if(fail&&sql.startsWith('UPDATE correction_batch_items SET state=')){fail=false;throw new Error('simulated storage failure');}
    return tx.query(sql,args);
  }}))};
  assert.equal((await runReviewQueue({db:database,provider:f.provider})).state,'worker_storage_failure');
  assert.equal(Number((await f.store.budget()).held),held);
  assert.equal((await f.db.query('SELECT result FROM correction_batch_items')).rows[0].result,null);
  assert.equal((await f.run()).state,'assessed');assert.equal(Number((await f.store.budget()).daily),1725);
});
test('late duplicate reports never reopen an assessed revision or start another paid assessment',async t=> {
  const f=await fixture(t);await f.run();await complete(f);await f.run();
  await f.store.report({userID:'reader-b',documentID:source.id,translationID:f.ids[0],sourceID:'L0001',category:'translation',detail:'Another report.'});
  assert.equal((await f.run()).state,'empty');assert.equal(f.provider.submits,1);
});
test('provider model substitution pauses paid work and retains its unknown charge',async t=> {
  const f=await fixture(t);await f.run();const items=await complete(f),bad=record(items[0].operation_id);
  bad.response.body.model='gpt-6-astra';f.provider.text=JSON.stringify(bad);
  assert.equal((await f.run()).state,'reconciliation_required');
  const s=(await f.db.query('SELECT enabled,review_enabled FROM library_settings')).rows[0];
  assert.equal(s.enabled,false);assert.equal(s.review_enabled,false);assert.ok(Number((await f.store.budget()).held)>0);
});
test('reports without translation context stay out of the paid queue',async t=> {
  const f=await fixture(t,{report:false});
  for(const category of ['lyrics','timing','pronunciation'])await f.store.report({userID:'reader-a',documentID:source.id,sourceID:'L0001',category,detail:'Check.'});
  assert.equal((await f.run()).state,'empty');assert.equal(f.provider.uploads,0);
});

async function comparing(f) {
  await f.db.query('UPDATE library_settings SET review_publication_enabled=true');
  await f.run();await complete(f,'correct');await f.run();
  assert.equal((await f.run()).state,'processing');
  return (await f.db.query("SELECT * FROM correction_batch_items WHERE stage='verification'")).rows[0];
}
async function comparison(f,overrides={}) {
  const v=(await f.db.query("SELECT * FROM correction_batch_items WHERE stage='verification'")).rows[0];
  const r=record(v.operation_id),value={preferred:v.comparison_context.candidateSlot,sourceSufficient:true,noRegressions:true,materialImprovement:true,
    summary:'The correction preserves the source action.',evidence:[{sourceID:'L0001',sourceQuote:source.structure.occurrences[0].sourceText,explanation:'Today becomes the song.'}],...overrides};
  r.response.body.output[0].content[0].text=JSON.stringify(value);
  f.provider.remote.status='completed';f.provider.remote.output_file_id='verification-output';f.provider.text=JSON.stringify(r);return r;
}
test('two-stage review publishes exactly once, closes frozen reports and retains rollback history without extra reservations',async t=> {
  const f=await fixture(t);await comparing(f);
  assert.equal(f.provider.submits,2);assert.equal(Number((await f.store.budget()).held),VERIFICATION_RESERVATION);
  await comparison(f);assert.equal((await f.run()).state,'published');
  const head=await f.store.translation(source.id,'en');assert.notEqual(head.id,f.ids[0]);assert.equal(head.lines[0].lyricText,'Turn today into a song.');
  assert.equal(Number((await f.store.budget()).held),0);assert.equal(Number((await f.store.budget()).daily),2450);
  assert.equal((await f.db.query('SELECT status FROM correction_reports')).rows[0].status,'accepted');
  assert.equal((await f.db.query('SELECT published_revision_id FROM correction_review_outcomes')).rows[0].published_revision_id,head.id);
  await f.run();assert.equal(f.provider.submits,2);assert.equal((await f.store.revisions(source.id,'en')).length,2);
  const original=(await f.store.revisions(source.id,'en')).find(r=>r.id===f.ids[0]);assert.ok(original);
  await assert.rejects(f.db.query("UPDATE correction_review_outcomes SET reason='changed'"),/review_outcome_immutable/);
  const restored=await f.store.rollbackRevision({expectedRevisionID:head.id,restoreRevisionID:f.ids[0],sourceHash:source.sourceHash,publicationKey:'restore',actor:'test',reason:'Restore the original.'});
  assert.equal((await f.store.translation(source.id,'en')).id,restored.id);
  assert.equal((await f.store.translation(source.id,'en')).lines[0].lyricText,'Make a song of today.');
  await f.run();assert.equal(f.provider.submits,2);assert.equal((await f.store.revisions(source.id,'en')).length,3);
});
test('comparison ties, missing evidence and uncertainty retain the existing translation',async t=> {
  for(const value of [{preferred:'equivalent'},{preferred:'uncertain'},{evidence:[]},{noRegressions:false}]) {
    const f=await fixture(t);await comparing(f);await comparison(f,value);assert.equal((await f.run()).state,'review_completed');
    assert.equal((await f.store.translation(source.id,'en')).id,f.ids[0]);assert.equal(Number((await f.store.budget()).held),0);
    assert.equal(f.provider.submits,2);assert.notEqual((await f.db.query('SELECT disposition FROM correction_review_outcomes')).rows[0].disposition,'published');
  }
});
test('publication pause reconciles comparison costs and resumes from saved results without another model call',async t=> {
  const f=await fixture(t);await comparing(f);await comparison(f);
  await f.db.query('UPDATE library_settings SET review_publication_enabled=false');await f.run();
  assert.equal(Number((await f.store.budget()).held),0);assert.equal((await f.store.translation(source.id,'en')).id,f.ids[0]);
  await f.db.query('UPDATE library_settings SET review_publication_enabled=true');assert.equal((await f.run()).state,'published');
  assert.equal(f.provider.submits,2);
});
test('stale submitted comparison settles its cost but never overwrites a newer revision',async t=> {
  const f=await fixture(t);await comparing(f);
  const changed=await f.store.publishRevision({expectedRevisionID:f.ids[0],sourceHash:source.sourceHash,publicationKey:'concurrent',actor:'test',reason:'Concurrent edit',candidate:{translations:{L0001:'Today is a song.'},sourceNotes:[]}});
  await comparison(f);await f.run();assert.equal((await f.store.translation(source.id,'en')).id,changed.id);
  assert.equal(Number((await f.store.budget()).held),0);assert.equal(Number((await f.store.budget()).daily),2450);
  assert.equal((await f.db.query('SELECT disposition FROM correction_review_outcomes')).rows[0].disposition,'superseded');
});
test('unknown comparison usage and model substitution cannot authorize publication',async t=> {
  for(const substitute of [false,true]) {
    const f=await fixture(t);await comparing(f);const r=await comparison(f);
    if(substitute)r.response.body.model='gpt-6-astra';else delete r.response.body.usage;
    f.provider.text=JSON.stringify(r);assert.equal((await f.run()).state,'reconciliation_required');
    assert.equal((await f.store.translation(source.id,'en')).id,f.ids[0]);assert.equal(Number((await f.store.budget()).held),VERIFICATION_RESERVATION);
    assert.equal((await f.db.query('SELECT count(*) FROM correction_review_outcomes')).rows[0].count,0);
  }
});
test('publication and settlement roll back together if the outcome receipt cannot be persisted',async t=> {
  const f=await fixture(t);await comparing(f);await comparison(f);let fail=true;
  const db={...f.database,transaction:fn=>f.database.transaction(tx=>fn({query:async(sql,args)=> {
    if(fail&&sql.startsWith('INSERT INTO correction_review_outcomes')){fail=false;throw new Error('simulated write failure');}return tx.query(sql,args);
  }}))};
  assert.equal((await runReviewQueue({db,provider:f.provider})).state,'worker_storage_failure');
  assert.equal((await f.store.translation(source.id,'en')).id,f.ids[0]);assert.equal((await f.store.revisions(source.id,'en')).length,1);
  assert.equal(Number((await f.store.budget()).held),VERIFICATION_RESERVATION);
  assert.equal((await f.run()).state,'published');assert.equal(f.provider.submits,2);assert.equal((await f.store.revisions(source.id,'en')).length,2);
});
test('changing a frozen candidate after comparison submission blocks publication',async t=> {
  const f=await fixture(t);await comparing(f);await comparison(f);
  await f.db.query(`UPDATE correction_batch_items SET result=jsonb_set(result,'{candidate,translations,L0001}','"Unreviewed replacement."') WHERE stage='assessment'`);
  await f.run();assert.equal((await f.store.translation(source.id,'en')).id,f.ids[0]);
  assert.equal((await f.db.query('SELECT disposition FROM correction_review_outcomes')).rows[0].disposition,'blocked');
});
test('late reports do not inherit an assessment or reopen paid work',async t=> {
  const f=await fixture(t);await comparing(f);
  await f.store.report({userID:'reader-b',documentID:source.id,translationID:f.ids[0],category:'translation',sourceID:'L0001',detail:'A later unreviewed claim.'});
  await comparison(f);await f.run();
  const reports=(await f.db.query('SELECT user_id,status,assessment FROM correction_reports ORDER BY user_id')).rows;
  assert.equal(reports[0].status,'accepted');assert.equal(reports[1].status,'pending');assert.equal(reports[1].assessment,null);
  await f.run();assert.equal(f.provider.submits,2);
});
test('comparison reservation cannot be attached to an assessment-stage batch item',async t=> {
  const f=await fixture(t);await f.run();
  await assert.rejects(f.db.query(`INSERT INTO correction_batch_items(batch_id,operation_id,review_id,revision_id,request_body,report_snapshot)
    SELECT i.batch_id,o.id,i.review_id,i.revision_id,i.request_body,'[]' FROM correction_batch_items i
    JOIN library_spend_operations o ON o.review_id=i.review_id AND o.kind='review_verification'`),/review_operation_mismatch/);
});
test('verification cost overrun records the full charge and pauses automatic publication',async t=> {
  const f=await fixture(t);await comparing(f);const r=await comparison(f);
  r.response.body.usage.output_tokens=100_000;f.provider.text=JSON.stringify(r);await f.run();
  assert.equal((await f.store.translation(source.id,'en')).id,f.ids[0]);
  assert.equal((await f.db.query('SELECT enabled FROM library_settings')).rows[0].enabled,false);
  assert.equal(Number((await f.store.budget()).daily),61_850);assert.equal(Number((await f.store.budget()).held),0);
});
test('stale prepared verification releases only unsubmitted funds and keeps the assessment charge',async t=> {
  const f=await fixture(t);await f.db.query('UPDATE library_settings SET review_publication_enabled=true');
  await f.run();await complete(f,'correct');await f.run();
  const q=f.queue();await q.acquire();const {batch}=await q.prepare();await q.release('fixture');
  assert.equal(batch.stage,'verification');
  await f.store.publishRevision({expectedRevisionID:f.ids[0],sourceHash:source.sourceHash,publicationKey:'stale-prepared',actor:'test',reason:'New version',candidate:{translations:{L0001:'Today is a song.'},sourceNotes:[]}});
  await f.run();await f.run();assert.equal(f.provider.submits,1);
  assert.equal(Number((await f.store.budget()).held),0);assert.equal(Number((await f.store.budget()).daily),1725);
});
test('changing the frozen comparison request or slot cannot publish its response',async t=> {
  for(const field of ['body','slot']) {
    const f=await fixture(t);await comparing(f);await comparison(f);
    if(field==='body')await f.db.query(`UPDATE correction_batch_items SET request_body=jsonb_set(request_body,'{instructions}','"Changed instructions"') WHERE stage='verification'`);
    else await f.db.query(`UPDATE correction_batch_items SET comparison_context=jsonb_set(comparison_context,'{candidateSlot}',to_jsonb(CASE WHEN comparison_context->>'candidateSlot'='A' THEN 'B' ELSE 'A' END)) WHERE stage='verification'`);
    await f.run();assert.equal((await f.store.translation(source.id,'en')).id,f.ids[0]);
    assert.equal((await f.db.query('SELECT reason FROM correction_review_outcomes')).rows[0].reason,'comparison_request_changed');
  }
});
