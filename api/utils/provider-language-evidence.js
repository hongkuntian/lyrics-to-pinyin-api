import {createHash} from 'node:crypto';

export const PROVIDER_LANGUAGE_EVIDENCE_VERSION='provider-language-evidence-1';
const providers=new Set(['qq','kugou']);
const specific=Object.freeze({'日语':'ja','韩语':'ko','德语':'de','俄语':'ru','泰语':'th','印尼语':'id',
 '西班牙语':'es','葡萄牙语':'pt','意大利语':'it','越南语':'vi','英语':'en'});
const broad=new Set(['印度语','其他','小语种']);
const maxObservations=8,maxEvidenceBytes=4096;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const scalar=value=>value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)
 ||typeof value==='string'&&[...value].length<=256&&!/[\u0000-\u001f\u007f\p{Surrogate}]/u.test(value);
const canonical=value=>JSON.stringify(ordered(value));
function ordered(value){return Array.isArray(value)?value.map(ordered):object(value)
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;}
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const validSource=source=>object(source)&&Object.keys(source).length===2&&providers.has(source.provider)&&typeof source.id==='string'&&/^[1-9]\d{0,19}$/.test(source.id);
export function providerLanguageSource(provider,id){
 const value={provider:({QQMusicAPI:'qq',KugouAPI:'kugou'})[provider]??provider,id:String(id)};
 return validSource(value)?value:null;
}
const captured=(source,observations=[],unusable=false)=>({version:PROVIDER_LANGUAGE_EVIDENCE_VERSION,source,observations,unusable});
function observation(operation,field,namespace,raw,observedAt){
 return {operation,field,namespace,scope:'song',subject:'source_language',raw,observed_at:observedAt};
}

// Capture only fields from an already acquired, ID-checked song-detail reply.
// Numeric track enums and category IDs deliberately have separate namespaces.
export function qqLanguageObservations(id,data,{observedAt=new Date().toISOString()}={}) {
 const source=providerLanguageSource('qq',id),rows=[];
 if(!source||!object(data)||String(data.track_info?.id)!==source.id)return captured(source,[],true);
 if(Object.hasOwn(data.track_info,'language')) {
  if(!scalar(data.track_info.language))return captured(source,[],true);
  rows.push(observation('get_song_detail_yqq','/data/track_info/language','qq.track_info.language',data.track_info.language,observedAt));
 }
 const category=data.info?.lan;
 if(category?.title==='歌曲语种') {
  if(!Array.isArray(category.content)||category.content.length>maxObservations-rows.length)return captured(source,[],true);
  for(let i=0;i<category.content.length;i++) {
   const entry=category.content[i];
   if(!object(entry)||!Object.hasOwn(entry,'id')||!Object.hasOwn(entry,'value')||!scalar(entry.id)||!scalar(entry.value))return captured(source,[],true);
   rows.push(observation('get_song_detail_yqq',`/data/info/lan/content/${i}`,'qq.info.lan.category',{id:entry.id,value:entry.value},observedAt));
  }
 }
 return bounded(captured(source,rows));
}
export function kugouLanguageObservations(id,candidate,index,{observedAt=new Date().toISOString()}={}) {
 const source=providerLanguageSource('kugou',id);
 if(!source||!object(candidate)||String(candidate.id)!==source.id||!Number.isSafeInteger(index)||index<0||index>=100)return captured(source,[],true);
 if(!Object.hasOwn(candidate,'language'))return captured(source);
 if(!scalar(candidate.language))return captured(source,[],true);
 return bounded(captured(source,[observation('/search',`/candidates/${index}/language`,'kugou.search.language',candidate.language,observedAt)]));
}
function bounded(value){
 return value.observations.length>maxObservations||Buffer.byteLength(JSON.stringify(value))>maxEvidenceBytes
  ?captured(value.source,[],true):value;
}
export function mergeLanguageObservations(left,right){
 if(!left)return right;if(!right)return left;
 if(!validSource(left.source)||canonical(left.source)!==canonical(right.source))return captured(left.source,[],true);
 if(left.unusable||right.unusable)return captured(left.source,[],true);
 const rows=[...left.observations];
 for(const row of right.observations)if(!rows.some(previous=>canonical({...previous,observed_at:null})===canonical({...row,observed_at:null})))rows.push(row);
 return bounded(captured(left.source,rows));
}
export function bindProviderLanguageObservations(lyrics,song,evidence,{field,format,role='original_slot'}={}){
 if(!lyrics)return lyrics;
 const source=providerLanguageSource(song?.source,song?.id);
 if(!source)return lyrics;
 const record=evidence??captured(source);
 return {...lyrics,providerLanguageEvidence:{...record,body:{track_role:role,field,format}}};
}
function interpreted(row){
 if(row.namespace==='qq.track_info.language')return {...row,interpretation:'uninterpreted_enum',language:null};
 const label=row.namespace==='qq.info.lan.category'?row.raw.value:row.raw;
 const interpretation=label===''?'empty':typeof label==='string'&&Object.hasOwn(specific,label)?'specific':broad.has(label)?'broad':'unknown';
 return {...row,interpretation,language:interpretation==='specific'?specific[label]:null};
}
function validObservation(row){
 if(!object(row)||Object.keys(row).length!==7||!Object.keys(row).every(key=>['operation','field','namespace','scope','subject','raw','observed_at'].includes(key))
  ||row.scope!=='song'||row.subject!=='source_language'||typeof row.observed_at!=='string'
  ||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.observed_at)||!Number.isFinite(Date.parse(row.observed_at)))return false;
 if(row.namespace==='qq.track_info.language')return row.operation==='get_song_detail_yqq'&&row.field==='/data/track_info/language'&&scalar(row.raw);
 if(row.namespace==='qq.info.lan.category')return row.operation==='get_song_detail_yqq'&&/^\/data\/info\/lan\/content\/[0-7]$/u.test(row.field)
  &&object(row.raw)&&Object.keys(row.raw).length===2&&Object.hasOwn(row.raw,'id')&&Object.hasOwn(row.raw,'value')&&scalar(row.raw.id)&&scalar(row.raw.value);
 return row.namespace==='kugou.search.language'&&row.operation==='/search'&&/^\/candidates\/(?:[0-9]|[1-9][0-9])\/language$/u.test(row.field)&&scalar(row.raw);
}

