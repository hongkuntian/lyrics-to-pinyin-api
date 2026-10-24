import {createHash} from 'node:crypto';

// This is a spelling aid. It supplies neither stress nor phonetic/speech authority.
const mapping=Object.freeze({
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',
  к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
  х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'ʺ',ы:'y',ь:'ʹ',э:'e',ю:'yu',я:'ya'
});
export const russianWrittenNotation=Object.freeze({
  id:'lyrica-written-1',label:'Russian · Written Latin',version:1,
  mapping,
  caseRule:'Uppercase Cyrillic runs use uppercase expansions. Otherwise uppercase letters title-case their expansion.',
  normalization:'NFC lookup and display only; original source bytes and grapheme ranges are retained.',
  limitations:Object.freeze([
    'Spelling guide: stress, vowel reduction, palatalization and other sound changes are not supplied.',
    'е/э and й/ы share Latin spellings. Signs ʹ/ʺ preserve ь/ъ; ё is never inferred from е.',
    'Foreign or unsupported Cyrillic runs remain unresolved. This aid does not establish source language.'
  ])
});
export const russianWrittenNotationRevision=createHash('sha256')
  .update(JSON.stringify(russianWrittenNotation)).digest('hex');
export const russianWrittenEngineVersion='lyrica-ru-written-1';

const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const graphemes=text=>Array.from(segmenter.segment(text),part=>part.segment);
const cyrillic=character=>/\p{Script=Cyrillic}/u.test(character);
const marks=/\p{Mark}/u;
const supported=word=>[...word.normalize('NFC')].every(character=>
  marks.test(character)||Object.hasOwn(mapping,character.toLowerCase()));

function transform(word){
  const characters=[...word.normalize('NFC')];
  const letters=characters.filter(character=>/\p{Letter}/u.test(character));
  const uppercase=letters.length>0&&letters.every(character=>character===character.toUpperCase());
  return characters.map(character=>{
    const value=mapping[character.toLowerCase()];
    if(value===undefined)return character;
    if(uppercase)return value.toUpperCase();
    return character===character.toUpperCase()?value[0].toUpperCase()+value.slice(1):value;
  }).join('').normalize('NFC');
}

// Segments always cover the original text exactly, in original EGC coordinates.
// The caller must separately admit the effective language/range for this profile.
export function analyzeRussianWritten(text){
  if(typeof text!=='string')throw new TypeError('Russian written source must be a string');
  const chars=graphemes(text),segments=[];
  for(let lower=0;lower<chars.length;){
    const active=cyrillic(chars[lower]);let upper=lower+1;
    while(upper<chars.length&&cyrillic(chars[upper])===active)upper++;
    const source=chars.slice(lower,upper).join('');
    const resolved=active&&supported(source);
    segments.push({lower,upper,source,reading:null,aid:resolved?transform(source):null,
      status:resolved?'resolved':active?'unresolved':'verbatim',
      readingBasis:resolved?'orthographic':'none'});
    lower=upper;
  }
  return {language:'ru',segments};
}

export function russianWritten(text){
  return analyzeRussianWritten(text).segments.map(segment=>segment.aid??segment.source).join('');
}
