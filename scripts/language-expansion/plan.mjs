import {caseInput} from '../evaluate-content-quality.mjs';
import {requestBody, reservationMicros} from '../../api/utils/song-library/translation.js';
import {explanationBody, selectionV2} from '../../api/utils/song-library/study-explanation.js';
import {digest} from '../../api/utils/song-library/store.js';
import {modelPolicy, MODEL} from '../../api/utils/song-library/model-policy.js';
import {SCHEMA, hash, fail, integer, codeHashes} from './common.mjs';
import {BATCH_RETRIEVAL} from './batch-files.mjs';
import {SOURCE_PROFILE, validateRouting, expectedSourceIDs, sourceDefinition, jobDefinition} from './routing.mjs';

export const TAGS = ['ja', 'ko', 'pt', 'it', 'de', 'ru', 'vi', 'id', 'th', 'hi', 'hi-Latn'];
export const TARGETS = ['en', 'fr', 'es', 'zh-Hans'];
export const CEILING = 20_000_000;
export const INPUT_LIMIT = 24_000;
const policy = modelPolicy(MODEL);
export const DEPENDENT_RESERVE = Math.ceil(INPUT_LIMIT * policy.input + 4096 * policy.output);
export const CONFIRMATION_RESERVE = Math.ceil(INPUT_LIMIT * policy.input + 32768 * policy.output);
const graphemes = text => Array.from(new Intl.Segmenter('und', {granularity: 'grapheme'}).segment(text), x => x.segment);
const idFor = (doc, kind, target, explanation) => [doc.id, kind, target, explanation].filter(Boolean).join('--');

