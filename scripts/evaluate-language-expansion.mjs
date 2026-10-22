// Research only. This entry point never changes production policy or data.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash, readJSON, save, fail} from './language-expansion/common.mjs';
import {preparePlan, shard, validatePlan} from './language-expansion/plan.mjs';
import {initJournal, registerPlan, snapshot, admitShard, claimStart, append, importEvents} from './language-expansion/journal.mjs';
import {runStandard, submitBatch, inspectBatch, recoverBatch, retrieveBatch, openAIClient} from './language-expansion/transport.mjs';
export {hash, preparePlan, shard, validatePlan, initJournal, registerPlan, snapshot, admitShard, claimStart, importEvents,
  runStandard, submitBatch, inspectBatch, recoverBatch, retrieveBatch};

export async function execute({plan, manifest, ticket, directory, operation, client, emit, secret, executionID = ticket.executionID}) {
  const state = await snapshot(directory);
  if (!state.manifests.some(m => hash(m) === hash(manifest))) fail('unregistered_manifest');
  const send = async event => { await append(directory, event); if (emit) await emit(event); };
  const options = {plan, manifest, ticket, executionID, approvedHash: hash(manifest), client, emit: send, secret,
    claimStart: t => claimStart(directory, t), retainedResults: state.results};
  if (operation === 'standard') return runStandard(options);
  if (operation === 'submit') return submitBatch(options);
  const controls = state.events.filter(e => e.event === 'language_expansion_control' && e.shardHash === hash(manifest));
  const known = controls.findLast(e => e.batchID);
  options.batchID = known?.batchID;
  options.inputFileID = controls.findLast(e => e.inputFileID)?.inputFileID;
  if (operation === 'recover') return recoverBatch(options);
  if (!options.batchID) fail('known_batch_id_required');
  if (operation === 'inspect') return inspectBatch(options);
  if (operation === 'retrieve') return retrieveBatch(options);
  fail('explicit_operation_required');
}

async function main() {
  const [command, ...args] = process.argv.slice(2), options = {};
  if (args.length % 2) fail('named_argument_values_required');
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || Object.hasOwn(options, args[i])) fail('invalid_argument');
    options[args[i]] = args[i + 1];
  }
  const directory = options['--journal'];
  if (command === 'prepare') {
    const corpus = await readJSON(options['--corpus']);
    const plan = await preparePlan({corpus, approvedCorpusHash: options['--approved-corpus-hash'],
      mode: options['--mode'] ?? 'matrix728', confirmationNames: JSON.parse(options['--confirmation-names'] ?? '[]')});
    await save(options['--out'], plan);
    return {planHash: hash(plan), jobs: plan.jobs.length, seedIDs: plan.seedIDs, maxReservedMicros: plan.maxReservedMicros, confirmationReserveMicros: plan.confirmationReserveMicros};
  }
  if (command === 'init') return initJournal(directory, {priorMicros: Number(options['--prior-micros'] ?? 0), unknownHeldMicros: Number(options['--unknown-held-micros'] ?? 0)});
  if (command === 'status') {
    const state = await snapshot(directory);
    if (options['--out']) await save(options['--out'], state);
    return {committedMicros: state.committedMicros, admitted: Object.keys(state.states).length,
      completed: Object.keys(state.results).length, dependentFailures: Object.keys(state.dependentFailures).length,
      unknown: Object.values(state.states).filter(s => ['unknown', 'unknown_cost'].includes(s.state)).length};
  }
  if (command === 'import') {
    const lines = (await fs.readFile(options['--events'], 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    await importEvents(directory, lines); return {imported: lines.length};
  }
  const plan = await readJSON(options['--plan']);
  await validatePlan(plan, options['--approved-plan-hash']);
  if (command === 'register') return registerPlan(directory, plan, options['--approved-plan-hash']);
  if (command === 'freeze') {
    const state = await snapshot(directory);
    const manifest = shard(plan, options['--case-ids'].split(','), state.results, options['--transport'] ?? 'standard');
    await save(options['--out'], manifest); return {shardHash: hash(manifest), cases: manifest.jobs.length};
  }
  const manifest = await readJSON(options['--manifest']);
  if (hash(manifest) !== options['--approved-shard-hash']) fail('shard_changed');
  if (command === 'admit') {
    const ticket = await admitShard({directory, plan, manifest, executionID: options['--execution-id'],
      batchAccepted: options['--batch-accepted'] === 'yes', representativeReviewed: options['--representative-reviewed'] === 'yes'});
    await save(options['--out'], ticket); return ticket;
  }
  if (command === 'start') {
    const receipt = await claimStart(directory, await readJSON(options['--ticket']));
    await save(options['--out'], receipt); return {started: true, receiptHash: hash(receipt)};
  }
  // Root alone supplies a positive allocation and explicit live instruction.
  // This worker has zero allocation and exercises only injected fake clients.
  if (command !== 'execute' || options['--live'] !== 'yes' || Number(options['--allocation-micros']) !== manifest.jobs.reduce((n, j) => n + j.reservedMicros, 0)) fail('explicit_root_allocation_required');
  const ticket = await readJSON(options['--ticket']);
  const secret = process.env.OPENAI_API_KEY;
  return execute({plan, manifest, ticket, directory, operation: options['--operation'], secret,
    client: openAIClient({apiKey: secret, fetchFn: globalThis.fetch}), emit: event => process.stdout.write(JSON.stringify(event) + '\n')});
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(value => { if (value !== undefined) process.stdout.write(JSON.stringify({event: 'language_expansion_command', result: value}) + '\n'); })
    .catch(() => { process.stderr.write('language_expansion_command_failed; reconcile external journal before any further submission\n'); process.exitCode = 1; });
}
