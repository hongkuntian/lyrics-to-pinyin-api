import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {packagedLexicons} from './lexicon-runtime.js';
import {sourceSpans,exactSourceSelection} from './source-spans.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const thaiCandidateEngineVersion='lyrica-th-kaikki-ipa-beta-1';
export const hindiLatinCandidateEngineVersion='dakshina-1.0-lyrica-source-bound-deva-1';
const unique=xs=>[...new Set(xs)].sort();
const failure=(source,language,span,engineVersion,reason)=>({language,source,engineVersion,selection:span,reading:null,canonicalReading:null,canonicalAdmission:'unavailable',readingStatus:'unavailable',readingBasis:'none',speechStatus:'unavailable',reason,candidates:[],publicationStatus:'unpublished'});
const thai=/^[\p{Script=Thai}]+$/u;
// Dictionary attestation never qualifies the source range. Input has no confirmation flag.
export async function analyzeThaiSelection(text,selection,{lexicons=packagedLexicons}={}){
  const span=exactSourceSelection(text,selection),out=failure(text,'th',span,thaiCandidateEngineVersion,'not-in-pinned-dictionary');
  out.requiresExplicitBoundary=true;out.originalSpeechProposal=thai.test(span.source)?{text:span.source,script:'Thai',locale:'th-TH',basis:'original-script',requiresIndependentAdmission:true}:null;
  if(!thai.test(span.source)){out.reason='unsupported-exact-thai-source';return out;}
  let entries,qualification;try{[entries,qualification]=await Promise.all([lexicons.lookup('thai',span.source),lexicons.thaiQualification()]);}catch{out.reason='data-unavailable-or-corrupt';return out;}
  const variants=unique(entries.map(e=>e.rawIPA));
  const q=qualification.rows?.find(r=>r.source===span.source),matched=qualification.sourceInputSHA256===entries[0]?.inputSHA256&&q&&isDeepStrictEqual(q.rawVariants,variants)&&isDeepStrictEqual(q.entryRefs,entries.filter(e=>e.rawIPA===q.rawIPA).map(e=>e.id).sort());
  out.qualification={matched:Boolean(matched),basis:matched?'model-assisted-lexicon':null,automaticUseQualified:false,publicationStatus:'unpublished',boundaryQualified:false};
  out.candidates=variants.map(value=>({id:hash(['thai-ipa-candidate-1',span.source,value,entries.filter(e=>e.rawIPA===value).map(e=>e.id).sort()]),value,rawIPA:value,readingScript:'Latn',basis:'unreviewed-candidate',reviewStatus:matched?'dual-model-intersection-proposal':'unreviewed-candidate',requiresExplicitChoice:true,entryRefs:entries.filter(e=>e.rawIPA===value).map(e=>e.id),entries:entries.filter(e=>e.rawIPA===value)}));
  if(entries.length){out.readingStatus=variants.length>1?'ambiguous':'candidate';out.readingBasis='unreviewed-candidate';out.reason=variants.length>1?'dictionary-variants-require-choice':matched?'publication-and-boundary-admission-required':'unreviewed-dictionary-candidate';}
  return out;
}
const latin=/^\p{Script=Latin}[\p{Script=Latin}\p{M}'’ -]*$/u;
export const validHindiNativeScript=text=>typeof text==='string'&&text===text.normalize('NFC')&&text.length>0&&Buffer.byteLength(text)<=2048&&/\p{Script=Devanagari}/u.test(text)&&/^[\p{Script_Extensions=Devanagari}\p{Zs}\u200c\u200d।॥]+$/u.test(text);
export async function analyzeHindiLatinSelection(text,selection,{lexicons=packagedLexicons}={}){
  const span=exactSourceSelection(text,selection),out=failure(text,'hi-Latn',span,hindiLatinCandidateEngineVersion,'not-in-pinned-aliases');out.requiresExplicitNativeScriptConfirmation=true;out.manualNativeScriptAllowed=true;
  if(!latin.test(span.source)){out.reason='unsupported-latin-hindi-source';return out;}
  let entries;try{entries=await lexicons.lookup('hindi',span.source.normalize('NFC').toLowerCase());}catch{out.reason='data-unavailable-or-corrupt';return out;}
  out.candidates=unique(entries.map(e=>e.value)).map(value=>({id:hash(['hindi-native-script-candidate-1',span.source,value,entries.filter(e=>e.value===value).map(e=>e.id).sort()]),value,spokenScript:'Deva',locale:'hi-IN',basis:'unreviewed-candidate',requiresExplicitNativeScriptConfirmation:true,entryRefs:entries.filter(e=>e.value===value).map(e=>e.id),entries:entries.filter(e=>e.value===value)}));
  if(entries.length){out.readingStatus=out.candidates.length>1?'ambiguous':'candidate';out.readingBasis='unreviewed-candidate';out.reason='explicit-native-script-confirmation-required';}
  return out;
}
// Syntax-only manual draft. Root binds, confirms and persists it privately; this grants no speech authority.
export function hindiNativeScriptDraft(text,selection,nativeText){
  const span=exactSourceSelection(text,selection);if(!latin.test(span.source)||!validHindiNativeScript(nativeText))throw new TypeError('Exact Latin source and native Devanagari draft required');
  return {selection:span,nativeText,spokenScript:'Deva',locale:'hi-IN',requiresExplicitNativeScriptConfirmation:true,authority:'none'};
}
