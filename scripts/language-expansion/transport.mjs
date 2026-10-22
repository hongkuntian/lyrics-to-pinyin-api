import {RESEARCH_BATCH_PRICE} from '../../api/utils/song-library/model-policy.js';
import {isModelPlan,validateModelManifest} from './model-plans.mjs';
import {observeHTTP,validateObservation} from './http-observation.mjs';
import {requestBody, parseTranslation, usageMicros, reservationMicros} from '../../api/utils/song-library/translation.js';
import {explanationBody, parseExplanation, parseGroundedExplanation} from '../../api/utils/song-library/study-explanation.js';
import {GROUNDING_FORMAT} from '../../api/utils/song-library/study-grounding.js';
import {hash, fail, MAX_PAYLOAD, emitRecord, payloadEvents, boundedSink} from './common.mjs';
import {batchInput, validatePlan} from './plan.mjs';
import {baseEvent} from './journal.mjs';
import {terminalBatch, terminalIdentity, scanReceipt, scanProjection} from './reconciliation.mjs';
import {BATCH_RETRIEVAL, scanFile, fileProjection, boundedFetchStream, validateFileReceipt} from './batch-files.mjs';

export async function validateManifest(plan, manifest, approvedHash) {
  await validatePlan(plan, manifest.planHash);
  if (hash(manifest) !== approvedHash || !['standard', 'batch'].includes(manifest.transport) || !manifest.jobs.length ||
      (manifest.transport === 'standard' && manifest.jobs.length > 4) || manifest.maxRawBytes !== MAX_PAYLOAD ||
      new Set(manifest.jobs.map(j => j.id)).size !== manifest.jobs.length) fail('invalid_frozen_manifest');
  if(isModelPlan(plan)){validateModelManifest(plan,manifest);return;}
  for (const job of manifest.jobs) {
    const intent = plan.jobs.find(j => j.id === (job.confirmationOf ?? job.id)), source = plan.sources.find(s => s.id === job.source);
    if (intent?.executionDisposition !== 'generate' || job.executionDisposition !== 'generate') fail('static_refusal_not_dispatchable');
    if (job.confirmationOf && (manifest.transport !== 'standard' || !plan.confirmationNames.includes(job.confirmationName) || job.id !== `${job.confirmationOf}--confirmation--${job.confirmationName}`)) fail('invalid_named_standard_confirmation');
    if (!intent || !source || ['source', 'kind', 'target', 'explanation', 'dependency'].some(k => job[k] !== intent[k])) fail('unknown_manifest_case');
    if (['definitionHash', 'sourceDefinitionHash', 'executionDisposition'].some(k => job[k] !== intent[k]) || hash(job.qualification) !== hash(intent.qualification)) fail('case_definition_changed');
    const expected = job.kind === 'translation' ? requestBody(source.doc, job.target) : explanationBody(source.doc, job.translation ?? null, job.selection ?? source.selection, job.explanation ?? job.target);
    if (JSON.stringify(expected) !== job.bodyJSON || JSON.stringify(job.body) !== job.bodyJSON || hash(job.bodyJSON) !== job.bodyHash ||
        Buffer.byteLength(job.bodyJSON) + 4096 > 24000 || job.reservedMicros !== reservationMicros(job.body) || job.reservedMicros > intent.reservedMicros) fail('frozen_body_changed');
  }
  if (manifest.transport === 'batch' && (manifest.jobs.length > BATCH_RETRIEVAL.maxCases || !manifest.retrievalPolicy || hash(manifest.retrievalPolicy) !== hash(BATCH_RETRIEVAL) ||
      Buffer.byteLength(batchInput(manifest)) > BATCH_RETRIEVAL.inputBytes)) fail('invalid_batch_retrieval_policy');
}
export function responseResult(plan, job, response, transport, error = null) {
  if (job.executionDisposition !== 'generate') fail('static_refusal_not_dispatchable');
  if (transport==='batch'&&job.body?.model==='gpt-6.1-sol'&&hash(job.batchPriceDescriptor??null)!==hash(RESEARCH_BATCH_PRICE)) fail('sol_batch_descriptor_not_reviewed_for_case');
  const actualMicros = response?.model === job.body.model && response?.service_tier === job.body.service_tier ? usageMicros(response?.usage, job.body.model, {batch: transport === 'batch'}) : null;
  const source = plan.sources.find(s => s.id === job.source);
  const result = {id: job.id, bodyHash: job.bodyHash, definitionHash: job.definitionHash, sourceDefinitionHash: job.sourceDefinitionHash,
    qualification: job.qualification, transport, valid: false, actualMicros,
    accountedMicros: actualMicros ?? job.reservedMicros, response: response ?? null,
    sourceBindings: source.bindings, selection: job.selection ?? source.selection};
  try {
    if (error) fail(error);
    if (response?.model !== job.body.model || response?.service_tier !== job.body.service_tier) fail('provider_configuration_changed');
    if (actualMicros === null) fail('invalid_provider_usage');
    if (response.status !== 'completed') fail('provider_incomplete');
    const parts = (response.output ?? []).filter(o => o.type === 'message').flatMap(o => o.content ?? []);
    if (parts.some(p => p.type === 'refusal')) fail('provider_refused');
    const texts = parts.filter(p => p.type === 'output_text');
    if (texts.length !== 1) fail('invalid_provider_response');
    result.content = job.kind === 'translation' ? parseTranslation(texts[0].text, source.doc) :
      job.body.text.format.name === GROUNDING_FORMAT ? parseGroundedExplanation(texts[0].text, source.doc, job.translation ?? null, job.selection ?? source.selection) : parseExplanation(texts[0].text, job.selection ?? source.selection);
    if (result.content.rejectedNotes?.length) fail('invalid_source_evidence');
    result.valid = true;
  } catch (e) { result.error = /^[a-z_]{1,80}$/.test(e.message) ? e.message : 'invalid_provider_response'; delete result.content; }
  return result;
}
function safeResult(plan, job, result, secret) {
  // Discard the credential-bearing response completely. A canonical result
  // remains reconstructible from retained evidence and keeps the full hold.
  if (secret && JSON.stringify(result).includes(secret))
    return responseResult(plan, job, null, result.transport, 'provider_echoed_credentials');
  return result;
}
async function output(plan, manifest, job, result, emit, secret) {
  const safe = safeResult(plan, job, result, secret);
  for (const event of payloadEvents(baseEvent(manifest, job), safe)) await emitRecord(emit, event);
  return safe;
}
function checkTicket(manifest, ticket, executionID) {
  if (ticket.planHash !== manifest.planHash || ticket.shardHash !== hash(manifest) || ticket.transport !== manifest.transport || ticket.executionID !== executionID) fail('execution_identity_mismatch');
}
export async function runStandard({plan, manifest, approvedHash, ticket, executionID, claimStart, client, emit, secret}) {
  emit = boundedSink(emit, secret);
  await validateManifest(plan, manifest, approvedHash);
  if (manifest.transport !== 'standard' || typeof client?.standard !== 'function' || typeof claimStart !== 'function') fail('explicit_provider_and_external_claim_required');
  checkTicket(manifest, ticket, executionID);
  // The Root ledger claims the entire shard BEFORE any call. A killed shard's
  // unobserved cases remain unknown, even when no per-case event escaped.
  await claimStart(ticket);
  for (const job of manifest.jobs) {
    await emitRecord(emit, {...baseEvent(manifest, job), event: 'language_expansion_submitting'});
    let result;
    try {
      const response = await client.standard(job.bodyJSON, job.kind === 'translation' ? 270_000 : 240_000);
      result = responseResult(plan, job, response, 'standard');
    } catch(error) {
      result = responseResult(plan, job, null, 'standard', 'submission_unknown');
      if(error?.providerObservation){validateObservation(error.providerObservation,job.bodyHash);result.httpObservation=error.providerObservation;}
    }
    result = await output(plan, manifest, job, result, emit, secret);
    if (result.actualMicros === null || result.actualMicros > job.reservedMicros || ['provider_configuration_changed', 'provider_echoed_credentials'].includes(result.error)) fail('stop_reconcile_unknown_or_configuration');
  }
}
const metadata = manifest => ({planHash: manifest.planHash, shardHash: hash(manifest), inputHash: hash(batchInput(manifest))});
const control = async (manifest, emit, operation, state, extra = {}) => emitRecord(emit, {...baseEvent(manifest, manifest.jobs[0]), event: 'language_expansion_control', operation, state, inputHash: metadata(manifest).inputHash, ...extra});
function batchIdentity(manifest, batch, inputFileID) {
  if (!batch || !/^batch_[A-Za-z0-9_-]+$/.test(batch.id ?? '') || batch.endpoint !== '/v1/responses' ||
      Object.entries(metadata(manifest)).some(([key, value]) => batch.metadata?.[key] !== value) ||
      !/^file-[A-Za-z0-9_-]+$/.test(batch.input_file_id ?? '') || (inputFileID && inputFileID !== batch.input_file_id)) fail('batch_identity_unknown');
  return batch;
}
function batchFields(batch) {
  return {batchID: batch.id, inputFileID: batch.input_file_id, outputFileID: batch.output_file_id ?? null, errorFileID: batch.error_file_id ?? null, status: batch.status, requestCounts: batch.request_counts ?? null};
}
export async function submitBatch({plan, manifest, approvedHash, ticket, executionID, claimStart, client, emit, secret}) {
  emit = boundedSink(emit, secret);
  await validateManifest(plan, manifest, approvedHash);
  if (manifest.transport !== 'batch' || typeof claimStart !== 'function') fail('batch_admission_required');
  checkTicket(manifest, ticket, executionID);
  await claimStart(ticket);
  for (const job of manifest.jobs) await emitRecord(emit, {...baseEvent(manifest, job), event: 'language_expansion_submitting'});
  await control(manifest, emit, 'upload', 'submitting');
  let file;
  try { file = await client.upload(batchInput(manifest)); } catch { await control(manifest, emit, 'upload', 'unknown'); fail('upload_unknown_stop'); }
  if (!/^file-[A-Za-z0-9_-]+$/.test(file?.id ?? '')) fail('input_file_identity_unknown');
  await control(manifest, emit, 'upload', 'known', {inputFileID: file.id});
  await control(manifest, emit, 'create', 'submitting', {inputFileID: file.id});
  let batch;
  try { batch = batchIdentity(manifest, await client.create({input_file_id: file.id, endpoint: '/v1/responses', completion_window: '24h', metadata: metadata(manifest)}), file.id); }
  catch { await control(manifest, emit, 'create', 'unknown', {inputFileID: file.id}); fail('batch_create_unknown_stop'); }
  await control(manifest, emit, 'create', 'known', batchFields(batch));
  return batch;
}
export async function inspectBatch({manifest, batchID, inputFileID, client, emit, secret}) {
  emit = boundedSink(emit, secret);
  const batch = batchIdentity(manifest, await client.inspect(batchID), inputFileID);
  if (batch.id !== batchID) fail('batch_identity_unknown');
  await control(manifest, emit, 'inspect', 'known', batchFields(batch));
  return batch;
}
async function fileBytes(client, id, maximum = MAX_PAYLOAD) {
  const chunks = []; let size = 0;
  for await (const bytes of await client.file(id)) {
    const chunk = Buffer.from(bytes); size += chunk.length;
    if (size > maximum) fail('retrieval_operation_limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
// Lost create responses are recovered by LIST + metadata + exact uploaded bytes.
// A zero/ambiguous/bounded-search result remains unknown; never call create here.
export async function recoverBatch({manifest, inputFileID, client, emit, maxPages = 10, secret}) {
  emit = boundedSink(emit, secret);
  const matches = []; let after;
  for (let page = 0; page < maxPages; page++) {
    const listing = await client.list(after);
    if (!Array.isArray(listing.data)) fail('invalid_batch_listing');
    for (const candidate of listing.data) {
      if (candidate.metadata?.shardHash !== hash(manifest)) continue;
      const batch = batchIdentity(manifest, candidate, inputFileID);
      if (hash(await fileBytes(client, batch.input_file_id)) !== metadata(manifest).inputHash) fail('batch_input_hash_mismatch');
      matches.push(batch);
    }
    if (!listing.has_more) break;
    if (page + 1 === maxPages || !listing.data.at(-1)?.id) fail('batch_identity_unknown');
    after = listing.data.at(-1).id;
  }
  if (matches.length !== 1) { await control(manifest, emit, 'recover', 'unknown'); fail('batch_identity_unknown'); }
  await control(manifest, emit, 'recover', 'known', batchFields(matches[0]));
  return matches[0];
}
export async function retrieveBatch({plan, manifest, approvedHash, batchID, inputFileID, client, emit, secret,
  selectedCaseID, expectedIdentity, expectedFiles = [], expectedScan, retainedResults = {}}) {
  emit = boundedSink(emit, secret);
  await validateManifest(plan, manifest, approvedHash);
  if (manifest.transport !== 'batch' || !manifest.jobs.some(j => j.id === selectedCaseID)) fail('one_selected_batch_case_required');
  if (!inputFileID) fail('known_batch_input_required');
  const batch = batchIdentity(manifest, await client.inspect(batchID), inputFileID);
  if (batch.id !== batchID) fail('batch_identity_unknown');
  if (!terminalBatch(batch.status)) fail('batch_not_terminal');
  const identity = terminalIdentity(manifest, batchFields(batch));
  if ((expectedIdentity && hash(terminalIdentity(manifest, expectedIdentity)) !== hash(identity)) ||
      (expectedScan && expectedScan.identityHash !== hash(identity))) fail('batch_identity_changed');
  if (expectedScan && (!Array.isArray(expectedScan.files) || expectedScan.version !== BATCH_RETRIEVAL.version)) fail('invalid_expected_scan');
  if (!Array.isArray(expectedFiles) || new Set(expectedFiles.map(f => f.role)).size !== expectedFiles.length ||
      expectedFiles.some(f => !['output', 'error'].includes(f.role) || f.fileID !== identity[f.role + 'FileID'] ||
        f.version !== BATCH_RETRIEVAL.version || f.identityHash !== hash(identity))) fail('invalid_partial_file_pins');
  for (const pin of [...expectedFiles, ...(expectedScan?.files ?? [])]) {
    validateFileReceipt(pin);
    if (pin.fileID !== identity[pin.role + 'FileID']) fail('batch_file_changed');
  }
  await control(manifest, emit, 'inspect', 'known', batchFields(batch));
  const seen = new Set(), files = [], rows = [], budget = {bytes: 0};
  for (const [role, fileID] of [['output', identity.outputFileID], ['error', identity.errorFileID]]) {
    if (!fileID) continue;
    const scan = await scanFile({stream: await client.file(fileID), role, fileID, manifest, seen, budget, selectedCaseID});
    const pins = [...expectedFiles.filter(f => f.role === role), ...(expectedScan?.files.filter(f => f.role === role) ?? [])];
    if (pins.some(f => hash(fileProjection(f)) !== hash(fileProjection(scan.receipt)))) fail('batch_file_changed');
    files.push(scan.receipt); rows.push(...scan.rows);
    await emitRecord(emit, {...baseEvent(manifest, manifest.jobs[0]), event: 'language_expansion_file_scan',
      version: BATCH_RETRIEVAL.version, identityHash: hash(identity), ...scan.receipt});
    if (scan.selected) {
      const {row, rawLine, descriptor} = scan.selected, job = manifest.jobs.find(j => j.id === selectedCaseID);
      const result = responseResult(plan, job, row.response?.body ?? null, 'batch',
        row.error != null ? 'batch_case_error' : row.response?.status_code !== 200 ? 'batch_http_error' : null);
      Object.assign(result, {fileID, role, lineIndex: descriptor.lineIndex, rawLine, filePayloadHash: scan.receipt.payloadHash});
      const safe = safeResult(plan, job, result, secret), retained = retainedResults[job.id];
      if (retained) { if (hash(safe) !== hash(retained)) fail('retained_batch_result_changed'); }
      else await output(plan, manifest, job, safe, emit, secret);
      if (['provider_configuration_changed', 'provider_echoed_credentials'].includes(safe.error)) fail('stop_reconcile_unknown_or_configuration');
    }
  }
  const receipt = scanReceipt(identity, files, rows);
  if (expectedScan && hash(scanProjection(expectedScan)) !== hash(receipt)) fail('batch_scan_changed');
  await emitRecord(emit, {...baseEvent(manifest, manifest.jobs[0]), event: 'language_expansion_scan', ...receipt});
  await control(manifest, emit, 'retrieve', 'retained', batchFields(batch));
  // Complete scans never clear the independent local reconciliation gate.
  return {cases: seen.size, selectedCaseID, rawBytes: budget.bytes, status: batch.status};
}

// No ambient global fetch: tests and build wiring must inject the transport.
export function openAIClient({apiKey, fetchFn}) {
  if (!apiKey || typeof fetchFn !== 'function') fail('explicit_sensitive_key_and_fetch_required');
  async function request(route, {method = 'GET', body, timeout = 30_000} = {}) {
    const response = await fetchFn('https://api.openai.com/v1/' + route, {method, headers: {Authorization: `Bearer ${apiKey}`, ...(typeof body === 'string' ? {'Content-Type': 'application/json'} : {})}, body, signal: AbortSignal.timeout(timeout)});
    if (!response.ok) {
      if(route==='responses'&&method==='POST'&&typeof body==='string') {
        const observation=await observeHTTP(response,hash(body),apiKey);
        const error=new Error('provider_rejected');error.providerObservation=observation;throw error;
      }
      await response.body?.cancel(); fail('provider_rejected');
    }
    return response;
  }
  const json = async (route, options) => {
    const response = await request(route, options), data = [];
    let size = 0;
    for await (const bytes of response.body) { size += bytes.length; if (size > MAX_PAYLOAD) fail('provider_response_limit'); data.push(Buffer.from(bytes)); }
    return JSON.parse(Buffer.concat(data).toString('utf8'));
  };
  return {
    standard: (body, timeout) => json('responses', {method: 'POST', body, timeout}),
    upload: text => { const form = new FormData(); form.set('purpose', 'batch'); form.set('file', new Blob([text], {type: 'application/jsonl'}), 'language-expansion.jsonl'); return json('files', {method: 'POST', body: form}); },
    create: body => json('batches', {method: 'POST', body: JSON.stringify(body)}),
    inspect: id => json('batches/' + encodeURIComponent(id)),
    list: after => json('batches?limit=100' + (after ? '&after=' + encodeURIComponent(after) : '')),
    file: async id => boundedFetchStream((await request('files/' + encodeURIComponent(id) + '/content')).body),
  };
}
