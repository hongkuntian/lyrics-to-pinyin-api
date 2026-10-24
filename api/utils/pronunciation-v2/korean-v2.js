import {sourceSpans} from './source-spans.js';
export const koreanEngineVersion='koroman-1.0.16-lyrica-ko-v2-1';
export const koreanSpeechSemanticsVersion='original-hangul-1';
// RR is a display aid. Canonical spelling and speaking text remain original NFC Hangul.
export async function analyzeKoreanV2(text){
  const view=sourceSpans(text),segments=[];let romanize;
  const active=c=>/^\p{Script=Hangul}+$/u.test(c);
  for(let lower=0;lower<view.chars.length;){
    let upper=lower+1;while(upper<view.chars.length&&active(view.chars[upper])===active(view.chars[lower]))upper++;
    const span=view.span(lower,upper),s={...span,reading:null,romanized:null,status:'verbatim',canonicalStatus:'verbatim',canonicalAdmission:'unavailable',readingBasis:'none',speechStatus:'unavailable',speechSemanticsVersion:koreanSpeechSemanticsVersion,reason:'non-hangul-or-gap',alternatives:[],speakingAlternatives:[]};
    if(active(view.chars[lower])){
      const original=span.source.normalize('NFC');
      // Isolated/archaic jamo cannot be advertised as ordinary Hangul text speech.
      if(/^[가-힣]+$/u.test(original)){
        romanize??=(await import('koroman')).romanize;const rr=romanize(original,{usePronunciationRules:true,useHyphen:false});
        Object.assign(s,{reading:original,status:'resolved',canonicalStatus:'resolved',canonicalAdmission:'available',readingBasis:'original-spelling',speechStatus:'available',spokenText:original,spokenScript:'Hang',spokenBasis:'original-script',reason:'original-hangul'});
        if(typeof rr==='string'&&!/[\p{Script=Hangul}\p{Script=Han}]/u.test(rr))s.romanized=rr;
      }else Object.assign(s,{status:'unresolved',canonicalStatus:'unresolved',reason:'unsupported-jamo'});
    }
    segments.push(s);lower=upper;
  }
  return {language:'ko',source:text,engineVersion:koreanEngineVersion,speechSemanticsVersion:koreanSpeechSemanticsVersion,segments};
}
