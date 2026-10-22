import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import * as api from '../../scripts/evaluate-language-expansion.mjs';
import {prepareModelCanaries,describeModelSchedule,prepareModelPartition,bindModel} from '../../scripts/language-expansion/model-plans.mjs';
import {makeSlotProfile,familyOption,assertProfiles,NAMES} from '../../scripts/language-expansion/model-family.mjs';
import {prepareBaseline,bindBaseline} from '../../scripts/language-expansion/baseline.mjs';
import {reservationMicros,usageMicros} from '../../api/utils/song-library/translation.js';
import {responseResult,validateManifest,openAIClient} from '../../scripts/language-expansion/transport.mjs';
import {hash,codeHashes,payloadEvents,recoverPayload} from '../../scripts/language-expansion/common.mjs';
import {transitionLedger,MAX_RECIPE_TRANSITIONS,transitionPlanLocked} from '../../scripts/language-expansion/recipe-transition.mjs';
import {baseEvent,exclusive,validateEvent} from '../../scripts/language-expansion/journal.mjs';
import {fakeResponse,directory,batchObject,byteStream} from '../fixtures/language-expansion.mjs';
const runtime=fileURLToPath(new URL('../../',import.meta.url));
const read=async f=>JSON.parse(await fs.readFile(f,'utf8'));
const named=await prepareModelCanaries();
const id=n=>named.jobs[n-1].id+'--confirmation--'+named.jobs[n-1].confirmationSlot;
async function journal(t,plan=named,prior={}){const d=await directory(t);await api.initJournal(d,prior);await api.registerPlan(d,plan,hash(plan));return d;}
async function settle(d,p,m,response){const ticket=await api.admitShard({directory:d,plan:p,manifest:m,executionID:'synthetic_'+m.jobs[0].id.slice(-16)});let i=0;
 await api.execute({directory:d,plan:p,manifest:m,ticket,operation:'standard',client:{standard:async()=>response??fakeResponse(p,m.jobs[i++])}});return api.snapshot(d);}
async function partition(kind,family,i=0,profile=makeSlotProfile()){const schedule=await describeModelSchedule({kind,modelFamily:family,slotProfile:profile});return prepareModelPartition({kind,modelFamily:family,slotProfile:profile,partitionIndex:i,approvedCompleteScheduleHash:hash(schedule)});}

