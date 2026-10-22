import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {planFixture,corpus,routeOptions,fakeResponse,directory} from '../fixtures/language-expansion.mjs';
import {hash,codeHashes} from '../../scripts/language-expansion/common.mjs';
import {shard,validatePlan,preparePlan,CONFIRMATION_RESERVE} from '../../scripts/language-expansion/plan.mjs';
import {snapshot,registerPlan,handoverPlan,admitShard,importEvents} from '../../scripts/language-expansion/journal.mjs';

async function legacyFixture(t, options = {}) {
  const root=await directory(t), project=fileURLToPath(new URL('../../',import.meta.url));
  await fs.cp(fileURLToPath(new URL('../fixtures/language-expansion-legacy/',import.meta.url)),root,{recursive:true});
  for(const name of ['api','shared','contracts','node_modules','package.json','package-lock.json'])await fs.symlink(path.join(project,name),path.join(root,name));
  await fs.symlink(path.join(project,'scripts/evaluate-content-quality.mjs'),path.join(root,'scripts/evaluate-content-quality.mjs'));
  const api=await import(pathToFileURL(path.join(root,'scripts/evaluate-language-expansion.mjs')).href);
  const plan=await api.preparePlan({corpus,approvedCorpusHash:hash(corpus),...routeOptions,...options});
  const dir=await directory(t);await api.initJournal(dir,{priorMicros:137,unknownHeldMicros:251});await api.registerPlan(dir,plan,hash(plan));
  return {api,plan,dir,root};
}
async function oldRun(old,ids,extras={}) {
  const current=await old.api.snapshot(old.dir),m=old.api.shard(old.plan,ids,current.results);
  const ticket=await old.api.admitShard({directory:old.dir,plan:old.plan,manifest:m,executionID:'old_'+ids[0]});let i=0;
  await old.api.execute({directory:old.dir,plan:old.plan,manifest:m,ticket,operation:'standard',client:{standard:async()=>fakeResponse(old.plan,m.jobs[i++],extras)}});
}

test('validated handover preserves 33 frozen Standard outputs, all 60 confirmations, old identities and global ledger', async t=>{
  const confirmationNames=Array.from({length:60},(_,i)=>'confirmation'+String(i+1).padStart(2,'0'));
  const old=await legacyFixture(t,{confirmationNames}),next=await preparePlan({corpus,approvedCorpusHash:hash(corpus),...routeOptions,confirmationNames});
  for(const dependent of [false,true]) {
    const ids=old.plan.seedIDs.filter(id=>(old.plan.jobs.find(j=>j.id===id).kind==='translated')===dependent);
    for(let i=0;i<ids.length;i+=4)await oldRun(old,ids.slice(i,i+4));
  }
  const before=await old.api.snapshot(old.dir),oldJournal=await fs.readFile(path.join(old.dir,'journal.jsonl'));
  assert.equal(Object.keys(before.results).length,33);
  const missing=await planFixture();await assert.rejects(handoverPlan(old.dir,missing,hash(missing),old.root),/handover_generation_identity_changed/);
  await assert.rejects(validatePlan(old.plan,hash(old.plan)),/retrieval_policy_changed|generation_code_changed/);
  await assert.rejects(registerPlan(old.dir,next,hash(next)),/retrieval_policy_changed|generation_code_changed/);
  const cli=fileURLToPath(new URL('../../scripts/evaluate-language-expansion.mjs',import.meta.url)),planPath=path.join(old.dir,'next.json');await fs.writeFile(planPath,JSON.stringify(next));
  const run=spawnSync(process.execPath,[cli,'handover','--journal',old.dir,'--plan',planPath,'--approved-plan-hash',hash(next),'--legacy-code-root',old.root],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);const after=await snapshot(old.dir);
  assert.equal(hash(before.results),hash(after.results));assert.equal(after.committedMicros,before.committedMicros);
  assert.equal(after.priorMicros,137);assert.equal(after.unknownHeldMicros,251);assert.equal(hash(after.staticRefusals),hash(before.staticRefusals));
  assert.deepEqual(after.plans.find(p=>hash(p)===hash(old.plan)),old.plan);
  assert.deepEqual(next.confirmationNames,old.plan.confirmationNames);assert.equal(next.confirmationReserveMicros,60*CONFIRMATION_RESERVE);
  assert.equal(after.manifests.filter(m=>m.jobs.some(j=>j.confirmationName)).length,0);
  assert.equal(hash(await fs.readFile(path.join(old.dir,'journal.jsonl'))),hash(oldJournal));
  for(const id of old.plan.seedIDs)await assert.rejects(admitShard({directory:old.dir,plan:next,manifest:shard(next,[id],after.results),executionID:'never_resubmit'}),/never_resend/);
  const job=next.jobs.find(j=>j.body&&!after.states[j.id]);
  const batch=shard(next,[job.id],after.results,'batch');await admitShard({directory:old.dir,plan:next,manifest:batch,executionID:'new_batch',representativeReviewed:true,batchAccepted:true});
  // Re-entry verifies the immutable legacy prefix, then the new suffix.
  const final=await snapshot(old.dir);assert.equal(final.committedMicros,before.committedMicros);
  await assert.rejects(importEvents(old.dir,[before.events.find(e=>e.event==='language_expansion_submitting')]),/legacy_executor_prefix_sealed/);
  const original=await fs.readFile(path.join(old.root,'scripts/language-expansion/common.mjs'));
  await fs.appendFile(path.join(old.root,'scripts/language-expansion/common.mjs'),'\n// mutation\n');
  await assert.rejects(snapshot(old.dir),/legacy_generation_code_changed/);
  await fs.writeFile(path.join(old.root,'scripts/language-expansion/common.mjs'),original);
  await fs.writeFile(path.join(old.root,'scripts/language-expansion/unlisted.mjs'),'export {};');
  await assert.rejects(snapshot(old.dir),/legacy_generation_code_changed/);
  await fs.rm(path.join(old.root,'scripts/language-expansion/unlisted.mjs'));
  const bytes=await fs.readFile(path.join(old.dir,'journal.jsonl'));bytes[10]^=1;await fs.writeFile(path.join(old.dir,'journal.jsonl'),bytes);
  await assert.rejects(snapshot(old.dir),/journal|handover|JSON/);
});

