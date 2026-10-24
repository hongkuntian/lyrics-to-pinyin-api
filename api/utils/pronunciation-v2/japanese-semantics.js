import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {sourceSpans,exactSourceSelection} from './source-spans.js';
import {pronunciationEngineProfileV2For} from './engine-profiles.js';
const need=(ok,message)=>{if(!ok)throw new TypeError(message);};
const HEX=/^[a-f0-9]{64}$/;
export const kana=x=>typeof x==='string'&&x===x.normalize('NFC')&&x.length>0&&Array.from(new Intl.Segmenter('ja',{granularity:'grapheme'}).segment(x)).length<=500&&/^[\p{Script=Hiragana}ー]+$/u.test(x)&&!x.startsWith('ー');
export function canonicalJSON(x){
 if(x===null||typeof x==='string'||typeof x==='boolean')return JSON.stringify(x);
 if(typeof x==='number'){need(Number.isSafeInteger(x),'canonical-integer');return JSON.stringify(x);}
 if(Array.isArray(x))return '['+x.map(canonicalJSON).join(',')+']';
 need(x&&Object.getPrototypeOf(x)===Object.prototype,'canonical-plain-object');
 return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonicalJSON(x[k])).join(',')+'}';
}
export const bytesHash=x=>createHash('sha256').update(x).digest('hex');
export const hash=x=>bytesHash(canonicalJSON(x));
const cmp=(a,b)=>a<b?-1:a>b?1:0;
const trusted=new WeakMap();
// Call ONLY with independently reconstructed server/native source and exact expected profile.
// The opaque local handle cannot be reconstructed from a wire envelope and confers no access/confirmation authority.
export function createJapaneseSemanticBinding(independentSource,independentExpectedProfile){
 const source=structuredClone(independentSource),profile=structuredClone(independentExpectedProfile);
 need(profile?.sourceLanguage==='ja'&&isDeepStrictEqual(profile,pronunciationEngineProfileV2For(profile.id)),'exact-allowlisted-ja-descriptor');
 for(const key of ['documentID','sourceHash','textRevision','contextRevision'])need(typeof source?.[key]==='string'&&HEX.test(source[key]),'independent-source-binding-'+key);
 need(Array.isArray(source.occurrences)&&source.occurrences.length>0&&source.occurrences.length<=250,'independent-occurrences');
 const order=new Map();for(const [i,o]of source.occurrences.entries()){need(typeof o.sourceID==='string'&&o.sourceID.length>0&&!order.has(o.sourceID),'independent-occurrence-id');sourceSpans(o.lyricText);order.set(o.sourceID,i);}
 need(Array.isArray(source.resolvedRanges),'independent-resolved-ranges');let previous=[-1,-1];
 for(const r of source.resolvedRanges){const i=order.get(r.sourceID),o=source.occurrences[i];need(o&&typeof r.language==='string','independent-range-language');sourceSpans(o.lyricText).span(r.lower,r.upper);need(i>previous[0]||i===previous[0]&&r.lower>=previous[1],'independent-range-order');previous=[i,r.upper];}
 const handle=Object.freeze({});trusted.set(handle,{source,profile});return handle;
}
const get=b=>{need(trusted.has(b),'independently-trusted-semantic-binding-required');return trusted.get(b);};
const sourceIdentity=b=>{const {source}=get(b);return {documentID:source.documentID,sourceHash:source.sourceHash,textRevision:source.textRevision,contextRevision:source.contextRevision,sourceLanguage:'ja',canonicalReadingKind:'ja-lexical-kana'};};
const lexicalIdentity=b=>{const {profile}=get(b);return {...sourceIdentity(b),engineVersion:profile.engineVersion,dataRevision:profile.dataRevision};};
export const semanticIdentity=b=>({...lexicalIdentity(b),speechSemanticsVersion:get(b).profile.speechSemanticsVersion});
function exact(b,sourceID,s,requireJA=true){const {source}=get(b),o=source.occurrences.find(o=>o.sourceID===sourceID);need(o,'independent-original-occurrence');exactSourceSelection(o.lyricText,s,65536);if(requireJA)need(source.resolvedRanges.some(r=>r.sourceID===sourceID&&r.language==='ja'&&s.lower>=r.lower&&s.upper<=r.upper),'independent-ja-range');}
export function lexicalID(b,sourceID,s,reading){exact(b,sourceID,s);need(kana(reading),'candidate-lexical-kana');return hash(['ja-lexical-candidate-3',sourceIdentity(b),sourceID,s.lower,s.upper,s.source,reading.normalize('NFC')]);}
export const speakingID=(lexicalCandidateID,spokenText)=>{need(HEX.test(lexicalCandidateID)&&kana(spokenText),'candidate-speaking-kana');return hash(['ja-speaking-candidate-3',lexicalCandidateID,spokenText.normalize('NFC'),'Hira']);};
export function lexicalCandidate(b,sourceID,s,reading,attribution){return {lexicalID:lexicalID(b,sourceID,s,reading),reading,readingScript:'Hira',basis:'unreviewed-candidate',attribution:structuredClone(attribution)};}
export function speakingCandidate(lex,spokenText,attribution){return {speakingID:speakingID(lex.lexicalID,spokenText),lexicalID:lex.lexicalID,spokenText,spokenScript:'Hira',basis:'unreviewed-candidate',attribution:structuredClone(attribution)};}
export function unique(rows,idKey){const map=new Map();for(const row of rows){need(HEX.test(row[idKey]),'candidate-id');if(map.has(row[idKey]))need(isDeepStrictEqual(map.get(row[idKey]),row),'conflicting-candidate-id');else map.set(row[idKey],row);}return [...map.values()].sort((a,b)=>cmp(a[idKey],b[idKey]));}
const exactFields=(x,fields)=>need(Object.keys(x).length===fields.length&&fields.every(k=>Object.hasOwn(x,k)),'candidate-fields');
export function canonicalCandidates(b,sourceID,s){
 const lex=(s.alternatives??[]).map(a=>{exactFields(a,['lexicalID','reading','readingScript','basis','attribution']);need(a.lexicalID===lexicalID(b,sourceID,s,a.reading)&&a.readingScript==='Hira'&&a.basis==='unreviewed-candidate'&&a.attribution,'lexical-candidate-binding');return structuredClone(a);});
 const alternatives=unique(lex,'lexicalID'),ids=new Set(alternatives.map(a=>a.lexicalID));
 const speech=(s.speakingAlternatives??[]).map(a=>{exactFields(a,['speakingID','lexicalID','spokenText','spokenScript','basis','attribution']);need(ids.has(a.lexicalID)&&a.speakingID===speakingID(a.lexicalID,a.spokenText)&&a.spokenScript==='Hira'&&a.basis==='unreviewed-candidate'&&a.attribution,'speaking-candidate-binding');return structuredClone(a);});
 return {alternatives,speakingAlternatives:unique(speech,'speakingID')};
}
export function bindJapaneseCandidates(b,sourceID,s){
 exact(b,sourceID,s);const alternatives=(s.alternatives??[]).map(a=>lexicalCandidate(b,sourceID,s,a.reading,a.attribution));
 const speakingAlternatives=(s.speakingAlternatives??[]).map(a=>{const lex=alternatives.find(l=>l.reading===a.reading);need(lex,'paired-lexical-candidate-required');return speakingCandidate(lex,a.spokenText,a.attribution);});
 return canonicalCandidates(b,sourceID,{...s,alternatives,speakingAlternatives});
}
function exactLines(b,lines){const {source}=get(b);need(lines.length===source.occurrences.length,'all-original-rows');for(const [i,l]of lines.entries()){const o=source.occurrences[i];need(l.sourceID===o.sourceID&&Array.isArray(l.segments),'original-row-order');let cursor=0;for(const s of l.segments){exact(b,l.sourceID,s,false);need(s.lower===cursor,'complete-original-EGC-coverage');cursor=s.upper;if(!source.resolvedRanges.some(r=>r.sourceID===l.sourceID&&r.language==='ja'&&s.lower>=r.lower&&s.upper<=r.upper))need(s.reading===null&&(s.alternatives??[]).length===0&&(s.speakingAlternatives??[]).length===0&&s.speechStatus==='unavailable','unmatched-range-source-only');}need(cursor===sourceSpans(o.lyricText).chars.length,'complete-original-EGC-coverage');}}
export function readingObject(b,lines){exactLines(b,lines);return {namespace:'pronunciation-reading-ja-3',...lexicalIdentity(b),lines:lines.map(l=>({sourceID:l.sourceID,segments:l.segments.map(s=>({lower:s.lower,upper:s.upper,source:s.source,reading:s.reading,status:s.status,readingBasis:s.readingBasis,unknownHanBoundary:s.unknownHanBoundary,alternatives:canonicalCandidates(b,l.sourceID,s).alternatives}))}))};}
export function speechObject(b,lines,independentReadingRevision){exactLines(b,lines);need(independentReadingRevision===hash(readingObject(b,lines)),'independent-reading-revision');return {namespace:'pronunciation-speech-ja-3',readingRevision:independentReadingRevision,speechSemanticsVersion:get(b).profile.speechSemanticsVersion,speakingAlternativesVersion:'ja-speaking-alternatives-1',lines:lines.map(l=>({sourceID:l.sourceID,segments:l.segments.map(s=>({lower:s.lower,upper:s.upper,speechStatus:s.speechStatus,speechReason:s.speechReason,spokenText:s.spokenText??null,spokenScript:s.spokenScript??null,spokenBasis:s.spokenBasis??null,speakingAlternatives:canonicalCandidates(b,l.sourceID,s).speakingAlternatives}))}))};}
export const cacheObject=b=>({namespace:'pronunciation-envelope-ja-3',...semanticIdentity(b),profileID:get(b).profile.id,profileVersion:get(b).profile.version});