test('finite options reject raw model/caps/effort/schema/body/callback and unknown family',async()=>{
 for(const o of [{model:'gpt-6.1-sol'},{modelFamily:'other'},{modelFamily:null},{maxOutputTokens:1},{effort:'high'},{schema:{}},{body:{}},{callback:()=>{}}]){
  assert.throws(()=>familyOption(o));await assert.rejects(prepareModelCanaries(o));
 }
 assert.equal(familyOption().model,'gpt-6-luna');assert.equal(familyOption({modelFamily:'r1-sol'}).model,'gpt-6.1-sol');
});
test('fixed thirteen names, nine actual R1 bodies, four genuine unbound fresh parents and one pool',async()=>{
 await api.validatePlan(named,hash(named));assert.equal(named.jobs.length,13);assert.equal(named.jobs.filter(j=>j.body).length,9);assert.equal(named.jobs.filter(j=>j.dependency).length,4);
 assert.deepEqual(named.jobs.map(j=>j.confirmationSlot),NAMES.slice(13,26));assert.equal(named.maxReservedMicros,0);assert.equal(named.confirmationReserveMicros,3657128);
 for(const j of named.jobs){assert.ok(j.templateOnly);assert.equal(j.qualification.positiveFamilyQualification,false);assert.throws(()=>api.shard(named,[j.id]));assert.throws(()=>api.shard(named,[id(j.cell)],{},'batch'));}
 for(const j of named.jobs.filter(j=>j.dependency)){assert.equal(j.body,null);assert.equal(j.bodyJSON,null);assert.throws(()=>api.shard(named,[id(j.cell)]),/parent/);}
 for(const i of [3,9,13])assert.match(named.jobs[i-1].qualification.disposition,/historical/);
 await assert.rejects(api.prepareRecipe({builderPlan:named,namespace:'cannot-wrap',caseIDs:[named.jobs[0].id]}),/cannot_be_wrapped/);
 const luna=await prepareModelCanaries({modelFamily:'r1-luna'});for(const j of luna.jobs.filter(j=>j.body)){
  const {model:a,...x}=j.body,{model:b,...y}=named.jobs[j.cell-1].body;assert.equal(a,'gpt-6-luna');assert.equal(b,'gpt-6.1-sol');assert.deepEqual(x,y);
 }
});
test('full schedules freeze exact 728/724/4 and 113, seeds and complete fixed partition closure',async()=>{
 for(const family of ['r1-luna','r1-sol'])for(const kind of ['genuine728','baseline113']){
  const s=await describeModelSchedule({kind,modelFamily:family});assert.equal(s.jobs.length,kind==='genuine728'?728:113);assert.equal(s.partitions.length,kind==='genuine728'?21:7);
  assert.equal(s.seedIDs.length,kind==='genuine728'?33:0);assert.equal(s.jobs.filter(j=>j.executionDisposition==='static_refusal').length,kind==='genuine728'?4:0);
  assert.equal(new Set(s.partitions.flatMap(p=>p.caseIDs)).size,s.jobs.length);
  for(const p of s.partitions){assert.ok(s.seedIDs.every(id=>p.caseIDs.includes(id)));for(const id of p.caseIDs){const j=s.jobs.find(j=>j.id===id);assert.ok(!j.dependency||p.caseIDs.includes(j.dependency));}}
  await assert.rejects(prepareModelPartition({kind,modelFamily:family,partitionIndex:0,approvedCompleteScheduleHash:'0'.repeat(64)}));
 }
});
test('named manifest reconstitution rejects altered source/model/parent/body/rates/cap/slot/profile and ordinary IDs',async()=>{
 const ready=api.shard(named,[id(1)]);await validateManifest(named,ready,hash(ready));
 for(const mutate of [m=>m.jobs[0].body.model='gpt-6-luna',m=>m.jobs[0].source='ru-a',m=>m.jobs[0].body.instructions+='x',m=>m.jobs[0].reservedMicros--,
 m=>m.jobs[0].body.max_output_tokens--,m=>m.jobs[0].confirmationName='confirmation26',m=>m.jobs[0].id=m.jobs[0].confirmationOf,m=>m.jobs[0].definitionHash='0'.repeat(64),m=>m.jobs[0].dependency='old']){
  const m=structuredClone(ready);mutate(m);await assert.rejects(validateManifest(named,m,hash(m)));
 }
 for(const mutate of [p=>p.jobs[0].modelFamily='r1-luna',p=>p.slotProfile.slots[13].inputRate=0,p=>p.slotProfile.slots[13].reservedMicros--,p=>p.jobs[0].confirmationSlot='confirmation26',p=>p.sources[0].spec.lines[0]='changed',p=>p.jobs[1].dependency='historical',p=>p.completeSchedule={}]){
  const p=structuredClone(named);mutate(p);await assert.rejects(api.validatePlan(p,hash(p)));
 }
 assert.throws(()=>api.shard(named,[id(1),id(1)]));assert.throws(()=>api.shard(named,['unknown']));
});
test('all thirteen actual fixture executions settle once; four deferred binders retain exact fresh parents',async t=>{
 const d=await journal(t);let state;
 for(let n=1;n<=13;n++){
  state=await api.snapshot(d);const m=api.shard(named,[id(n)],state.results);await validateManifest(named,m,hash(m));
  if(m.jobs[0].dependency){const j=m.jobs[0];assert.deepEqual(j.parentResult,state.results[j.dependency]);assert.equal(j.dependencyResultHash,hash(j.parentResult));assert.equal(j.translation.sourceNotes.length,0);
   for(const mutate of [r=>r.id='old',r=>r.actualMicros=null,r=>r.response.model='gpt-6-luna',r=>r.content.lines[0].lyricText+='changed',r=>r.bodyHash='0'.repeat(64)]){const r=structuredClone(j.parentResult);mutate(r);assert.throws(()=>bindModel(named,named.jobs[n-1],r),/parent/);}
  }
  state=await settle(d,named,m);assert.equal(state.results[id(n)].valid,true);assert.equal(state.states[id(n)].state,'settled');assert.equal(state.committedMicros,3657128);
 }
 assert.equal(Object.keys(state.results).length,13);
 await assert.rejects(api.admitShard({directory:d,plan:named,manifest:api.shard(named,[id(1)]),executionID:'duplicate'}),/never_resend/);
});
test('dependent whole occurrence refuses 81 EGC, unknown cost and parent overrun without fallback',()=>{
 const m=api.shard(named,[id(1)]),p=m.jobs[0];
 for(const text of ['e\u0301'.repeat(81),'']){
  const response=fakeResponse(named,p);const content=JSON.parse(response.output[0].content[0].text);for(const key of Object.keys(content.translations))content.translations[key]=text;response.output[0].content[0].text=JSON.stringify(content);
  const r=responseResult(named,p,response,'standard');assert.throws(()=>bindModel(named,named.jobs[1],r),/selection|parent/);
 }
 const good=responseResult(named,p,fakeResponse(named,p),'standard');for(const amount of [null,p.reservedMicros+1])assert.throws(()=>bindModel(named,named.jobs[1],{...good,actualMicros:amount}),/parent/);
});
test('baseline coalesces unchanged 38 ready/75 deferred and tests actual v1 plus v2 binders',async()=>{
 const p=await prepareBaseline();assert.equal(p.jobs.length,113);assert.equal(p.jobs.filter(j=>j.body).length,38);assert.equal(p.maxReservedMicros,780573);
 await api.validatePlan(p,hash(p));for(const child of [p.jobs.find(j=>j.studyVersion===1),p.jobs.find(j=>j.kind==='translated')]){
  const parent=p.jobs.find(j=>j.id===child.dependency),r=responseResult(p,parent,fakeResponse(p,parent),'standard');assert.equal(r.valid,true);
  const j=bindBaseline(p,child,r),m=api.shard(p,[child.id],{[parent.id]:r});assert.ok(j.body);await validateManifest(p,m,hash(m));
 }
});
test('profile registration is immutable on same code; all pending ordinary work remains fully reserved',async t=>{
 const d=await journal(t);const p=await partition('baseline113','r1-luna');await api.registerPlan(d,p,hash(p));
 let state=await api.snapshot(d);assert.equal(state.committedMicros,3657128+p.maxReservedMicros);
 const luna=await prepareModelCanaries({modelFamily:'r1-luna'});await assert.rejects(api.registerPlan(d,luna,hash(luna)),/profile/);
 await assert.rejects(api.registerPlan(d,await prepareBaseline(),hash(await prepareBaseline())),/profile/);
 assert.equal((await api.snapshot(d)).committedMicros,state.committedMicros);
});
test('whole-chunk ordered registration deduplicates exact new seeds; missing order and overbudget writes refuse',async t=>{
 const d=await journal(t);const p0=await partition('genuine728','r1-sol'),p1=await partition('genuine728','r1-sol',1),p2=await partition('genuine728','r1-sol',2);
 await assert.rejects(api.registerPlan(d,p1,hash(p1)),/order/);await api.registerPlan(d,p0,hash(p0));
 const before=await api.snapshot(d);await api.registerPlan(d,p0,hash(p0));assert.equal((await api.snapshot(d)).committedMicros,before.committedMicros);
 await api.registerPlan(d,p1,hash(p1));const state=await api.snapshot(d);
 const unique=new Map([...p0.jobs,...p1.jobs].map(j=>[j.id,j]));assert.equal(state.committedMicros,3657128+[...unique.values()].reduce((n,j)=>n+j.reservedMicros,0));
 const limited=await journal(t,named,{priorMicros:14000000});await assert.rejects(api.registerPlan(limited,p0,hash(p0)),/budget/);
 assert.equal((await api.snapshot(limited)).plans.length,1);assert.equal(p2.partitionIndex,2);
});
test('Both families require new33; diagnostic13 and baseline remain Standard-only',async t=>{
 const p=await partition('genuine728','r1-luna'),d=await journal(t,p),ready=p.jobs.find(j=>j.body),m=api.shard(p,[ready.id],{},'batch');
 await assert.rejects(api.admitShard({directory:d,plan:p,manifest:m,executionID:'no_old_seed',batchAccepted:true,representativeReviewed:true}),/standard_review/);
 const psol=await partition('genuine728','r1-sol'),base=await partition('baseline113','r1-luna');
 const solDir=await journal(t,psol),solManifest=api.shard(psol,[psol.jobs.find(j=>j.body).id],{},'batch');
 await assert.rejects(api.admitShard({directory:solDir,plan:psol,manifest:solManifest,executionID:'no_borrowed33',batchAccepted:true,representativeReviewed:true,solSeedDualReviewed:true,solBatchCapacityReviewed:true}),/standard_review/);assert.throws(()=>api.shard(base,[base.jobs.find(j=>j.body).id],{},'batch'),/standard_only/);
 for(const seed of p.seedIDs)assert.match(seed,/^r1-luna-genuine728--/);
});
test('same-request HTTP nonOK is bounded, sanitized, bound to exact request and preserves unknown full hold',async t=>{
 const d=await journal(t),m=api.shard(named,[id(1)]);let calls=0;
 const client=openAIClient({apiKey:'fixture_private_key',fetchFn:async(url,options)=>{
  calls++;assert.equal(options.body,m.jobs[0].bodyJSON);return new Response(JSON.stringify({error:{message:'fixture_private_key do not echo',code:'model_not_found',type:'invalid_request_error'}}),{status:403,headers:{'x-request-id':'req_fixture'}});
 }});
 const ticket=await api.admitShard({directory:d,plan:named,manifest:m,executionID:'http_once'});
 await assert.rejects(api.execute({directory:d,plan:named,manifest:m,ticket,operation:'standard',client}),/stop_reconcile/);
 const state=await api.snapshot(d),r=state.results[id(1)];assert.equal(calls,1);assert.equal(r.actualMicros,null);assert.equal(state.states[id(1)].state,'unknown_cost');assert.equal(state.committedMicros,3657128);
 assert.equal(r.httpObservation.requestBodyHash,m.jobs[0].bodyHash);assert.equal(r.httpObservation.status,403);assert.equal(r.httpObservation.providerRequestID,'req_fixture');assert.equal(r.httpObservation.code,'model_not_found');assert.equal(r.response,null);
 assert.ok(!JSON.stringify(state).includes('fixture_private_key'));
 await assert.rejects(api.admitShard({directory:d,plan:named,manifest:api.shard(named,[id(4)]),executionID:'no_fallback'}),/unresolved/);assert.equal(calls,1);
});
test('same-request observation truncates huge error and drops unallowlisted code/type/IDs',async()=>{
 const m=api.shard(named,[id(1)]);let count=0;
 const client=openAIClient({apiKey:'fixture',fetchFn:async()=>{count++;return new Response('x'.repeat(20000),{status:429,headers:{'x-request-id':'unsafe value fixture'}});}});
 await assert.rejects(client.standard(m.jobs[0].bodyJSON,270000),e=>{const o=e.providerObservation;assert.equal(o.bytes,16384);assert.equal(o.complete,false);assert.equal(o.providerRequestID,null);assert.equal(o.code,null);return true;});assert.equal(count,1);
});
test('unknown and actual overrun block admissions; no zero-cost refusal or released ordinary holds',async t=>{
 const p=await partition('baseline113','r1-luna'),d=await journal(t,p),job=p.jobs.find(j=>j.body),m=api.shard(p,[job.id]);
 const response=fakeResponse(p,job,{usage:{input_tokens:24000,output_tokens:999999}});await assert.rejects(settle(d,p,m,response),/stop_reconcile/);
 const s=await api.snapshot(d);assert.equal(s.states[job.id].state,'cost_overrun');assert.ok(s.committedMicros>p.maxReservedMicros+3657128);
 await assert.rejects(api.admitShard({directory:d,plan:p,manifest:api.shard(p,[p.jobs.find(j=>j.body&&j.id!==job.id).id]),executionID:'no_next'}),/unresolved/);
});
test('synthetic prior root/prefix/unknown holds survive interrupted explicit transition and exact resume',async t=>{
 const legacy=await directory(t);
 await fs.cp(path.join(runtime,'tests/fixtures/language-expansion-legacy'),legacy,{recursive:true});
 for(const name of ['api','shared','contracts','node_modules','package.json','package-lock.json'])await fs.symlink(path.join(runtime,name),path.join(legacy,name));
 await fs.symlink(path.join(runtime,'scripts/evaluate-content-quality.mjs'),path.join(legacy,'scripts/evaluate-content-quality.mjs'));
 const old=await import(pathToFileURL(path.join(legacy,'scripts/evaluate-language-expansion.mjs')).href);
 const args=(await read(path.join(runtime,'scripts/language-expansion/model-authored.json'))).args;
 const p=await old.preparePlan(args);
 const d=await directory(t);await old.initJournal(d,{priorMicros:30074,unknownHeldMicros:37});await old.registerPlan(d,p,hash(p));
 const m=old.shard(p,[p.jobs[0].id+'--confirmation--confirmation01']),ticket=await old.admitShard({directory:d,plan:p,manifest:m,executionID:'synthetic_old'});
 await old.execute({directory:d,plan:p,manifest:m,ticket,operation:'standard',client:{standard:async()=>fakeResponse(p,m.jobs[0],{usage:null})}}).catch(e=>assert.match(e.message,/stop_reconcile/));
 const prefix=await fs.readFile(path.join(d,'journal.jsonl')),root=await fs.readFile(path.join(d,'root.json'));
 await assert.rejects(exclusive(d,()=>transitionPlanLocked(d,named,hash(named),legacy,[],{replayRoot:os.tmpdir(),append:async()=>{throw Error('fixture_before_anchor');}})),/fixture_before_anchor/);
 await assert.rejects(api.snapshot(d),/anchor_missing/);
 await api.transitionPlan(d,named,hash(named),legacy,[],{replayRoot:os.tmpdir()});const s=await api.snapshot(d);
 assert.deepEqual(await fs.readFile(path.join(d,'root.json')),root);assert.deepEqual((await fs.readFile(path.join(d,'journal.jsonl'))).subarray(0,prefix.length),prefix);
 assert.equal(s.priorMicros,30074);assert.equal(s.unknownHeldMicros,37);assert.equal(s.states[m.jobs[0].id].state,'unknown_cost');assert.equal(s.results[m.jobs[0].id].actualMicros,null);assert.equal(s.recipeTransitions.length,1);assert.equal(MAX_RECIPE_TRANSITIONS,4);
 assert.equal(s.committedMicros,30074+37+p.maxReservedMicros+3657128);
 const next=await partition('baseline113','r1-luna');await api.registerPlan(d,next,hash(next));assert.equal((await api.snapshot(d)).recipeTransitions.length,1);
 await assert.rejects(api.admitShard({directory:d,plan:named,manifest:api.shard(named,[id(1)]),executionID:'unknown_still_blocks'}),/unresolved/);
});

