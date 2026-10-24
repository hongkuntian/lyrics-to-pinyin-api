import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const vendorSHA256='6dca053574abfb840823a2b014341468b7e247416d0e7754b6a49f76d24d0def';
export const hindiWrittenEngineVersion='sanscript-1.3.3-lyrica-deva-written-1';
export const hindiWrittenNotation=Object.freeze({
  id:'lyrica-hi-iast-written-1',version:1,label:'Hindi · Written Latin (IAST-based)',
  vendorVersion:'1.3.3',vendorSHA256,
  inherentVowels:'Retain written inherent a; no modern-Hindi schwa deletion.',
  nasalization:'Anusvara ṃ; chandrabindu ~. These preserve spelling, not a phonetic realization.',
  nukta:'q, f, z, ġ, r̤, r̤h; vocalic-r spelling ṛ stays distinct.',
  normalization:'NFC disposable lookup with U+0958–U+095F nukta composition; original source/ranges unchanged.',
  limitations:Object.freeze([
    'Written spelling conversion, not modern Hindi pronunciation or a recorded-performance reading.',
    'No inverse transliteration of Latin lyrics and no automatically derived speaking text.',
    'Residual Devanagari or unsupported format controls keep the display aid unresolved.'
  ])
});
export const hindiWrittenNotationRevision=createHash('sha256')
  .update(JSON.stringify(hindiWrittenNotation)).digest('hex');
let engine;

function writtenEngine(){
  if(engine)return engine;
  // The byte-pinned distributed runtime has its schemes bundled, without runtime imports.
  // Keep it lazy: unrelated profiles need not parse the 188,729-byte third-party source.
  const sanscript=require('./vendor/sanscript-1.3.3/sanscript.cjs');
  const scheme=structuredClone(sanscript.schemes.devanagari),compositions=[];
  for(let code=0x958;code<=0x95f;code++){
    const composed=String.fromCodePoint(code),decomposed=composed.normalize('NFD');
    const key=Object.keys(scheme.extra_consonants).find(key=>
      scheme.extra_consonants[key].normalize('NFD')===decomposed);
    if(key===undefined)throw new Error('Pinned Sanscript nukta scheme mismatch');
    scheme.extra_consonants[key]=composed;compositions.push([decomposed,composed]);
  }
  sanscript.addBrahmicScheme('lyrica_devanagari_written_1',scheme);
  engine={sanscript,compositions};return engine;
}

function transform(source){
  // Reject unsupported joining controls rather than silently deleting or interpreting them.
  if(/\p{Cf}/u.test(source))return null;
  const {sanscript,compositions}=writtenEngine();
  let lookup=source.normalize('NFC');
  for(const [decomposed,composed] of compositions)lookup=lookup.replaceAll(decomposed,composed);
  const aid=sanscript.t(lookup,'lyrica_devanagari_written_1','iast').normalize('NFC');
  return /[\p{Script=Devanagari}\p{Cf}]/u.test(aid)?null:aid;
}

const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
export function analyzeHindiWritten(text){
  if(typeof text!=='string')throw new TypeError('Hindi written source must be a string');
  const chars=Array.from(segmenter.segment(text),part=>part.segment),segments=[];
  const active=character=>/\p{Script=Devanagari}/u.test(character);
  for(let lower=0;lower<chars.length;){
    const native=active(chars[lower]);let upper=lower+1;
    while(upper<chars.length&&active(chars[upper])===native)upper++;
    const source=chars.slice(lower,upper).join(''),aid=native?transform(source):null;
    segments.push({lower,upper,source,reading:null,aid,
      status:!native?'verbatim':aid===null?'unresolved':'resolved',
      readingBasis:aid===null?'none':'orthographic'});
    lower=upper;
  }
  return {language:'hi',segments};
}

export function hindiWritten(text){
  return analyzeHindiWritten(text).segments.map(segment=>segment.aid??segment.source).join('');
}
