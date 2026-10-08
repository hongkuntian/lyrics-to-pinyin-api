import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepare,run} from '../../scripts/evaluate-content-quality.mjs';
import {evaluateContentInBuild} from '../../scripts/content-quality-build.mjs';
const corpus={hypothesis:'test',cases:[{id:'original',phase:'fresh',language:'zh',lines:['我沒有說你離開。','這封信仍留在桌上。'],line:0,text:'沒有',checks:['Preserve negated speech.']}]};
async function fixture(t) {const directory=await fs.mkdtemp(path.join(os.tmpdir(),'content-quality-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
test('paired plan fixes model/whole-song input and budgets both requests before execution',async t=>{
 const directory=await fixture(t),prepared=await prepare({directory,corpus,snapshot:{rows:[]},budgetMicros:5_000_000});
 const plan=JSON.parse(await fs.readFile(path.join(directory,'plan.json')));
 assert.equal(prepared.jobs,2);assert.ok(prepared.maxReservedMicros<prepared.budgetMicros);
 assert.equal(plan.jobs[0].body.model,plan.jobs[1].body.model);assert.equal(plan.jobs[0].body.reasoning.effort,plan.jobs[1].body.reasoning.effort);
 assert.equal(plan.jobs[0].body.input[0].content,plan.jobs[1].body.input[0].content);
});
test('insufficient or unauthorized budget makes no plan',async t=>{
 const directory=await fixture(t);
 for(const budgetMicros of [1,0,5_000_001,NaN])await assert.rejects(prepare({directory,corpus,snapshot:{rows:[]},budgetMicros}));
 await assert.rejects(fs.access(path.join(directory,'plan.json')));
});
test('failed unknown-cost request holds its reservation and the run cannot be resent',async t=>{
 const directory=await fixture(t),prepared=await prepare({directory,corpus,snapshot:{rows:[]},budgetMicros:5_000_000});let calls=0;
 const generated=async()=>{calls++;throw Object.assign(new Error('unavailable'),{code:'provider_unavailable'});};
 const summary=await run({directory,approvedHash:prepared.planHash,apiKey:'test-key',generateFn:generated});
 assert.equal(calls,2);assert.equal(summary.accountedMicros,prepared.maxReservedMicros);assert.equal(summary.results.every(r=>!r.valid),true);
 await assert.rejects(run({directory,approvedHash:prepared.planHash,apiKey:'test-key',generateFn:generated}));assert.equal(calls,2);
});
test('changed plan cannot issue a provider call',async t=>{
 const directory=await fixture(t),prepared=await prepare({directory,corpus,snapshot:{rows:[]},budgetMicros:5_000_000});let calls=0;
 const file=path.join(directory,'plan.json'),plan=JSON.parse(await fs.readFile(file));plan.jobs[0].body.model='other';await fs.writeFile(file,JSON.stringify(plan));
 await assert.rejects(run({directory,approvedHash:prepared.planHash,apiKey:'test-key',generateFn:async()=>{calls++;}}),/plan_changed/);assert.equal(calls,0);
});
test('build evaluation is opt-in, production-only and requires a reviewed plan hash',async()=>{
 await evaluateContentInBuild({});
 await assert.rejects(evaluateContentInBuild({LYRA_CONTENT_QUALITY_EVALUATE_ON_BUILD:'1',VERCEL:'1',VERCEL_ENV:'preview'}),/production_build/);
 await assert.rejects(evaluateContentInBuild({LYRA_CONTENT_QUALITY_EVALUATE_ON_BUILD:'1',VERCEL:'1',VERCEL_ENV:'production'}),/plan_hash/);
});
test('prior uncertain attempts remain inside the same authorized budget',async t=>{
 const directory=await fixture(t);
 await assert.rejects(prepare({directory,corpus,snapshot:{rows:[]},budgetMicros:5_000_000,previousAccountedMicros:5_000_000}),/budget_exceeded/);
});