test('consumed legacy names are immutable including unknown admissions; profile increases are not a second pool',()=>{
 const p={...named,codeHashes:{legacy:'synthetic'},slotProfile:undefined};
 const m={planHash:hash(p),jobs:[{id:'legacy',confirmationName:'confirmation14'}]};
 assert.throws(()=>assertProfiles([p,named],{manifests:[m]}),/admitted_slot/);
 const safe={...m,jobs:[{id:'legacy',confirmationName:'confirmation01'}]};assert.equal(assertProfiles([p,named],{manifests:[safe]}).slots.length,60);
 const state={priorMicros:30074,unknownHeldMicros:100,results:{},manifests:[]};
 assert.equal(transitionLedger(state,[named],{}),30074+100+3657128);
});

test('finite reviewed Sol Batch price is separate from eligibility; old Luna Batch unchanged',()=>{
 const job=named.jobs[0];assert.equal(reservationMicros(job.body,{batch:true}),Math.ceil((Buffer.byteLength(job.bodyJSON)+4096)*1.25+32768*5));
 assert.equal(usageMicros({input_tokens:100,output_tokens:100},'gpt-6.1-sol',{batch:true}),625);
 assert.equal(usageMicros({input_tokens:100,output_tokens:100},'gpt-6-luna',{batch:true}),32);
 assert.throws(()=>responseResult(named,job,fakeResponse(named,job),'batch'),/descriptor/);
});