function freezeBody(body) {
  const bodyJSON = JSON.stringify(body);
  if (Buffer.byteLength(bodyJSON) + 4096 > INPUT_LIMIT) fail('experiment_input_limit');
  if (body.model !== MODEL || body.reasoning?.effort !== 'xhigh' || body.service_tier !== 'default' || body.store !== false) fail('production_configuration_changed');
  return {body, bodyJSON, bodyHash: hash(bodyJSON), reservedMicros: reservationMicros(body)};
}
export function sourceInput(spec) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(spec.id ?? '') || !TAGS.includes(spec.language) || !Array.isArray(spec.lines) || !spec.lines.length) fail('invalid_protocol_source');
  const lines = spec.lines.map(line => typeof line === 'string' ? line : line.text);
  if (lines.some(line => typeof line !== 'string')) fail('invalid_protocol_source');
  spec.lines.forEach((line, index) => {
    if (typeof line !== 'string' && ((line.order != null && line.order !== index) || (line.utf8SHA256 && line.utf8SHA256 !== hash(lines[index])))) fail('source_bytes_or_order_changed');
  });
  const authorIDs = spec.lines.map((line, index) => typeof line === 'string' ? `L${String(index + 1).padStart(4, '0')}` : line.sourceID);
  if (authorIDs.some(id => typeof id !== 'string') || new Set(authorIDs).size !== authorIDs.length) fail('invalid_author_occurrences');
  const choice = spec.selection;
  if (!choice) fail('selection_intent_required');
  const line = choice.line ?? authorIDs.indexOf(choice.sourceID);
  const text = choice.originalText ?? choice.text;
  const input = caseInput({id: spec.id, language: spec.language, lines, speakers: spec.speakers,
    line, text, textOccurrence: choice.occurrence}, {rows: []});
  const sourceIDMap = Object.fromEntries(authorIDs.map((id, index) => [id, input.doc.structure.occurrences[index].sourceID]));
  const bindings = authorIDs.map((corpusSourceID, index) => {
    const occurrence = input.doc.structure.occurrences[index];
    if (occurrence.sourceText !== lines[index]) fail('source_bytes_changed');
    return {corpusSourceID, wireSourceID: occurrence.sourceID, order: index,
      sourceUtf8SHA256: hash(lines[index]), lyricUtf8SHA256: hash(occurrence.lyricText)};
  });
  // Validate through the actual v2 selection resolver, including grapheme boundaries.
  const s = input.selection;
  const selection = selectionV2(input.doc, {studyText: s.studyText,
    selection: {offsetUnit: 'grapheme', ranges: [{lower: s.lower, upper: s.upper}], textHash: digest(s.text)}});
  if (choice.range && (choice.range.startGrapheme !== selection.lower || choice.range.endGrapheme !== selection.upper ||
      choice.range.selectionUtf8SHA256 !== hash(selection.text) || choice.range.sourceUtf8SHA256 !== hash(lines[line]))) fail('authored_range_changed');
  return {doc: input.doc, selection, sourceIDMap, wireSourceIDMap: Object.fromEntries(bindings.map(b => [b.wireSourceID, b.corpusSourceID])), bindings};
}
export async function preparePlan({corpus, approvedCorpusHash, routingManifest, approvedRoutingHash, mode = 'matrix728', confirmationNames = []}) {
  if (hash(corpus) !== approvedCorpusHash) fail('approved_corpus_hash_required');
  if (!['matrix728', 'full1440'].includes(mode)) fail('explicit_plan_mode_required');
  if (!Array.isArray(confirmationNames) || confirmationNames.length > 60 || new Set(confirmationNames).size !== confirmationNames.length || confirmationNames.some(x => !/^[A-Za-z0-9_-]{1,80}$/.test(x))) fail('invalid_named_confirmations');
  const specs = corpus.documents ?? corpus.sources;
  if (!Array.isArray(specs) || specs.length !== 60 || new Set(specs.map(x => x.id)).size !== 60) fail('sixty_unique_sources_required');
  validateRouting(specs, routingManifest, approvedRoutingHash);
  const sources = [], jobs = [], seedIDs = [];
  for (const [tagIndex, tag] of TAGS.entries()) {
    const group = specs.filter(x => x.language === tag);
    if (group.length !== (tag.startsWith('hi') ? 3 : 6)) fail('exact_tag_document_count');
    if (group.map(s => s.id).join() !== expectedSourceIDs(tag).join()) fail('exact_source_schedule_changed');
    for (const [ordinal, spec] of group.entries()) {
      const input = sourceInput(spec);
      sources.push({id: spec.id, tag, ordinal, spec, specHash: hash(spec), ...input, ...sourceDefinition(spec, input, routingManifest),
        semanticInvariants: spec.semanticInvariants ?? [], permissibleInterpretations: spec.permissibleInterpretations ?? []});
      for (const [targetIndex, target] of TARGETS.entries()) {
        const translationID = idFor(spec, 'translation', target);
        jobs.push({id: translationID, source: spec.id, tag, kind: 'translation', target, ...freezeBody(requestBody(input.doc, target))});
        const originalID = idFor(spec, 'original', target);
        jobs.push({id: originalID, source: spec.id, tag, kind: 'original', target, ...freezeBody(explanationBody(input.doc, null, input.selection, target))});
        for (const explanation of mode === 'full1440' ? TARGETS : [TARGETS[(ordinal + targetIndex) % 4]]) {
          jobs.push({id: idFor(spec, 'translated', target, explanation), source: spec.id, tag, kind: 'translated', target, explanation,
            dependency: translationID, intent: {sourceID: input.selection.sourceID, strategy: 'whole-occurrence-max80'},
            body: null, bodyHash: null, reservedMicros: DEPENDENT_RESERVE});
        }
      }
      if (ordinal === 0) {
        const target = TARGETS[tagIndex % 4];
        seedIDs.push(idFor(spec, 'translation', target), idFor(spec, 'original', TARGETS[(tagIndex + 1) % 4]), idFor(spec, 'translated', target, target));
      }
    }
    // Three Hindi documents miss ordinal=3: freeze these extra four cells on the first source.
    if (mode === 'matrix728' && tag.startsWith('hi')) {
      const spec = group[0], source = sources.find(s => s.id === spec.id);
      for (const [index, target] of TARGETS.entries()) jobs.push({id: idFor(spec, 'translated', target, TARGETS[(3 + index) % 4]),
        source: spec.id, tag, kind: 'translated', target, explanation: TARGETS[(3 + index) % 4], dependency: idFor(spec, 'translation', target),
        intent: {sourceID: source.selection.sourceID, strategy: 'whole-occurrence-max80'}, body: null, bodyHash: null, reservedMicros: DEPENDENT_RESERVE});
    }
  }
  for (const job of jobs) {
    Object.assign(job, jobDefinition(sources.find(s => s.id === job.source), job));
    if (job.executionDisposition === 'static_refusal') Object.assign(job, {body: null, bodyJSON: null, bodyHash: null, reservedMicros: 0, refusalCode: 'unsupported_selected_language'});
  }
  if (jobs.length !== (mode === 'matrix728' ? 728 : 1440) || new Set(jobs.map(x => x.id)).size !== jobs.length) fail('matrix_count');
  const plan = {schema: SCHEMA, retrievalPolicy: BATCH_RETRIEVAL, mode, corpusHash: hash(corpus), sourceProfile: SOURCE_PROFILE, routingManifest, routingHash: approvedRoutingHash, codeHashes: await codeHashes(), sources, jobs, seedIDs,
    ceilingMicros: CEILING, confirmationNames, confirmationReserveMicros: confirmationNames.length * CONFIRMATION_RESERVE,
    maxReservedMicros: jobs.reduce((sum, job) => sum + job.reservedMicros, 0),
    coverage: {nominalDirections: 40, exactDirections: 44, translatedCells: 176, acceptanceCases: jobs.length, maxGenerationJobs: jobs.length - 4, staticRefusals: 4},
    rotation: '(docOrdinalWithinExactTag + targetIndex) % 4; Hindi missing ordinal=3 cells on first document',
    review: 'unreviewed; structural evidence never qualifies semantic quality'};
  if (plan.maxReservedMicros + plan.confirmationReserveMicros > CEILING) fail('evaluation_budget_exceeded');
  return plan;
}
export async function validatePlan(plan, approvedHash) {
  if (!plan.retrievalPolicy || hash(plan.retrievalPolicy) !== hash(BATCH_RETRIEVAL)) fail('retrieval_policy_changed');
  if (plan.schema !== SCHEMA || hash(plan) !== approvedHash) fail('plan_changed');
  if (JSON.stringify(plan.codeHashes) !== JSON.stringify(await codeHashes())) fail('generation_code_changed');
  if (plan.ceilingMicros !== CEILING || !integer(plan.maxReservedMicros) || !['matrix728', 'full1440'].includes(plan.mode) ||
      plan.jobs.length !== (plan.mode === 'matrix728' ? 728 : 1440) || new Set(plan.jobs.map(j => j.id)).size !== plan.jobs.length ||
      plan.seedIDs.length !== 33 || new Set(plan.seedIDs).size !== 33 || plan.seedIDs.some(id => !plan.jobs.some(j => j.id === id)) ||
      plan.sources.length !== 60 || !Array.isArray(plan.confirmationNames) || plan.confirmationNames.length > 60 ||
      new Set(plan.confirmationNames).size !== plan.confirmationNames.length || plan.confirmationNames.some(n => !/^[A-Za-z0-9_-]{1,80}$/.test(n)) ||
      plan.confirmationReserveMicros !== plan.confirmationNames.length * CONFIRMATION_RESERVE) fail('invalid_budget_or_schedule');
  if (plan.sourceProfile !== SOURCE_PROFILE) fail('source_profile_changed');
  validateRouting(plan.sources.map(s => s.spec), plan.routingManifest, plan.routingHash);
  for (const tag of TAGS) {
    const group = plan.sources.filter(s => s.tag === tag);
    if (group.map(s => s.id).join() !== expectedSourceIDs(tag).join() || group.some((s, i) => s.ordinal !== i)) fail('exact_source_schedule_changed');
  }
  for (const source of plan.sources) {
    const input = sourceInput(source.spec), definition = sourceDefinition(source.spec, input, plan.routingManifest);
    if (source.id !== source.spec.id || source.tag !== source.spec.language || source.specHash !== hash(source.spec) ||
        hash(source.semanticInvariants) !== hash(source.spec.semanticInvariants ?? []) || hash(source.permissibleInterpretations) !== hash(source.spec.permissibleInterpretations ?? []) ||
        Object.keys(input).some(k => hash(source[k]) !== hash(input[k])) ||
        Object.keys(definition).some(k => hash(source[k]) !== hash(definition[k]))) fail('source_definition_changed');
  }
  if (plan.jobs.filter(j => j.executionDisposition === 'static_refusal').map(j => j.id).sort().join() !== TARGETS.map(t => 'ru-c--original--' + t).sort().join() ||
      plan.jobs.filter(j => j.executionDisposition === 'generate').length !== plan.jobs.length - 4) fail('exact_static_refusals_required');
  for (const job of plan.jobs) {
    const source = plan.sources.find(s => s.id === job.source);
    if (!source) fail('source_missing');
    if (!['translation', 'original', 'translated'].includes(job.kind) || !TARGETS.includes(job.target) || job.tag !== source.tag ||
        job.id !== idFor(source.spec, job.kind, job.target, job.explanation)) fail('case_schedule_changed');
    if (job.kind === 'translated') {
      const targetIndex = TARGETS.indexOf(job.target);
      const scheduled = plan.mode === 'full1440' ? TARGETS : [TARGETS[(source.ordinal + targetIndex) % 4],
        ...(source.tag.startsWith('hi') && source.ordinal === 0 ? [TARGETS[(3 + targetIndex) % 4]] : [])];
      if (!scheduled.includes(job.explanation) || hash(job.intent) !== hash({sourceID: source.selection.sourceID, strategy: 'whole-occurrence-max80'})) fail('case_schedule_changed');
    } else if (job.explanation !== undefined || job.dependency !== undefined) fail('case_schedule_changed');
    const definition = jobDefinition(source, job);
    if (Object.keys(definition).some(k => hash(job[k]) !== hash(definition[k]))) fail('case_definition_changed');
    if (job.executionDisposition === 'static_refusal') {
      if (job.body !== null || job.bodyHash !== null || job.bodyJSON !== null || job.reservedMicros !== 0 || job.refusalCode !== 'unsupported_selected_language') fail('static_refusal_definition_changed');
      continue;
    }
    if (job.kind === 'translated') {
      if (!plan.jobs.some(j => j.id === job.dependency && j.kind === 'translation' && j.source === job.source && j.target === job.target) || job.reservedMicros !== DEPENDENT_RESERVE) fail('missing_dependency');
    } else {
      const expected = freezeBody(job.kind === 'translation' ? requestBody(source.doc, job.target) : explanationBody(source.doc, null, source.selection, job.target));
      if (['bodyJSON', 'bodyHash', 'reservedMicros'].some(k => expected[k] !== job[k]) || JSON.stringify(job.body) !== expected.bodyJSON) fail('frozen_body_changed');
    }
  }
  const expectedSeed = TAGS.flatMap((tag, index) => {
    const source = plan.sources.find(s => s.tag === tag && s.ordinal === 0), target = TARGETS[index % 4];
    return [idFor(source, 'translation', target), idFor(source, 'original', TARGETS[(index + 1) % 4]), idFor(source, 'translated', target, target)];
  });
  if (hash(plan.seedIDs) !== hash(expectedSeed)) fail('seed_schedule_changed');
  if (hash(plan.coverage) !== hash({nominalDirections: 40, exactDirections: 44, translatedCells: 176, acceptanceCases: plan.jobs.length, maxGenerationJobs: plan.jobs.length - 4, staticRefusals: 4})) fail('coverage_definition_changed');
  if (plan.jobs.reduce((sum, j) => sum + j.reservedMicros, 0) !== plan.maxReservedMicros) fail('invalid_reservations');
}
export function bindDependent(plan, job, result) {
  const source = plan.sources.find(s => s.id === job.source);
  const parent = plan.jobs.find(j => j.id === job.dependency);
  if (!result?.valid || result.id !== job.dependency || result.bodyHash !== parent?.bodyHash || result.definitionHash !== parent?.definitionHash || result.sourceDefinitionHash !== parent?.sourceDefinitionHash) fail('dependent_translation_failed');
  const translation = {id: hash({bodyHash: result.bodyHash, content: result.content}), target: job.target, ...result.content};
  const row = translation.lines.find(line => line.sourceID === job.intent.sourceID)?.lyricText;
  if (typeof row !== 'string' || !row.trim() || graphemes(row).length > 80) fail('dependent_selection_invalid');
  const selection = selectionV2(source.doc, {studyText: {layer: 'translation', revisionID: translation.id, occurrenceID: job.intent.sourceID, target: job.target},
    selection: {offsetUnit: 'grapheme', ranges: [{lower: 0, upper: graphemes(row).length}], textHash: digest(row)}}, translation);
  const frozen = freezeBody(explanationBody(source.doc, translation, selection, job.explanation));
  if (frozen.reservedMicros > job.reservedMicros) fail('dependent_reservation_exceeded');
  return {...job, ...frozen, translation, selection, dependencyResultHash: hash(result)};
}
export function shard(plan, caseIDs, results = {}, transport = 'standard') {
  if (!['standard', 'batch'].includes(transport) || !caseIDs.length || new Set(caseIDs).size !== caseIDs.length || (transport === 'standard' && caseIDs.length > 4) || (transport === 'batch' && caseIDs.length > BATCH_RETRIEVAL.maxCases)) fail('invalid_shard');
  const jobs = caseIDs.map(id => {
    let job = plan.jobs.find(j => j.id === id);
    if (!job && id.includes('--confirmation--')) {
      const [originalID, name, extra] = id.split('--confirmation--');
      const original = plan.jobs.find(j => j.id === originalID);
      if (extra !== undefined || !original || !plan.confirmationNames.includes(name) || transport !== 'standard') fail('invalid_named_standard_confirmation');
      job = {...original, id, confirmationOf: originalID, confirmationName: name};
    }
    if (!job) fail('unknown_case');
    if (job.executionDisposition !== 'generate') fail('static_refusal_not_dispatchable');
    return job.kind === 'translated' ? bindDependent(plan, job, results[job.dependency]) : job;
  });
  const names = jobs.filter(j => j.confirmationName).map(j => j.confirmationName);
  if (new Set(names).size !== names.length) fail('duplicate_confirmation_name');
  const manifest = {schema: SCHEMA, planHash: hash(plan), transport, jobs, maxRawBytes: 1_048_576,
    ...(transport === 'batch' ? {retrievalPolicy: BATCH_RETRIEVAL} : {}),
    standardDeadlineSeconds: 4 * 270 + 300, maxBuildSeconds: 45 * 60};
  if (transport === 'batch' && Buffer.byteLength(batchInput(manifest)) > BATCH_RETRIEVAL.inputBytes) fail('batch_input_limit');
  return manifest;
}
export function batchInput(manifest) {
  return manifest.jobs.map(job => JSON.stringify({custom_id: job.id, method: 'POST', url: '/v1/responses', body: job.body})).join('\n') + '\n';
}
