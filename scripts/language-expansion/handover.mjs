// Explicit version handover: retain the old executable, plans, journal prefix,
// results and costs. Old receipts are decoded only by that pinned executable.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {hash, fail, readJSON, save, codeHashes} from './common.mjs';
import {validatePlan} from './plan.mjs';

export async function hashesAt(directory) {
  const files = ['scripts/evaluate-language-expansion.mjs', 'scripts/language-expansion-build.mjs', 'scripts/evaluate-content-quality.mjs',
    'api/utils/lyric-annotations.js', 'api/utils/lyric-selection.js', 'api/utils/vocal-timing.js', 'api/utils/rejected-lyrics.js',
    'api/data/lyric-performers.json', 'api/data/rejected-lyrics.json', 'package.json', 'package-lock.json'];
  for (const dir of ['scripts/language-expansion', 'api/utils/song-library'])
    for (const name of (await fs.readdir(path.join(directory, dir))).sort())
      if (/\.(mjs|js|json)$/.test(name)) files.push(dir + '/' + name);
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, hash(await fs.readFile(path.join(directory, file)))])));
}
const production = values => Object.fromEntries(Object.entries(values).filter(([name]) =>
  !name.startsWith('scripts/language-expansion/') && !['scripts/evaluate-language-expansion.mjs', 'scripts/language-expansion-build.mjs'].includes(name)));