test('imported model result content, validity and costs are reconstructed before any seed qualification',async t=>{
 for(const mutate of [r=>r.valid=false,r=>r.content.lines[0].lyricText+='forged',r=>{r.actualMicros=0;r.accountedMicros=0;},r=>r.transport='batch']) {
  const d=await journal(t),m=api.shard(named,[id(1)]),ticket=await api.admitShard({directory:d,plan:named,manifest:m,executionID:'synthetic_import'});
  await api.claimStart(d,ticket);const r=responseResult(named,m.jobs[0],fakeResponse(named,m.jobs[0]),'standard');mutate(r);
  await assert.rejects(api.importEvents(d,payloadEvents(baseEvent(m,m.jobs[0]),r)),/reconstruction|transport_changed/);
  const state=await api.snapshot(d);assert.equal(state.results[id(1)],undefined);assert.equal(state.states[id(1)].state,'unknown');assert.equal(state.committedMicros,3657128);
 }
});
test('partition zero freezes full definition once; later plans carry its exact hash and cannot mutate cached builders',async()=>{
 const p0=await partition('genuine728','r1-luna'),p1=await partition('genuine728','r1-luna',1);
 assert.ok(p0.completeSchedule);assert.equal(p1.completeSchedule,null);assert.equal(p0.completeScheduleHash,p1.completeScheduleHash);
 p0.jobs[0].body.model='forged';p0.completeSchedule.jobs[0].bodyHash='forged';
 const fresh=await partition('genuine728','r1-luna');await api.validatePlan(fresh,hash(fresh));assert.equal(fresh.jobs[0].body.model,'gpt-6-luna');
});

