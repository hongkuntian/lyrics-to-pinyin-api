// Offline compiler. No provider calls or account admission here.
import {digest} from '../song-library/store.js';
import {canonicalJSON} from '../song-library/spotify-recording.js';
import {TARGETS,requireDirection} from '../song-library/languages.js';
import {requestBody,reservationMicros,translationRecipe} from '../song-library/translation.js';
import {selectionV2,explanationRecipe,explanationBody} from '../song-library/study-explanation.js';
import {lineSelections,lineBody,LINE_RECIPE,publicLine} from '../song-library/study-line.js';
import {publicExplanation} from '../song-library/study-store.js';
import {publicDocument,publicTranslation} from '../song-library/public-content.js';
import {artifact,editionIdentity,fail,exact} from './core.js';
export const stableUUID=value=>{const h=digest(canonicalJSON(value));return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export function translationTasks(doc,policy){
 return Object.keys(TARGETS).filter(target=>doc.response.song.language!==target).map(target=>{
  requireDirection(policy,'translation',doc.response.song.language,target);
  const body=requestBody(doc,target);return {id:digest({documentID:doc.id,sourceHash:doc.sourceHash,target,body}),kind:'translation',target,body,reservationMicros:reservationMicros(body)};
 });
}
export function acceptedTranslations(doc,results){
 return Object.fromEntries(Object.keys(TARGETS).map(target=>{
  const same=doc.response.song.language===target,result=results.find(r=>r.target===target);
  if(!same&&!result?.content)fail('translation_incomplete',422);
  const content=same?{lines:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:o.lyricText,text:o.lyricText,speakerID:o.speakerID,startsTurn:o.startsTurn})),sourceNotes:[]}:result.content;
  const value={...content,id:stableUUID({documentID:doc.id,target,content,recipe:translationRecipe(target)}),documentID:doc.id,sourceHash:doc.sourceHash,target,recipe:translationRecipe(target),notesLanguage:target,...(same?{identity:true}:{})};
  return [target,value];
 }));
}
const graphemes=text=>Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text),s=>s.segment);
const selection=(text,lower,upper)=>({offsetUnit:'grapheme',ranges:[{lower,upper}],textHash:digest(graphemes(text).slice(lower,upper).join(''))});
export function provisionalRows(doc,translations){
 // Provisional cost planning only. Native parity is independently required for publication.
 const rows=[];
 for(const layer of ['original',...Object.keys(TARGETS)])for(const o of doc.structure.occurrences){
  const translated=layer!=='original',t=translations[layer],text=translated?t.lines.find(l=>l.sourceID===o.sourceID)?.lyricText:o.lyricText;
  if(typeof text!=='string')fail('translation_incomplete',422);
  const chars=graphemes(text),utf16ToGrapheme=new Map();let cursor=0;
  chars.forEach((c,i)=>{utf16ToGrapheme.set(cursor,i);cursor+=c.length;});utf16ToGrapheme.set(cursor,chars.length);
  const words=[];
  for(const segment of new Intl.Segmenter('und',{granularity:'word'}).segment(text))if(segment.isWordLike){const lower=utf16ToGrapheme.get(segment.index),upper=utf16ToGrapheme.get(segment.index+segment.segment.length);if(upper-lower<=80)words.push(selection(text,lower,upper));}
  rows.push({studyText:{layer:translated?'translation':'original',revisionID:translated?t.id:doc.id,occurrenceID:o.sourceID,...(translated?{target:layer}:{})},words,
   characters:chars.flatMap((c,i)=>/\p{Script=Han}/u.test(c)?[selection(text,i,i+1)]:[]),wholeLine:chars.length<=80&&/[\p{L}\p{N}]/u.test(text)?selection(text,0,chars.length):null});
 }
 return rows;
}
export function inspectorManifest(doc,translations,rows=provisionalRows(doc,translations)){
 if(rows&& !Array.isArray(rows)&&Array.isArray(rows.requests))return validateInspectorManifest(doc,translations,rows);
 const expected=provisionalRows(doc,translations).map(r=>canonicalJSON(r.studyText)).sort();
 if(!Array.isArray(rows)||canonicalJSON(rows.map(r=>canonicalJSON(r.studyText)).sort())!==canonicalJSON(expected))fail('inspector_rows_incomplete',422);
 const requests=Object.values(translations).map(t=>({kind:'translation',selector:{target:t.target,revisionID:t.id}}));
 const seen=new Set(requests.map(canonicalJSON));
 const add=q=>{const key=canonicalJSON(q);if(!seen.has(key)){seen.add(key);requests.push(q);}};
 for(const row of rows){
  const t=row.studyText.layer==='translation'?translations[row.studyText.target]:null;
  if(!Array.isArray(row.words)||!Array.isArray(row.characters)||row.words.length>2000||row.characters.length>2000)fail('invalid_inspector_rows',422);
  // Every offered original/translated selection gets exactly five explanation contexts.
  for(const language of Object.keys(TARGETS)){
   for(let i=0;i<row.words.length;i+=32){
    const manifest=row.words.slice(i,i+32).map(s=>({id:`w${s.ranges[0].lower}-${s.ranges[0].upper}`,selection:s}));
    const selector={contractVersion:1,recipe:LINE_RECIPE,studyText:row.studyText,explanationLanguage:language,manifest};lineSelections(doc,selector,t);add({kind:'batch',selector});
   }
   for(const s of [...row.characters,...(row.wholeLine?[row.wholeLine]:[])]){
    const selected=selectionV2(doc,{studyText:row.studyText,selection:s},t);
    add({kind:'explanation',selector:{contractVersion:2,recipe:explanationRecipe(selected,language),studyText:row.studyText,explanationLanguage:language,selection:s}});
   }
  }
 }
 return {version:1,documentID:doc.id,sourceHash:doc.sourceHash,rows,requests};
}
export function validateInspectorManifest(doc,translations,m){
 if(!m||m.version!==1||m.documentID!==doc.id||m.sourceHash!==doc.sourceHash||!Array.isArray(m.requests)||!m.requests.length||m.requests.length>20000)fail('manifest_changed',422);
 const seen=new Set(),contexts=new Map(),translationTargets=new Set();
 for(const q of m.requests){
  if(!exact(q,['kind','selector']))fail('invalid_manifest',422);
  const key=canonicalJSON(q);if(seen.has(key))fail('invalid_manifest',422);seen.add(key);const s=q.selector;
  if(q.kind==='translation'){
   if(!exact(s,['target','revisionID'])||!translations[s.target]||s.revisionID!==translations[s.target].id||translationTargets.has(s.target))fail('translation_incomplete',422);translationTargets.add(s.target);continue;
  }
  if(!['batch','explanation'].includes(q.kind)||!Object.hasOwn(TARGETS,s.explanationLanguage)||!exact(s,q.kind==='batch'?['contractVersion','recipe','studyText','explanationLanguage','manifest']:['contractVersion','recipe','studyText','explanationLanguage','selection']))fail('invalid_manifest',422);
  const t=s.studyText?.layer==='translation'?translations[s.studyText.target]:null;
  const selected=q.kind==='batch'?lineSelections(doc,s,t):selectionV2(doc,s,t);
  if(s.contractVersion!==(q.kind==='batch'?1:2)||s.recipe!==(q.kind==='batch'?LINE_RECIPE:explanationRecipe(selected,s.explanationLanguage)))fail('invalid_manifest',422);
  const {explanationLanguage,recipe,...base}=s,b=canonicalJSON({kind:q.kind,selector:base});if(!contexts.has(b))contexts.set(b,new Set());contexts.get(b).add(explanationLanguage);
 }
 if(translationTargets.size!==Object.keys(TARGETS).length||contexts.size===0||[...contexts.values()].some(c=>c.size!==Object.keys(TARGETS).length))fail('inspector_contexts_incomplete',422);
 for(const o of doc.structure.occurrences)if(/[\p{L}\p{N}]/u.test(o.lyricText)&&!m.requests.some(q=>q.kind==='batch'&&q.selector.studyText.layer==='original'&&q.selector.studyText.occurrenceID===o.sourceID))fail('inspector_rows_incomplete',422);
 if(m.rows&&canonicalJSON(inspectorManifest(doc,translations,m.rows))!==canonicalJSON(m))fail('manifest_changed',422);
 return m;
}
export function studyTasks(doc,translations,manifest,policy){
 validateInspectorManifest(doc,translations,manifest);
 return manifest.requests.filter(q=>q.kind!=='translation').map(q=>{
  const s=q.selector,t=s.studyText.layer==='translation'?translations[s.studyText.target]:null;
  requireDirection(policy,'explanation',t?.target??doc.response.song.language,s.explanationLanguage);
  const selected=q.kind==='batch'?lineSelections(doc,s,t):selectionV2(doc,s,t);
  const body=q.kind==='batch'?lineBody(doc,t,selected,{language:s.explanationLanguage}):explanationBody(doc,t,selected,s.explanationLanguage);
  return {id:digest({documentID:doc.id,sourceHash:doc.sourceHash,...q,body}),...q,body,reservationMicros:reservationMicros(body)};
 });
}
export function studyArtifact(doc,translations,task,result){
 const s=task.selector,t=s.studyText.layer==='translation'?translations[s.studyText.target]:null,id=stableUUID({taskID:task.id,content:result.content});
 const value=task.kind==='batch'?publicLine({id,explanation_language:s.explanationLanguage,content:result.content},doc,t,lineSelections(doc,s,t)):
  publicExplanation({id,document_id:doc.id,revision_id:t?.id??null,source_id:s.studyText.occurrenceID,lower_offset:s.selection.ranges[0].lower,upper_offset:s.selection.ranges[0].upper,
   recipe:s.recipe,content:result.content,contract_version:2,explanation_language:s.explanationLanguage,study_text:s.studyText,selection_text_hash:s.selection.textHash});
 return artifact(task.kind,value,s);
}
export function assembleBundle({doc,translations,manifest,studyArtifacts,spec}){
 const m=artifact('manifest',manifest),artifacts=[artifact('document',publicDocument(doc)),...Object.values(translations).map(t=>artifact('translation',publicTranslation(t,doc),{target:t.target,revisionID:t.id})),m,...studyArtifacts];
 const b={version:1,songID:spec.songID,display:spec.display,documentVariant:spec.documentVariant,documentID:doc.id,sourceHash:doc.sourceHash,
  variants:spec.variants,uses:spec.uses,rights:spec.rights,recordingEvidence:spec.recordingEvidence,
  coverage:{complete:true,targets:Object.keys(TARGETS),nativeManifestHash:m.id,parityReference:spec.parityReference,requiredArtifactIDs:artifacts.map(a=>a.id)},artifacts};
 return {...b,editionID:editionIdentity(b)};
}
