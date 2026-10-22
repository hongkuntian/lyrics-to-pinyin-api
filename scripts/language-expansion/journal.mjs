import fs from 'node:fs/promises';
import {isModelPlan,bindModel,assertPartitionOrder,assertPartitionSet,validateModelResult} from './model-plans.mjs';
import {assertProfiles} from './model-family.mjs';
import {validateObservation} from './http-observation.mjs';
import {BASELINE_MODE, bindBaseline} from './baseline.mjs';
import path from 'node:path';
import {SCHEMA, hash, fail, integer, save, readJSON, recoverPayload} from './common.mjs';
import {CEILING, CONFIRMATION_RESERVE, validatePlan, shard, bindDependent} from './plan.mjs';
import {reconciliationFor, terminalBatch, terminalIdentity, scanProjection} from './reconciliation.mjs';

import {BATCH_RETRIEVAL, fileProjection, validateFileReceipt, freshPayloadRecords} from './batch-files.mjs';
import {batchInput} from './plan.mjs';

import {validateRecipeParents} from './recipe.mjs';
import {recipeTransitionState, transitionPlanLocked, assertCommonCases, transitionLedger} from './recipe-transition.mjs';
import {handoverState, handoverPlanLocked} from './handover.mjs';

const events = {
  language_expansion_admitted: ['executionID'],
  language_expansion_submitting: [],
  language_expansion_chunk: ['payloadHash', 'bytes', 'count', 'index', 'data'],
  language_expansion_complete: ['payloadHash', 'bytes', 'count'],
  language_expansion_control: ['operation', 'state', 'inputHash', 'inputFileID', 'batchID', 'outputFileID', 'errorFileID', 'status', 'requestCounts'],
  language_expansion_file_scan: ['version', 'identityHash', 'role', 'fileID', 'bytes', 'payloadHash', 'count', 'finalNewline', 'coverageHash'],
  language_expansion_scan: ['version', 'identityHash', 'files', 'rowCoverageHash', 'rowCount'],
  language_expansion_file: ['role', 'fileID', 'bytes', 'payloadHash', 'count', 'finalNewline'],
  language_expansion_reconciled: ['version', 'inputHash', 'identityHash', 'inputFileID', 'batchID', 'outputFileID', 'errorFileID', 'status', 'requestCounts', 'files', 'rowCoverageHash', 'rowCount'],
};
const common = ['schema', 'event', 'planHash', 'shardHash', 'caseID', 'bodyHash', 'definitionHash', 'reservedMicros', 'transport'];
export function validateEvent(event, manifests) {
  return validateEventIndexed(event,manifests,new Map(manifests.map(m=>[hash(m),m])));
}
function validateEventIndexed(event,manifests,manifestIndex) {
  if (event.event === 'language_expansion_terminal') {
    if (event.schema !== SCHEMA || Object.keys(event).sort().join() !== 'event,intentionalBuildFailure,operation,planHash,schema,shardHash,state' ||
        event.intentionalBuildFailure !== true || !['standard', 'submit', 'inspect', 'recover', 'retrieve'].includes(event.operation) ||
        !['evaluation_only_complete', 'evaluation_only_interrupted'].includes(event.state) ||
        (!manifestIndex.has(event.shardHash)||manifestIndex.get(event.shardHash).planHash !== event.planHash)) fail('invalid_terminal_event');
    return;
  }
  if (!events[event.event] || event.schema !== SCHEMA || Object.keys(event).some(k => ![...common, ...events[event.event]].includes(k)) ||
      Buffer.byteLength(JSON.stringify(event)) > 16_384) fail('invalid_journal_event');
  const manifest = manifestIndex.get(event.shardHash);
  if (!manifest || event.planHash!==manifest.planHash || event.transport !== manifest.transport) fail('unknown_event_shard');
  const job = manifest.jobs.find(j => j.id === event.caseID);
  if (!job || job.bodyHash !== event.bodyHash || job.definitionHash !== event.definitionHash || job.reservedMicros !== event.reservedMicros) fail('unknown_event_case_or_body');
  if (event.event === 'language_expansion_admitted' && !/^[A-Za-z0-9_-]{1,120}$/.test(event.executionID ?? '')) fail('invalid_execution_identity');
  if (event.event === 'language_expansion_control') {
    if (!['upload', 'create', 'inspect', 'recover', 'retrieve'].includes(event.operation) ||
        !['submitting', 'known', 'unknown', 'retained'].includes(event.state) ||
        !/^[a-f0-9]{64}$/.test(event.inputHash ?? '') ||
        ['inputFileID', 'batchID', 'outputFileID', 'errorFileID', 'status'].some(k => event[k] != null && !/^[A-Za-z0-9_-]{1,120}$/.test(event[k]))) fail('invalid_control_event');
  }
  if (event.event === 'language_expansion_file' && (!['output', 'error'].includes(event.role) || !/^file-[A-Za-z0-9_-]+$/.test(event.fileID ?? '') ||
      !integer(event.bytes) || event.bytes > 1_048_576 || !integer(event.count) || typeof event.finalNewline !== 'boolean' || !/^[a-f0-9]{64}$/.test(event.payloadHash ?? ''))) fail('invalid_file_receipt');
  if (['language_expansion_file', 'language_expansion_reconciled'].includes(event.event) && event.version !== BATCH_RETRIEVAL.version) fail('legacy_batch_receipt_decoding_only');
  if (['language_expansion_file_scan', 'language_expansion_scan', 'language_expansion_reconciled'].includes(event.event)) {
    if (event.transport !== 'batch' || event.version !== BATCH_RETRIEVAL.version) fail('invalid_batch_scan_version');
    if (event.event === 'language_expansion_file_scan') {
      if (!/^[a-f0-9]{64}$/.test(event.identityHash ?? '')) fail('invalid_scan_identity');
      validateFileReceipt(event);
    }
    if (event.event === 'language_expansion_scan') {
      if (!/^[a-f0-9]{64}$/.test(event.identityHash ?? '') || !/^[a-f0-9]{64}$/.test(event.rowCoverageHash ?? '') ||
          !integer(event.rowCount) || event.rowCount !== manifest.jobs.length || !Array.isArray(event.files) || event.files.length > 2 ||
          new Set(event.files.map(f => f.role)).size !== event.files.length) fail('invalid_batch_scan');
      for (const f of event.files) {
        if (Object.keys(f).sort().join() !== Object.keys(fileProjection(f)).sort().join()) fail('invalid_file_receipt');
        validateFileReceipt(f);
      }
      if (event.files.reduce((n, f) => n + f.bytes, 0) > BATCH_RETRIEVAL.combinedBytes) fail('retrieval_operation_limit');
    }
  }

}
export async function initJournal(directory, {priorMicros = 0, unknownHeldMicros = 0} = {}) {
  if (![priorMicros, unknownHeldMicros].every(integer) || priorMicros + unknownHeldMicros > CEILING) fail('invalid_prior_accounting');
  await save(path.join(directory, 'root.json'), {schema: SCHEMA, ceilingMicros: CEILING, priorMicros, unknownHeldMicros});
  await fs.writeFile(path.join(directory, 'journal.jsonl'), '', {flag: 'wx', mode: 0o600});
}
async function entries(directory) {
  const text = await fs.readFile(path.join(directory, 'journal.jsonl'), 'utf8');
  if (text && !text.endsWith('\n')) fail('truncated_external_journal');
  let previousHash = hash('');
  return text.trim() ? text.trim().split('\n').map((line, seq) => {
    const entry = JSON.parse(line);
    if (entry.seq !== seq || entry.previousHash !== previousHash || entry.hash !== hash({seq, previousHash, value: entry.value})) fail('corrupt_external_journal');
    previousHash = entry.hash;
    return entry;
  }) : [];
}
export async function append(directory, value) {
  return appendMany(directory, [value]);
}
async function appendMany(directory, values) {
  const rows = await entries(directory);
  let seq = rows.length, previousHash = rows.at(-1)?.hash ?? hash('');
  const handle = await fs.open(path.join(directory, 'journal.jsonl'), 'a', 0o600);
  try {
    for (const value of values) {
      const entry = {seq, previousHash, value}; entry.hash = hash(entry);
      await handle.writeFile(JSON.stringify(entry) + '\n');
      seq++; previousHash = entry.hash;
    }
    await handle.sync();
  } finally { await handle.close(); }
}
async function records(directory, name) {
  const folder = path.join(directory, name);
  const names = await fs.readdir(folder).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
  return Promise.all(names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort().map(async n => {
    const value = await readJSON(path.join(folder, n));
    if (hash(value) !== n.slice(0, -5)) fail('frozen_file_hash_mismatch');
    return value;
  }));
}
export async function snapshot(directory, {incoming = [], replayRoot} = {}) {
  const root = await readJSON(path.join(directory, 'root.json'));
  if (root.schema !== SCHEMA || root.ceilingMicros !== CEILING || ![root.priorMicros, root.unknownHeldMicros].every(integer)) fail('invalid_external_journal');
  const plans = await records(directory, 'plans'), manifests = await records(directory, 'shards'), rows = await entries(directory);
  // Immutable identity indexes are rebuilt from verified frozen files on every
  // replay. No cached state/results and no skipped reducer/validation work.
  const planIndex=new Map(plans.map(p=>[hash(p),p])),manifestIndex=new Map(manifests.map(m=>[hash(m),m]));
  const inherited = await recipeTransitionState(directory, plans, rows, {replayRoot}) ?? await handoverState(directory, plans, rows, {replayRoot});
  assertCommonCases(plans);
  assertPartitionSet(plans);
  for (const plan of plans) if (!inherited?.record.legacyPlanHashes.includes(hash(plan))) await validatePlan(plan, hash(plan));
  const jobs = new Map(), confirmations = new Set();
  for (const plan of plans) {
    if(!isModelPlan(plan)&&plan.jobs.some(j=>j.templateOnly))fail('named_only_mode_required');
    for (const name of plan.confirmationNames) confirmations.add(name);
    for (const job of plan.jobs) {
      if (jobs.has(job.id) && hash(jobs.get(job.id)) !== hash(job)) fail('case_spec_changed');
      jobs.set(job.id, job);
    }
  }
  if (confirmations.size > 60) fail('confirmation_budget_exceeded');
  const staticRefusals = Object.fromEntries([...jobs.values()].filter(j => j.executionDisposition === 'static_refusal').map(job => {
    const source = plans.flatMap(p => p.sources).find(s => s.id === job.source && s.definitionHash === job.sourceDefinitionHash);
    return [job.id, {id: job.id, definitionHash: job.definitionHash, sourceDefinitionHash: job.sourceDefinitionHash,
      disposition: 'static_refusal', reason: job.refusalCode, effectiveSelectionLanguage: 'uk', providerCalled: false,
      actualMicros: 0, accountedMicros: 0, sourceBindings: source.bindings, selection: source.selection, qualification: job.qualification}];
  }));
  let result = {plans, manifests, events: [], states: {}, shardStates: {}, results: {}, staticRefusals, dependentFailures: {}, priorMicros: root.priorMicros, unknownHeldMicros: root.unknownHeldMicros};
  if (inherited) result = {...result, ...inherited.state, plans, manifests, staticRefusals: {...staticRefusals,...inherited.state.staticRefusals}};
  const startIndex = inherited?.record.prefixEvents ?? 0;
  const values = [...rows.map(r => r.value), ...incoming];
  for (let eventIndex = startIndex; eventIndex < values.length; eventIndex++) {
    const value = values[eventIndex];
    try {
      if (inherited?.record.legacyPlanHashes.includes(value.planHash) || (value.event === 'language_expansion_start' && inherited?.record.legacyShardHashes.includes(value.shardHash))) fail('legacy_executor_prefix_sealed');
      if (value.event === 'language_expansion_start') {
        const manifest = manifestIndex.get(value.shardHash);
        if (!manifest || !value.executionID || Object.keys(value).sort().join() !== 'event,executionID,schema,shardHash' || value.schema !== SCHEMA || result.events.some(e => e.event === value.event && e.shardHash === value.shardHash)) fail('invalid_or_duplicate_start');
        const admissions = result.events.filter(e => e.event === 'language_expansion_admitted' && e.shardHash === value.shardHash);
        if (admissions.length !== manifest.jobs.length || admissions.some(e => e.executionID !== value.executionID)) fail('unadmitted_start');
        result.events.push(value); continue;
      }
      validateEventIndexed(value,manifests,manifestIndex);
      if (value.event === 'language_expansion_terminal') { result.events.push(value); continue; }
      if (value.event === 'language_expansion_admitted') {
        if (result.retiredJobs?.[value.caseID] || manifestIndex.get(value.shardHash)?.jobs.some(j=>result.retiredJobs?.[j.confirmationOf])) fail('retired_case_cannot_reactivate');
        if (result.states[value.caseID]) fail('duplicate_case_admission');
        result.states[value.caseID] = {state: 'unknown', ...value};
        if (value.transport === 'batch') result.shardStates[value.shardHash] = {state: 'unresolved'};
      } else {
        const admission = result.states[value.caseID];
        if (!admission || admission.shardHash !== value.shardHash || admission.bodyHash !== value.bodyHash) fail('unadmitted_event');
        if (!result.events.some(e => e.event === 'language_expansion_start' && e.shardHash === value.shardHash)) fail('unstarted_event');
        if (value.event === 'language_expansion_control' && value.transport === 'batch') {
          const controls = result.events.filter(e => e.event === value.event && e.shardHash === value.shardHash);
          if (value.inputHash !== hash(batchInput(manifestIndex.get(value.shardHash)))) fail('batch_identity_changed');
          const manifest = manifestIndex.get(value.shardHash);
          const pinned = controls.find(e => e.operation === 'inspect' && e.state === 'known' && terminalBatch(e.status));
          if (pinned && value.status && terminalBatch(value.status) && hash(terminalIdentity(manifest, pinned)) !== hash(terminalIdentity(manifest, value))) fail('batch_identity_changed');
          const prior = controls.findLast(e => e.batchID);
          if ((prior && value.batchID && prior.batchID !== value.batchID) ||
              controls.some(e => e.inputFileID && value.inputFileID && e.inputFileID !== value.inputFileID)) fail('batch_identity_changed');
        }
        if (value.event === 'language_expansion_submitting' && result.events.some(e => e.caseID === value.caseID && e.event === value.event)) fail('duplicate_submission');
        if (value.event === 'language_expansion_chunk' && result.events.some(e => e.caseID === value.caseID && e.event === value.event && e.index === value.index)) fail('duplicate_chunk');
        if (value.event === 'language_expansion_complete') {
          if (result.results[value.caseID]) fail('duplicate_completion');
          const output = recoverPayload([...result.events, value], value);
          const manifest = manifestIndex.get(value.shardHash), job = manifest.jobs.find(j => j.id === value.caseID);
          const source = planIndex.get(manifest.planHash).sources.find(s => s.id === job.source);
          if (output.id !== value.caseID || output.bodyHash !== value.bodyHash || output.definitionHash !== job.definitionHash || output.sourceDefinitionHash !== job.sourceDefinitionHash ||
              hash(output.sourceBindings) !== hash(source.bindings) || hash(output.selection) !== hash(job.selection ?? source.selection) || hash(output.qualification) !== hash(job.qualification) || typeof output.valid !== 'boolean' ||
              !(output.actualMicros === null || integer(output.actualMicros)) || output.accountedMicros !== (output.actualMicros ?? value.reservedMicros)) fail('invalid_result_accounting');
          const owner=planIndex.get(manifest.planHash);
          if(isModelPlan(owner)||owner.mode===BASELINE_MODE)validateModelResult(owner,job,output,manifest.transport);
          if(output.httpObservation)validateObservation(output.httpObservation,job.bodyHash);
          result.results[value.caseID] = output;
          result.states[value.caseID].state = output.actualMicros === null ? 'unknown_cost' : output.actualMicros > value.reservedMicros ? 'cost_overrun' : 'settled';
        }
        if (['language_expansion_file_scan', 'language_expansion_scan'].includes(value.event)) {
          const manifest = manifestIndex.get(value.shardHash);
          const prior = result.events.filter(e => e.shardHash === value.shardHash);
          const terminal = prior.findLast(e => e.event === 'language_expansion_control' && e.operation === 'inspect' && e.state === 'known');
          if (!terminal || value.identityHash !== hash(terminalIdentity(manifest, terminal))) fail('batch_identity_changed');
          const receipts = prior.filter(e => e.event === 'language_expansion_file_scan');
          if (value.event === 'language_expansion_file_scan' && (value.fileID !== terminal[value.role + 'FileID'] || value.count > manifest.jobs.length)) fail('batch_file_changed');
          if (value.event === 'language_expansion_file_scan' && receipts.some(e => e.role === value.role && hash(fileProjection(e)) !== hash(fileProjection(value)))) fail('batch_file_changed');
          if (value.event === 'language_expansion_scan') {
            const identity = terminalIdentity(manifest, terminal);
            if (value.files.length !== [identity.outputFileID, identity.errorFileID].filter(Boolean).length ||
                value.files.some(f => f.fileID !== identity[f.role + 'FileID'] || !receipts.some(e => hash(fileProjection(e)) === hash(f)))) fail('incomplete_batch_files');
            const scans = prior.filter(e => e.event === value.event);
            if (scans.some(e => hash(scanProjection(e)) !== hash(scanProjection(value)))) fail('batch_scan_changed');
          }
        }
        if (value.event === 'language_expansion_control' && value.transport === 'batch' && ['inspect', 'recover'].includes(value.operation)) {
          if (result.shardStates[value.shardHash]?.state !== 'reconciled') result.shardStates[value.shardHash] = {state: 'unresolved', batchID: value.batchID ?? null};
        }
        if (value.event === 'language_expansion_reconciled') {
          const manifest = manifestIndex.get(value.shardHash);
          const controls = result.events.filter(e => e.shardHash === value.shardHash && e.event === 'language_expansion_control');
          const terminal = controls.findLast(e => e.operation === 'inspect' && e.state === 'known');
          if (!terminal || !terminalBatch(terminal.status)) fail('terminal_batch_identity_required');
          const files = result.events.filter(e => e.shardHash === value.shardHash && e.event === 'language_expansion_file_scan');
          const scans = result.events.filter(e => e.shardHash === value.shardHash && e.event === 'language_expansion_scan');
          const plan = planIndex.get(manifest.planHash);
          const expected = {...baseEvent(manifest, manifest.jobs[0]), event: 'language_expansion_reconciled', ...reconciliationFor(manifest, terminal, files, result.results, scans, plan)};
          if (hash(expected) !== hash(value)) fail('batch_reconciliation_changed');
          result.shardStates[value.shardHash] = {state: 'reconciled', ...value};
        }
      }
      result.events.push(value);
    } catch (error) { error.journalEventIndex = eventIndex; throw error; }
  }
  const confirmationJobs = new Map();
  for (const manifest of manifests) {
    const plan = planIndex.get(manifest.planHash);
    if (!plan || (!inherited?.record.legacyShardHashes.includes(hash(manifest)) && hash(shard(plan, manifest.jobs.map(j => j.id), result.results, manifest.transport)) !== hash(manifest))) fail('unregistered_or_changed_shard');
    for (const job of manifest.jobs.filter(j => j.confirmationName)) {
      if (confirmationJobs.has(job.confirmationName)) fail('duplicate_confirmation_name');
      confirmationJobs.set(job.confirmationName, job);
    }
  }
  for (const plan of plans.filter(p=>!inherited?.record.legacyPlanHashes.includes(hash(p)))) for (const job of plan.jobs.filter(j => (j.kind === 'translated' || ((plan.mode === BASELINE_MODE || isModelPlan(plan)) && j.dependency)) && result.results[j.dependency])) {
    try { (isModelPlan(plan) ? bindModel : plan.mode === BASELINE_MODE ? bindBaseline : bindDependent)(plan, job, result.results[job.dependency]); }
    catch (e) { result.dependentFailures[job.id] = e.message; }
  }
  for (const p of plans.filter(p=>!inherited?.record.legacyPlanHashes.includes(hash(p)))) validateRecipeParents(p,result);
  result.committedMicros = transitionLedger(result, plans, result.retiredJobs ?? {});
  result.budgetExceeded = result.committedMicros > CEILING;
  return result;
}
// All mutating Root commands serialize briefly; never hold this across provider work.
export async function exclusive(directory, fn) {
  const file = path.join(directory, 'mutation.lock');
  const handle = await fs.open(file, 'wx');
  try { return await fn(); } finally { await handle.close(); await fs.unlink(file); }
}
export async function registerPlan(directory, plan, approvedHash) {
  await validatePlan(plan, approvedHash);
  return exclusive(directory, async () => {
    const current = await snapshot(directory);
    if (current.budgetExceeded) fail('evaluation_budget_exceeded');
    if (current.plans.some(p => hash(p) === approvedHash)) return;
    assertCommonCases([...current.plans,plan], 'case_spec_changed');
    assertProfiles([...current.plans,plan],current,true);
    assertPartitionOrder(current.plans,plan);
    validateRecipeParents(plan,current);
    if (plan.jobs.some(j=>current.retiredJobs?.[j.id])) fail('retired_case_cannot_reactivate');
    if (transitionLedger(current,[...current.plans,plan],current.retiredJobs??{})>CEILING) fail('evaluation_budget_exceeded');
    await save(path.join(directory, 'plans', approvedHash + '.json'), plan);
  });
}
export async function admitShard({directory, plan, manifest, executionID, batchAccepted = false, representativeReviewed = false, solSeedDualReviewed = false, solBatchCapacityReviewed = false}) {
  await validatePlan(plan, manifest.planHash);
  return exclusive(directory, async () => {
    const current = await snapshot(directory);
    if (current.budgetExceeded) fail('evaluation_budget_exceeded');
    if (!current.plans.some(p => hash(p) === hash(plan))) fail('register_plan_first');
    if (manifest.jobs.some(j=>current.retiredJobs?.[j.id] || current.retiredJobs?.[j.confirmationOf])) fail('retired_case_cannot_reactivate');
    if (current.recipeTransitions?.at(-1)?.legacyPlanHashes.includes(hash(plan))) fail('legacy_executor_prefix_sealed');
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(executionID ?? '')) fail('execution_identity_required');
    const expected = shard(plan, manifest.jobs.map(j => j.id), current.results, manifest.transport);
    if (hash(expected) !== hash(manifest)) fail('shard_changed');
    if (manifest.transport === 'batch' && (plan.seedIDs.length !== 33 || !plan.seedIDs.every(id=>plan.jobs.some(j=>j.id===id)))) fail('recipe_standard_seed_qualification_required');
    if (manifest.transport === 'batch' && (!batchAccepted || !representativeReviewed || !plan.seedIDs.every(id => current.results[id]?.valid && current.states[id]?.transport === 'standard'))) fail('standard_review_and_batch_entitlement_required');
    if(manifest.transport==='batch'&&plan.modelFamily==='r1-sol'&&(plan.mode!=='model-partition-r1'||plan.kind!=='genuine728'||solSeedDualReviewed!==true||solBatchCapacityReviewed!==true))fail('sol_fresh_seed_dual_review_and_capacity_required');
    if (manifest.jobs.some(j => current.states[j.id])) fail('already_submitted_or_unknown_never_resend');
    if (manifest.jobs.some(j => j.confirmationName && current.manifests.some(m => m.jobs.some(old => old.confirmationName === j.confirmationName)))) fail('duplicate_confirmation_name');
    if (Object.values(current.states).some(s => ['unknown', 'unknown_cost', 'cost_overrun'].includes(s.state)) ||
        Object.values(current.shardStates).some(s => s.state !== 'reconciled')) fail('prior_shard_unresolved_reconcile_first');
    const shardHash = hash(manifest);
    await save(path.join(directory, 'shards', shardHash + '.json'), manifest);
    await appendMany(directory, manifest.jobs.map(job => ({...baseEvent(manifest, job), event: 'language_expansion_admitted', executionID})));
    return {schema: SCHEMA, planHash: hash(plan), shardHash, executionID, transport: manifest.transport};
  });
}
export const baseEvent = (manifest, job) => ({schema: SCHEMA, planHash: manifest.planHash, shardHash: hash(manifest), caseID: job.id, bodyHash: job.bodyHash, definitionHash: job.definitionHash, reservedMicros: job.reservedMicros, transport: manifest.transport});
export async function claimStart(directory, ticket) {
  return exclusive(directory, async () => {
    const current = await snapshot(directory);
    const manifest = current.manifests.find(m => hash(m) === ticket.shardHash && m.planHash === ticket.planHash && m.transport === ticket.transport);
    if (!manifest || manifest.jobs.some(j => current.states[j.id]?.executionID !== ticket.executionID)) fail('invalid_external_ticket');
    if (current.events.some(e => e.shardHash === ticket.shardHash && e.event === 'language_expansion_start')) fail('execution_already_started');
    const start = {schema: SCHEMA, event: 'language_expansion_start', shardHash: ticket.shardHash, executionID: ticket.executionID};
    await append(directory, start);
    const entry = (await entries(directory)).at(-1);
    return {schema: SCHEMA, ticketHash: hash(ticket), entry};
  });
}
export function validateStartReceipt(receipt, ticket) {
  const entry = receipt?.entry;
  if (receipt?.schema !== SCHEMA || receipt.ticketHash !== hash(ticket) || !entry || !integer(entry.seq) ||
      !/^[a-f0-9]{64}$/.test(entry.previousHash ?? '') || entry.hash !== hash({seq: entry.seq, previousHash: entry.previousHash, value: entry.value}) ||
      entry.value?.event !== 'language_expansion_start' || entry.value.schema !== SCHEMA || entry.value.shardHash !== ticket.shardHash || entry.value.executionID !== ticket.executionID) fail('invalid_external_start_receipt');
}
export async function importEvents(directory, incoming) {
  return exclusive(directory, async () => {
    const current = await snapshot(directory);
    let reconciled;
    try { reconciled = await snapshot(directory, {incoming}); }
    catch (error) {
      // Retain the verified prefix when later records are corrupt/interrupted.
      // The offending record is never appended; its case keeps an unknown hold.
      const count = error.journalEventIndex - current.events.length;
      if (Number.isSafeInteger(count) && count > 0) {
        const prefix = incoming.slice(0, count);
        await snapshot(directory, {incoming: prefix});
        await appendMany(directory, prefix);
      }
      throw error;
    }
    await appendMany(directory, incoming);
    return reconciled;
  });
}