test('added sf07 Study diagnostic preserves exact historical whole L0001 and both DE/ID languages',()=>{
 const added=named.jobs[12];assert.equal(added.source,'id-a');assert.equal(added.target,'zh-Hans');assert.equal(added.explanation,'zh-Hans');assert.equal(added.selection.sourceID,'L0001');assert.equal(added.qualification.positiveFamilyQualification,false);assert.equal(added.dependency,undefined);assert.ok(added.historicalParentHash);assert.ok(added.historicalRequestBinding.parentBinding);const row=added.translation.lines.find(l=>l.sourceID==='L0001').lyricText;assert.equal(added.selection.lower,0);assert.equal(added.selection.text,row);assert.equal(added.selection.upper,[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(row)].length);assert.equal(named.jobs[11].source,'de-a');
 assert.equal(named.jobs.filter(j=>j.kind==='translation').length,5);assert.equal(named.jobs.filter(j=>j.kind!=='translation').length,8);
 assert.equal(named.slotProfile.slots.slice(13,26).reduce((n,s)=>n+s.reservedMicros,0),2746080);assert.equal(3657128-1163040,2494088);assert.equal(17766898+81576,17848474);
});

test('Sol Batch admission needs exact new33 Standard outputs plus explicit dual-review/capacity/entitlement; no dispatch fallback',async t=>{
 const p0=await partition('genuine728','r1-sol'),d=await journal(t,p0);
 for(const dependent of [false,true]) {
  const ids=p0.seedIDs.filter(id=>Boolean(p0.jobs.find(j=>j.id===id).dependency)===dependent);
  for(let i=0;i<ids.length;i+=4){const state=await api.snapshot(d);await settle(d,p0,api.shard(p0,ids.slice(i,i+4),state.results));}
 }
 const s=await api.snapshot(d);assert.equal(Object.keys(s.results).length,33);assert.ok(p0.seedIDs.every(id=>s.states[id].transport==='standard'&&s.results[id].valid));
 const p1=await partition('genuine728','r1-sol',1);await api.registerPlan(d,p1,hash(p1));const j=p1.jobs.find(j=>j.body&&!p1.seedIDs.includes(j.id)),m=api.shard(p1,[j.id],{},'batch');
 const corrupted=structuredClone(m);corrupted.jobs[0].batchPriceDescriptor.input=0;await assert.rejects(validateManifest(p1,corrupted,hash(corrupted)),/manifest_changed/);
 const hold=responseResult(p1,j,null,'batch','batch_case_error');assert.equal(hold.actualMicros,null);assert.equal(hold.accountedMicros,j.reservedMicros);
 const args={directory:d,plan:p1,manifest:m,executionID:'fixture_sol_batch',batchAccepted:true,representativeReviewed:true};
 for(const flags of [{},{solSeedDualReviewed:true},{solBatchCapacityReviewed:true}])await assert.rejects(api.admitShard({...args,...flags}),/dual_review_and_capacity/);
 const ticket=await api.admitShard({...args,solSeedDualReviewed:true,solBatchCapacityReviewed:true});assert.equal(ticket.transport,'batch');
 const result=responseResult(p1,j,fakeResponse(p1,j),'batch');assert.equal(result.actualMicros,625);assert.equal(result.valid,true);assert.equal(j.reservedMicros,reservationMicros(j.body));
 const batch=batchObject(m),raw=JSON.stringify({custom_id:j.id,response:{status_code:200,body:fakeResponse(p1,j)},error:null})+'\n';
 const client={upload:async()=>({id:'file-input'}),create:async()=>batch,inspect:async()=>batch,file:async()=>byteStream(raw)};
 await api.execute({directory:d,plan:p1,manifest:m,ticket,operation:'submit',client});
 await api.execute({directory:d,plan:p1,manifest:m,ticket,operation:'retrieve',client,selectedCaseID:j.id});
 let recovered=await api.snapshot(d);assert.equal(recovered.results[j.id].actualMicros,625);assert.equal(recovered.shardStates[hash(m)].state,'unresolved');
 const next=p1.jobs.find(x=>x.body&&!recovered.states[x.id]);await assert.rejects(api.admitShard({directory:d,plan:p1,manifest:api.shard(p1,[next.id]),executionID:'barrier_still_held'}),/unresolved/);
 await api.finalizeBatch(d,hash(m));recovered=await api.snapshot(d);assert.equal(recovered.shardStates[hash(m)].state,'reconciled');
 await assert.rejects(api.admitShard({...args,solSeedDualReviewed:true,solBatchCapacityReviewed:true}),/never_resend/);
});

