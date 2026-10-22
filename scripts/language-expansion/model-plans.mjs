// Research-only fixed compilers. No provider, journal mutation or supplied bodies.
import fs from 'node:fs/promises';
import {RESEARCH_BATCH_PRICE} from '../../api/utils/song-library/model-policy.js';
import {preparePlan,sourceInput} from './plan.mjs';
import {prepareBaseline,wholeOccurrenceLength} from './baseline.mjs';
import {hash,fail,codeHashes,SCHEMA,integer} from './common.mjs';
import {BATCH_RETRIEVAL} from './batch-files.mjs';
import {FAMILIES,NAMES,familyOption,exactOptions,maximum,capFor,makeSlotProfile,checkProfile,checkSlot} from './model-family.mjs';
import {requestBody,reservationMicros,translationRecipe} from '../../api/utils/song-library/translation.js';
import {explanationBody,explanationRecipe,selectionV2} from '../../api/utils/song-library/study-explanation.js';
import {digest} from '../../api/utils/song-library/store.js';
import {responseResult} from './transport.mjs';
export const NAMED_MODE='named-model-canaries-r1',PARTITION_MODE='model-partition-r1';
export const isModelPlan=p=>[NAMED_MODE,PARTITION_MODE].includes(p?.mode);
const AUTHORED='6f7e270f0b11f104b60a0cbcf57208a65e03131fe8bdcbfc50bd7476445dd585';
async function inputs(){const bytes=await fs.readFile(new URL('./model-authored.json',import.meta.url));if(hash(bytes)!==AUTHORED)fail('model_authored_changed');return JSON.parse(bytes);}
function freeze(body,kind,family) {
 const f=familyOption({modelFamily:family}),bodyJSON=JSON.stringify(body);
 if(body.model!==f.model||body.reasoning?.effort!=='xhigh'||body.service_tier!=='default'||body.store!==false||
  body.max_output_tokens!==capFor(kind)||Object.hasOwn(body,'prompt_cache_retention')||body.input.some(x=>Object.hasOwn(x,'cache_control')))fail('r1_configuration_changed');
 if(Buffer.byteLength(bodyJSON)+4096>24000)fail('experiment_input_limit');
 return {body,bodyJSON,bodyHash:hash(bodyJSON),reservedMicros:reservationMicros(body)};
}
export function modelBody(source,job,translation=null,selection=job.selection??source.selection) {
 const model=familyOption({modelFamily:job.modelFamily}).model;
 return freeze(job.kind==='translation'?requestBody(source.doc,job.target,{model}):
  explanationBody(source.doc,translation,selection,job.explanation??job.target,{model}),job.kind,job.modelFamily);
}
function define(source,job) {
 return {...job,sourceDefinitionHash:source.definitionHash,definitionHash:hash({version:'model-only-r1',...job,
  sourceDefinitionHash:source.definitionHash,configuration:FAMILIES[job.modelFamily]})};
}
const cache=new Map(); // At most the four fixed family/kind definitions; never journal state.
async function complete(kind,family,profile=makeSlotProfile()) {
 profile=structuredClone(profile);checkProfile(profile);
 familyOption({modelFamily:family});if(hash(await fs.readFile(new URL('./sol-batch-price.json',import.meta.url)))!==RESEARCH_BATCH_PRICE.sourceReceiptSHA256)fail('reviewed_sol_batch_price_changed');if(!['genuine728','baseline113'].includes(kind))fail('fixed_scientific_kind_required');
 const codes=await codeHashes(),key=hash({kind,family,codes,profile});
 if(cache.has(key))return cache.get(key);
 const input=await inputs(),base=kind==='genuine728'?await preparePlan(input.args):await prepareBaseline();
 const map=id=>family+'-'+kind+'--'+id;
 const jobs=base.jobs.map(j=>{
  const source=base.sources.find(s=>s.id===j.source);
  const job={...j,id:map(j.id),...(j.dependency?{dependency:map(j.dependency)}:{}),modelFamily:family,
   recipe:j.recipe??(j.kind==='translation'?translationRecipe(j.target):explanationRecipe(j.kind==='translated'?{studyText:{layer:'translation'}}:source.selection,j.explanation??j.target)),
   ...(family==='r1-sol'&&kind==='genuine728'?{batchPriceDescriptor:RESEARCH_BATCH_PRICE}:{}),
   familyQualification:kind==='genuine728'?'exact-new-family-standard-seed-required':'automatic-source-baseline-not-private-context'};
  Object.assign(job,j.body?modelBody(source,job):{body:null,bodyJSON:null,bodyHash:null,reservedMicros:j.executionDisposition==='static_refusal'?0:maximum(family,j.kind)});
  return define(source,job);
 });
 const seedIDs=base.seedIDs.map(map),groups=[];
 if(kind==='genuine728') {
  groups.push({id:'matrix-seeds33',caseIDs:seedIDs});
  for(const tag of ['ja','ko','pt','it','de','ru','vi','id','th','hi','hi-Latn']) {
   const sources=base.sources.filter(s=>s.tag===tag).map(s=>s.id);
   for(let i=0;i<sources.length;i+=3)groups.push({id:'matrix-'+tag+'-'+(i/3+1),caseIDs:jobs.filter(j=>sources.slice(i,i+3).includes(j.source)||seedIDs.includes(j.id)).map(j=>j.id)});
  }
 } else for(const s of base.sources)groups.push({id:'baseline-'+s.id,caseIDs:jobs.filter(j=>j.source===s.id).map(j=>j.id)});
 const index={version:'complete-model-schedule-r1',kind,modelFamily:family,configuration:FAMILIES[family],slotProfile:profile,codeHashes:codes,
  authoredSHA256:AUTHORED,corpusHash:base.corpusHash??base.authoredSHA256,routingHash:base.routingHash??base.checkedInPolicySHA256,
  sources:base.sources.map(s=>({id:s.id,definitionHash:s.definitionHash,specHash:s.specHash,sourceHash:s.doc.sourceHash})),
  jobs:jobs.map(({body,bodyJSON,...j})=>j),seedIDs,partitions:groups};
 const result={base,jobs,seedIDs,index,scheduleHash:hash(index)};
 if(cache.size>=4)cache.delete(cache.keys().next().value);cache.set(key,result);return result;
}
export async function describeModelSchedule(options={}) {
 exactOptions(options,['kind','modelFamily','slotProfile']);if(Object.hasOwn(options,'modelFamily'))familyOption({modelFamily:options.modelFamily});const d=await complete(options.kind,options.modelFamily??'r1-luna',options.slotProfile);return structuredClone(d.index);
}
function envelope(mode,family,profile,codes,sources,jobs,seedIDs) {
 checkProfile(profile);return {schema:SCHEMA,mode,modelFamily:family,slotProfile:profile,confirmationNames:[...NAMES],
  confirmationReserveMicros:profile.slots.reduce((n,s)=>n+s.reservedMicros,0),ceilingMicros:20000000,retrievalPolicy:BATCH_RETRIEVAL,
  codeHashes:codes,sources,jobs,seedIDs,maxReservedMicros:jobs.reduce((n,j)=>n+(j.templateOnly?0:j.reservedMicros),0),
  review:'proposal only; Root admits/transitions; semantic review and actual ledger reconciliation required'};
}
export async function prepareModelPartition(options={}) {
 exactOptions(options,['kind','modelFamily','approvedCompleteScheduleHash','partitionIndex','slotProfile']);if(Object.hasOwn(options,'modelFamily'))familyOption({modelFamily:options.modelFamily});
 const family=options.modelFamily??'r1-luna',d=await complete(options.kind,family,options.slotProfile);
 if(options.approvedCompleteScheduleHash!==d.scheduleHash)fail('approved_complete_schedule_required');
 const i=options.partitionIndex;if(!integer(i)||!d.index.partitions[i])fail('fixed_partition_index_required');
 const ids=d.index.partitions[i].caseIDs,jobs=d.jobs.filter(j=>ids.includes(j.id));
 const plan=envelope(PARTITION_MODE,family,options.slotProfile??makeSlotProfile(),d.base.codeHashes,
  d.base.sources.filter(s=>jobs.some(j=>j.source===s.id)),jobs,d.seedIDs);
 return structuredClone({...plan,kind:options.kind,partitionIndex:i,completeScheduleHash:d.scheduleHash,
  // Freeze every future partition and full definition identity before admitting any.
  completeSchedule:i===0?d.index:null,standardOnly:options.kind==='baseline113',
  policyProvenance:options.kind==='baseline113'?d.base.policyProvenance:null});
}
export async function prepareModelCanaries(options={}) {
 exactOptions(options,['modelFamily','slotProfile']);if(Object.hasOwn(options,'modelFamily'))familyOption({modelFamily:options.modelFamily});const family=options.modelFamily??'r1-sol';familyOption({modelFamily:family});
 const profile=options.slotProfile??makeSlotProfile(family),input=await inputs(),base=await preparePlan(input.args);
 const transfer=input.comparison.transferSource,t=sourceInput(transfer);
 const extra={...t,id:transfer.id,spec:transfer,specHash:hash(transfer),tag:transfer.language,definitionHash:hash({spec:transfer,bindings:t.bindings,doc:t.doc})};
 const sources=[...base.sources,extra].filter(s=>input.comparison.cells.some(c=>c.source===s.id));
 const id=n=>family+'-comparison13-r1--cell'+String(n).padStart(2,'0');
 const jobs=input.comparison.cells.map(c=>{
  const source=sources.find(s=>s.id===c.source),slot=NAMES[c.n+12],history=input.historical[String(c.n)];
  if(c.sourceDefinitionHash!==source.definitionHash||c.sourceHash!==source.doc.sourceHash)fail('comparison_source_changed');
  const parent={2:1,5:4,8:7,11:10}[c.n];
  let job={id:id(c.n),cell:c.n,source:c.source,tag:source.tag,kind:c.kind,target:c.target,explanation:c.explanation,
   modelFamily:family,templateOnly:true,confirmationSlot:slot,executionDisposition:'generate',
   recipe:c.kind==='translation'?translationRecipe(c.target):explanationRecipe(c.kind==='translated'?{studyText:{layer:'translation'}}:source.selection,c.explanation??c.target),
   qualification:{profile:NAMED_MODE,positiveFamilyQualification:false,disposition:history?'exact-historical-parent-diagnostic':parent?'fresh-same-arm-parent-diagnostic':'model-diagnostic',parentPolicy:c.parentPolicy},
   ...(parent?{dependency:id(parent)+'--confirmation--'+NAMES[parent+12],intent:{sourceID:source.selection.sourceID,strategy:'whole-occurrence-max80'}}:{}),
   ...(history?{translation:history.translation,selection:history.selection,historicalParentHash:hash(history),historicalRequestBinding:input.historicalRequestPins[String(c.n)].binding}:{})};
  Object.assign(job,parent?{body:null,bodyJSON:null,bodyHash:null,reservedMicros:maximum(family,c.kind)}:modelBody(source,job,history?.translation??null));
  if(!parent&&c.n<=12&&job.bodyHash!==c.bodies[family].bodyHash)fail('comparison_body_pin_changed');
  if(c.n===13){
   const pin=input.historicalRequestPins['13'];
   const {model:priorModel,...before}=pin.originalBody,{model:nextModel,...after}=job.body;
   if(pin.originalBodyJSON!==JSON.stringify(pin.originalBody)||hash(pin.originalBodyJSON)!==pin.bodyHash||priorModel!=='gpt-6-luna'||hash(before)!==hash(after))fail('sf07_model_only_body_changed');
  }
  job=define(source,job);
  checkSlot({...job,confirmationName:slot,body:job.body??{model:FAMILIES[family].model,max_output_tokens:capFor(c.kind)},bodyJSON:job.bodyJSON??''},profile);
  return job;
 });
 return {...envelope(NAMED_MODE,family,profile,base.codeHashes,sources,jobs,[]),comparisonSpecHash:hash(input.comparison),standardOnly:true};
}
export async function validateModelPlan(plan,approvedHash) {
 if(hash(plan)!==approvedHash)fail('plan_changed');
 const expected=plan.mode===NAMED_MODE?await prepareModelCanaries({modelFamily:plan.modelFamily,slotProfile:plan.slotProfile}):
  await prepareModelPartition({kind:plan.kind,modelFamily:plan.modelFamily,slotProfile:plan.slotProfile,partitionIndex:plan.partitionIndex,approvedCompleteScheduleHash:plan.completeScheduleHash});
 if(hash(expected)!==approvedHash)fail('fixed_model_plan_changed');
}
export function bindModel(plan,job,result) {
 const parentID=job.dependency,template=plan.mode===NAMED_MODE?plan.jobs.find(j=>parentID===j.id+'--confirmation--'+j.confirmationSlot):plan.jobs.find(j=>j.id===parentID);
 const parent=template&&plan.mode===NAMED_MODE?{...template,id:parentID,confirmationOf:template.id,confirmationName:template.confirmationSlot}:template;
 const source=plan.sources.find(s=>s.id===job.source);
 if(!parent||parent.kind!=='translation'||parent.source!==job.source||parent.target!==job.target||parent.modelFamily!==job.modelFamily||
  !result?.valid||result.id!==parentID||!['standard','batch'].includes(result.transport)||
  (result.transport==='batch'&&plan.standardOnly)||!integer(result.actualMicros)||result.actualMicros>parent.reservedMicros||
  hash(result)!==hash(responseResult(plan,parent,result.response,result.transport)))fail('exact_actual_new_model_parent_required');
 const translation={id:hash({bodyHash:result.bodyHash,content:result.content}),target:parent.target,...result.content};
 const row=translation.lines.find(l=>l.sourceID===job.intent.sourceID)?.lyricText,length=wholeOccurrenceLength(row);
 const selection=job.studyVersion===1?source.v1Selection:selectionV2(source.doc,{studyText:{layer:'translation',revisionID:translation.id,occurrenceID:job.intent.sourceID,target:parent.target},
  selection:{offsetUnit:'grapheme',ranges:[{lower:0,upper:length}],textHash:digest(row)}},translation);
 const frozen=modelBody(source,job,translation,selection);
 if(frozen.reservedMicros>job.reservedMicros)fail('dependent_reservation_exceeded');
 return {...job,...frozen,translation,selection,dependencyResultHash:hash(result),parentResult:result};
}
export function modelShard(plan,ids,results={},transport='standard') {
 if(!['standard','batch'].includes(transport)||!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.length>(transport==='standard'?4:32))fail('invalid_shard');
 if(transport==='batch'&&plan.standardOnly)fail('model_standard_only');
 const jobs=ids.map(id=>{
  let job=plan.jobs.find(j=>id===(plan.mode===NAMED_MODE?j.id+'--confirmation--'+j.confirmationSlot:j.id));
  if(!job)fail('exact_named_or_partition_case_required');
  if(job.executionDisposition!=='generate')fail('static_refusal_not_dispatchable');
  if(job.dependency)job=bindModel(plan,job,results[job.dependency]);
  if(plan.mode===NAMED_MODE){job={...job,id,confirmationOf:job.id,confirmationName:job.confirmationSlot};checkSlot(job,plan.slotProfile);}
  return job;
 });
 const manifest={schema:SCHEMA,planHash:hash(plan),transport,jobs,maxRawBytes:1048576,
  ...(transport==='batch'?{retrievalPolicy:BATCH_RETRIEVAL}:{}),standardDeadlineSeconds:4*270+300,maxBuildSeconds:45*60};
 if(transport==='batch'&&Buffer.byteLength(jobs.map(j=>JSON.stringify({custom_id:j.id,method:'POST',url:'/v1/responses',body:j.body})).join('\n')+'\n')>BATCH_RETRIEVAL.inputBytes)fail('batch_input_limit');
 return manifest;
}
export function validateModelManifest(plan,manifest) {
 const results={};for(const j of manifest.jobs)if(j.dependency){if(!j.parentResult)fail('exact_parent_receipt_required');results[j.dependency]=j.parentResult;}
 if(hash(modelShard(plan,manifest.jobs.map(j=>j.id),results,manifest.transport))!==hash(manifest))fail('model_manifest_changed');
}
// Frozen registration order, with a complete union reservation before each write.
export function assertPartitionOrder(plans,next) {
 if(next.mode!==PARTITION_MODE)return;
 const prior=plans.filter(p=>p.mode===PARTITION_MODE&&p.completeScheduleHash===next.completeScheduleHash).sort((a,b)=>a.partitionIndex-b.partitionIndex);
 if(prior.some(p=>p.partitionIndex===next.partitionIndex))return;
 if(next.partitionIndex!==prior.length||prior.some((p,i)=>p.partitionIndex!==i))fail('frozen_partition_order_required');
}