export async function finalizeBatch(directory, shardHash) {
  return exclusive(directory, async () => {
    const state = await snapshot(directory), manifest = state.manifests.find(m => hash(m) === shardHash);
    if (!manifest || manifest.transport !== 'batch') fail('registered_batch_required');
    const prior = state.events.filter(e => e.shardHash === shardHash);
    const terminal = prior.findLast(e => e.event === 'language_expansion_control' && e.operation === 'inspect' && e.state === 'known');
    if (!terminal) fail('terminal_batch_identity_required');
    const value = {...baseEvent(manifest, manifest.jobs[0]), event: 'language_expansion_reconciled',
      ...reconciliationFor(manifest, terminal, prior.filter(e => e.event === 'language_expansion_file_scan'), state.results,
        prior.filter(e => e.event === 'language_expansion_scan'), state.plans.find(p => hash(p) === manifest.planHash))};
    await snapshot(directory, {incoming: [value]});
    if (state.shardStates[shardHash]?.state !== 'reconciled') await append(directory, value);
    return value;
  });
}
export async function importReadReplay(directory, incoming, shardHash, caseID) {
  return exclusive(directory, async () => {
    const state = await snapshot(directory), manifest = state.manifests.find(m => hash(m) === shardHash);
    const job = manifest?.jobs.find(j => j.id === caseID);
    if (!job || manifest.transport !== 'batch' || incoming.some(e => e.shardHash !== shardHash || e.planHash !== manifest.planHash ||
        ['language_expansion_admitted', 'language_expansion_submitting', 'language_expansion_start', 'language_expansion_reconciled'].includes(e.event))) fail('readonly_replay_required');
    if (incoming.some(e => !['language_expansion_chunk', 'language_expansion_complete', 'language_expansion_control', 'language_expansion_file_scan', 'language_expansion_scan', 'language_expansion_terminal'].includes(e.event) ||
        (e.event === 'language_expansion_control' && !['inspect', 'retrieve'].includes(e.operation)) ||
        (e.event === 'language_expansion_terminal' && e.operation !== 'retrieve'))) fail('readonly_replay_required');
    const payload = incoming.filter(e => ['language_expansion_chunk', 'language_expansion_complete'].includes(e.event));
    const fresh = new Set(freshPayloadRecords(state.events, payload, baseEvent(manifest, job)));
    const records = incoming.filter(e => !['language_expansion_chunk', 'language_expansion_complete'].includes(e.event) || fresh.has(e));
    // Validate the entire repeat before importing any of its records.
    await snapshot(directory, {incoming: records});
    await appendMany(directory, records);
    return {imported: records.length, comparedPayloadRecords: payload.length, freshPayloadRecords: fresh.size};
  });
}

export async function handoverPlan(directory, plan, approvedHash, legacyCodeRoot) {
  return exclusive(directory, () => handoverPlanLocked(directory, plan, approvedHash, legacyCodeRoot));
}

export async function transitionPlan(directory, plan, approvedHash, legacyCodeRoot, retireCaseIDs, options = {}) {
  return exclusive(directory, () => transitionPlanLocked(directory,plan,approvedHash,legacyCodeRoot,retireCaseIDs,{...options,append}));
}