test('indexed terminal validation still requires an existing exact immutable shard',()=>{
 assert.throws(()=>validateEvent({schema:'language-expansion-1',event:'language_expansion_terminal',planHash:undefined,shardHash:undefined,intentionalBuildFailure:true,operation:'standard',state:'evaluation_only_complete'},[]),/invalid_terminal/);
});

test('caller-owned profile mutation cannot poison a cached complete schedule or its approved hash',async()=>{
 const profile=makeSlotProfile(),schedule=await describeModelSchedule({kind:'genuine728',modelFamily:'r1-luna',slotProfile:profile});
 const p=await prepareModelPartition({kind:'genuine728',modelFamily:'r1-luna',partitionIndex:0,slotProfile:profile,approvedCompleteScheduleHash:hash(schedule)});
 profile.slots[13].model='forged';profile.slots[13].reservedMicros=0;
 await api.validatePlan(p,hash(p));assert.equal(hash(p.completeSchedule),p.completeScheduleHash);
 const fresh=await partition('genuine728','r1-luna');assert.equal(hash(fresh.completeSchedule),fresh.completeScheduleHash);
});


test('standalone baseline imports reconstruct parsed content and usage before releasing any hold',async t=>{
 const p=await prepareBaseline();
 for(const kind of ['translation','original'])for(const corruption of ['content','cost','both']){
  const d=await directory(t);await api.initJournal(d);await api.registerPlan(d,p,hash(p));
  const j=p.jobs.find(j=>j.body&&j.kind===kind),m=api.shard(p,[j.id]);
  const ticket=await api.admitShard({directory:d,plan:p,manifest:m,executionID:'baseline_'+kind+'_'+corruption});await api.claimStart(d,ticket);
  const before=await api.snapshot(d),r=responseResult(p,j,fakeResponse(p,j),'standard');
  assert.equal(r.valid,true);assert.equal(r.actualMicros,63);
  if(corruption!=='cost'){
   if(kind==='translation')r.content.lines[0].lyricText='FORGED parsed content';else r.content.meaning='FORGED parsed teaching';
  }
  if(corruption!=='content'){r.actualMicros=0;r.accountedMicros=0;}
  await assert.rejects(api.importEvents(d,payloadEvents(baseEvent(m,j),r)),/model_result_reconstruction_changed/);
  const after=await api.snapshot(d);assert.equal(after.results[j.id],undefined);assert.equal(after.states[j.id].state,'unknown');
  assert.equal(after.committedMicros,before.committedMicros);
  const next=p.jobs.find(x=>x.body&&x.id!==j.id);
  await assert.rejects(api.admitShard({directory:d,plan:p,manifest:api.shard(p,[next.id]),executionID:'no_released_hold'}),/unresolved/);
 }
});
test('standalone baseline imports retain exact parser output and known usage for legitimate results',async t=>{
 const p=await prepareBaseline();
 for(const kind of ['translation','original']){
  const d=await directory(t);await api.initJournal(d);await api.registerPlan(d,p,hash(p));
  const j=p.jobs.find(j=>j.body&&j.kind===kind),m=api.shard(p,[j.id]);
  const ticket=await api.admitShard({directory:d,plan:p,manifest:m,executionID:'baseline_legitimate_'+kind});await api.claimStart(d,ticket);
  const r=responseResult(p,j,fakeResponse(p,j),'standard');assert.equal(r.valid,true);assert.equal(r.actualMicros,63);
  await api.importEvents(d,payloadEvents(baseEvent(m,j),r));
  const state=await api.snapshot(d);assert.deepEqual(state.results[j.id],r);assert.equal(state.states[j.id].state,'settled');
  assert.equal(state.committedMicros,p.confirmationReserveMicros+p.maxReservedMicros-j.reservedMicros+r.actualMicros);
 }
});


