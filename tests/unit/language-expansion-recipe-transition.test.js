import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {corpus,routeOptions,directory} from '../fixtures/language-expansion.mjs';
import * as api from '../../scripts/evaluate-language-expansion.mjs';
import {append,exclusive} from '../../scripts/language-expansion/journal.mjs';
import {transitionPlanLocked} from '../../scripts/language-expansion/recipe-transition.mjs';
const project=fileURLToPath(new URL('../../',import.meta.url));
const names=Array.from({length:60},(_,i)=>'confirmation'+String(i+1).padStart(2,'0'));
const options={corpus,approvedCorpusHash:api.hash(corpus),...routeOptions,confirmationNames:names};
async function fixture(t){
  const code=await directory(t);
  await fs.cp(fileURLToPath(new URL('../fixtures/language-expansion-legacy/',import.meta.url)),code,{recursive:true});
  for(const name of ['api','shared','contracts','node_modules','package.json','package-lock.json'])await fs.symlink(path.join(project,name),path.join(code,name));
  await fs.symlink(path.join(project,'scripts/evaluate-content-quality.mjs'),path.join(code,'scripts/evaluate-content-quality.mjs'));
  const old=await import(pathToFileURL(path.join(code,'scripts/evaluate-language-expansion.mjs')).href);
  const d=await directory(t),p=await old.preparePlan(options);
  await old.initJournal(d);await old.registerPlan(d,p,api.hash(p));
  const builder=await api.preparePlan(options);
  const recipe=namespace=>api.prepareRecipe({builderPlan:builder,namespace,caseIDs:['ja-a--translation--en']});
  return {d,code,ids:p.jobs.map(j=>j.id).sort(),recipe};
}
const transition=(f,p,ids=f.ids,code=f.code)=>api.transitionPlan(f.d,p,api.hash(p),code,ids);
const recordDir=f=>path.join(f.d,'recipe-transitions');
const target=(f,p)=>path.join(f.d,'plans',api.hash(p)+'.json');
async function files(d){return (await fs.readdir(d).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e))).sort();}
async function journal(f){return fs.readFile(path.join(f.d,'journal.jsonl'));}
async function fault(method,replacement,body){const original=fs[method];fs[method]=replacement(original);try{return await body();}finally{fs[method]=original;}}
async function pending(t){const f=await fixture(t),a=await f.recipe('pending-a');
 await fault('link',original=>async(from,to)=>{if(String(to)===target(f,a))throw Error('before_plan_install');return original(from,to);},()=>assert.rejects(transition(f,a),/before_plan_install/));return {f,a};}

