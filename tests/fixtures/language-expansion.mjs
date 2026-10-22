import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {hash, SCHEMA} from '../../scripts/language-expansion/common.mjs';
import {preparePlan, shard, TAGS, TARGETS, batchInput} from '../../scripts/language-expansion/plan.mjs';
import {initJournal, registerPlan, admitShard} from '../../scripts/language-expansion/journal.mjs';
import {execute} from '../../scripts/evaluate-language-expansion.mjs';
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


export {corpus, routingManifest, routeOptions, planFixture, directory, journalFixture, fakeResponse, ticketFor, batchObject, byteStream};
