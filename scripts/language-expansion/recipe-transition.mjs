// Research-only, at most four explicit code/plan transitions in one root ledger.
import fs from 'node:fs/promises';
import {assertProfiles,checkSlot} from './model-family.mjs';
import path from 'node:path';
import {hash, fail, readJSON, codeHashes, SCHEMA} from './common.mjs';
import {validateRecipeParents} from './recipe.mjs';
import {validatePlan, CONFIRMATION_RESERVE, CEILING} from './plan.mjs';
import {legacyReplay, hashesAt} from './handover.mjs';
export const MAX_RECIPE_TRANSITIONS = 4;
export async function transitionRecords(directory) {
  const dir = path.join(directory, 'recipe-transitions');
  const names = await fs.readdir(dir).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
  const records = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('invalid_recipe_transition_file');
    const bytes = await fs.readFile(path.join(dir,name));
    const value = JSON.parse(bytes);
    if (!bytes.equals(jsonBytes(value))) fail('immutable_transition_metadata_changed');
    if (hash(value)+'.json' !== name) fail('recipe_transition_hash_changed');
    records.push(value);
  }
  records.sort((a,b)=>a.ordinal-b.ordinal);
  if (records.length > MAX_RECIPE_TRANSITIONS || records.some((r,i)=>r.version!=='recipe-transition-1' || r.ordinal!==i+1 ||
      hash(r.parentTransitions)!==hash(records.slice(0,i).map(hash)))) fail('invalid_recipe_transition_chain');
  return records;
}
const jsonBytes = value => Buffer.from(JSON.stringify(value)+'\n');
const anchorFor = record => ({schema:SCHEMA,event:'language_expansion_recipe_transition',transitionHash:hash(record)});
function assertAnchors(records, rows) {
  for (const [i,record] of records.entries())
    if (!Number.isSafeInteger(record.prefixEvents) || record.prefixEvents<0 ||
        (i && record.prefixEvents<=records[i-1].prefixEvents) ||
        hash(rows[record.prefixEvents]?.value??null)!==hash(anchorFor(record))) fail('recipe_transition_anchor_missing');
}
async function exactFinal(file, bytes) {
  const stat=await fs.lstat(file).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
  if (!stat) return false;
  if (!stat.isFile() || !(await fs.readFile(file)).equals(bytes)) fail('immutable_transition_metadata_changed');
  return true;
}
// Called only under journal.exclusive. Staging is unpublished and never replayed.
// After interruption discard only these two known regular temporary files. Final
// records/plans are immutable: even equivalent JSON with different bytes refuses.
async function prepareStaging(directory) {
  const dir=path.join(directory,'.recipe-transition-staging');
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  if (!(await fs.lstat(dir)).isDirectory() || (await fs.lstat(dir)).isSymbolicLink()) fail('invalid_transition_staging');
  const names=await fs.readdir(dir);
  for (const name of names)
    if (!['record.tmp','plan.tmp'].includes(name) || !(await fs.lstat(path.join(dir,name))).isFile()) fail('invalid_transition_staging');
  for (const name of names) await fs.unlink(path.join(dir,name));
  return dir;
}
async function immutableSave(file, value, staging, name) {
  const bytes=jsonBytes(value), temp=path.join(staging,name+'.tmp');
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  if (!await exactFinal(file,bytes)) {
    const handle=await fs.open(temp,'wx',0o600);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      // Hard-link installation is atomic and cannot replace an existing final.
      try { await fs.link(temp,file); }
      catch(e) { if (e.code!=='EEXIST' || !await exactFinal(file,bytes)) throw e; }
    } finally { await fs.unlink(temp); }
  }
  // Also sync on an exact retry: the preceding attempt may have stopped here.
  const parent=await fs.open(path.dirname(file),'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
export function assertCommonCases(plans, errorCode='common_case_binding_changed_new_id_required') {
  const seen = new Map();
  for (const p of plans) for (const j of p.jobs) {
    const source = p.sources.find(s=>s.id===j.source);
    const binding = hash({job:j,source});
    if (seen.has(j.id) && seen.get(j.id)!==binding) fail(errorCode);
    seen.set(j.id,binding);
  }
}
export function transitionLedger(state, plans, retiredJobs) {
  assertCommonCases(plans);
  const profile=assertProfiles(plans,state);
  const unique = new Map(plans.flatMap(p=>p.jobs).map(j=>[j.id,j]));
  const names = new Set(plans.flatMap(p=>p.confirmationNames));
  if (names.size>60) fail('confirmation_budget_exceeded');
  return state.priorMicros + state.unknownHeldMicros + [...unique.values()].reduce((n,j)=>n +
    (retiredJobs[j.id] || j.templateOnly===true ? 0 : state.results[j.id]?.actualMicros ?? j.reservedMicros),0) + (profile?profile.slots.reduce((n,s)=>n+s.reservedMicros,0):names.size*CONFIRMATION_RESERVE) +
    state.manifests.flatMap(m=>m.jobs).filter(j=>j.confirmationName).reduce((n,j)=>{
      if(profile && j.modelFamily)checkSlot(j,profile);
      return n+Math.max(0,(state.results[j.id]?.actualMicros??0)-(profile?.slots.find(s=>s.name===j.confirmationName)?.reservedMicros??CONFIRMATION_RESERVE));
    },0);
}
function retirement(state, ids, recordHash) {
  if (!Array.isArray(ids) || new Set(ids).size!==ids.length || hash(ids)!==hash([...ids].sort())) fail('invalid_retirement_schedule');
  const retired = {...state.retiredJobs};
  for (const id of ids) {
    const job = state.plans.flatMap(p=>p.jobs).find(j=>j.id===id);
    if (!job || retired[id] || state.states[id] || state.results[id] ||
        state.manifests.some(m=>m.jobs.some(j=>j.id===id))) fail('only_never_admitted_jobs_may_retire');
    retired[id] = {transitionHash:recordHash, definitionHash:job.definitionHash, reservedMicros:job.reservedMicros};
  }
  return retired;
}
export async function recipeTransitionState(directory, plans, rows, options) {
  const records = await transitionRecords(directory);
  if (!records.length) return null;
  assertAnchors(records,rows);
  const record = records.at(-1), recordHash=hash(record);
  if (record.targetCodeHash!==hash(await codeHashes()) || !Number.isSafeInteger(record.prefixEvents) || record.prefixEvents<0)
    fail('recipe_transition_code_changed');
  const retainedHandover=await readJSON(path.join(directory,'handover.json')).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
  if (hash(retainedHandover)!==hash(record.priorHandover)) fail('handover_metadata_changed');
  const next=plans.find(p=>hash(p)===record.targetPlanHash);
  if (!next) fail('recipe_transition_registration_incomplete');
  await validatePlan(next,record.targetPlanHash);
  const anchor=anchorFor(record);
  const state=await legacyReplay(directory,record,{...options,metadata:{handover:record.priorHandover,transitions:records.slice(0,-1)}});
  if (state.events.length!==record.prefixEvents || (rows[record.prefixEvents-1]?.hash??hash(''))!==record.prefixTip)
    fail('handover_prefix_changed');
  assertCommonCases([...state.plans,next]);
  validateRecipeParents(next,state);
  if (hash(next.confirmationNames)!==hash(state.plans[0].confirmationNames)) fail('global_confirmation_allocations_changed');
  if (Object.values(state.states).some(s=>s.state==='unknown') || Object.values(state.shardStates).some(s=>s.state!=='reconciled'))
    fail('finish_legacy_execution_before_transition');
  const retiredJobs=retirement(state,record.retireCaseIDs,recordHash);
  if (next.jobs.some(j=>retiredJobs[j.id])) fail('retired_case_cannot_reactivate');
  if (transitionLedger(state,[...state.plans,next],retiredJobs)>CEILING) fail('evaluation_budget_exceeded');
  state.retiredJobs=retiredJobs;
  state.recipeTransitions=[...(state.recipeTransitions??[]),record];
  state.events.push(anchor);
  return {record:{...record,prefixEvents:record.prefixEvents+1},state};
}
// Called under the same short journal.exclusive lock as admission/import.
export async function transitionPlanLocked(directory,plan,approvedHash,legacyCodeRoot,retireCaseIDs,{append, replayRoot}={}) {
  await validatePlan(plan,approvedHash);
  let records=await transitionRecords(directory);
  const raw=await fs.readFile(path.join(directory,'journal.jsonl'));
  const rows=raw.length?raw.toString('utf8').trimEnd().split('\n').map(JSON.parse):[];
  const last=records.at(-1);
  // A published intent belongs to its frozen prefix, independent of the new target.
  const pending=last && last.prefixBytes===raw.length && last.prefixHash===hash(raw) ? last : null;
  assertAnchors(pending?records.slice(0,-1):records,rows);
  if (pending && pending.targetPlanHash!==approvedHash) fail('pending_transition_inputs_changed');
  if (!pending && records.some(r=>r.targetPlanHash===approvedHash)) fail('recipe_transition_already_registered');
  if (pending) records=records.slice(0,-1);
  if (records.length>=MAX_RECIPE_TRANSITIONS) fail('recipe_transition_limit');
  const names=async kind=>(await fs.readdir(path.join(directory,kind)).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e)))
    .filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).map(n=>n.slice(0,-5)).sort();
  const record={version:'recipe-transition-1',ordinal:records.length+1,parentTransitions:records.map(hash),
    legacyCodeRoot:await fs.realpath(legacyCodeRoot),legacyCodeHash:hash(await hashesAt(legacyCodeRoot)),
    legacyPlanHashes:(await names('plans')).filter(h=>!pending || h!==approvedHash),legacyShardHashes:await names('shards'),
    priorHandover:await readJSON(path.join(directory,'handover.json')).catch(e=>e.code==='ENOENT'?null:Promise.reject(e)),
    targetPlanHash:approvedHash,targetCodeHash:hash(await codeHashes()),rootHash:hash(await fs.readFile(path.join(directory,'root.json'))),
    prefixBytes:raw.length,prefixHash:hash(raw),prefixEvents:rows.length,prefixTip:rows.at(-1)?.hash??hash(''),retireCaseIDs};
  if (!record.legacyPlanHashes.length || record.legacyPlanHashes.includes(approvedHash)) fail('new_recipe_plan_required');
  const state=await legacyReplay(directory,record,{replayRoot,metadata:{handover:record.priorHandover,transitions:records}});
  if (state.events.length!==rows.length) fail('handover_prefix_changed');
  assertCommonCases([...state.plans,plan]);
  validateRecipeParents(plan,state);
  if (hash(plan.confirmationNames)!==hash(state.plans[0].confirmationNames)) fail('global_confirmation_allocations_changed');
  if (Object.values(state.states).some(s=>s.state==='unknown') || Object.values(state.shardStates).some(s=>s.state!=='reconciled'))
    fail('finish_legacy_execution_before_transition');
  const retired=retirement(state,retireCaseIDs,hash(record));
  if (plan.jobs.some(j=>retired[j.id])) fail('retired_case_cannot_reactivate');
  if (transitionLedger(state,[...state.plans,plan],retired)>CEILING) fail('evaluation_budget_exceeded');
  record.legacySnapshotHash=hash(state);
  if (pending && hash(pending)!==hash(record)) fail('pending_transition_inputs_changed');
  const recordFile=path.join(directory,'recipe-transitions',hash(record)+'.json'), planFile=path.join(directory,'plans',approvedHash+'.json');
  await exactFinal(recordFile,jsonBytes(record));
  await exactFinal(planFile,jsonBytes(plan));
  const staging=await prepareStaging(directory);
  await immutableSave(recordFile,record,staging,'record');
  await immutableSave(planFile,plan,staging,'plan');
  await append(directory,{schema:SCHEMA,event:'language_expansion_recipe_transition',transitionHash:hash(record)});
  return record;
}
