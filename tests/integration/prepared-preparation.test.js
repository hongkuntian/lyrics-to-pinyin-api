import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {libraryDB} from '../helpers/library-db.js';
import {preparedInputs,allDirections} from '../helpers/prepared-edition.js';
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
 const options={path:join(dir,'translations.json'),review:review(stage,200000),database,apiKey:'test',generateTranslation:async(doc,{target,generationRequest})=>{calls++;assert.equal(generationRequest.model,stage.tasks[0].body.model);return {content:{lines:fixture.translations[target].lines,sourceNotes:[]},actualMicros:1};}};
 const checkpoint=await executeStage(acquired,stage,options);assert.equal(checkpoint.state,'ready');assert.equal(calls,4);
 await executeStage(acquired,stage,options);assert.equal(calls,4,'resume must not submit twice');
 const translations=finishTranslations(acquired,stage,checkpoint),study=stagePlan(acquired,{stage:'study',translations,policy:allDirections});
 const studyOptions={path:join(dir,'study.json'),review:review(study,500000),database,apiKey:'test',translations,
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
