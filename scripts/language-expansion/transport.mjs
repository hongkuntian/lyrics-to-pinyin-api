import {requestBody, parseTranslation, usageMicros, reservationMicros} from '../../api/utils/song-library/translation.js';
import {explanationBody, parseExplanation, parseGroundedExplanation} from '../../api/utils/song-library/study-explanation.js';
import {GROUNDING_FORMAT} from '../../api/utils/song-library/study-grounding.js';
import {hash, fail, integer, MAX_PAYLOAD, emitRecord, payloadEvents, boundedSink} from './common.mjs';
import {batchInput, validatePlan} from './plan.mjs';
import {baseEvent} from './journal.mjs';

export async function validateManifest(plan, manifest, approvedHash) {
  await validatePlan(plan, manifest.planHash);
  if (hash(manifest) !== approvedHash || !['standard', 'batch'].includes(manifest.transport) || !manifest.jobs.length ||
      (manifest.transport === 'standard' && manifest.jobs.length > 4) || manifest.maxRawBytes !== MAX_PAYLOAD ||
      new Set(manifest.jobs.map(j => j.id)).size !== manifest.jobs.length) fail('invalid_frozen_manifest');
  for (const job of manifest.jobs) {
    const intent = plan.jobs.find(j => j.id === (job.confirmationOf ?? job.id)), source = plan.sources.find(s => s.id === job.source);
    if (job.confirmationOf && (manifest.transport !== 'standard' || !plan.confirmationNames.includes(job.confirmationName) || job.id !== `${job.confirmationOf}--confirmation--${job.confirmationName}`)) fail('invalid_named_standard_confirmation');
    if (!intent || !source || ['source', 'kind', 'target', 'explanation', 'dependency'].some(k => job[k] !== intent[k])) fail('unknown_manifest_case');
    const expected = job.kind === 'translation' ? requestBody(source.doc, job.target) : explanationBody(source.doc, job.translation ?? null, job.selection ?? source.selection, job.explanation ?? job.target);
    if (JSON.stringify(expected) !== job.bodyJSON || JSON.stringify(job.body) !== job.bodyJSON || hash(job.bodyJSON) !== job.bodyHash ||
        Buffer.byteLength(job.bodyJSON) + 4096 > 24000 || job.reservedMicros !== reservationMicros(job.body) || job.reservedMicros > intent.reservedMicros) fail('frozen_body_changed');
  }
}
export function responseResult(plan, job, response, transport, error = null) {
  const actualMicros = response?.model === job.body.model && response?.service_tier === job.body.service_tier ? usageMicros(response?.usage, job.body.model, {batch: transport === 'batch'}) : null;
  const source = plan.sources.find(s => s.id === job.source);
  const result = {id: job.id, bodyHash: job.bodyHash, transport, valid: false, actualMicros,
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
function safeResult(result, secret) {
  if (secret && JSON.stringify(result).includes(secret)) return {id: result.id, bodyHash: result.bodyHash, transport: result.transport,
    valid: false, error: 'provider_echoed_credentials', actualMicros: result.actualMicros, accountedMicros: result.accountedMicros, response: null};
  return result;
}
async function output(manifest, job, result, emit, secret) {
  const safe = safeResult(result, secret);
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
    } catch { result = responseResult(plan, job, null, 'standard', 'submission_unknown'); }
    result = await output(manifest, job, result, emit, secret);
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
  return {batchID: batch.id, inputFileID: batch.input_file_id, outputFileID: batch.output_file_id ?? null, errorFileID: batch.error_file_id ?? null, status: batch.status};
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
export async function retrieveBatch({plan, manifest, approvedHash, batchID, inputFileID, client, emit, secret, retainedResults = {}}) {
  emit = boundedSink(emit, secret);
  await validateManifest(plan, manifest, approvedHash);
  const batch = await inspectBatch({manifest, batchID, inputFileID, client, emit});
  if (!['completed', 'expired', 'cancelled', 'failed'].includes(batch.status)) fail('batch_not_terminal');
  const seen = new Set(); let bytes = 0;
  for (const [role, fileID] of [['output', batch.output_file_id], ['error', batch.error_file_id]]) {
    if (!fileID) continue;
    const raw = await fileBytes(client, fileID, MAX_PAYLOAD - bytes); bytes += raw.length;
    const lines = new TextDecoder('utf-8', {fatal: true}).decode(raw).split('\n');
    if (lines.at(-1) === '') lines.pop();
    for (const [lineIndex, line] of lines.entries()) {
      const row = JSON.parse(line), job = manifest.jobs.find(j => j.id === row.custom_id);
      if (!job || seen.has(row.custom_id)) fail('duplicate_or_unknown_batch_case');
      seen.add(row.custom_id);
      if (retainedResults[job.id]) {
        const retained = retainedResults[job.id];
        if (retained.bodyHash !== job.bodyHash || retained.rawLine !== line || retained.fileID !== fileID) fail('retained_batch_result_changed');
        continue;
      }
      const result = responseResult(plan, job, row.response?.body ?? null, 'batch', row.error ? 'batch_case_error' : row.response?.status_code !== 200 ? 'batch_http_error' : null);
      Object.assign(result, {fileID, role, lineIndex, rawLine: line});
      const retained = await output(manifest, job, result, emit, secret);
      if (retained.error === 'provider_echoed_credentials') fail('provider_echoed_credentials');
    }
    await emitRecord(emit, {...baseEvent(manifest, manifest.jobs[0]), event: 'language_expansion_file', role, fileID,
      bytes: raw.length, payloadHash: hash(raw), count: lines.length, finalNewline: raw.at(-1) === 10});
  }
  // Keep partial successes on expiry/failure. Missing cases keep their full holds.
  if (seen.size !== manifest.jobs.length) fail('missing_batch_cases_hold_unknown');
  const counts = batch.request_counts;
  if (!counts || counts.total !== manifest.jobs.length || !integer(counts.completed) || !integer(counts.failed) || counts.completed + counts.failed !== counts.total) fail('invalid_batch_request_counts');
  await control(manifest, emit, 'retrieve', 'retained', batchFields(batch));
  return {cases: seen.size, rawBytes: bytes, status: batch.status};
}

// No ambient global fetch: tests and build wiring must inject the transport.
export function openAIClient({apiKey, fetchFn}) {
  if (!apiKey || typeof fetchFn !== 'function') fail('explicit_sensitive_key_and_fetch_required');
  async function request(route, {method = 'GET', body, timeout = 30_000} = {}) {
    const response = await fetchFn('https://api.openai.com/v1/' + route, {method, headers: {Authorization: `Bearer ${apiKey}`, ...(typeof body === 'string' ? {'Content-Type': 'application/json'} : {})}, body, signal: AbortSignal.timeout(timeout)});
    if (!response.ok) fail('provider_rejected');
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
    file: async id => (await request('files/' + encodeURIComponent(id) + '/content')).body,
  };
}