test('redacted Standard completions stay replayable with full holds for baseline, named and partition routes',async t=>{
 const plans=[await prepareBaseline(),named,await partition('genuine728','r1-sol')];
 for(const p of plans)for(const kind of ['translation','original']){
  const d=await directory(t);await api.initJournal(d);await api.registerPlan(d,p,hash(p));
  const template=p.jobs.find(j=>j.body&&j.kind===kind),id=p.mode==='named-model-canaries-r1'?template.id+'--confirmation--'+template.confirmationSlot:template.id;
  const m=api.shard(p,[id]),j=m.jobs[0],ticket=await api.admitShard({directory:d,plan:p,manifest:m,executionID:'redacted_'+kind});
  const before=await api.snapshot(d),secret='FIXTURE_ONLY_REDACTION_MARKER_7925',response=fakeResponse(p,j);response.fixtureEcho=secret;
  assert.equal(responseResult(p,j,response,'standard').actualMicros,j.body.model==='gpt-6.1-sol'?1250:63);
  let calls=0;await assert.rejects(api.execute({directory:d,plan:p,manifest:m,ticket,operation:'standard',secret,client:{standard:async()=>{calls++;return response;}}}),/stop_reconcile_unknown_or_configuration/);
  assert.equal(calls,1);const state=await api.snapshot(d),result=state.results[id];
  assert.equal(result.error,'provider_echoed_credentials');assert.equal(result.response,null);assert.equal(result.valid,false);
  assert.equal(result.actualMicros,null);assert.equal(result.accountedMicros,j.reservedMicros);assert.equal(state.states[id].state,'unknown_cost');
  assert.equal(state.committedMicros,before.committedMicros);
  assert.equal(hash(result),hash(responseResult(p,j,null,'standard','provider_echoed_credentials')));
  assert.equal((await fs.readFile(path.join(d,'journal.jsonl'),'utf8')).includes(secret),false);
  await api.importEvents(d,[]);assert.deepEqual((await api.snapshot(d)).results[id],result);
  const next=p.jobs.find(x=>x.body&&x.id!==template.id),nextID=p.mode==='named-model-canaries-r1'?next.id+'--confirmation--'+next.confirmationSlot:next.id;
  await assert.rejects(api.admitShard({directory:d,plan:p,manifest:api.shard(p,[nextID]),executionID:'no_automatic_fallback'}),/unresolved/);
 }
});