export function assertPartitionSet(plans) {
 for(const key of new Set(plans.filter(p=>p.mode===PARTITION_MODE).map(p=>p.completeScheduleHash))) {
  const indices=plans.filter(p=>p.mode===PARTITION_MODE&&p.completeScheduleHash===key).map(p=>p.partitionIndex).sort((a,b)=>a-b);
  if(indices.some((n,i)=>n!==i))fail('frozen_partition_order_required');
 }
}

// Recompute imported results as well as request bodies. A caller's valid/cost
// flags cannot establish a current-family Standard seed or release a reservation.
export function validateModelResult(plan,job,result,transport) {
 if(result.transport!==transport)fail('model_result_transport_changed');
 const error=result.response==null&&['submission_unknown','provider_echoed_credentials','batch_case_error','batch_http_error'].includes(result.error)?result.error:
  transport==='batch'&&['batch_case_error','batch_http_error'].includes(result.error)?result.error:null;
 const expected=responseResult(plan,job,result.response,transport,error);
 if(result.httpObservation) {
  if(transport!=='standard'||result.response!==null||result.actualMicros!==null||result.error!=='submission_unknown')fail('invalid_http_observation_result');
  expected.httpObservation=result.httpObservation;
 }
 if(transport==='batch')for(const field of ['fileID','role','lineIndex','rawLine','filePayloadHash'])if(Object.hasOwn(result,field))expected[field]=result[field];
 if(hash(expected)!==hash(result))fail('model_result_reconstruction_changed');
}