test('published record before target plan blocks different target without mutation; exact complete inputs resume',async t=>{
 const {f,a}=await pending(t),b=await f.recipe('pending-b'),before=await journal(f),records=await files(recordDir(f));
 await assert.rejects(transition(f,b),/pending_transition_inputs_changed/);
 assert.deepEqual(await journal(f),before);assert.deepEqual(await files(recordDir(f)),records);assert.equal((await files(path.join(f.d,'plans'))).includes(api.hash(b)+'.json'),false);
 await assert.rejects(api.snapshot(f.d),/anchor_missing|registration_incomplete/);
 await transition(f,a);const state=await api.snapshot(f.d);assert.deepEqual(state.recipeTransitions.map(r=>r.ordinal),[1]);
 assert.equal(state.events.filter(e=>e.event==='language_expansion_recipe_transition').length,1);
 assert.ok(await api.admitShard({directory:f.d,plan:a,manifest:api.shard(a,[a.jobs[0].id+'--confirmation--confirmation01']),executionID:'exact_resume'}));
});
test('published pending intent rejects changed retirement and legacy executable inputs',async t=>{
 const {f,a}=await pending(t),before=await journal(f);
 await assert.rejects(transition(f,a,f.ids.slice(1)),/pending_transition_inputs_changed/);
 const alternate=await directory(t);await fs.cp(f.code,alternate,{recursive:true,verbatimSymlinks:true});
 await assert.rejects(transition(f,a,f.ids,alternate),/pending_transition_inputs_changed/);
 assert.deepEqual(await journal(f),before);await transition(f,a);
});
for(const kind of ['record','plan'])test(`partial ${kind} staging write never publishes partial final JSON; identical retry succeeds`,async t=>{
 const f=await fixture(t),a=await f.recipe('partial-'+kind);let injected=false;
 await fault('open',original=>async(file,...args)=>{const handle=await original(file,...args);if(String(file).endsWith('/'+kind+'.tmp')&&args[0]==='wx'){
  const write=handle.writeFile.bind(handle);handle.writeFile=async bytes=>{injected=true;await write(bytes.subarray(0,127));throw Object.assign(Error('partial_ENOSPC'),{code:'ENOSPC'});};}return handle;},()=>assert.rejects(transition(f,a),/partial_ENOSPC/));
 assert.equal(injected,true);assert.equal((await files(recordDir(f))).length,kind==='record'?0:1);assert.equal((await files(path.join(f.d,'plans'))).includes(api.hash(a)+'.json'),false);
 if(kind==='plan')await assert.rejects(transition(f,await f.recipe('other-target')),/pending_transition_inputs_changed/);
 await transition(f,a);assert.equal((await api.snapshot(f.d)).recipeTransitions.length,1);
});
for(const kind of ['record','plan'])test(`${kind} fsync failure cannot publish its final; exact retry succeeds`,async t=>{
 const f=await fixture(t),a=await f.recipe('sync-'+kind);let injected=false;
 await fault('open',original=>async(file,...args)=>{const handle=await original(file,...args);if(String(file).endsWith('/'+kind+'.tmp')&&args[0]==='wx')handle.sync=async()=>{injected=true;throw Error('injected_fsync');};return handle;},()=>assert.rejects(transition(f,a),/injected_fsync/));
 assert.equal(injected,true);assert.equal((await files(recordDir(f))).length,kind==='record'?0:1);assert.equal((await files(path.join(f.d,'plans'))).includes(api.hash(a)+'.json'),false);await transition(f,a);
});
test('complete unpublished record staging is discarded conservatively; a new target may proceed',async t=>{
 const f=await fixture(t),a=await f.recipe('not-published'),b=await f.recipe('next-target');
 await fault('link',original=>async(from,to)=>{if(String(to).startsWith(recordDir(f)+path.sep))throw Error('before_record_install');return original(from,to);},()=>assert.rejects(transition(f,a),/before_record_install/));
 assert.equal((await files(recordDir(f))).length,0);await transition(f,b);assert.equal((await api.snapshot(f.d)).recipeTransitions[0].targetPlanHash,api.hash(b));
});
test('metadata published before anchor requires exact resume and rejects completed duplicate',async t=>{
 const f=await fixture(t),a=await f.recipe('metadata-published');
 await assert.rejects(exclusive(f.d,()=>transitionPlanLocked(f.d,a,api.hash(a),f.code,f.ids,{append:async()=>{throw Error('before_anchor');}})),/before_anchor/);
 await assert.rejects(api.snapshot(f.d),/anchor_missing/);await assert.rejects(transition(f,await f.recipe('different')),/pending_transition_inputs_changed/);
 await transition(f,a);const before=await journal(f);await assert.rejects(transition(f,a),/already_registered/);assert.deepEqual(await journal(f),before);
});
test('every prior completed record needs its own anchor even with a pre-transition legacy executable',async t=>{
 const {f,a}=await pending(t),b=await f.recipe('forged-later');const name=(await files(recordDir(f)))[0],r=JSON.parse(await fs.readFile(path.join(recordDir(f),name),'utf8'));
 const later={...r,ordinal:2,parentTransitions:[api.hash(r)],targetPlanHash:api.hash(b)};
 await fs.writeFile(path.join(recordDir(f),api.hash(later)+'.json'),JSON.stringify(later)+'\n');await fs.writeFile(target(f,b),JSON.stringify(b)+'\n');
 await append(f.d,{schema:'language-expansion-1',event:'language_expansion_recipe_transition',transitionHash:api.hash(later)});
 const before=await journal(f);await assert.rejects(api.snapshot(f.d),/anchor_missing/);
 await assert.rejects(transition(f,await f.recipe('third')),/anchor_missing/);assert.deepEqual(await journal(f),before);
});
for(const kind of ['record','plan'])test(`partial or different existing final ${kind} metadata is refused without overwrite`,async t=>{
 const {f,a}=await pending(t),name=(await files(recordDir(f)))[0],file=kind==='record'?path.join(recordDir(f),name):target(f,a);
 const exact=kind==='record'?await fs.readFile(file):Buffer.from(JSON.stringify(a)+'\n');
 for(const bytes of [exact.subarray(0,127),Buffer.from(JSON.stringify(JSON.parse(exact))+' \n')]){
  await fs.writeFile(file,bytes);const before=await journal(f);await assert.rejects(transition(f,a));assert.deepEqual(await fs.readFile(file),bytes);assert.deepEqual(await journal(f),before);
 }
 await fs.writeFile(file,exact);await transition(f,a);
});
test('only known regular staging leftovers are discarded; unexpected entries and symlinks refuse',async t=>{
 const f=await fixture(t),a=await f.recipe('stale-staging'),staging=path.join(f.d,'.recipe-transition-staging');await fs.mkdir(staging);
 await fs.writeFile(path.join(staging,'record.tmp'),'{');await fs.writeFile(path.join(staging,'plan.tmp'),'unpublished');await transition(f,a);assert.deepEqual(await files(staging),[]);
 const b=await f.recipe('after-stale');await fs.writeFile(path.join(staging,'unknown'),'keep');await assert.rejects(transition(f,b,[],project),/invalid_transition_staging/);assert.equal(await fs.readFile(path.join(staging,'unknown'),'utf8'),'keep');await fs.unlink(path.join(staging,'unknown'));
 const protectedFile=path.join(f.d,'protected');await fs.writeFile(protectedFile,'keep');await fs.symlink(protectedFile,path.join(staging,'record.tmp'));await assert.rejects(transition(f,b,[],project),/invalid_transition_staging/);assert.equal(await fs.readFile(protectedFile,'utf8'),'keep');
});
for(const kind of ['record','plan'])test(`interruption immediately after ${kind} atomic install leaves complete immutable intent for exact resume`,async t=>{
 const f=await fixture(t),a=await f.recipe('installed-'+kind);let installed;
 await fault('link',original=>async(from,to)=>{await original(from,to);if(kind==='record'?String(to).startsWith(recordDir(f)+path.sep):String(to)===target(f,a)){installed=String(to);throw Error('after_install');}},()=>assert.rejects(transition(f,a),/after_install/));
 const bytes=await fs.readFile(installed);assert.doesNotThrow(()=>JSON.parse(bytes));
 await assert.rejects(transition(f,await f.recipe('changed')),/pending_transition_inputs_changed/);
 await transition(f,a);assert.deepEqual(await fs.readFile(installed),bytes);assert.equal((await api.snapshot(f.d)).recipeTransitions.length,1);
});
test('target directory fsync interruption resumes complete metadata without duplicating the anchor',async t=>{
 const f=await fixture(t),a=await f.recipe('directory-sync');let injected=false;
 await fault('open',original=>async(file,...args)=>{const handle=await original(file,...args);if(String(file)===path.join(f.d,'plans')&&args[0]==='r')handle.sync=async()=>{injected=true;throw Error('directory_sync');};return handle;},()=>assert.rejects(transition(f,a),/directory_sync/));
 assert.equal(injected,true);assert.deepEqual(await fs.readFile(target(f,a)),Buffer.from(JSON.stringify(a)+'\n'));await transition(f,a);
 assert.equal((await api.snapshot(f.d)).events.filter(e=>e.event==='language_expansion_recipe_transition').length,1);
});
