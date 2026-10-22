// Intentionally unwired. Root owns the existing streaming build wrapper.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {readJSON, hash, fail, emitRecord, SCHEMA} from './language-expansion/common.mjs';
import {runStandard, submitBatch, inspectBatch, recoverBatch, retrieveBatch, validateManifest, openAIClient} from './language-expansion/transport.mjs';
import {validateStartReceipt} from './language-expansion/journal.mjs';

/** Root supplies an authoritative, durable one-time claim BEFORE provider work.
 * A frozen journal snapshot or a /tmp marker is NOT an implementation of claimStart.
 * emit receives allowlisted JSON records, already bounded for build-preflight.mjs.
 */
export async function evaluateLanguageExpansionInBuild(env = process.env, {loadBundle, claimStart, emit, fetchFn, client} = {}) {
  if (env.LYRA_LANGUAGE_EXPANSION_ON_BUILD !== '1') return;
  if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'production') fail('unpromoted_production_build_required');
  if (!/^[a-f0-9]{64}$/.test(env.LYRA_LANGUAGE_EXPANSION_PLAN_HASH ?? '') || !/^[a-f0-9]{64}$/.test(env.LYRA_LANGUAGE_EXPANSION_SHARD_HASH ?? '')) fail('reviewed_frozen_hashes_required');
  if (typeof emit !== 'function') fail('streaming_emit_required');
  if (!loadBundle) {
    const file = env.LYRA_LANGUAGE_EXPANSION_BUNDLE_PATH;
    if (!file || !path.isAbsolute(file) || /(^|\/)(public|static|\.vercel)(\/|$)/.test(file)) fail('private_bundle_path_required');
    loadBundle = () => readJSON(file);
  }
  const bundle = await loadBundle();
  const {plan, manifest, ticket, operation} = bundle;
  if (hash(plan) !== env.LYRA_LANGUAGE_EXPANSION_PLAN_HASH) fail('plan_changed');
  await validateManifest(plan, manifest, env.LYRA_LANGUAGE_EXPANSION_SHARD_HASH);
  if (ticket.planHash !== hash(plan) || ticket.shardHash !== hash(manifest) || ticket.executionID !== env.VERCEL_DEPLOYMENT_ID || ticket.transport !== manifest.transport) fail('execution_identity_mismatch');
  if (bundle.allocationMicros !== manifest.jobs.reduce((sum, j) => sum + j.reservedMicros, 0)) fail('explicit_root_allocation_required');
  if (manifest.transport === 'batch' && (!bundle.representativeReviewed || !bundle.batchAccepted)) fail('standard_review_and_batch_entitlement_required');
  const options = {plan, manifest, ticket, approvedHash: hash(manifest), executionID: env.VERCEL_DEPLOYMENT_ID,
    claimStart, client: client ?? openAIClient({apiKey: env.OPENAI_API_KEY, fetchFn}), emit, secret: env.OPENAI_API_KEY,
    batchID: bundle.batchID, inputFileID: bundle.inputFileID};
  options.retainedResults = bundle.retainedResults ?? {};
  if (operation === 'standard' && manifest.transport === 'standard') return runStandard(options);
  if (operation === 'submit' && manifest.transport === 'batch') return submitBatch(options);
  // Read-only recovery commands never submit or switch transports.
  if (operation === 'inspect' && bundle.batchID) return inspectBatch(options);
  if (operation === 'recover') return recoverBatch(options);
  if (operation === 'retrieve' && bundle.batchID) return retrieveBatch(options);
  fail('explicit_transport_operation_required');
}

/** Direct entry for an immutable EVALUATION-ONLY branch. Always rejects after
 * emitting terminal evidence, so the caller must leave the build nonzero.
 * Root records start in the external journal before submitting ONE deployment.
 * The receipt binds that decision; it is not a cross-container dedup service.
 */
