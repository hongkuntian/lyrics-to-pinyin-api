// Unapplied research schedule only. Exact seven existing authored sources;
// no product admission, private contexts, arbitrary bodies, source tags or outputs.
import fs from 'node:fs/promises';
import {caseInput} from '../evaluate-content-quality.mjs';
import {requestBody, translationRecipe, reservationMicros} from '../../api/utils/song-library/translation.js';
import {explanationBody, explanationRecipe, selectionV2, selectionFor} from '../../api/utils/song-library/study-explanation.js';
import {digest} from '../../api/utils/song-library/store.js';
import {requireDirection} from '../../api/utils/song-library/languages.js';
import {responseResult} from './transport.mjs';
import {SCHEMA, hash, fail, codeHashes, integer} from './common.mjs';
import {BATCH_RETRIEVAL} from './batch-files.mjs';
export const BASELINE_MODE = 'baseline113-automatic-source-v1';
const AUTHORED_SHA256 = '4de83e04ebf6e134076c9f4958caced9a6d13a69283a232cf695d5fb664306c7';
const POLICY_SHA256 = 'aa027de5a9febdc97c08602962402e949a9fabd77fa1ad9047ac3e28e8959d4e';
const TARGETS = ['en','fr','es','zh-Hans'];
const names = Array.from({length:60},(_,i)=>'confirmation'+String(i+1).padStart(2,'0'));
const segments = text => Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text),s=>s.segment);
const idFor = (id,kind,target,explanation) => ['baseline113-r1',id,kind,target,explanation].filter(Boolean).join('--');
function freezeBody(body) {
 const bodyJSON=JSON.stringify(body);
 if(Buffer.byteLength(bodyJSON)+4096>24000) fail('experiment_input_limit');
 if(body.model!=='gpt-6-luna'||body.reasoning?.effort!=='xhigh'||body.service_tier!=='default'||body.store!==false) fail('production_configuration_changed');
 return {body,bodyJSON,bodyHash:hash(bodyJSON),reservedMicros:reservationMicros(body)};
}
export function wholeOccurrenceLength(row) {
 if(typeof row!=='string'||!row.trim()||!/[\p{L}\p{N}]/u.test(row)) fail('dependent_selection_invalid');
 const length=segments(row).length;
 if(length>80) fail('dependent_selection_invalid');
 return length;
}
function defineJob(source,job) {
 const qualification={profile:BASELINE_MODE,route:'automatic-source',rawSourceLanguage:source.tag,
  sourceFamily:source.familyTag,layer:job.kind==='translated'?'translation':'original',
  privateLanguageContextQualified:false,modelContext:'existing automatic document language; no private context',
  sourceChecks:source.spec.checks,semanticQuality:'unreviewed'};
 return {...job,sourceDefinitionHash:source.definitionHash,executionDisposition:'generate',qualification,
  definitionHash:hash({sourceDefinitionHash:source.definitionHash,id:job.id,kind:job.kind,target:job.target,
   explanation:job.explanation,studyVersion:job.studyVersion,dependency:job.dependency,intent:job.intent,
   selection:job.selection,recipe:job.recipe,qualification})};
}
export async function prepareBaseline() {
 const authoredBytes=await fs.readFile(new URL('./baseline-authored.json',import.meta.url));
 if(hash(authoredBytes)!==AUTHORED_SHA256) fail('baseline_authored_sources_changed');
 const authored=JSON.parse(authoredBytes);
 const policyBytes=await fs.readFile(new URL('../../evaluation/multilingual/beta-policy.json',import.meta.url));
 if(hash(policyBytes)!==POLICY_SHA256) fail('baseline_checked_in_policy_changed');
 const policy=JSON.parse(policyBytes),sources=[],jobs=[];
 for(const entry of authored.sources) {
  const spec=entry.spec;
  // Adapt call arguments only: retained authored definition is never rewritten.
  const adapted=spec.selection?{...spec,line:spec.selection.line,text:spec.selection.text}:spec;
  const {doc,selection}=caseInput(adapted,{rows:[]});
  if(hash(doc.response.lines.map(l=>l.original))!==hash(spec.lines)||doc.response.song.language!==spec.language) fail('source_bytes_changed');
  const resolved=selectionV2(doc,{studyText:selection.studyText,selection:{offsetUnit:'grapheme',ranges:[{lower:selection.lower,upper:selection.upper}],textHash:digest(selection.text)}});
  if(resolved.text!==selection.text) fail('authored_range_changed');
  const bindings=doc.structure.occurrences.map((o,index)=>({corpusSourceID:`L${String(index+1).padStart(4,'0')}`,wireSourceID:o.sourceID,order:index,
   sourceUtf8SHA256:hash(o.sourceText),lyricUtf8SHA256:hash(o.lyricText),sourceText:o.sourceText,lyricText:o.lyricText}));
  const occurrence=doc.structure.occurrences.find(o=>o.sourceID===selection.sourceID),at=occurrence.sourceText.indexOf(selection.text);
  if(at<0||at!==occurrence.sourceText.lastIndexOf(selection.text)) fail('ambiguous_v1_selection');
  const lower=segments(occurrence.sourceText.slice(0,at)).length;
  const rawSelection=selectionFor(doc,{sourceID:selection.sourceID,lower:String(lower),upper:String(lower+segments(selection.text).length)});
  const source={id:spec.id,tag:spec.language,familyTag:entry.family,role:entry.role,spec,specHash:hash(spec),origin:{ref:authored.backend,path:entry.path,pointer:entry.pointer,fileSHA256:entry.sourceFileSHA256},
   doc,selection,v1Selection:rawSelection,bindings};
  source.definitionHash=hash(source);sources.push(source);
  const admitted=entry.role==='primary'?TARGETS.filter(t=>{try{requireDirection(policy,'translation',spec.language,t);return true;}catch{return false;}}):['en'];
  const originals=entry.role==='primary'?TARGETS.filter(t=>{try{requireDirection(policy,'explanation',spec.language,t);return true;}catch{return false;}}):['en'];
  const add=job=>jobs.push(defineJob(source,{source:spec.id,tag:spec.language,...job}));
  for(const target of admitted) add({id:idFor(spec.id,'translation',target),kind:'translation',target,recipe:translationRecipe(target),...freezeBody(requestBody(doc,target))});
  for(const target of originals) add({id:idFor(spec.id,'original-v2',target),kind:'original',studyVersion:2,target,recipe:explanationRecipe(selection,target),...freezeBody(explanationBody(doc,null,selection,target))});
  for(const target of admitted) for(const explanation of entry.role==='primary'?TARGETS:['en']) {
   requireDirection(policy,'explanation',target,explanation);
   add({id:idFor(spec.id,'translated-v2',target,explanation),kind:'translated',studyVersion:2,target,explanation,
    recipe:explanationRecipe({studyText:{layer:'translation'}},explanation),dependency:idFor(spec.id,'translation',target),
    intent:{sourceID:selection.sourceID,strategy:'whole-occurrence-max80'},body:null,bodyJSON:null,bodyHash:null,reservedMicros:5048});
  }
  if(entry.role==='primary') add({id:idFor(spec.id,'original-v1','en'),kind:'original',studyVersion:1,target:'en',
   recipe:explanationRecipe(rawSelection,'en'),selection:rawSelection,dependency:idFor(spec.id,'translation','en'),
   intent:{sourceID:selection.sourceID,strategy:'original-raw-selection-with-whole-parent-occurrence-max80'},body:null,bodyJSON:null,bodyHash:null,reservedMicros:5048});
 }
 if(sources.length!==7||jobs.length!==113||new Set(jobs.map(j=>j.id)).size!==113||jobs.filter(j=>j.body).length!==38) fail('baseline_schedule_changed');
 return {schema:SCHEMA,mode:BASELINE_MODE,sourceProfile:BASELINE_MODE,codeHashes:await codeHashes(),retrievalPolicy:BATCH_RETRIEVAL,
  authoredSHA256:AUTHORED_SHA256,checkedInPolicySHA256:POLICY_SHA256,policyProvenance:'checked-in only; live deployment not verified',
  sources,jobs,seedIDs:[],confirmationNames:names,confirmationReserveMicros:60*19384,
  namedExtraCanarySlots:0,ceilingMicros:20000000,maxReservedMicros:jobs.reduce((n,j)=>n+j.reservedMicros,0),
  reservationCeilingMicros:842808,review:'unreviewed; no product/private-context or semantic qualification'};
}
export async function validateBaseline(plan,approvedHash) {
 if(hash(plan)!==approvedHash) fail('plan_changed');
 if(hash(await prepareBaseline())!==approvedHash) fail('baseline_schedule_or_builder_changed');
}
export function bindBaseline(plan,job,result) {
 const parent=plan.jobs.find(j=>j.id===job.dependency),source=plan.sources.find(s=>s.id===job.source);
 if(!parent||parent.kind!=='translation'||parent.source!==job.source||parent.body===null||!result?.valid||result.id!==parent.id||result.transport!=='standard'||
  !integer(result.actualMicros)||result.actualMicros>parent.reservedMicros||
  hash(result)!==hash(responseResult(plan,parent,result.response,'standard'))) fail('exact_actual_new_parent_required');
 const translation={id:hash({bodyHash:result.bodyHash,content:result.content}),target:parent.target,...result.content};
 const row=translation.lines.find(l=>l.sourceID===job.intent.sourceID)?.lyricText;
 const length=wholeOccurrenceLength(row); // Applies to all 75 dependent bodies, including v1.
 const selection=job.studyVersion===1?source.v1Selection:selectionV2(source.doc,{studyText:{layer:'translation',revisionID:translation.id,occurrenceID:job.intent.sourceID,target:parent.target},
  selection:{offsetUnit:'grapheme',ranges:[{lower:0,upper:length}],textHash:digest(row)}},translation);
 const frozen=freezeBody(explanationBody(source.doc,translation,selection,job.explanation??job.target));
 if(frozen.reservedMicros>job.reservedMicros) fail('dependent_reservation_exceeded');
 return {...job,...frozen,translation,selection,dependencyResultHash:hash(result)};
}
export function baselineShard(plan,caseIDs,results={},transport='standard') {
 if(transport!=='standard') fail('baseline_standard_only_no_batch_qualification');
 if(!Array.isArray(caseIDs)||!caseIDs.length||caseIDs.length>4||new Set(caseIDs).size!==caseIDs.length) fail('invalid_shard');
 const jobs=caseIDs.map(id=>{
  const job=plan.jobs.find(j=>j.id===id);
  if(!job) fail('unknown_baseline_case'); // Cannot create a named confirmation here.
  return job.dependency?bindBaseline(plan,job,results[job.dependency]):job;
 });
 return {schema:SCHEMA,planHash:hash(plan),transport,jobs,maxRawBytes:1048576,standardDeadlineSeconds:4*270+300,maxBuildSeconds:45*60};
}
