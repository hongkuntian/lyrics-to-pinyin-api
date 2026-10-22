import {hash, fail} from './common.mjs';

// Research definitions only. These annotations never enter production prompts.
export const SOURCE_PROFILE = 'curated-r1-legacy-document-language-only';
export const CONTROLS = {'ja-c': 'zh-Hans', 'ko-c': 'en', 'pt-c': 'es', 'it-c': 'es', 'de-c': 'es', 'ru-c': 'uk', 'vi-c': 'vi', 'id-c': 'id', 'th-c': 'en', 'hi-c': 'hi-Latn'};
const family = tag => tag.startsWith('hi') ? 'hi' : tag;
const disposition = id => id === 'ru-c' ? 'unsupported-source-study-refusal' : id === 'hi-c' ? 'hi-Latn-estimate-or-explicit-context-confirmation-hold' : ['vi-c', 'id-c'].includes(id) ? 'family-source-context-qualification-hold' : 'existing-source-context-qualification-hold';
const routeKeys = ['effectiveSelectionLanguage', 'authority', 'selectionSourceID', 'selectionText', 'selectionUtf8SHA256', 'basis', 'disposition', 'note', 'paidMatrixScheduleChanged'];
export function validateRouting(specs, manifest, approvedHash) {
  if (!manifest || hash(manifest) !== approvedHash || manifest.schema !== 'lyrica-selected-routing-research-v1' ||
      manifest.originalSelectionsRetained !== true || manifest.paidMatrixScheduleChanged !== false ||
      !Array.isArray(manifest.cases) || manifest.cases.length !== 10 || new Set(manifest.cases.map(r => r.caseID)).size !== 10 ||
      manifest.cases.some(r => !Object.hasOwn(CONTROLS, r.caseID))) fail('approved_exact_routing_required');
  for (const spec of specs) {
    const route = manifest.cases.find(r => r.caseID === spec.id);
    const effective = CONTROLS[spec.id] ?? spec.language;
    if ((spec.sourceFamily != null && spec.sourceFamily !== family(spec.language)) ||
        (spec.effectiveSelectionLanguage != null && spec.effectiveSelectionLanguage !== effective)) fail('effective_selection_language_changed');
    if (!route) {
      if (spec.selectionRouting != null) fail('unexpected_selection_routing');
      continue;
    }
    if (route.sourceFamily !== family(spec.language) || route.exactTag !== spec.language || route.effectiveSelectionLanguage !== effective ||
        route.disposition !== disposition(spec.id) || route.authority !== 'research-annotation-only' || route.paidMatrixScheduleChanged !== false ||
        Object.keys(route).sort().join() !== [...routeKeys, 'caseID', 'sourceFamily', 'exactTag'].sort().join() ||
        typeof route.basis !== 'string' || typeof route.note !== 'string' || !spec.selectionRouting ||
        Object.keys(spec.selectionRouting).sort().join() !== [...routeKeys].sort().join() ||
        routeKeys.some(k => spec.selectionRouting[k] !== route[k]) || spec.effectiveSelectionLanguage !== effective ||
        route.selectionSourceID !== spec.selection.sourceID || route.selectionText !== (spec.selection.originalText ?? spec.selection.text) ||
        route.selectionUtf8SHA256 !== hash(route.selectionText)) fail('exact_selection_routing_changed');
  }
  if (manifest.cases.some(r => !specs.some(s => s.id === r.caseID))) fail('missing_routing_source');
}
export function expectedSourceIDs(tag) {
  return (tag === 'hi' ? ['b', 'd', 'f'] : tag === 'hi-Latn' ? ['a', 'c', 'e'] : ['a', 'b', 'c', 'd', 'e', 'f']).map(s => family(tag) + '-' + s);
}
export function sourceDefinition(spec, input, routingManifest) {
  const routing = routingManifest.cases.find(r => r.caseID === spec.id) ?? null;
  const definition = {profile: SOURCE_PROFILE, spec, bindings: input.bindings, doc: input.doc, selection: input.selection, routing};
  return {definitionHash: hash(definition), routing, effectiveSelectionLanguage: routing?.effectiveSelectionLanguage ?? spec.language,
    familyTag: family(spec.language)};
}
export function jobDefinition(source, job) {
  const foreign = source.effectiveSelectionLanguage !== source.tag;
  const diagnosticOnly = job.kind === 'original' && foreign;
  const executionDisposition = job.kind === 'original' && source.id === 'ru-c' ? 'static_refusal' : 'generate';
  const qualification = {profile: SOURCE_PROFILE, familyTag: source.familyTag, documentTag: source.tag,
    originalEffectiveSelectionLanguage: source.effectiveSelectionLanguage,
    effectiveSelectionLanguage: job.kind === 'original' ? source.effectiveSelectionLanguage : job.kind === 'translated' ? job.target : null,
    originalSelectionHash: hash(source.selection), originalBindingsHash: hash(source.bindings),
    sourceContextQualification: source.routing?.disposition ?? 'unreviewed-source',
    mixedContextDiagnostic: foreign, diagnosticOnly, familyDirectionPositiveEligible: !diagnosticOnly,
    modelContext: 'legacy-document-language-only; no resolved passage hints'};
  const definition = {sourceDefinitionHash: source.definitionHash, id: job.id, kind: job.kind, target: job.target,
    explanation: job.explanation, dependency: job.dependency, intent: job.intent, executionDisposition, qualification};
  return {sourceDefinitionHash: source.definitionHash, definitionHash: hash(definition), executionDisposition, qualification};
}
