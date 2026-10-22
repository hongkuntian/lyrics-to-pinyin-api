// Bounded research subsets of an independently validated real-builder plan.
// There is deliberately no supplied-body or arbitrary-builder callback interface.
import {hash, fail, SCHEMA} from './common.mjs';
import {validatePlan, CEILING} from './plan.mjs';
import {jobDefinition} from './routing.mjs';
export const RECIPE_MODE = 'frozen-recipe-subset-1';
function project(builderPlan, namespace, caseIDs, dependencyBindings) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(namespace ?? '') || !Array.isArray(caseIDs) || !caseIDs.length ||
      caseIDs.length > 1440 || new Set(caseIDs).size !== caseIDs.length) fail('invalid_recipe_schedule');
  if (!dependencyBindings || typeof dependencyBindings!=='object' || Array.isArray(dependencyBindings) || Object.keys(dependencyBindings).some(id=>!caseIDs.includes(id))) fail('invalid_recipe_parent_bindings');
  const mapID = id => namespace + '--recipe--' + id;
  const jobs = caseIDs.map(id => {
    const original = builderPlan.jobs.find(j => j.id === id);
    if (!original || original.confirmationName) fail('unknown_recipe_builder_case');
    const binding=dependencyBindings[id];
    if (binding && original.kind!=='translated') fail('invalid_recipe_parent_binding');
    if (original.dependency && !caseIDs.includes(original.dependency) && !binding?.historical) fail('recipe_dependency_closure_required');
    let parentBinding;
    if (binding?.confirmationName) {
      if (Object.keys(binding).join()!=='confirmationName' || !builderPlan.confirmationNames.includes(binding.confirmationName) || !caseIDs.includes(original.dependency)) fail('invalid_recipe_parent_binding');
      parentBinding={confirmationName:binding.confirmationName,confirmationOf:mapID(original.dependency)};
    } else if (binding?.historical) {
      const h=binding.historical;
      if (Object.keys(binding).join()!=='historical' || Object.keys(h).sort().join()!=='job,planHash,resultHash,source' ||
          !/^[a-f0-9]{64}$/.test(h.planHash??'') || !/^[a-f0-9]{64}$/.test(h.resultHash??'') ||
          h.job?.kind!=='translation' || h.job.source!==original.source || h.job.target!==original.target ||
          h.job.sourceDefinitionHash!==h.source?.definitionHash || hash(h.source)!==hash(builderPlan.sources.find(s=>s.id===original.source)) ||
          h.job.bodyJSON!==JSON.stringify(h.job.body) || h.job.bodyHash!==hash(h.job.bodyJSON)) fail('invalid_historical_recipe_parent');
      parentBinding={historical:h};
    } else if (binding) fail('invalid_recipe_parent_binding');
    const job = {...original, id: mapID(id), ...(original.dependency ? {dependency: mapID(original.dependency)} : {})};
    if (parentBinding) {job.parentBinding=parentBinding;job.dependency=parentBinding.historical?.job.id ?? parentBinding.confirmationOf+'--confirmation--'+parentBinding.confirmationName;}
    Object.assign(job, jobDefinition(builderPlan.sources.find(s => s.id === job.source), job));
    if (parentBinding?.historical) job.qualification={...job.qualification,historicalParentDiagnosticOnly:true,diagnosticOnly:true,familyDirectionPositiveEligible:false};
    if (parentBinding) job.definitionHash=hash({definitionHash:job.definitionHash,parentBinding,qualification:job.qualification});
    return job;
  });
  return {schema: SCHEMA, mode: RECIPE_MODE, namespace, builderPlan, builderCaseIDs: caseIDs, dependencyBindings,
    codeHashes: builderPlan.codeHashes, retrievalPolicy: builderPlan.retrievalPolicy,
    sourceProfile: builderPlan.sourceProfile, sources: builderPlan.sources, jobs,
    // Missing seeds never make a small confirmation subset Batch-qualified.
    seedIDs: builderPlan.seedIDs.map(mapID), confirmationNames: builderPlan.confirmationNames,
    confirmationReserveMicros: builderPlan.confirmationReserveMicros,
    maxReservedMicros: jobs.reduce((n,j) => n+j.reservedMicros,0), ceilingMicros: CEILING,
    review: 'unreviewed frozen recipe; no semantic qualification or provider admission'};
}
export async function prepareRecipe({builderPlan, namespace, caseIDs, dependencyBindings = {}}) {
  if (builderPlan?.mode === RECIPE_MODE) fail('nested_recipe_forbidden');
  if (['named-model-canaries-r1','model-partition-r1','baseline113-automatic-source-v1'].includes(builderPlan?.mode)) fail('fixed_research_compiler_cannot_be_wrapped');
  await validatePlan(builderPlan, hash(builderPlan));
  return project(builderPlan, namespace, caseIDs, dependencyBindings);
}
export async function validateRecipe(plan, approvedHash) {
  if (hash(plan) !== approvedHash) fail('plan_changed');
  const expected = await prepareRecipe({builderPlan: plan.builderPlan, namespace: plan.namespace, caseIDs: plan.builderCaseIDs, dependencyBindings:plan.dependencyBindings});
  if (hash(expected) !== approvedHash) fail('frozen_recipe_changed');
}

// Resolve historical references ONLY against the fully replayed prefix, never a
// caller's raw result/body. Their costs remain in their original plan/manifest.
export function validateRecipeParents(plan, state) {
  if (plan.mode!==RECIPE_MODE) return;
  for (const job of plan.jobs) if (job.parentBinding?.historical) {
    const h=job.parentBinding.historical,p=state.plans.find(p=>hash(p)===h.planHash);
    const parent=p?.jobs.find(j=>j.id===h.job.id) ?? state.manifests.filter(m=>m.planHash===h.planHash).flatMap(m=>m.jobs).find(j=>j.id===h.job.id);
    if (!p || hash(parent??null)!==hash(h.job) || hash(p.sources.find(s=>s.id===job.source)??null)!==hash(h.source) ||
        state.states[h.job.id]?.state!=='settled' || !state.results[h.job.id]?.valid || hash(state.results[h.job.id])!==h.resultHash) fail('historical_recipe_parent_not_in_replayed_prefix');
  }
}