export async function runLanguageExpansionBuild({planPath, planHash, manifestPath, manifestHash, shardID, ticketPath,
  startReceiptPath, operation, allocationMicros, batchID, inputFileID, retainedResultsPath,
  representativeReviewed = false, batchAccepted = false},
  {env = process.env, emit = e => process.stdout.write(JSON.stringify(e) + '\n'), client, fetchFn, claimStart} = {}) {
  let completed = false;
  try {
    if (env.VERCEL !== '1' || env.VERCEL_ENV !== 'production') fail('evaluation_requires_production_build');
    if (!/^[a-f0-9]{64}$/.test(planHash ?? '') || !/^[a-f0-9]{64}$/.test(manifestHash ?? '') || shardID !== manifestHash) fail('reviewed_fixed_shard_required');
    for (const file of [planPath, manifestPath, ticketPath, startReceiptPath, retainedResultsPath].filter(Boolean)) {
      if (/(^|\/)(public|static|\.vercel)(\/|$)/.test(file)) fail('private_bundle_path_required');
    }
    const [plan, manifest, ticket] = await Promise.all([readJSON(planPath), readJSON(manifestPath), readJSON(ticketPath)]);
    if (hash(plan) !== planHash || manifest.planHash !== planHash) fail('plan_changed');
    await validateManifest(plan, manifest, manifestHash);
    if (ticket.shardHash !== manifestHash || ticket.planHash !== planHash || ticket.transport !== manifest.transport || !ticket.executionID) fail('invalid_external_ticket');
    if (allocationMicros !== manifest.jobs.reduce((sum, j) => sum + j.reservedMicros, 0)) fail('explicit_root_allocation_required');
    if (manifest.transport === 'batch' && (!representativeReviewed || !batchAccepted)) fail('standard_review_and_batch_entitlement_required');
    if (['standard', 'submit'].includes(operation) && !claimStart) {
      const receipt = await readJSON(startReceiptPath);
      validateStartReceipt(receipt, ticket);
      claimStart = async t => validateStartReceipt(receipt, t);
    }
    const options = {plan, manifest, ticket, executionID: ticket.executionID, approvedHash: manifestHash, claimStart,
      client: client ?? openAIClient({apiKey: env.OPENAI_API_KEY, fetchFn}), emit, secret: env.OPENAI_API_KEY,
      batchID, inputFileID, retainedResults: retainedResultsPath ? await readJSON(retainedResultsPath) : {}};
    if (operation === 'standard' && manifest.transport === 'standard') await runStandard(options);
    else if (operation === 'submit' && manifest.transport === 'batch') await submitBatch(options);
    else if (operation === 'inspect' && manifest.transport === 'batch' && batchID) await inspectBatch(options);
    else if (operation === 'recover' && manifest.transport === 'batch') await recoverBatch(options);
    else if (operation === 'retrieve' && manifest.transport === 'batch' && batchID) await retrieveBatch(options);
    else fail('explicit_transport_operation_required');
    completed = true;
  } finally {
    await emitRecord(emit, {schema: SCHEMA, event: 'language_expansion_terminal', planHash: planHash ?? null,
      shardHash: manifestHash ?? null, operation: operation ?? null, state: completed ? 'evaluation_only_complete' : 'evaluation_only_interrupted',
      intentionalBuildFailure: true});
  }
  fail('evaluation_only_intentional_build_failure');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // The reviewed configuration contains paths/hashes/operation, never a secret.
  const [flag, file] = process.argv.slice(2);
  (async () => {
    if (flag !== '--config' || !file || process.argv.length !== 4) fail('reviewed_config_required');
    await runLanguageExpansionBuild(await readJSON(file), {fetchFn: globalThis.fetch});
  })().catch(() => {
    process.stderr.write('language_expansion_evaluation_only_build_failed; retain streamed records and reconcile Root journal\n');
    process.exitCode = 1; // Let stdout flush. Never exit(1) over pending chunks.
  });
}
