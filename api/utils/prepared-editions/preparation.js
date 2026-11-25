// Explicit offline acquisition/preparation. Listener code never imports this module.
import {POOL,variantKey,fail,artifact,validateBundle} from './core.js';
import {makeDocument,recordingRequest} from '../song-library/document.js';
import {independentProvider,canonicalJSON} from '../song-library/spotify-recording.js';
import {digest} from '../song-library/store.js';
import {generate} from '../song-library/translation.js';
import {generateLine,lineSelections} from '../song-library/study-line.js';
import {generateExplanation,selectionV2} from '../song-library/study-explanation.js';
import {planTasks,pricePlan,runPreparationJob} from './jobs.js';
import {budgetedGenerate,reservePlanBudget,settlePlanBudget} from './budget.js';
import {translationTasks,acceptedTranslations,inspectorManifest,studyTasks,studyArtifact,assembleBundle} from './compiler.js';
import {environmentLanguagePolicy} from '../song-library/languages.js';
import {modelPolicy} from '../song-library/model-policy.js';
export function poolInventory(){
 const entries=Object.entries(POOL).flatMap(([language,songs])=>songs.map(song=>({language,songID:song.id,variants:song.recordings.map(r=>({provider:'apple',catalogID:r.catalog_id,storefront:r.storefront})),state:'unqualified',costStatus:'unpriced_missing_source_manifest_and_measured_pilot_usage',published:false,gaps:['source_permission','acquisition','timing_listening','five_target_translations','native_inspector_manifest','priced_review','complete_artifacts']})));
 return {version:1,recordings:entries.length,entries};
}
export function requirePreparationRights(spec,selectionRevision){
 const r=spec?.rights;
 if(!r?.reference||!r.reviewer||r.acquisition!==true||r.derivatives!==true||r.persistentServing!==true||Date.parse(r.expiresAt)<=Date.now()||!Number.isFinite(Date.parse(r.expiresAt))||
  spec.acquisitionReview?.selectionRevision!==selectionRevision||!spec.acquisitionReview.reference||spec.acquisitionReview.allOrdinaryProviderPathsApproved!==true||!r.source?.provider||!r.source?.itemID)fail('source_permission_required',409);
}
export async function acquireEdition(spec,{loadLyrics,selectionRevision}={}){
 requirePreparationRights(spec,selectionRevision);
 const song=Object.values(POOL).flat().find(s=>s.id===spec.songID);
 if(!song||!Array.isArray(spec.variants)||!spec.variants.length||spec.variants.some(v=>!song.recordings.some(r=>r.catalog_id===v.catalogID&&r.storefront===v.storefront)))fail('variant_unavailable',403);
 const v=spec.documentVariant;variantKey(v);
 const recording=song.recordings.find(r=>r.catalog_id===v.catalogID&&r.storefront===v.storefront);if(!recording)fail('variant_unavailable',403);
 // Metadata is server-owned fixed pool data. Client titles cannot choose a source.
 const request=recordingRequest(recording),response=await loadLyrics(request),doc=makeDocument(request,response,selectionRevision);
 const provider=independentProvider(response.metadata?.source);
 if(provider!==spec.rights.source.provider||String(response.song.id)!==spec.rights.source.itemID)fail('source_scope_mismatch',409);
 if(spec.expectedSourceHash&&spec.expectedSourceHash!==doc.sourceHash)fail('source_changed',409);
 return {version:1,spec,doc,acquiredAt:new Date().toISOString(),acquisitionHash:digest({request,documentID:doc.id,sourceHash:doc.sourceHash,selectionRevision})};
}
export function stagePlan(acquired,{stage,translations=null,rows=null,policy}){
 const {doc}=acquired;
 const manifest=stage==='study'?inspectorManifest(doc,translations,rows??undefined):null;
 const tasks=stage==='translations'?translationTasks(doc,policy):stage==='study'?studyTasks(doc,translations,manifest,policy):fail('invalid_stage');
 const plan=planTasks(tasks);
 return {version:1,stage,documentID:doc.id,sourceHash:doc.sourceHash,acquisitionHash:acquired.acquisitionHash,manifest,tasks,plan};
}
export function priceStage(stage,pilotUsage,{retryAllowance=0}={}){
 const models=new Set(stage.tasks.map(t=>t.body.model));if(models.size>1)fail('mixed_model_plan',422);
 const model=[...models][0],rates=modelPolicy(model);if(!rates&&stage.tasks.length)fail('generation_configuration_unavailable',503);
 return {...pricePlan(stage.plan,{pilotUsage,rates:rates??{input:0,output:0},retryAllowance}),stage:stage.stage,documentID:stage.documentID,sourceHash:stage.sourceHash,model:model??null};
}
export async function executeStage(acquired,stage,{path,review,database,apiKey,translations=null,generateTranslation=generate,generateBatch=generateLine,generateSingleton=generateExplanation,policy=environmentLanguagePolicy()}={}){
 requirePreparationRights(acquired.spec,acquired.doc.selectionRevision);
 if(stage.acquisitionHash!==acquired.acquisitionHash||stage.documentID!==acquired.doc.id||stage.sourceHash!==acquired.doc.sourceHash)fail('source_changed',409);
 const expected=stagePlan(acquired,{stage:stage.stage,translations,rows:stage.manifest,policy});
 if(canonicalJSON(expected)!==canonicalJSON(stage))fail('preparation_plan_changed',409);
 const {plan}=stage;
 if(planTasks(stage.tasks).id!==plan.id||!review?.reviewer||!review.reference||review.planID!==plan.id||review.currency!=='USD'||review.retryAllowance!==0||!Number.isSafeInteger(review.ceilingMicros)||review.ceilingMicros<0||!apiKey)fail('priced_review_required',409);
 if(stage.stage==='study'&&(!stage.manifest||!review.nativeManifestHash||review.nativeManifestHash!==artifact('manifest',stage.manifest).id))fail('native_manifest_required',409);
 if(!database)fail('generation_budget_required',409);
 await reservePlanBudget(database,plan.id,review.ceilingMicros);
 const byID=new Map(stage.tasks.map(t=>[t.id,t]));
 const checkpoint=await runPreparationJob({path,plan,ceilingMicros:review.ceilingMicros,retryAllowance:0,generate:(input,{attempt})=>budgetedGenerate(database,{planID:plan.id,task:input,attempt,generate:async()=>{
  const task=byID.get(input.id),doc=acquired.doc;
  if(canonicalJSON(task.body)!==canonicalJSON(input.body))fail('manifest_changed',409);
  if(stage.stage==='translations')return generateTranslation(doc,{apiKey,target:task.target,generationRequest:input.body});
  const s=task.selector,t=s.studyText.layer==='translation'?translations?.[s.studyText.target]:null;
  return task.kind==='batch'?generateBatch(doc,t,lineSelections(doc,s,t),{apiKey,explanationLanguage:s.explanationLanguage,generationRequest:input.body}):generateSingleton(doc,t,selectionV2(doc,s,t),{apiKey,explanationLanguage:s.explanationLanguage,generationRequest:input.body});
 }})});
 if(checkpoint.state==='ready')await settlePlanBudget(database,plan.id,plan.tasks.map(t=>t.id));
 return checkpoint;
}
export function finishTranslations(acquired,stage,checkpoint){
 if(checkpoint.state!=='ready'||checkpoint.planID!==stage.plan.id)fail('preparation_incomplete',409);
 return acceptedTranslations(acquired.doc,stage.tasks.map(t=>({target:t.target,content:checkpoint.tasks.find(r=>r.id===t.id)?.content})));
}
export function finishEdition(acquired,stage,checkpoint,translations){
 if(checkpoint.state!=='ready'||checkpoint.planID!==stage.plan.id)fail('preparation_incomplete',409);
 const studyArtifacts=stage.tasks.map(t=>studyArtifact(acquired.doc,translations,t,{content:checkpoint.tasks.find(r=>r.id===t.id)?.content}));
 const b=assembleBundle({doc:acquired.doc,translations,manifest:stage.manifest,studyArtifacts,spec:acquired.spec});return validateBundle(b);
}