function sameGeneration(oldPlans, next) {
  for (const old of oldPlans) {
    if (hash(production(old.codeHashes)) !== hash(production(next.codeHashes)) ||
        ['corpusHash', 'routingHash', 'sourceProfile', 'sources', 'seedIDs'].some(k => hash(old[k]) !== hash(next[k])) ||
        old.jobs.some(j => hash(j) !== hash(next.jobs.find(n => n.id === j.id))) ||
        old.confirmationNames.some(n => !next.confirmationNames.includes(n))) fail('handover_generation_identity_changed');
  }
}
async function readFrozen(directory, kind, hashes) {
  const values = [];
  for (const digest of hashes) {
    const value = await readJSON(path.join(directory, kind, digest + '.json'));
    if (hash(value) !== digest) fail('frozen_file_hash_mismatch');
    values.push(value);
  }
  return values;
}
export async function legacyReplay(directory, record, {replayRoot = os.tmpdir(), metadata} = {}) {
  const oldPlans = await readFrozen(directory, 'plans', record.legacyPlanHashes);
  const oldShards = await readFrozen(directory, 'shards', record.legacyShardHashes);
  const observed = await hashesAt(record.legacyCodeRoot);
  if (record.legacyCodeHash ? record.legacyCodeHash !== hash(observed) : oldPlans.some(p => hash(p.codeHashes) !== hash(observed))) fail('legacy_generation_code_changed');
  const rootBytes = await fs.readFile(path.join(directory, 'root.json'));
  const journalBytes = await fs.readFile(path.join(directory, 'journal.jsonl'));
  const prefix = journalBytes.subarray(0, record.prefixBytes);
  if (hash(rootBytes) !== record.rootHash || prefix.length !== record.prefixBytes || hash(prefix) !== record.prefixHash ||
      (prefix.length && prefix.at(-1) !== 10)) fail('handover_prefix_changed');
  const oldAPI = await import(pathToFileURL(path.join(record.legacyCodeRoot, 'scripts/evaluate-language-expansion.mjs')).href);
  // Replay a private prefix view; the original journal is never rewritten.
  const parent = await fs.realpath(replayRoot), journal = await fs.realpath(directory);
  if (parent === journal || parent.startsWith(journal + path.sep)) fail('replay_scratch_must_be_outside_journal');
  const view = await fs.mkdtemp(path.join(parent, 'language-expansion-replay-'));
  try {
    await fs.writeFile(path.join(view, 'root.json'), rootBytes);
    await fs.writeFile(path.join(view, 'journal.jsonl'), prefix);
    for (const [kind, values] of [['plans', oldPlans], ['shards', oldShards]])
      for (const value of values) await save(path.join(view, kind, hash(value) + '.json'), value);
    if (metadata?.handover) await save(path.join(view, 'handover.json'), metadata.handover);
    for (const value of metadata?.transitions ?? []) await save(path.join(view,'recipe-transitions',hash(value)+'.json'),value);
    const state = await oldAPI.snapshot(view, {replayRoot: parent});
    if (record.legacySnapshotHash && hash(state) !== record.legacySnapshotHash) fail('handover_legacy_snapshot_changed');
    return state;
  } finally { await fs.rm(view, {recursive: true}); }
}
export async function handoverState(directory, plans, rows, options) {
  const record = await readJSON(path.join(directory, 'handover.json')).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (!record) return null;
  if (record.version !== 'executor-handover-1' || record.targetCodeHash !== hash(await codeHashes()) ||
      !Number.isSafeInteger(record.prefixEvents) || record.prefixEvents < 0) fail('invalid_executor_handover');
  const next = plans.find(p => hash(p) === record.targetPlanHash);
  if (!next) fail('handover_registration_incomplete');
  await validatePlan(next, record.targetPlanHash);
  const state = await legacyReplay(directory, record, options);
  if (state.events.length !== record.prefixEvents || rows.length < record.prefixEvents ||
      (rows[record.prefixEvents - 1]?.hash ?? hash('')) !== record.prefixTip) fail('handover_prefix_changed');
  sameGeneration(state.plans, next);
  return {record, state};
}
// Caller owns journal.exclusive. This is idempotent only for the identical
// checkpoint/target; it neither initializes nor replaces a global ledger.
export async function handoverPlanLocked(directory, plan, approvedHash, legacyCodeRoot) {
  await validatePlan(plan, approvedHash);
  const names = async kind => (await fs.readdir(path.join(directory, kind))).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => n.slice(0, -5)).sort();
  const existing = await readJSON(path.join(directory, 'handover.json')).catch(e => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (existing) {
    if (existing.targetPlanHash !== approvedHash || existing.legacyCodeRoot !== path.resolve(legacyCodeRoot) || existing.targetCodeHash !== hash(await codeHashes())) fail('handover_already_frozen');
    const state = await legacyReplay(directory, existing); sameGeneration(state.plans, plan);
    const target = path.join(directory, 'plans', approvedHash + '.json');
    try { await save(target, plan); } catch (e) { if (e.code !== 'EEXIST' || hash(await readJSON(target)) !== approvedHash) throw e; }
    return existing;
  }
  const raw = await fs.readFile(path.join(directory, 'journal.jsonl'));
  const rows = raw.length ? raw.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line)) : [];
  const record = {version: 'executor-handover-1', legacyCodeRoot: path.resolve(legacyCodeRoot), targetPlanHash: approvedHash,
    targetCodeHash: hash(await codeHashes()), legacyPlanHashes: await names('plans'), legacyShardHashes: await names('shards').catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e)),
    rootHash: hash(await fs.readFile(path.join(directory, 'root.json'))), prefixBytes: raw.length, prefixHash: hash(raw),
    prefixEvents: rows.length, prefixTip: rows.at(-1)?.hash ?? hash('')};
  if (!record.legacyPlanHashes.length) fail('legacy_registered_plan_required');
  const state = await legacyReplay(directory, record); sameGeneration(state.plans, plan);
  if (Object.values(state.shardStates).some(s => s.state !== 'reconciled') || Object.values(state.states).some(s => s.state === 'unknown')) fail('finish_legacy_execution_before_handover');
  // Unknown costs/overruns remain in the inherited state and still block admission.
  if (state.budgetExceeded) fail('evaluation_budget_exceeded');
  const extra = plan.jobs.filter(j => !state.plans.some(p => p.jobs.some(old => old.id === j.id))).reduce((n, j) => n + j.reservedMicros, 0);
  if (extra || state.plans.some(p => hash(p.confirmationNames) !== hash(plan.confirmationNames))) fail('handover_requires_same_generation_schedule');
  record.legacySnapshotHash = hash(state);
  await save(path.join(directory, 'handover.json'), record);
  await save(path.join(directory, 'plans', approvedHash + '.json'), plan);
  return record;
}
