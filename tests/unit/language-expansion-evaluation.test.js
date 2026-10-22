import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {hash, preparePlan, shard, validatePlan, initJournal, registerPlan, snapshot, admitShard, claimStart,
  runStandard, submitBatch, inspectBatch, recoverBatch, retrieveBatch, importEvents, execute} from '../../scripts/evaluate-language-expansion.mjs';
import {TAGS, TARGETS, sourceInput, batchInput, DEPENDENT_RESERVE, CONFIRMATION_RESERVE} from '../../scripts/language-expansion/plan.mjs';
import {payloadEvents, recoverPayload, SCHEMA, boundedSink} from '../../scripts/language-expansion/common.mjs';
import {baseEvent} from '../../scripts/language-expansion/journal.mjs';
import {responseResult, openAIClient, validateManifest} from '../../scripts/language-expansion/transport.mjs';
import {evaluateLanguageExpansionInBuild, runLanguageExpansionBuild} from '../../scripts/language-expansion-build.mjs';

// Deliberately synthetic protocol fixtures, not a linguistic corpus or quality evidence.
const controls = {'ja-c': 'zh-Hans', 'ko-c': 'en', 'pt-c': 'es', 'it-c': 'es', 'de-c': 'es', 'ru-c': 'uk', 'vi-c': 'vi', 'id-c': 'id', 'th-c': 'en', 'hi-c': 'hi-Latn'};
const disposition = id => id === 'ru-c' ? 'unsupported-source-study-refusal' : id === 'hi-c' ? 'hi-Latn-estimate-or-explicit-context-confirmation-hold' : ['vi-c', 'id-c'].includes(id) ? 'family-source-context-qualification-hold' : 'existing-source-context-qualification-hold';
const corpus = {documents: TAGS.flatMap(language => (language === 'hi' ? ['b', 'd', 'f'] : language === 'hi-Latn' ? ['a', 'c', 'e'] : ['a', 'b', 'c', 'd', 'e', 'f']).map(suffix => {
  const id = (language.startsWith('hi') ? 'hi' : language) + '-' + suffix;
  // Deliberately English labels; route tags test protocol handling, never language quality.
  const route = controls[id] && {effectiveSelectionLanguage: controls[id], authority: 'research-annotation-only', selectionSourceID: id + ':01', selectionText: 'not', selectionUtf8SHA256: hash('not'), basis: 'Synthetic routing fixture only.', disposition: disposition(id), note: 'No linguistic claim.', paidMatrixScheduleChanged: false};
  return {id, language, sourceFamily: language.startsWith('hi') ? 'hi' : language,
    lines: [{sourceID: id + ':01', order: 0, text: 'I did not ask you to leave.', utf8SHA256: hash('I did not ask you to leave.')},
      {sourceID: id + ':02', order: 1, text: 'The note remains here.'}],
    selection: {sourceID: id + ':01', originalText: 'not', occurrence: 0},
    semanticInvariants: ['Do not reverse the negation.'], permissibleInterpretations: ['Addressee is unspecified.'],
    ...(route ? {effectiveSelectionLanguage: controls[id], selectionRouting: route} : {})};
}))};
const routingManifest = {schema: 'lyrica-selected-routing-research-v1', status: 'Synthetic protocol annotations only.', cases: corpus.documents.filter(d => d.selectionRouting).map(d => ({caseID: d.id, sourceFamily: d.sourceFamily, exactTag: d.language, ...d.selectionRouting})), originalSelectionsRetained: true, paidMatrixScheduleChanged: false};
const routeOptions = {routingManifest, approvedRoutingHash: hash(routingManifest)};
let shared;
const planFixture = async () => structuredClone(await (shared ??= preparePlan({...routeOptions, corpus, approvedCorpusHash: hash(corpus)})));
async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'language-expansion-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true})); return dir;
}
async function journalFixture(t, plan, prior = {}) {
  const dir = await directory(t); await initJournal(dir, prior); await registerPlan(dir, plan, hash(plan)); return dir;
}
function fakeResponse(plan, job, extra = {}) {
  const source = plan.sources.find(s => s.id === job.source), selection = job.selection ?? source.selection;
  let content;
  if (job.kind === 'translation') content = {translations: Object.fromEntries(source.doc.structure.occurrences.map(o => [o.sourceID, 'A translated fixture row.'])), sourceNotes: []};
  else {
    content = {meaning: 'Fixture meaning.', context: 'Fixture context.', grammar: '', uncertainty: '', sourceQuote: selection.text};
    if (job.body.text.format.name === 'study_explanation_grounded_1') content.evidence = [
      {field: 'meaning', sourceID: selection.sourceID, layer: selection.studyText.layer,
        sourceQuote: selection.studyText.layer === 'original' ? source.doc.structure.occurrences.find(o => o.sourceID === selection.sourceID).sourceText : job.translation.lines.find(o => o.sourceID === selection.sourceID).lyricText},
      {field: 'context', sourceID: selection.sourceID, layer: 'original', sourceQuote: source.doc.structure.occurrences.find(o => o.sourceID === selection.sourceID).sourceText}
    ];
  }
  return {model: job.body.model, service_tier: 'default', status: 'completed', usage: {input_tokens: 100, output_tokens: 100},
    output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(content)}]}], ...extra};
}
const ticketFor = manifest => ({schema: SCHEMA, planHash: manifest.planHash, shardHash: hash(manifest), executionID: 'build_test', transport: manifest.transport});
async function runInJournal(dir, plan, manifest, client, emit) {
  const ticket = await admitShard({directory: dir, plan, manifest, executionID: 'build_test'});
  return execute({directory: dir, plan, manifest, ticket, operation: 'standard', client, emit});
}
const batchObject = (manifest, extra = {}) => ({id: 'batch_test', endpoint: '/v1/responses', input_file_id: 'file-input',
  metadata: {planHash: manifest.planHash, shardHash: hash(manifest), inputHash: hash(batchInput(manifest))},
  status: 'completed', output_file_id: 'file-output', error_file_id: null,
  request_counts: {total: manifest.jobs.length, completed: manifest.jobs.length, failed: 0}, ...extra});
const byteStream = raw => (async function* () { const bytes = Buffer.from(raw); for (let i = 0; i < bytes.length; i += 791) yield bytes.subarray(i, i + 791); })();