test('handover preserves unknown costs and overruns, refuses active/changed generations, and never resets accounting', async t=>{
  const next=await planFixture();
  for(const mode of ['unknownCost','overrun','active','changedDefinition','changedBody']) {
    const old=await legacyFixture(t),job=old.plan.jobs[0];
    if(mode==='active')await old.api.admitShard({directory:old.dir,plan:old.plan,manifest:old.api.shard(old.plan,[job.id]),executionID:'active'});
    else await oldRun(old,[job.id],mode==='unknownCost'?{usage:null}:mode==='overrun'?{usage:{input_tokens:1000000,output_tokens:1000000}}:{}).catch(e=>{assert.match(e.message,/stop_reconcile/);});
    const before=await old.api.snapshot(old.dir);
    if(mode==='active') {await assert.rejects(handoverPlan(old.dir,next,hash(next),old.root),/finish_legacy_execution/);continue;}
    if(mode.startsWith('changed')) {
      const changed=structuredClone(next);if(mode==='changedDefinition')changed.jobs[0].definitionHash=hash('changed');else changed.jobs[0].bodyJSON+=' ';
      await assert.rejects(handoverPlan(old.dir,changed,hash(changed),old.root),/definition_changed|frozen_body_changed/);continue;
    }
    await handoverPlan(old.dir,next,hash(next),old.root);const after=await snapshot(old.dir);
    assert.equal(after.committedMicros,before.committedMicros);assert.equal(hash(after.results),hash(before.results));
    assert.equal(after.states[job.id].state,mode==='unknownCost'?'unknown_cost':'cost_overrun');
    await assert.rejects(admitShard({directory:old.dir,plan:next,manifest:shard(next,[next.jobs[1].id]),executionID:'blocked'}),/prior_shard_unresolved/);
    await handoverPlan(old.dir,next,hash(next),old.root); // matching checkpoint only
    const root=JSON.parse(await fs.readFile(path.join(old.dir,'root.json')));root.priorMicros=0;await fs.writeFile(path.join(old.dir,'root.json'),JSON.stringify(root));
    await assert.rejects(snapshot(old.dir),/handover_prefix_changed/);
  }
});