// This is a fallible declaration beside the unchanged text estimate, never a
// processing override, confirmation, recording proof or pronunciation grant.
export function resolveProviderLanguageEvidence(lines,analysis,evidence,expectedSource){
 const source=validSource(expectedSource)?{...expectedSource}:{provider:'unknown',id:''};
 const role=evidence?.body?.track_role,field=evidence?.body?.field,format=evidence?.body?.format;
 const body={track_role:['original_slot','translated','phonetic','unknown'].includes(role)?role:'unknown',
  field:['/data/lyric','/content'].includes(field)?field:'unknown',format:['lrc','qrc','krc'].includes(format)?format:'unknown',
  text_sha256:digest(lines),scripts:[...analysis.scripts],script_method:'legacy-presence-v1'};
 let reason=null;
 if(!validSource(expectedSource)||!validSource(evidence?.source)||canonical(evidence.source)!==canonical(expectedSource))reason='source_binding_mismatch';
 else if(body.track_role!=='original_slot')reason='body_not_original_slot';
 else if(evidence.version!==PROVIDER_LANGUAGE_EVIDENCE_VERSION||evidence.unusable||!Array.isArray(evidence.observations)
  ||evidence.observations.length>maxObservations||Buffer.byteLength(JSON.stringify(evidence))>maxEvidenceBytes
  ||!evidence.observations.every(validObservation)
  ||evidence.observations.some(row=>!row.namespace.startsWith(source.provider+'.'))
  ||(source.provider==='qq'?(body.field!=='/data/lyric'||!['lrc','qrc'].includes(body.format))
    :(body.field!=='/content'||!['lrc','krc'].includes(body.format))))reason='invalid_optional_metadata';
 const observations=reason?[]:evidence.observations.map(interpreted).sort((a,b)=>{
  const left=canonical([a.operation,a.namespace,a.field,a.raw]),right=canonical([b.operation,b.namespace,b.field,b.raw]);return left<right?-1:left>right?1:0;
 });
 const languages=[...new Set(observations.filter(row=>row.interpretation==='specific').map(row=>row.language))];
 let decision;
 if(reason)decision={status:'unusable',candidate:null,reasons:[reason]};
 else if(!observations.length)decision={status:'absent',candidate:null,reasons:[]};
 else if(languages.length>1)decision={status:'declaration_conflict',candidate:null,reasons:['different_specific_labels']};
 else if(languages.length!==1||observations.some(row=>['broad','unknown'].includes(row.interpretation)))decision={status:'unspecific',candidate:null,reasons:['no_unique_specific_declaration']};
 else decision={status:analysis.primary==='und'?'declared_only':analysis.primary===languages[0]?'agreement':'disagreement',candidate:languages[0],reasons:[]};
 const semantic={version:PROVIDER_LANGUAGE_EVIDENCE_VERSION,source,body,observations:observations.map(({observed_at,...row})=>row),analysis,unusable:reason};
 const result={version:PROVIDER_LANGUAGE_EVIDENCE_VERSION,source,body,observations,decision,semantic_sha256:digest(semantic)};
 if(Buffer.byteLength(JSON.stringify(result))>maxEvidenceBytes){
  return {...result,observations:[],decision:{status:'unusable',candidate:null,reasons:['optional_metadata_size_limit']},
   semantic_sha256:digest({...semantic,observations:[],unusable:'optional_metadata_size_limit'})};
 }
 return result;
}
