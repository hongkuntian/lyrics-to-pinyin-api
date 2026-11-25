import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planTasks,pricePlan,runPreparationJob} from '../../api/utils/prepared-editions/jobs.js';

async function jobPath(t){const dir=await mkdtemp(join(tmpdir(),'prepared-job-'));t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'job.json');}
const task=(id='one',reservationMicros=100)=>({id,body:{input:id},reservationMicros});

test('plans deterministically deduplicate identical work and reject conflicting IDs',()=>{
 const a=task(),b={...a,body:{input:'one'}};
 assert.deepEqual(planTasks([a,b]),planTasks([a]));
 assert.equal(planTasks([task('two'),a]).id,planTasks([a,task('two')]).id);
 assert.throws(()=>planTasks([a,{...a,body:{input:'different'}}]),/conflicting_task_id/);
 assert.throws(()=>planTasks([{...a,reservationMicros:-1}]),/invalid_task/);
});

test('pricing enumerates the exact unique work and separates pilot estimate from conservative reservation',()=>{
 const plan=planTasks([task(),task(),task('two',200)]);
 const price=pricePlan(plan,{pilotUsage:{input_tokens:100,output_tokens:20},rates:{input:0.125,output:0.5},retryAllowance:1});
 assert.equal(price.currency,'USD');assert.equal(price.tasks,2);assert.equal(price.maxAttempts,4);
 assert.equal(price.estimatedMicros,90);assert.equal(price.reservationMicros,600);
 assert.throws(()=>pricePlan(plan,{pilotUsage:{input_tokens:1,output_tokens:1},rates:{input:1,output:1},retryAllowance:3}),/invalid_retry_allowance/);
});

test('ready work is reused on restart and known usage frees unused reservation',async t=>{
 const path=await jobPath(t),plan=planTasks([task(),task('two')]);let calls=0;
 const generate=async t=>{calls++;return {content:{id:t.id},actualMicros:20};};
 const first=await runPreparationJob({path,plan,ceilingMicros:120,generate});
 assert.equal(first.state,'ready');assert.equal(first.chargedMicros,40);assert.equal(calls,2);
 const resumed=await runPreparationJob({path,plan,ceilingMicros:120,generate});
 assert.equal(resumed.state,'ready');assert.equal(calls,2);
 assert.deepEqual(resumed.tasks.map(t=>t.content),[{id:'one'},{id:'two'}]);
});

test('currency ceiling is persisted before calls and prevents the next paid attempt',async t=>{
 const path=await jobPath(t),plan=planTasks([task(),task('two')]);let calls=0;
 const state=await runPreparationJob({path,plan,ceilingMicros:150,generate:async()=>{calls++;return {content:{},actualMicros:100};}});
 assert.equal(calls,1);assert.equal(state.state,'pending');assert.equal(state.blockedCode,'currency_ceiling');assert.equal(state.chargedMicros,100);
 assert.equal(state.tasks[1].attempts.length,0);
 await assert.rejects(runPreparationJob({path,plan,ceilingMicros:200,generate:async()=>assert.fail()}),/job_configuration_changed/);
});

test('bounded safe retries are charged cumulatively; ambiguous provider errors never retry',async t=>{
 const path=await jobPath(t),plan=planTasks([task()]);let calls=0;
 const state=await runPreparationJob({path,plan,ceilingMicros:150,retryAllowance:1,generate:async()=>{
  calls++;if(calls===1)throw Object.assign(new Error('safe'),{safeToRetry:true,actualMicros:50});
  return {content:{ok:true},actualMicros:20};
 }});
 assert.equal(calls,2);assert.equal(state.state,'ready');assert.equal(state.chargedMicros,70);assert.equal(state.tasks[0].attempts.length,2);
 const ambiguousPath=path+'-ambiguous';calls=0;
 const unknown=await runPreparationJob({path:ambiguousPath,plan,ceilingMicros:1000,retryAllowance:2,generate:async()=>{calls++;throw Object.assign(new Error('lost reply'),{safeToRetry:true});}});
 assert.equal(calls,1);assert.equal(unknown.state,'unknown');assert.equal(unknown.chargedMicros,100);
 await runPreparationJob({path:ambiguousPath,plan,ceilingMicros:1000,retryAllowance:2,generate:async()=>assert.fail('ambiguous retry')});
});

test('a persisted running attempt resumes as unknown and retains its full reservation',async t=>{
 const path=await jobPath(t),plan=planTasks([task()]);
 // The callback sees a durable running reservation, before provider work starts.
 let saved;
 await runPreparationJob({path,plan,ceilingMicros:100,generate:async()=>{saved=JSON.parse(await readFile(path,'utf8'));return {content:{ok:true},actualMicros:20};}});
 assert.equal(saved.tasks[0].state,'running');assert.equal(saved.tasks[0].attempts[0].chargedMicros,100);
 await writeFile(path,JSON.stringify(saved));
 const resumed=await runPreparationJob({path,plan,ceilingMicros:100,generate:async()=>assert.fail('must not retry interrupted work')});
 assert.equal(resumed.state,'unknown');assert.equal(resumed.chargedMicros,100);assert.equal(resumed.tasks[0].attempts[0].state,'unknown');
});

test('exclusive job lock prevents concurrent spend and unknown successful usage remains reserved',async t=>{
 const path=await jobPath(t),plan=planTasks([task()]);let release,entered;
 const started=new Promise(resolve=>{entered=resolve;}),pending=new Promise(resolve=>{release=resolve;});
 const run=runPreparationJob({path,plan,ceilingMicros:100,generate:async()=>{entered();await pending;return {content:{ok:true},actualMicros:null};}});
 await started;
 await assert.rejects(runPreparationJob({path,plan,ceilingMicros:100,generate:async()=>assert.fail('concurrent spend')}),/job_locked/);
 release();const state=await run;
 assert.equal(state.state,'unknown');assert.equal(state.chargedMicros,100);assert.equal(state.tasks[0].state,'unknown');
});

test('retry allowance is a lifetime bound and an underestimated reservation stops further work',async t=>{
 const path=await jobPath(t),plan=planTasks([task()]);let calls=0;
 const exhausted=await runPreparationJob({path,plan,ceilingMicros:1000,retryAllowance:1,generate:async()=>{calls++;throw Object.assign(new Error('safe rejection'),{safeToRetry:true,actualMicros:10});}});
 assert.equal(calls,2);assert.equal(exhausted.state,'unknown');assert.equal(exhausted.tasks[0].code,'retry_exhausted');assert.equal(exhausted.chargedMicros,20);
 await runPreparationJob({path,plan,ceilingMicros:1000,retryAllowance:1,generate:async()=>assert.fail('retry allowance reset')});
 const overrun=await runPreparationJob({path:path+'-overrun',plan:planTasks([task(),task('two')]),ceilingMicros:200,generate:async()=>({content:{ok:true},actualMicros:110})});
 assert.equal(overrun.state,'unknown');assert.equal(overrun.tasks[0].code,'reservation_exceeded');assert.equal(overrun.chargedMicros,110);assert.equal(overrun.tasks[1].attempts.length,0);
});