test('728 schedule covers 44 exact / 40 nominal directions, all 176 cells, and the exact 33-call seed', async () => {
  const plan = await planFixture();
  assert.equal(plan.jobs.length, 728);
  assert.equal(plan.jobs.filter(j => j.kind === 'translation').length, 240);
  assert.equal(plan.jobs.filter(j => j.kind === 'original').length, 240);
  assert.equal(plan.jobs.filter(j => j.kind === 'translated').length, 248);
  assert.equal(new Set(plan.jobs.filter(j => j.kind === 'translated').map(j => [j.tag, j.target, j.explanation].join())).size, 176);
  assert.equal(new Set(plan.jobs.filter(j => j.kind === 'translation').map(j => [j.tag, j.target].join())).size, 44);
  assert.equal(plan.seedIDs.length, 33); assert.equal(new Set(plan.seedIDs).size, 33);
  for (const [i, tag] of TAGS.entries()) {
    const seed = plan.seedIDs.map(id => plan.jobs.find(j => j.id === id)).filter(j => j.tag === tag);
    assert.equal(seed.find(j => j.kind === 'translation').target, TARGETS[i % 4]);
    assert.equal(seed.find(j => j.kind === 'original').target, TARGETS[(i + 1) % 4]);
    assert.equal(seed.find(j => j.kind === 'translated').explanation, TARGETS[i % 4]);
  }
  assert.equal(DEPENDENT_RESERVE, 5048); assert.equal(CONFIRMATION_RESERVE, 19384);
  assert.equal(plan.jobs[0].body.model, 'gpt-6-luna'); assert.equal(plan.jobs[0].body.reasoning.effort, 'xhigh');
  assert.equal(plan.jobs[0].body.service_tier, 'default'); assert.equal(plan.jobs[0].body.store, false);
  assert.equal(plan.jobs[0].body.max_output_tokens, 32768);
  assert.equal(plan.jobs[1].body.max_output_tokens, 4096);
  assert.equal(plan.jobs[2].body, null); assert.equal(plan.jobs[2].reservedMicros, DEPENDENT_RESERVE);
});
test('full crossproduct is an explicit 1440-call mode; corpus approval and exact tag counts are mandatory', async () => {
  assert.equal((await preparePlan({...routeOptions, corpus, approvedCorpusHash: hash(corpus), mode: 'full1440'})).jobs.length, 1440);
  await assert.rejects(preparePlan({...routeOptions, corpus, approvedCorpusHash: 'unreviewed'}), /approved_corpus/);
  const changed = structuredClone(corpus); changed.documents.at(-1).language = 'hi';
  await assert.rejects(preparePlan({...routeOptions, corpus: changed, approvedCorpusHash: hash(changed)}), /exact_tag/);
  await assert.rejects(preparePlan({...routeOptions, corpus, approvedCorpusHash: hash(corpus), mode: 'automatic'}), /plan_mode/);
});
test('adapter binds both corpus and production IDs, exact bytes and grapheme ranges', () => {
  const spec = {id: 'unicode', language: 'vi', lines: [{sourceID: 'unicode:01', order: 0, text: 'e\u0301 🧑🏽‍🎓 here', utf8SHA256: hash('e\u0301 🧑🏽‍🎓 here')}],
    selection: {sourceID: 'unicode:01', originalText: 'here', range: {startGrapheme: 4, endGrapheme: 8, sourceUtf8SHA256: hash('e\u0301 🧑🏽‍🎓 here'), selectionUtf8SHA256: hash('here')}}};
  const input = sourceInput(spec);
  assert.equal(input.sourceIDMap['unicode:01'], 'L0001'); assert.equal(input.wireSourceIDMap.L0001, 'unicode:01');
  assert.equal(input.selection.lower, 4); assert.equal(input.selection.upper, 8);
  assert.equal(input.bindings[0].sourceUtf8SHA256, spec.lines[0].utf8SHA256);
  assert.throws(() => sourceInput({...spec, lines: [{...spec.lines[0], text: 'changed'}]}), /bytes_or_order/);
  assert.throws(() => sourceInput({...spec, selection: {...spec.selection, range: {...spec.selection.range, startGrapheme: 1}}}), /range_changed/);
  assert.throws(() => sourceInput({...spec, lines: ['not not'], selection: {line: 0, text: 'not'}}), /selection_ambiguous/);
});
test('code hashes, exact frozen body bytes, dependency declarations and reservations fail closed', async () => {
  const plan = await planFixture(); await validatePlan(plan, hash(plan));
  const edit = structuredClone(plan); edit.jobs[0].body.model = 'changed';
  await assert.rejects(validatePlan(edit, hash(plan)), /plan_changed/);
  await assert.rejects(validatePlan(edit, hash(edit)), /frozen_body_changed/);
  const code = structuredClone(plan); code.codeHashes['new-source.mjs'] = hash('new');
  await assert.rejects(validatePlan(code, hash(code)), /generation_code_changed/);
  const missing = structuredClone(plan); missing.jobs[2].dependency = 'absent';
  await assert.rejects(validatePlan(missing, hash(missing)), /missing_dependency|case_definition_changed/);
  const reserves = structuredClone(plan); reserves.maxReservedMicros--;
  await assert.rejects(validatePlan(reserves, hash(reserves)), /invalid_reservations/);
});
test('oversize experiment bodies and more than 60 unnamed/duplicate confirmations are rejected', async () => {
  const large = structuredClone(corpus); large.documents[0].lines = Array.from({length: 20}, () => 'x'.repeat(1900)); large.documents[0].selection = {line: 0, text: 'x', occurrence: 0};
  await assert.rejects(preparePlan({...routeOptions, corpus: large, approvedCorpusHash: hash(large)}), /input_limit/);
  for (const confirmationNames of [Array.from({length: 61}, (_, i) => 'c' + i), ['same', 'same'], ['']]) await assert.rejects(preparePlan({...routeOptions, corpus, approvedCorpusHash: hash(corpus), confirmationNames}), /confirmations/);
});
test('prior/unknown costs and all unfrozen dependencies count before execution', async t => {
  const plan = await planFixture(); const dir = await directory(t);
  await initJournal(dir, {priorMicros: 19_000_000, unknownHeldMicros: 1});
  await assert.rejects(registerPlan(dir, plan, hash(plan)), /budget_exceeded/);
  const dir2 = await journalFixture(t, plan, {priorMicros: 41, unknownHeldMicros: 59});
  assert.equal((await snapshot(dir2)).committedMicros, plan.maxReservedMicros + 100);
});
test('plan union reuses exact bodies and refuses changed source hashes under an existing case ID', async t => {
  const plan = await planFixture(), dir = await journalFixture(t, plan);
  await registerPlan(dir, plan, hash(plan)); assert.equal((await snapshot(dir)).plans.length, 1);
  const changed = structuredClone(corpus); changed.documents[0].lines[1].text = 'A new source row.';
  const next = await preparePlan({...routeOptions, corpus: changed, approvedCorpusHash: hash(changed)});
  await assert.rejects(registerPlan(dir, next, hash(next)), /case_spec_changed/);
});
test('dependent body freezes only from exact recovered translation and retains selection intent', async () => {
  const plan = await planFixture(), dependent = plan.jobs.find(j => j.kind === 'translated'), parent = plan.jobs.find(j => j.id === dependent.dependency);
  assert.throws(() => shard(plan, [dependent.id]), /translation_failed/);
  const result = responseResult(plan, parent, fakeResponse(plan, parent), 'standard');
  const manifest = shard(plan, [dependent.id], {[parent.id]: result});
  const job = manifest.jobs[0]; assert.equal(job.selection.sourceID, dependent.intent.sourceID);
  assert.equal(job.selection.text, 'A translated fixture row.'); assert.ok(job.reservedMicros <= DEPENDENT_RESERVE);
  assert.equal(job.dependencyResultHash, hash(result));
  result.content.lines[0].lyricText = 'x'.repeat(81);
  assert.throws(() => shard(plan, [dependent.id], {[parent.id]: result}), /selection_invalid/);
  const failed = {...result, valid: false}; assert.throws(() => shard(plan, [dependent.id], {[parent.id]: failed}), /translation_failed/);
});
test('Standard shards are serial and bounded to four production-timeout calls', async t => {
  const plan = await planFixture(), ids = plan.jobs.filter(j => j.body).slice(0, 4).map(j => j.id);
  assert.throws(() => shard(plan, [...ids, plan.jobs[6].id]), /invalid_shard/);
  const manifest = shard(plan, ids), dir = await journalFixture(t, plan); let active = 0, peak = 0, index = 0;
  await runInJournal(dir, plan, manifest, {standard: async (body, timeout) => {
    active++; peak = Math.max(peak, active); const job = manifest.jobs[index++];
    assert.equal(body, job.bodyJSON); assert.equal(timeout, job.kind === 'translation' ? 270000 : 240000);
    await Promise.resolve(); active--; return fakeResponse(plan, job);
  }});
  assert.equal(peak, 1); assert.ok(manifest.standardDeadlineSeconds < manifest.maxBuildSeconds);
  const state = await snapshot(dir); assert.equal(Object.keys(state.results).length, 4);
  for (const result of Object.values(state.results)) { assert.equal(result.valid, true); assert.ok(result.sourceBindings[0].corpusSourceID); }
});
test('one-time external start and repeat builds cannot resend already admitted/unknown cases', async t => {
  const plan = await planFixture(), manifest = shard(plan, [plan.jobs[0].id]), dir = await journalFixture(t, plan);
  const ticket = await admitShard({directory: dir, plan, manifest, executionID: 'build_one'});
  await claimStart(dir, ticket);
  await assert.rejects(claimStart(dir, ticket), /already_started/);
  await assert.rejects(admitShard({directory: dir, plan, manifest, executionID: 'different_container'}), /never_resend/);
  let calls = 0;
  await assert.rejects(runStandard({plan, manifest, approvedHash: hash(manifest), ticket, executionID: 'different_container',
    claimStart: t => claimStart(dir, t), client: {standard: async () => { calls++; }}, emit: () => {}}), /identity_mismatch/);
  assert.equal(calls, 0);
});
test('unknown cost stops without retry while preserving completed earlier case and every remaining hold', async t => {
  const plan = await planFixture(), jobs = plan.jobs.filter(j => j.body).slice(0, 3), manifest = shard(plan, jobs.map(j => j.id)), dir = await journalFixture(t, plan);
  let calls = 0;
  await assert.rejects(runInJournal(dir, plan, manifest, {standard: async () => { calls++; if (calls === 2) throw new Error('socket closed'); return fakeResponse(plan, jobs[0]); }}), /stop_reconcile/);
  const state = await snapshot(dir); assert.equal(calls, 2);
  assert.equal(state.results[jobs[0].id].valid, true); assert.equal(state.states[jobs[1].id].state, 'unknown_cost');
  assert.equal(state.states[jobs[2].id].state, 'unknown');
  assert.equal(state.committedMicros, plan.maxReservedMicros - jobs[0].reservedMicros + state.results[jobs[0].id].actualMicros);
  await assert.rejects(admitShard({directory: dir, plan, manifest, executionID: 'retry'}), /never_resend/);
  await assert.rejects(admitShard({directory: dir, plan, manifest: shard(plan, [plan.jobs[6].id]), executionID: 'next'}), /prior_shard_unresolved/);
});
test('invalid/grounding/configuration/usage failures are retained; no easier case substitution', async () => {
  const plan = await planFixture(), translation = plan.jobs[0], original = plan.jobs[1];
  assert.equal(responseResult(plan, translation, fakeResponse(plan, translation, {service_tier: 'flex'}), 'standard').error, 'provider_configuration_changed');
  assert.equal(responseResult(plan, translation, fakeResponse(plan, translation, {usage: null}), 'standard').actualMicros, null);
  const bad = fakeResponse(plan, original); const text = JSON.parse(bad.output[0].content[0].text); text.evidence = []; bad.output[0].content[0].text = JSON.stringify(text);
  assert.equal(responseResult(plan, original, bad, 'standard').valid, false);
});
test('chunks recover out of order and reject drops, duplicates, unknown chunks, altered bytes and incomplete tails', () => {
  const base = {schema: SCHEMA, planHash: hash('p'), shardHash: hash('s'), caseID: 'c', bodyHash: hash('b'), reservedMicros: 5, transport: 'standard'};
  const value = {id: 'c', text: 'é'.repeat(4000)}, events = payloadEvents(base, value);
  assert.deepEqual(recoverPayload([...events.slice(0, -1).reverse(), events.at(-1)], base), value);
  for (const corrupt of [events.slice(1), [...events, events[0]], events.slice(0, -1), events.map((e, i) => i === 0 ? {...e, data: 'AAAA'} : e), events.map((e, i) => i === 0 ? {...e, index: 999} : e)]) assert.throws(() => recoverPayload(corrupt, base));
});
test('external imports reject unknown records and preserve completed prefixes before later corruption', async t => {
  const plan = await planFixture(), manifest = shard(plan, [plan.jobs[0].id]), dir = await journalFixture(t, plan);
  const ticket = await admitShard({directory: dir, plan, manifest, executionID: 'build_test'}); await claimStart(dir, ticket);
  const base = baseEvent(manifest, manifest.jobs[0]), good = payloadEvents(base, responseResult(plan, manifest.jobs[0], fakeResponse(plan, manifest.jobs[0]), 'standard'));
  const before = await fs.readFile(path.join(dir, 'journal.jsonl'), 'utf8');
  await assert.rejects(importEvents(dir, [{...good[0], caseID: 'unknown'}]), /unknown_event_case/);
  assert.equal(await fs.readFile(path.join(dir, 'journal.jsonl'), 'utf8'), before);
  await importEvents(dir, [...good.slice(0, -1).reverse(), good.at(-1)]);
  assert.equal((await snapshot(dir)).results[manifest.jobs[0].id].valid, true);
  const dir2 = await journalFixture(t, plan), ticket2 = await admitShard({directory: dir2, plan, manifest, executionID: 'build_test'});
  await claimStart(dir2, ticket2);
  await assert.rejects(importEvents(dir2, [...good, good[0]]), /duplicate_chunk/);
  assert.equal((await snapshot(dir2)).results[manifest.jobs[0].id].valid, true);
  await fs.appendFile(path.join(dir, 'journal.jsonl'), '{'); await assert.rejects(snapshot(dir), /truncated_external_journal/);
});
test('large payload events stream incrementally above old 2MiB buffer with bounded individual records', async () => {
  const plan = await planFixture(), jobs = plan.jobs.filter(j => j.body).slice(0, 4), manifest = shard(plan, jobs.map(j => j.id));
  let index = 0, bytes = 0, max = 0, completedBeforeNext = 0;
  await runStandard({plan, manifest, approvedHash: hash(manifest), ticket: ticketFor(manifest), executionID: 'build_test', claimStart: async () => {},
    client: {standard: async () => { assert.equal(completedBeforeNext, index); return fakeResponse(plan, jobs[index++], {padding: 'x'.repeat(580000)}); }},
    emit: event => { const size = Buffer.byteLength(JSON.stringify(event)); bytes += size; max = Math.max(max, size); if (event.event === 'language_expansion_complete') completedBeforeNext++; }});
  assert.ok(bytes > 2 * 1024 * 1024); assert.ok(bytes < 16 * 1024 * 1024); assert.ok(max <= 16384);
});
test('SIGTERM after a completed case retains its output and the interrupted shard cannot restart', async t => {
  const plan = await planFixture(), jobs = plan.jobs.filter(j => j.kind === 'translation').slice(0, 2), manifest = shard(plan, jobs.map(j => j.id)), dir = await journalFixture(t, plan);
  const ticket = await admitShard({directory: dir, plan, manifest, executionID: 'build_test'});
  const fixture = path.join(dir, 'child.json'); await fs.writeFile(fixture, JSON.stringify({plan, manifest, ticket, response: fakeResponse(plan, jobs[0])}));
  const moduleURL = new URL('../../scripts/evaluate-language-expansion.mjs', import.meta.url).href;
  const code = `import fs from 'node:fs/promises'; import {execute} from ${JSON.stringify(moduleURL)};
    const {plan,manifest,ticket,response}=JSON.parse(await fs.readFile(process.argv[1]));let calls=0;
    await execute({plan,manifest,ticket,directory:process.argv[2],operation:'standard',client:{standard:async()=>{if(++calls===1)return response;await new Promise(resolve=>setTimeout(resolve,60000));}},emit:e=>process.stdout.write(JSON.stringify(e)+'\\n')});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, fixture, dir], {stdio: ['ignore', 'pipe', 'pipe']});
  let pending = '', killed = false, stderr = '';
  child.stderr.on('data', data => stderr += data);
  child.stdout.on('data', data => { pending += data; let newline; while ((newline = pending.indexOf('\n')) >= 0) { const e = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1); if (e.event === 'language_expansion_submitting' && e.caseID === jobs[1].id) { killed = child.kill('SIGTERM'); } } });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000); t.after(() => clearTimeout(timer));
  const [, signal] = await once(child, 'exit'); assert.equal(killed, true, stderr); assert.equal(signal, 'SIGTERM', stderr);
  const state = await snapshot(dir); assert.equal(state.results[jobs[0].id].valid, true); assert.equal(state.states[jobs[1].id].state, 'unknown');
  await assert.rejects(claimStart(dir, ticket), /already_started/);
});
test('Batch admission waits for all 33 Standard seed outputs and explicit review/entitlement', async t => {
  const plan = await planFixture(), dir = await journalFixture(t, plan), remaining = plan.jobs.find(j => j.body && !plan.seedIDs.includes(j.id));
  let manifest = shard(plan, [remaining.id], {}, 'batch');
  await assert.rejects(admitShard({directory: dir, plan, manifest, executionID: 'batch_test', representativeReviewed: true, batchAccepted: true}), /standard_review/);
  for (const dependent of [false, true]) {
    const ids = plan.seedIDs.filter(id => (plan.jobs.find(j => j.id === id).kind === 'translated') === dependent);
    for (let i = 0; i < ids.length; i += 4) {
      const state = await snapshot(dir), chunk = shard(plan, ids.slice(i, i + 4), state.results);
      let index = 0; await runInJournal(dir, plan, chunk, {standard: async () => fakeResponse(plan, chunk.jobs[index++])});
    }
  }
  const state = await snapshot(dir); assert.equal(Object.keys(state.results).length, 33);
  await assert.rejects(admitShard({directory: dir, plan, manifest, executionID: 'batch_test', representativeReviewed: true}), /standard_review/);
  const ticket = await admitShard({directory: dir, plan, manifest, executionID: 'batch_test', representativeReviewed: true, batchAccepted: true});
  await assert.rejects(admitShard({directory: dir, plan, manifest: shard(plan, [plan.seedIDs[0]]), executionID: 'seed_again'}), /never_resend/);
  const raw = JSON.stringify({custom_id: remaining.id, response: {status_code: 200, body: fakeResponse(plan, manifest.jobs[0])}, error: null}) + '\n';
  const client = {upload: async () => ({id: 'file-input'}), create: async () => batchObject(manifest), inspect: async () => batchObject(manifest), file: async () => byteStream(raw)};
  await execute({plan, manifest, ticket, directory: dir, operation: 'submit', client});
  await execute({plan, manifest, ticket, directory: dir, operation: 'retrieve', client});
  const recovered = await snapshot(dir); assert.equal(recovered.results[remaining.id].valid, true);
  const fileReceipt = recovered.events.find(e => e.event === 'language_expansion_file');
  await assert.rejects(importEvents(dir, [{...fileReceipt, payloadHash: hash('corrupt')}]), /corrupt_retained_file/);
  // A read-only retrieval can revisit known IDs without repeating settled case chunks.
  await execute({plan, manifest, ticket, directory: dir, operation: 'retrieve', client});
  assert.equal((await snapshot(dir)).results[remaining.id].valid, true);
});
test('lost Batch create response stops and recovers only by metadata AND exact uploaded input hash', async () => {
  const plan = await planFixture(), manifest = shard(plan, [plan.jobs[0].id], {}, 'batch'), output = []; let creates = 0;
  const client = {upload: async () => ({id: 'file-input'}), create: async () => { creates++; throw new Error('lost response'); },
    list: async () => ({data: [batchObject(manifest)], has_more: false}), file: async () => byteStream(batchInput(manifest))};
  await assert.rejects(submitBatch({plan, manifest, approvedHash: hash(manifest), ticket: ticketFor(manifest), executionID: 'build_test', claimStart: async () => {}, client, emit: e => output.push(e)}), /create_unknown/);
  assert.equal(output.at(-1).state, 'unknown'); assert.equal(creates, 1);
  assert.equal((await recoverBatch({manifest, client, emit: e => output.push(e)})).id, 'batch_test'); assert.equal(creates, 1);
  await assert.rejects(recoverBatch({manifest, client: {...client, file: async () => byteStream('changed')}, emit: () => {}}), /input_hash/);
  await assert.rejects(recoverBatch({manifest, client: {...client, list: async () => ({data: [], has_more: false})}, emit: () => {}}), /identity_unknown/);
  await assert.rejects(recoverBatch({manifest, client: {...client, list: async () => ({data: [batchObject(manifest), batchObject(manifest)], has_more: false})}, emit: () => {}}), /identity_unknown/);
});
test('Batch results match custom IDs out of order, retain error files and validate usage/transport', async () => {
  const plan = await planFixture(), jobs = plan.jobs.filter(j => j.kind === 'translation').slice(0, 2), manifest = shard(plan, jobs.map(j => j.id), {}, 'batch'), output = [];
  const raw = jobs.toReversed().map(job => JSON.stringify({custom_id: job.id, response: {status_code: 200, body: fakeResponse(plan, job)}, error: null})).join('\n') + '\n';
  const client = {inspect: async () => batchObject(manifest), file: async () => byteStream(raw)};
  const result = await retrieveBatch({plan, manifest, approvedHash: hash(manifest), batchID: 'batch_test', inputFileID: 'file-input', client, emit: e => output.push(e)});
  assert.equal(result.cases, 2); assert.equal(output.find(e => e.event === 'language_expansion_file').payloadHash, hash(raw));
  for (const job of jobs) { const r = recoverPayload(output, baseEvent(manifest, job)); assert.equal(r.valid, true); assert.equal(r.actualMicros, 32); }
  await assert.rejects(inspectBatch({manifest, batchID: 'wrong', client, emit: () => {}}), /identity_unknown/);
});
test('partial Batch expiry retains successes plus failed/unknown costs; missing/duplicate/unknown rows reject', async () => {
  const plan = await planFixture(), jobs = plan.jobs.filter(j => j.kind === 'translation').slice(0, 2), manifest = shard(plan, jobs.map(j => j.id), {}, 'batch'), output = [];
  const one = JSON.stringify({custom_id: jobs[0].id, response: {status_code: 200, body: fakeResponse(plan, jobs[0])}, error: null}) + '\n';
  const error = JSON.stringify({custom_id: jobs[1].id, response: null, error: {code: 'batch_expired'}}) + '\n';
  const batch = batchObject(manifest, {status: 'expired', error_file_id: 'file-error', request_counts: {total: 2, completed: 1, failed: 1}});
  const client = {inspect: async () => batch, file: async id => byteStream(id === 'file-output' ? one : error)};
  await retrieveBatch({plan, manifest, approvedHash: hash(manifest), batchID: 'batch_test', client, emit: e => output.push(e)});
  assert.equal(recoverPayload(output, baseEvent(manifest, jobs[0])).valid, true);
  const failed = recoverPayload(output, baseEvent(manifest, jobs[1])); assert.equal(failed.valid, false); assert.equal(failed.actualMicros, null);
  for (const raw of [one, one + one, one + JSON.stringify({custom_id: 'unknown'}) + '\n']) {
    const retained = []; await assert.rejects(retrieveBatch({plan, manifest, approvedHash: hash(manifest), batchID: 'batch_test', client: {...client, inspect: async () => batchObject(manifest), file: async () => byteStream(raw)}, emit: e => retained.push(e)}));
    assert.equal(recoverPayload(retained, baseEvent(manifest, jobs[0])).valid, true);
  }
});
test('Batch retrieval enforces one MiB per operation and retains earlier file results on later-file failure', async () => {
  const plan = await planFixture(), job = plan.jobs[0], manifest = shard(plan, [job.id], {}, 'batch'), output = [];
  const raw = JSON.stringify({custom_id: job.id, response: {status_code: 200, body: fakeResponse(plan, job)}}) + '\n';
  const client = {inspect: async () => batchObject(manifest, {error_file_id: 'file-error'}), file: async id => byteStream(id === 'file-output' ? raw : 'x'.repeat(1048576))};
  await assert.rejects(retrieveBatch({plan, manifest, approvedHash: hash(manifest), batchID: 'batch_test', client, emit: e => output.push(e)}), /operation_limit/);
  assert.equal(recoverPayload(output, baseEvent(manifest, job)).valid, true);
});
test('sensitive values cannot appear in output; all provider traffic requires injected fetch', async () => {
  assert.throws(() => openAIClient({apiKey: 'secret'}), /explicit_sensitive/);
  const plan = await planFixture(), job = plan.jobs[0], manifest = shard(plan, [job.id]), output = [];
  await assert.rejects(runStandard({plan, manifest, approvedHash: hash(manifest), ticket: ticketFor(manifest), executionID: 'build_test', claimStart: async () => {},
    secret: 'secret-fixture-value', client: {standard: async () => fakeResponse(plan, job, {echo: 'secret-fixture-value'})}, emit: e => output.push(e)}), /stop_reconcile/);
  assert.equal(JSON.stringify(output).includes('secret-fixture-value'), false); assert.equal(recoverPayload(output, baseEvent(manifest, job)).error, 'provider_echoed_credentials');
});
test('unwired build hook is opt-in, binds reviewed manifest/execution, and requires external claim', async () => {
  await evaluateLanguageExpansionInBuild({});
  await assert.rejects(evaluateLanguageExpansionInBuild({LYRA_LANGUAGE_EXPANSION_ON_BUILD: '1'}), /production_build/);
  const plan = await planFixture(), manifest = shard(plan, [plan.jobs[0].id]), ticket = ticketFor(manifest);
  const env = {LYRA_LANGUAGE_EXPANSION_ON_BUILD: '1', VERCEL: '1', VERCEL_ENV: 'production', VERCEL_DEPLOYMENT_ID: 'build_test', LYRA_LANGUAGE_EXPANSION_PLAN_HASH: hash(plan), LYRA_LANGUAGE_EXPANSION_SHARD_HASH: hash(manifest)};
  const bundle = {plan, manifest, ticket, operation: 'standard', allocationMicros: manifest.jobs[0].reservedMicros}; let calls = 0; const events = [];
  const deps = {loadBundle: async () => bundle, emit: e => events.push(e), client: {standard: async () => { calls++; return fakeResponse(plan, manifest.jobs[0]); }}};
  await assert.rejects(evaluateLanguageExpansionInBuild(env, deps), /external_claim/); assert.equal(calls, 0);
  await assert.rejects(evaluateLanguageExpansionInBuild({...env, VERCEL_DEPLOYMENT_ID: 'another_build'}, {...deps, claimStart: async () => {}}), /identity_mismatch/);
  await assert.rejects(evaluateLanguageExpansionInBuild(env, {...deps, claimStart: async () => {}}), /intentional_build_failure/); assert.equal(calls, 1);
  assert.equal(events.at(-1).event, 'language_expansion_terminal'); assert.equal(events.at(-1).state, 'evaluation_only_complete');
  assert.equal(events.at(-1).operation, 'standard');
  const bad = structuredClone(manifest); bad.jobs[0].bodyJSON += ' ';
  await assert.rejects(validateManifest(plan, bad, hash(bad)), /frozen_body_changed/);
});
test('evaluation-only direct build uses frozen paths/start receipt, emits terminal, always fails after results', async t => {
  const plan = await planFixture(), job = plan.jobs[0], manifest = shard(plan, [job.id]), dir = await journalFixture(t, plan);
  const ticket = await admitShard({directory: dir, plan, manifest, executionID: 'root_fixed_attempt'}), receipt = await claimStart(dir, ticket);
  for (const [name, data] of Object.entries({plan, manifest, ticket, receipt})) await fs.writeFile(path.join(dir, name + '.json'), JSON.stringify(data));
  const config = {planPath: path.join(dir, 'plan.json'), planHash: hash(plan), manifestPath: path.join(dir, 'manifest.json'), manifestHash: hash(manifest),
    shardID: hash(manifest), ticketPath: path.join(dir, 'ticket.json'), startReceiptPath: path.join(dir, 'receipt.json'), operation: 'standard', allocationMicros: job.reservedMicros};
  const output = [], dependencies = {env: {VERCEL: '1', VERCEL_ENV: 'production'}, emit: e => output.push(e), client: {standard: async () => fakeResponse(plan, job)}};
  await assert.rejects(runLanguageExpansionBuild(config, dependencies), /intentional_build_failure/);
  assert.equal(output.at(-1).event, 'language_expansion_terminal'); assert.equal(output.at(-1).state, 'evaluation_only_complete');
  assert.equal(recoverPayload(output, baseEvent(manifest, job)).valid, true);
  await importEvents(dir, output); assert.equal((await snapshot(dir)).results[job.id].valid, true);
  const interrupted = []; await assert.rejects(runLanguageExpansionBuild({...config, shardID: 'changed'}, {...dependencies, emit: e => interrupted.push(e)}), /fixed_shard/);
  assert.equal(interrupted.at(-1).state, 'evaluation_only_interrupted');
  await assert.rejects(claimStart(dir, ticket), /already_started/);
});
test('provider-overrun and new source code refuse further admissions; ambient global fetch is never used in source tests', async t => {
  const plan = await planFixture(), job = plan.jobs[0], manifest = shard(plan, [job.id]), dir = await journalFixture(t, plan);
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = () => { throw new Error('actual_global_fetch_forbidden'); };
  await assert.rejects(runInJournal(dir, plan, manifest, {standard: async () => fakeResponse(plan, job, {usage: {input_tokens: 100000, output_tokens: 100000}})}), /stop_reconcile/);
  assert.equal((await snapshot(dir)).states[job.id].state, 'cost_overrun');
  await assert.rejects(admitShard({directory: dir, plan, manifest: shard(plan, [plan.jobs[1].id]), executionID: 'next'}), /prior_shard_unresolved/);
});
test('named confirmation slots remain inside the common ceiling and cannot be reused across cases or Batch', async t => {
  const plan = await preparePlan({...routeOptions, corpus, approvedCorpusHash: hash(corpus), confirmationNames: ['negation01']}), dir = await journalFixture(t, plan);
  assert.equal((await snapshot(dir)).committedMicros, plan.maxReservedMicros + CONFIRMATION_RESERVE);
  const id = plan.jobs[0].id + '--confirmation--negation01', manifest = shard(plan, [id]);
  assert.throws(() => shard(plan, [id], {}, 'batch'), /named_standard/);
  await runInJournal(dir, plan, manifest, {standard: async () => fakeResponse(plan, manifest.jobs[0])});
  await assert.rejects(admitShard({directory: dir, plan, manifest: shard(plan, [plan.jobs[1].id + '--confirmation--negation01']), executionID: 'again'}), /confirmation_name/);
});
test('operation output has a hard ceiling with terminal-record headroom', () => {
  let retained = 0; const emit = boundedSink(() => retained++), record = {event: 'language_expansion_chunk', data: 'x'.repeat(16000)};
  assert.throws(() => { for (let i = 0; i < 2000; i++) emit(record); }, /operation_output_limit/);
  assert.ok(retained > 1000 && retained < 1100);
  const secretSink = boundedSink(() => assert.fail('secret must not reach sink'), 'private-key-value');
  assert.throws(() => secretSink({event: 'language_expansion_control', batchID: 'batch_private-key-value'}), /echoed_credentials/);
});

// Independent review r1 reproductions. All providers remain synthetic.
test('CLI import retains a complete case before malformed JSON and never imports later records', async t => {
  const plan = await planFixture(), manifest = shard(plan, [plan.jobs[0].id, plan.jobs[1].id]), dir = await journalFixture(t, plan);
  const ticket = await admitShard({directory: dir, plan, manifest, executionID: 'cli_tail'}); await claimStart(dir, ticket);
  const eventsFor = job => payloadEvents(baseEvent(manifest, job), responseResult(plan, job, fakeResponse(plan, job), 'standard'));
  const file = path.join(dir, 'truncated.jsonl');
  await fs.writeFile(file, eventsFor(manifest.jobs[0]).map(e => JSON.stringify(e)).join('\n') + '\n{"schema":\n' + eventsFor(manifest.jobs[1]).map(e => JSON.stringify(e)).join('\n') + '\n');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/evaluate-language-expansion.mjs', import.meta.url)), 'import', '--journal', dir, '--events', file], {encoding: 'utf8'});
  assert.equal(run.status, 1);
  const state = await snapshot(dir);
  assert.equal(state.results[manifest.jobs[0].id]?.valid, true);
  assert.equal(state.results[manifest.jobs[1].id], undefined);
  assert.equal(state.states[manifest.jobs[1].id].state, 'unknown');
  // Exact interrupted-tail shape from the independent review, in a fresh journal.
  const tailDir = await journalFixture(t, plan), one = shard(plan, [plan.jobs[0].id]);
  const tailTicket = await admitShard({directory: tailDir, plan, manifest: one, executionID: 'tail_only'}); await claimStart(tailDir, tailTicket);
  const tailFile = path.join(tailDir, 'tail.jsonl');
  await fs.writeFile(tailFile, payloadEvents(baseEvent(one, one.jobs[0]), responseResult(plan, one.jobs[0], fakeResponse(plan, one.jobs[0]), 'standard')).map(e => JSON.stringify(e)).join('\n') + '\n{\"schema\":');
  const tail = spawnSync(process.execPath, [fileURLToPath(new URL('../../scripts/evaluate-language-expansion.mjs', import.meta.url)), 'import', '--journal', tailDir, '--events', tailFile], {encoding: 'utf8'});
  assert.equal(tail.status, 1); assert.equal((await snapshot(tailDir)).results[one.jobs[0].id].valid, true);
});
test('plan union rejects changed authored occurrence even with identical wire body', async t => {
  const plan = await planFixture(), dir = await journalFixture(t, plan), changed = structuredClone(corpus);
  changed.documents[0].lines[0].sourceID = 'different-author-occurrence'; changed.documents[0].selection.sourceID = 'different-author-occurrence';
  const next = await preparePlan({...routeOptions, corpus: changed, approvedCorpusHash: hash(changed)});
  assert.equal(next.jobs[0].bodyHash, plan.jobs[0].bodyHash);
  await assert.rejects(registerPlan(dir, next, hash(next)), /case_spec_changed/);
});
test('four exact ru-c original cases are separate static refusals and cannot enter either transport', async () => {
  const plan = await planFixture();
  const staticJobs = plan.jobs.filter(j => j.executionDisposition === 'static_refusal');
  assert.deepEqual(staticJobs.map(j => j.id), TARGETS.map(target => 'ru-c--original--' + target));
  assert.equal(plan.jobs.filter(j => j.executionDisposition === 'generate').length, 724);
  for (const job of staticJobs) for (const transport of ['standard', 'batch']) assert.throws(() => shard(plan, [job.id], {}, transport), /static_refusal/);
});
test('all settled Batch cases still block admission after failed second-file retrieval', async t => {
  const plan = await planFixture(), dir = await journalFixture(t, plan);
  for (const dependent of [false, true]) {
    const ids = plan.seedIDs.filter(id => (plan.jobs.find(j => j.id === id).kind === 'translated') === dependent);
    for (let i = 0; i < ids.length; i += 4) {
      const state = await snapshot(dir), m = shard(plan, ids.slice(i, i + 4), state.results); let index = 0;
      await runInJournal(dir, plan, m, {standard: async () => fakeResponse(plan, m.jobs[index++])});
    }
  }
  const job = plan.jobs.find(j => j.body && !plan.seedIDs.includes(j.id)), manifest = shard(plan, [job.id], {}, 'batch');
  const ticket = await admitShard({directory: dir, plan, manifest, executionID: 'cap_batch', representativeReviewed: true, batchAccepted: true});
  const batch = batchObject(manifest, {error_file_id: 'file-error'});
  const raw = JSON.stringify({custom_id: job.id, response: {status_code: 200, body: fakeResponse(plan, job)}, error: null}) + '\n';
  const client = {upload: async () => ({id: 'file-input'}), create: async () => batch, inspect: async () => batch,
    file: async id => byteStream(id === 'file-output' ? raw : 'x'.repeat(1048576))};
  await execute({directory: dir, plan, manifest, ticket, operation: 'submit', client});
  await assert.rejects(execute({directory: dir, plan, manifest, ticket, operation: 'retrieve', client}), /operation_limit/);
  const state = await snapshot(dir); assert.equal(state.states[job.id].state, 'settled');
  assert.equal(state.shardStates[hash(manifest)].state, 'unresolved');
  assert.equal(Object.values(state.states).filter(s => ['unknown', 'unknown_cost'].includes(s.state)).length, 0);
  const next = plan.jobs.find(j => j.body && !state.states[j.id]);
  await assert.rejects(admitShard({directory: dir, plan, manifest: shard(plan, [next.id]), executionID: 'next'}), /prior_shard_unresolved/);
  // Even a build terminal or old retained control cannot clear shard reconciliation.
  await importEvents(dir, [{schema: SCHEMA, event: 'language_expansion_terminal', planHash: hash(plan), shardHash: hash(manifest), operation: 'retrieve', state: 'evaluation_only_interrupted', intentionalBuildFailure: true}]);
  await assert.rejects(admitShard({directory: dir, plan, manifest: shard(plan, [next.id]), executionID: 'still_blocked'}), /prior_shard_unresolved/);
  const goodClient = {...client, file: async id => byteStream(id === 'file-output' ? raw : '')};
  await assert.rejects(execute({directory: dir, plan, manifest, ticket, operation: 'retrieve', client: {...goodClient, inspect: async () => ({...batch, request_counts: {total: 1, completed: 0, failed: 1}})}}), /request_counts/);
  assert.equal((await snapshot(dir)).shardStates[hash(manifest)].state, 'unresolved');
  await assert.rejects(admitShard({directory: dir, plan, manifest: shard(plan, [next.id]), executionID: 'bad_counts'}), /prior_shard_unresolved/);
  await execute({directory: dir, plan, manifest, ticket, operation: 'retrieve', client: goodClient});
  const recovered = await snapshot(dir), receipt = recovered.events.findLast(e => e.event === 'language_expansion_reconciled');
  assert.equal(recovered.shardStates[hash(manifest)].state, 'reconciled');
  assert.deepEqual(receipt.files.map(f => f.role), ['output', 'error']);
  assert.equal(receipt.files[1].bytes, 0); assert.equal(receipt.batchID, batch.id);
  for (const changed of [{...receipt, rowCoverageHash: hash('wrong')}, {...receipt, requestCounts: {total: 1, completed: 0, failed: 1}}, {...receipt, errorFileID: null}, {...receipt, batchID: 'batch_other'}]) {
    await assert.rejects(importEvents(dir, [changed]), /reconciliation_changed/);
  }
  await admitShard({directory: dir, plan, manifest: shard(plan, [next.id]), executionID: 'reconciled_next'});
});

test('static receipts have exact identities, zero cost, no provider validity or unknown admission', async t => {
  const plan = await planFixture(), dir = await journalFixture(t, plan), state = await snapshot(dir);
  assert.equal(Object.keys(state.staticRefusals).length, 4); assert.equal(Object.keys(state.results).length, 0); assert.equal(Object.keys(state.states).length, 0);
  for (const receipt of Object.values(state.staticRefusals)) {
    assert.equal(receipt.providerCalled, false); assert.equal(receipt.actualMicros, 0); assert.equal(receipt.accountedMicros, 0);
    assert.equal(receipt.valid, undefined); assert.equal(receipt.reason, 'unsupported_selected_language'); assert.equal(receipt.effectiveSelectionLanguage, 'uk');
    assert.equal(receipt.sourceBindings[0].corpusSourceID, 'ru-c:01'); assert.equal(receipt.selection.text, 'not');
    const job = plan.jobs.find(j => j.id === receipt.id);
    assert.equal(job.definitionHash, receipt.definitionHash); assert.equal(job.body, null);
    assert.throws(() => responseResult(plan, job, null, 'standard'), /static_refusal/);
    assert.throws(() => shard({...plan, confirmationNames: ['refusal']}, [job.id + '--confirmation--refusal']), /static_refusal/);
    for (const transport of ['standard', 'batch']) {
      const bad = {...shard(plan, [plan.jobs[0].id]), transport, jobs: [job]};
      await assert.rejects(validateManifest(plan, bad, hash(bad)), /static_refusal/);
      await assert.rejects(admitShard({directory: dir, plan, manifest: bad, executionID: 'never_dispatch', representativeReviewed: true, batchAccepted: true}), /static_refusal/);
    }
  }
});
test('all six foreign original controls retain exact production bodies and cannot qualify family positives', async () => {
  const plan = await planFixture();
  for (const [id, language] of Object.entries(controls)) {
    const source = plan.sources.find(s => s.id === id);
    assert.equal(source.effectiveSelectionLanguage, language); assert.equal(source.routing.selectionUtf8SHA256, hash(source.selection.text));
    const originals = plan.jobs.filter(j => j.source === id && j.kind === 'original');
    for (const job of originals) {
      assert.equal(job.qualification.effectiveSelectionLanguage, language);
      assert.equal(job.qualification.diagnosticOnly, language !== source.tag);
      assert.equal(job.qualification.familyDirectionPositiveEligible, language === source.tag);
      assert.match(job.qualification.modelContext, /no resolved passage hints/);
      if (job.body) assert.equal(JSON.parse(job.body.input[0].content).sourceLanguage, source.tag);
    }
    assert.equal(plan.jobs.filter(j => j.source === id && j.kind === 'translation').length, 4);
  }
  assert.equal(plan.jobs.filter(j => j.kind === 'original' && j.qualification.familyDirectionPositiveEligible).length, 212);
  for (const seedID of plan.seedIDs) { const job = plan.jobs.find(j => j.id === seedID); assert.equal(job.executionDisposition, 'generate'); assert.equal(job.qualification.mixedContextDiagnostic, false); }
});
test('routing rejects arbitrary exclusions, changed selected tags, missing cases and easier c selections', async () => {
  for (const mutate of [
    (c, r) => { r.cases.pop(); },
    (c, r) => { r.cases[0].caseID = 'ja-b'; },
    (c, r) => { r.cases[0].effectiveSelectionLanguage = 'ja'; },
    (c, r) => { c.documents.find(d => d.id === 'ru-c').effectiveSelectionLanguage = 'ru'; },
    (c, r) => { c.documents.find(d => d.id === 'ru-c').selection.sourceID = 'ru-c:02'; },
    (c, r) => { c.documents.find(d => d.id === 'ja-b').selectionRouting = {...r.cases[0]}; },
    (c, r) => { r.cases[0].familyDirectionPositiveEligible = true; }
  ]) {
    const c = structuredClone(corpus), r = structuredClone(routingManifest); mutate(c, r);
    await assert.rejects(preparePlan({corpus: c, approvedCorpusHash: hash(c), routingManifest: r, approvedRoutingHash: hash(r)}), /routing|selection_language/);
  }
  await assert.rejects(preparePlan({corpus, approvedCorpusHash: hash(corpus), routingManifest, approvedRoutingHash: hash('wrong')}), /routing/);
});
test('immutable source profile and routing qualification changes cannot reuse case IDs or wire results', async t => {
  const plan = await planFixture(), dir = await journalFixture(t, plan), changed = structuredClone(corpus), routes = structuredClone(routingManifest);
  const c = changed.documents.find(d => d.id === 'ja-c'); c.selectionRouting.note = 'Revised research annotation'; routes.cases.find(r => r.caseID === c.id).note = c.selectionRouting.note;
  const next = await preparePlan({corpus: changed, approvedCorpusHash: hash(changed), routingManifest: routes, approvedRoutingHash: hash(routes)});
  const oldJob = plan.jobs.find(j => j.source === 'ja-c' && j.kind === 'translation'), newJob = next.jobs.find(j => j.id === oldJob.id);
  assert.equal(oldJob.bodyHash, newJob.bodyHash); assert.notEqual(oldJob.definitionHash, newJob.definitionHash);
  await assert.rejects(registerPlan(dir, next, hash(next)), /case_spec_changed/);
  const profile = structuredClone(plan); profile.sourceProfile = 'future-context-aware'; await assert.rejects(validatePlan(profile, hash(profile)), /profile_changed/);
  const qualification = structuredClone(plan); qualification.jobs[0].qualification.familyDirectionPositiveEligible = false;
  await assert.rejects(validatePlan(qualification, hash(qualification)), /case_definition_changed/);
  const manifest = shard(plan, [oldJob.id]), bad = structuredClone(manifest); bad.jobs[0].definitionHash = newJob.definitionHash;
  await assert.rejects(validateManifest(plan, bad, hash(bad)), /case_definition_changed/);
  const ticket = await admitShard({directory: dir, plan, manifest, executionID: 'old_result'}); await claimStart(dir, ticket);
  const result = responseResult(next, newJob, fakeResponse(next, newJob), 'standard');
  await assert.rejects(importEvents(dir, payloadEvents(baseEvent(manifest, oldJob), result)), /invalid_result_accounting/);
  assert.equal((await snapshot(dir)).results[oldJob.id], undefined);
});

test('partial Batch recovery keeps shard and missing case holds until exact complete files reconcile', async t => {
  const plan = await planFixture(), dir = await journalFixture(t, plan);
  for (const dependent of [false, true]) {
    const ids = plan.seedIDs.filter(id => (plan.jobs.find(j => j.id === id).kind === 'translated') === dependent);
    for (let i = 0; i < ids.length; i += 4) {
      const state = await snapshot(dir), m = shard(plan, ids.slice(i, i + 4), state.results); let index = 0;
      await runInJournal(dir, plan, m, {standard: async () => fakeResponse(plan, m.jobs[index++])});
    }
  }
  const jobs = plan.jobs.filter(j => j.body && !plan.seedIDs.includes(j.id)).slice(0, 2), manifest = shard(plan, jobs.map(j => j.id), {}, 'batch');
  const ticket = await admitShard({directory: dir, plan, manifest, executionID: 'partial_batch', representativeReviewed: true, batchAccepted: true});
  const batch = batchObject(manifest, {status: 'expired', request_counts: {total: 2, completed: 1, failed: 0}});
  const one = JSON.stringify({custom_id: jobs[0].id, response: {status_code: 200, body: fakeResponse(plan, jobs[0])}, error: null}) + '\n';
  const client = {upload: async () => ({id: 'file-input'}), create: async () => batch, inspect: async () => batch, file: async () => byteStream(one)};
  await execute({directory: dir, plan, manifest, ticket, operation: 'submit', client});
  await assert.rejects(execute({directory: dir, plan, manifest, ticket, operation: 'retrieve', client}), /missing_batch_cases/);
  const state = await snapshot(dir), next = plan.jobs.find(j => j.body && !state.states[j.id]);
  assert.equal(state.results[jobs[0].id].valid, true); assert.equal(state.states[jobs[1].id].state, 'unknown');
  assert.equal(state.shardStates[hash(manifest)].state, 'unresolved');
  await assert.rejects(admitShard({directory: dir, plan, manifest: shard(plan, [next.id]), executionID: 'no_partial_next'}), /prior_shard_unresolved/);
});
test('optional full plan reuses identical case definitions and all seed IDs without another seed admission', async t => {
  const plan = await planFixture(), dir = await journalFixture(t, plan);
  const full = await preparePlan({...routeOptions, corpus, approvedCorpusHash: hash(corpus), mode: 'full1440'});
  assert.deepEqual(full.seedIDs, plan.seedIDs);
  for (const job of plan.jobs) assert.equal(hash(job), hash(full.jobs.find(j => j.id === job.id)));
  await registerPlan(dir, full, hash(full));
  const job = plan.jobs.find(j => j.id === plan.seedIDs[0]), manifest = shard(plan, [job.id]);
  await runInJournal(dir, plan, manifest, {standard: async () => fakeResponse(plan, job)});
  await assert.rejects(admitShard({directory: dir, plan: full, manifest: shard(full, [job.id]), executionID: 'do_not_repeat_seed'}), /never_resend/);
});
test('every enabled legacy Batch build operation emits terminal evidence and rejects after fake work', async () => {
  const plan = await planFixture(), manifest = shard(plan, [plan.jobs[0].id], {}, 'batch'), ticket = ticketFor(manifest), batch = batchObject(manifest);
  const raw = JSON.stringify({custom_id: manifest.jobs[0].id, response: {status_code: 200, body: fakeResponse(plan, manifest.jobs[0])}, error: null}) + '\n';
  for (const operation of ['submit', 'inspect', 'recover', 'retrieve']) {
    const events = [];
    const bundle = {plan, manifest, ticket, operation, allocationMicros: manifest.jobs[0].reservedMicros, representativeReviewed: true, batchAccepted: true, batchID: batch.id, inputFileID: batch.input_file_id};
    const client = {upload: async () => ({id: batch.input_file_id}), create: async () => batch, inspect: async () => batch,
      list: async () => ({data: [batch], has_more: false}), file: async id => byteStream(id === batch.input_file_id ? batchInput(manifest) : raw)};
    const env = {LYRA_LANGUAGE_EXPANSION_ON_BUILD: '1', VERCEL: '1', VERCEL_ENV: 'production', VERCEL_DEPLOYMENT_ID: ticket.executionID, LYRA_LANGUAGE_EXPANSION_PLAN_HASH: hash(plan), LYRA_LANGUAGE_EXPANSION_SHARD_HASH: hash(manifest)};
    await assert.rejects(evaluateLanguageExpansionInBuild(env, {loadBundle: async () => bundle, claimStart: async () => {}, emit: e => events.push(e), client}), /intentional_build_failure/);
    assert.equal(events.at(-1).state, 'evaluation_only_complete'); assert.equal(events.at(-1).operation, operation); assert.equal(events.at(-1).intentionalBuildFailure, true);
  }
});
