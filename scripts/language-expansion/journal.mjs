import fs from 'node:fs/promises';
import path from 'node:path';
import {SCHEMA, hash, fail, integer, save, readJSON, recoverPayload} from './common.mjs';
import {CEILING, CONFIRMATION_RESERVE, validatePlan, shard, bindDependent} from './plan.mjs';

const events = {
  language_expansion_admitted: ['executionID'],
  language_expansion_submitting: [],
  language_expansion_chunk: ['payloadHash', 'bytes', 'count', 'index', 'data'],
  language_expansion_complete: ['payloadHash', 'bytes', 'count'],
  language_expansion_control: ['operation', 'state', 'inputHash', 'inputFileID', 'batchID', 'outputFileID', 'errorFileID', 'status'],
  language_expansion_file: ['role', 'fileID', 'bytes', 'payloadHash', 'count', 'finalNewline'],
};
const common = ['schema', 'event', 'planHash', 'shardHash', 'caseID', 'bodyHash', 'reservedMicros', 'transport'];
export function validateEvent(event, manifests) {
  if (event.event === 'language_expansion_terminal') {
    if (event.schema !== SCHEMA || Object.keys(event).sort().join() !== 'event,intentionalBuildFailure,operation,planHash,schema,shardHash,state' ||
        event.intentionalBuildFailure !== true || !['standard', 'submit', 'inspect', 'recover', 'retrieve'].includes(event.operation) ||
        !['evaluation_only_complete', 'evaluation_only_interrupted'].includes(event.state) ||
        !manifests.some(m => hash(m) === event.shardHash && m.planHash === event.planHash)) fail('invalid_terminal_event');
    return;
  }
  if (!events[event.event] || event.schema !== SCHEMA || Object.keys(event).some(k => ![...common, ...events[event.event]].includes(k)) ||
      Buffer.byteLength(JSON.stringify(event)) > 16_384) fail('invalid_journal_event');
  const manifest = manifests.find(m => hash(m) === event.shardHash && m.planHash === event.planHash);
  if (!manifest || event.transport !== manifest.transport) fail('unknown_event_shard');
  const job = manifest.jobs.find(j => j.id === event.caseID);
  if (!job || job.bodyHash !== event.bodyHash || job.reservedMicros !== event.reservedMicros) fail('unknown_event_case_or_body');
  if (event.event === 'language_expansion_admitted' && !/^[A-Za-z0-9_-]{1,120}$/.test(event.executionID ?? '')) fail('invalid_execution_identity');
  if (event.event === 'language_expansion_control') {
    if (!['upload', 'create', 'inspect', 'recover', 'retrieve'].includes(event.operation) ||
        !['submitting', 'known', 'unknown', 'retained'].includes(event.state) ||
        !/^[a-f0-9]{64}$/.test(event.inputHash ?? '') ||
        ['inputFileID', 'batchID', 'outputFileID', 'errorFileID', 'status'].some(k => event[k] != null && !/^[A-Za-z0-9_-]{1,120}$/.test(event[k]))) fail('invalid_control_event');
  }
  if (event.event === 'language_expansion_file' && (!['output', 'error'].includes(event.role) || !/^file-[A-Za-z0-9_-]+$/.test(event.fileID ?? '') ||
      !integer(event.bytes) || event.bytes > 1_048_576 || !integer(event.count) || typeof event.finalNewline !== 'boolean' || !/^[a-f0-9]{64}$/.test(event.payloadHash ?? ''))) fail('invalid_file_receipt');
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
export async function snapshot(directory, {incoming = []} = {}) {
  const root = await readJSON(path.join(directory, 'root.json'));
  if (root.schema !== SCHEMA || root.ceilingMicros !== CEILING || ![root.priorMicros, root.unknownHeldMicros].every(integer)) fail('invalid_external_journal');
  const plans = await records(directory, 'plans'), manifests = await records(directory, 'shards'), rows = await entries(directory);
  for (const plan of plans) await validatePlan(plan, hash(plan));
  const jobs = new Map(), confirmations = new Set();
  for (const plan of plans) {
    for (const name of plan.confirmationNames) confirmations.add(name);
    for (const job of plan.jobs) {
      if (jobs.has(job.id) && hash(jobs.get(job.id)) !== hash(job)) fail('case_spec_changed');
      jobs.set(job.id, job);
    }
  }
  if (confirmations.size > 60) fail('confirmation_budget_exceeded');
  const result = {plans, manifests, events: [], states: {}, results: {}, dependentFailures: {}, priorMicros: root.priorMicros, unknownHeldMicros: root.unknownHeldMicros};
  for (const [eventIndex, value] of [...rows.map(r => r.value), ...incoming].entries()) {
    try {
      if (value.event === 'language_expansion_start') {
        const manifest = manifests.find(m => hash(m) === value.shardHash);
        if (!manifest || !value.executionID || Object.keys(value).sort().join() !== 'event,executionID,schema,shardHash' || value.schema !== SCHEMA || result.events.some(e => e.event === value.event && e.shardHash === value.shardHash)) fail('invalid_or_duplicate_start');
        const admissions = result.events.filter(e => e.event === 'language_expansion_admitted' && e.shardHash === value.shardHash);
        if (admissions.length !== manifest.jobs.length || admissions.some(e => e.executionID !== value.executionID)) fail('unadmitted_start');
        result.events.push(value); continue;
      }
      validateEvent(value, manifests);
      if (value.event === 'language_expansion_terminal') { result.events.push(value); continue; }
      if (value.event === 'language_expansion_admitted') {
        if (result.states[value.caseID]) fail('duplicate_case_admission');
        result.states[value.caseID] = {state: 'unknown', ...value};
      } else {
        const admission = result.states[value.caseID];
        if (!admission || admission.shardHash !== value.shardHash || admission.bodyHash !== value.bodyHash) fail('unadmitted_event');
        if (!result.events.some(e => e.event === 'language_expansion_start' && e.shardHash === value.shardHash)) fail('unstarted_event');
        if (value.event === 'language_expansion_submitting' && result.events.some(e => e.caseID === value.caseID && e.event === value.event)) fail('duplicate_submission');
        if (value.event === 'language_expansion_chunk' && result.events.some(e => e.caseID === value.caseID && e.event === value.event && e.index === value.index)) fail('duplicate_chunk');
        if (value.event === 'language_expansion_complete') {
          if (result.results[value.caseID]) fail('duplicate_completion');
          const output = recoverPayload([...result.events, value], value);
          if (output.id !== value.caseID || output.bodyHash !== value.bodyHash || typeof output.valid !== 'boolean' ||
              !(output.actualMicros === null || integer(output.actualMicros)) || output.accountedMicros !== (output.actualMicros ?? value.reservedMicros)) fail('invalid_result_accounting');
          result.results[value.caseID] = output;
          result.states[value.caseID].state = output.actualMicros === null ? 'unknown_cost' : output.actualMicros > value.reservedMicros ? 'cost_overrun' : 'settled';
        }
        if (value.event === 'language_expansion_file') {
          const lines = Object.values(result.results).filter(r => r.fileID === value.fileID && r.role === value.role).sort((a, b) => a.lineIndex - b.lineIndex);
          if (lines.length !== value.count || lines.some((r, i) => r.lineIndex !== i || typeof r.rawLine !== 'string')) fail('incomplete_retained_file');
          const raw = lines.map(r => r.rawLine).join('\n') + (value.finalNewline ? '\n' : '');
          if (Buffer.byteLength(raw) !== value.bytes || hash(raw) !== value.payloadHash) fail('corrupt_retained_file');
        }
      }
      result.events.push(value);
    } catch (error) { error.journalEventIndex = eventIndex; throw error; }
  }
  const confirmationJobs = new Map();
  for (const manifest of manifests) {
    const plan = plans.find(p => hash(p) === manifest.planHash);
    if (!plan || hash(shard(plan, manifest.jobs.map(j => j.id), result.results, manifest.transport)) !== hash(manifest)) fail('unregistered_or_changed_shard');
    for (const job of manifest.jobs.filter(j => j.confirmationName)) {
      if (confirmationJobs.has(job.confirmationName)) fail('duplicate_confirmation_name');
      confirmationJobs.set(job.confirmationName, job);
    }
  }
  for (const plan of plans) for (const job of plan.jobs.filter(j => j.kind === 'translated' && result.results[j.dependency])) {
    try { bindDependent(plan, job, result.results[job.dependency]); }
    catch (e) { result.dependentFailures[job.id] = e.message; }
  }
  result.committedMicros = root.priorMicros + root.unknownHeldMicros + [...jobs.values()].reduce((sum, job) => sum + (result.results[job.id]?.actualMicros ?? job.reservedMicros), 0) + confirmations.size * CONFIRMATION_RESERVE +
    [...confirmationJobs.values()].reduce((sum, job) => sum + Math.max(0, (result.results[job.id]?.actualMicros ?? 0) - CONFIRMATION_RESERVE), 0);
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
    // Validate proposed union before writing any maintained registration.
    const unique = new Map(current.plans.flatMap(p => p.jobs).map(j => [j.id, j]));
    for (const job of plan.jobs) {
      if (unique.has(job.id) && hash(unique.get(job.id)) !== hash(job)) fail('case_spec_changed');
      unique.set(job.id, job);
    }
    const names = new Set([...current.plans.flatMap(p => p.confirmationNames), ...plan.confirmationNames]);
    const total = current.priorMicros + current.unknownHeldMicros + [...unique.values()].reduce((sum, j) => sum + (current.results[j.id]?.actualMicros ?? j.reservedMicros), 0) + names.size * CONFIRMATION_RESERVE;
    if (names.size > 60 || total > CEILING) fail('evaluation_budget_exceeded');
    await save(path.join(directory, 'plans', approvedHash + '.json'), plan);
  });
}
export async function admitShard({directory, plan, manifest, executionID, batchAccepted = false, representativeReviewed = false}) {
  await validatePlan(plan, manifest.planHash);
  return exclusive(directory, async () => {
    const current = await snapshot(directory);
    if (current.budgetExceeded) fail('evaluation_budget_exceeded');
    if (!current.plans.some(p => hash(p) === hash(plan))) fail('register_plan_first');
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(executionID ?? '')) fail('execution_identity_required');
    if (manifest.transport === 'batch' && (!batchAccepted || !representativeReviewed || !plan.seedIDs.every(id => current.results[id]?.valid && current.states[id]?.transport === 'standard'))) fail('standard_review_and_batch_entitlement_required');
    const expected = shard(plan, manifest.jobs.map(j => j.id), current.results, manifest.transport);
    if (hash(expected) !== hash(manifest)) fail('shard_changed');
    if (manifest.jobs.some(j => current.states[j.id])) fail('already_submitted_or_unknown_never_resend');
    if (manifest.jobs.some(j => j.confirmationName && current.manifests.some(m => m.jobs.some(old => old.confirmationName === j.confirmationName)))) fail('duplicate_confirmation_name');
    if (Object.values(current.states).some(s => ['unknown', 'unknown_cost', 'cost_overrun'].includes(s.state))) fail('prior_shard_unresolved_reconcile_first');
    const shardHash = hash(manifest);
    await save(path.join(directory, 'shards', shardHash + '.json'), manifest);
    await appendMany(directory, manifest.jobs.map(job => ({...baseEvent(manifest, job), event: 'language_expansion_admitted', executionID})));
    return {schema: SCHEMA, planHash: hash(plan), shardHash, executionID, transport: manifest.transport};
  });
}
export const baseEvent = (manifest, job) => ({schema: SCHEMA, planHash: manifest.planHash, shardHash: hash(manifest), caseID: job.id, bodyHash: job.bodyHash, reservedMicros: job.reservedMicros, transport: manifest.transport});
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
