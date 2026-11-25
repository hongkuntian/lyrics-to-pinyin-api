import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {libraryDB} from '../helpers/library-db.js';
import {preparedInputs,allDirections} from '../helpers/prepared-edition.js';
import {inspectorManifest} from '../../api/utils/prepared-editions/compiler.js';
import {artifact} from '../../api/utils/prepared-editions/core.js';
import {poolInventory,acquireEdition,stagePlan,priceStage,executeStage,finishTranslations,finishEdition} from '../../api/utils/prepared-editions/preparation.js';
import {reservePlanBudget,budgetedGenerate} from '../../api/utils/prepared-editions/budget.js';
import {digest} from '../../api/utils/song-library/store.js';
async function setup(t){const {db,store}=await libraryDB();t.after(()=>db.close());await db.exec(await readFile(new URL('../../db/041-prepared-editions.sql',import.meta.url),'utf8'));return {db,database:store.db};}
const review=(stage,ceilingMicros)=>({reviewer:'test',reference:'test-only-pricing-review',planID:stage.plan.id,currency:'USD',retryAllowance:0,ceilingMicros,...(stage.manifest?{nativeManifestHash:artifact('manifest',stage.manifest).id}:{})});
test('offline pipeline acquires from server pool, prepares translations then native actions, and publishes only full coverage',async t=>{
 const {database,db}=await setup(t),dir=await mkdtemp(join(tmpdir(),'prepared-pipeline-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const fixture=preparedInputs(),spec={...fixture.spec,rights:{...fixture.spec.rights,source:{provider:'qq',itemID:'1'}},acquisitionReview:{reference:'test-only-path-permission',selectionRevision:'test',allOrdinaryProviderPathsApproved:true}};
 let acquisitions=0;
 const acquired=await acquireEdition(spec,{selectionRevision:'test',loadLyrics:async recording=>{acquisitions++;assert.equal(recording.catalog_id,'1817103029');assert.equal(recording.title,'月亮代表我的心');return fixture.doc.response;}});
 assert.equal(acquisitions,1);
 const stage=stagePlan(acquired,{stage:'translations',policy:allDirections}),priced=priceStage(stage,{input_tokens:100,output_tokens:100});assert.equal(priced.tasks,4);assert.equal(priced.currency,'USD');
 let calls=0;
 const options={policy:allDirections,path:join(dir,'translations.json'),review:review(stage,200000),database,apiKey:'test',generateTranslation:async(doc,{target,generationRequest})=>{calls++;assert.equal(generationRequest.model,stage.tasks[0].body.model);return {content:{lines:fixture.translations[target].lines,sourceNotes:[]},actualMicros:1};}};
 const checkpoint=await executeStage(acquired,stage,options);assert.equal(checkpoint.state,'ready');assert.equal(calls,4);
 await executeStage(acquired,stage,options);assert.equal(calls,4,'resume must not submit twice');
 const translations=finishTranslations(acquired,stage,checkpoint),{rows:ignored,...exported}=inspectorManifest(acquired.doc,translations);
 const native=JSON.parse(JSON.stringify(exported)),study=stagePlan(acquired,{stage:'study',translations,rows:native,policy:allDirections});
 const studyOptions={policy:allDirections,path:join(dir,'study.json'),review:review(study,500000),database,apiKey:'test',translations,
  generateBatch:async(doc,t,selections)=>({content:{items:selections.map(s=>({id:s.id,meaning:'hello',context:'greeting',grammar:'',uncertainty:'',sourceQuote:s.text}))},actualMicros:1}),
  generateSingleton:async(doc,t,s)=>({content:{meaning:'hello',context:'greeting',grammar:'',uncertainty:'',sourceQuote:s.text},actualMicros:1})};
 const studyResult=await executeStage(acquired,study,studyOptions);assert.equal(studyResult.state,'ready');
 const b=finishEdition(acquired,study,studyResult,translations);assert.equal(b.coverage.complete,true);assert.ok(b.artifacts.length>60);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM prepared_generation_runs WHERE state=\'settled\'')).rows[0].n,2);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM membership_usage')).rows[0].n,0);
});
test('missing rights, missing priced review and incomplete manifest stop before provider calls',async t=>{
 const {doc,spec}=preparedInputs();let calls=0;
 await assert.rejects(acquireEdition(spec,{selectionRevision:'test',loadLyrics:()=>{calls++;}}),{code:'source_permission_required'});assert.equal(calls,0);
 const inventory=poolInventory();assert.equal(inventory.recordings,46);assert.ok(inventory.entries.every(e=>e.state==='unqualified'));
 const acquired={doc,spec,acquisitionHash:digest('test')},stage=stagePlan(acquired,{stage:'translations',policy:allDirections});
 await assert.rejects(executeStage(acquired,stage,{apiKey:'test',generateTranslation:()=>assert.fail('generation')}),{code:'source_permission_required'});
});
test('offline ceiling shares ordinary/emergency budget and DB claims prevent duplicate provider spend across machines',async t=>{
 const {db,database}=await setup(t),planID=digest('plan');
 await reservePlanBudget(database,planID,900000);
 await assert.rejects(reservePlanBudget(database,digest('other-plan'),200000),{code:'budget_exhausted'});
 assert.equal(Number((await db.query('SELECT held FROM library_spend_totals')).rows[0].held),900000);
 const task={id:'task',reservationMicros:100},params={planID,task,attempt:1};let calls=0;
 const generate=async()=>{calls++;return {content:{ok:true},actualMicros:2};};
 assert.deepEqual(await budgetedGenerate(database,{...params,generate}),{content:{ok:true},actualMicros:2});
 assert.deepEqual(await budgetedGenerate(database,{...params,generate}),{content:{ok:true},actualMicros:2});assert.equal(calls,1);
 await assert.rejects(budgetedGenerate(database,{...params,task:{...task,id:'ambiguous'},generate:async()=>{throw new Error('network_lost');}}));
 assert.equal((await db.query('SELECT state FROM prepared_generation_runs WHERE plan_id=$1',[planID])).rows[0].state,'unknown');
 await assert.rejects(budgetedGenerate(database,{...params,task:{...task,id:'ambiguous'},generate:()=>assert.fail('retry')}),{code:'provider_outcome_unknown'});
 assert.equal(Number((await db.query('SELECT held FROM library_spend_totals')).rows[0].held),900000);
});
test('known usage overrun is fully accounted and disables ordinary generation, including errors carrying usage',async t=>{
 const {db,database}=await setup(t),planID=digest('overrun');await reservePlanBudget(database,planID,100);
 await assert.rejects(budgetedGenerate(database,{planID,task:{id:'overrun-task',reservationMicros:100},attempt:1,generate:async()=>({content:{ok:true},actualMicros:101})}),e=>e.actualMicros===101);
 const totals=(await db.query('SELECT held FROM library_spend_totals')).rows[0];assert.equal(Number(totals.held),101);
 assert.equal(Number((await db.query('SELECT accounted_micros FROM prepared_generation_attempts')).rows[0].accounted_micros),101);
 assert.equal((await db.query('SELECT enabled FROM library_settings WHERE id=1')).rows[0].enabled,false);
 // A provider failure with known usage is preserved as well.
 await db.query('UPDATE library_settings SET enabled=true WHERE id=1');
 const p2=digest('known-error');await reservePlanBudget(database,p2,100);
 await assert.rejects(budgetedGenerate(database,{planID:p2,task:{id:'error-task',reservationMicros:100},attempt:1,generate:async()=>{throw Object.assign(new Error('provider_failed'),{actualMicros:150});}}));
 assert.equal(Number((await db.query('SELECT accounted_micros FROM prepared_generation_runs WHERE plan_id=$1',[p2])).rows[0].accounted_micros),150);
 assert.equal((await db.query('SELECT enabled FROM library_settings WHERE id=1')).rows[0].enabled,false);
});
test('lowered emergency budget stops a previously reserved offline task before provider submission',async t=>{
 const {db,database}=await setup(t),planID=digest('emergency');await reservePlanBudget(database,planID,100);
 await db.query('UPDATE library_settings SET emergency_daily_micros=99 WHERE id=1');
 await assert.rejects(budgetedGenerate(database,{planID,task:{id:'task',reservationMicros:10},attempt:1,generate:()=>assert.fail('provider')}),{code:'emergency_budget_exhausted'});
 assert.equal((await db.query('SELECT count(*)::int AS n FROM prepared_generation_attempts')).rows[0].n,0);
});
test('reviewed files cannot reduce conservative task reservations or drift body/selector metadata before dispatch',async()=>{
 const {doc,spec}=preparedInputs(),{planTasks}=await import('../../api/utils/prepared-editions/jobs.js');
 const acquired={doc,spec:{...spec,acquisitionReview:{reference:'test-only',selectionRevision:'test',allOrdinaryProviderPathsApproved:true}},acquisitionHash:digest('acquisition')};
 const stage=stagePlan(acquired,{stage:'translations',policy:allDirections});
 for(const mutate of [
  s=>{s.tasks.forEach(t=>{t.reservationMicros=0;});},
  s=>{s.tasks[0].body.instructions='different request';},
  s=>{s.tasks[0].target='en';}
 ]){
  const forged=structuredClone(stage);mutate(forged);forged.plan=planTasks(forged.tasks);
  await assert.rejects(executeStage(acquired,forged,{review:review(forged,0),policy:allDirections,apiKey:'test',database:{transaction:()=>assert.fail('DB admission')},generateTranslation:()=>assert.fail('provider')}),{code:'preparation_plan_changed'});
 }
});
test('native exported-shaped manifest is an explicit CLI input; provisional enumeration is estimate-only',async t=>{
 const {doc,spec,translations,manifest}=preparedInputs(),dir=await mkdtemp(join(tmpdir(),'prepared-native-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const {writeFile}=await import('node:fs/promises'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),exec=promisify(execFile);
 const acquired={version:1,doc,spec:{...spec,acquisitionReview:{reference:'test-only',selectionRevision:'test',allOrdinaryProviderPathsApproved:true}},acquisitionHash:digest('native-cli')};
 for(const [name,value] of [['acquired',acquired],['translations',translations],['native',manifest]])await writeFile(join(dir,name+'.json'),JSON.stringify(value));
 const env={...process.env,LYRICA_TRANSLATION_DIRECTIONS:JSON.stringify(allDirections.translation),LYRICA_EXPLANATION_DIRECTIONS:JSON.stringify(allDirections.explanation)};
 const args=['scripts/prepared-editions.mjs','plan','--input',join(dir,'acquired.json'),'--stage','study','--translations',join(dir,'translations.json')];
 const native=JSON.parse((await exec(process.execPath,[...args,'--native-manifest',join(dir,'native.json')],{env,maxBuffer:10_000_000})).stdout);
 assert.deepEqual(native.manifest,manifest);assert.equal(Object.hasOwn(native.manifest,'rows'),false);
 const legacy=JSON.parse((await exec(process.execPath,[...args,'--native-rows',join(dir,'native.json')],{env,maxBuffer:10_000_000})).stdout);assert.equal(legacy.plan.id,native.plan.id);
 await assert.rejects(exec(process.execPath,args,{env}),e=>e.stderr.includes('native_manifest_required'));
 const provisional=JSON.parse((await exec(process.execPath,[...args,'--provisional'],{env,maxBuffer:10_000_000})).stdout);assert.ok(provisional.manifest.rows);
 await assert.rejects(executeStage(acquired,provisional,{review:review(provisional,0),policy:allDirections,apiKey:'test',translations,database:{transaction:()=>assert.fail('budget')},generateBatch:()=>assert.fail('provider')}),{code:'native_manifest_required'});
 await assert.rejects(async()=>finishEdition(acquired,provisional,{state:'ready',planID:provisional.plan.id},translations),{code:'native_manifest_required'});
});
