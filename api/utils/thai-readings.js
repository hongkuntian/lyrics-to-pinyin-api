import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let lexicon;
// Wiktionary readings first; Lyrica's reviewed additions fill words it does not list.
const entries=()=>lexicon??={...require('../data/thai-readings-supplement.json').entries,...require('../data/thai-readings.json').entries};
const graphemes=text=>Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text),x=>x.segment);
const words=new Intl.Segmenter('th',{granularity:'word'});
// A segmenter word missing from the list is read from the fewest listed words
// that spell it exactly (กลับมา = กลับ + มา); otherwise it has no reading.
export function compose(word,dictionary=entries()){
  const chars=graphemes(word),best=Array(chars.length+1).fill(null);best[0]=[];
  for(let end=1;end<=chars.length;end++)for(let start=Math.max(0,end-20);start<end;start++){
    const piece=chars.slice(start,end).join(''),before=best[start];
    if(before&&dictionary[piece]&&(!best[end]||before.length+1<best[end].length))best[end]=[...before,dictionary[piece]];
  }
  return best[chars.length]?.join('-')??null;
}
/// Thai words with grapheme offsets and Wiktionary Paiboon readings. ๆ repeats
/// the preceding word, so it joins that word and repeats its reading.
export function thaiSegments(text){
  const dictionary=entries(),result=[];let offset=0;
  for(const part of words.segment(text.normalize('NFC'))){
    const source=part.segment,length=graphemes(source).length,previous=result.at(-1);
    // A spaced ๆ (เด็ก ๆ) also repeats the word before the space.
    const owner=result.findLastIndex(r=>!/^\s*$/u.test(r.source));
    if(source==='ๆ'&&result[owner]?.wordLike){
      const word=result[owner];result.splice(owner+1).forEach(r=>{word.source+=r.source;});
      word.upper=offset+length;word.source+=source;word.reading=word.reading&&`${word.reading}-${word.reading}`;
      offset+=length;continue;
    }
    // A silenced letter split off its word (แดน|ซ์) is part of that word and adds no sound.
    if(/^[\u0E01-\u0E2E]{1,2}[\u0E34\u0E38]?\u0E4C$/u.test(source)&&previous?.wordLike&&previous.upper===offset&&!/\s/u.test(previous.source)){
      previous.source+=source;previous.upper=offset+length;previous.reading=dictionary[previous.source]??previous.reading;
      offset+=length;continue;
    }
    const wordLike=part.isWordLike&&/\p{Script=Thai}/u.test(source)&&/\p{L}/u.test(source);
    const base=source.replace(/\s*ๆ$/u,''),single=wordLike&&base?(dictionary[base]??compose(base,dictionary)):null;
    result.push({lower:offset,upper:offset+length,source,wordLike,reading:single&&base!==source?`${single}-${single}`:single});
    offset+=length;
  }
  return repair(result,dictionary);
}
// The segmenter can split a listed word (ร้องเพลงช้าๆ → ร้อง|เพ|ลง|ช้าๆ). A word
// without a reading is re-read together with its neighbours; the fewest listed
// words that exactly spell the joined text replace the original pieces.
function split(text,dictionary){
  const chars=graphemes(text),best=Array(chars.length+1).fill(null);best[0]=[];
  for(let end=1;end<=chars.length;end++)for(let start=Math.max(0,end-20);start<end;start++){
    const piece=chars.slice(start,end).join(''),before=best[start];
    if(before&&dictionary[piece]&&(!best[end]||before.length+1<best[end].length))best[end]=[...before,piece];
  }
  return best[chars.length];
}
function repair(segments,dictionary){
  const thai=s=>s?.wordLike&&!/\s/u.test(s.source);
  for(let i=0;i<segments.length;i++){
    if(!thai(segments[i])||segments[i].reading)continue;
    const options=[[i,i+1],[i-1,i],[i-1,i+1]].filter(([a,b])=>a>=0&&b<segments.length&&segments.slice(a,b+1).every(thai));
    let chosen=null;
    for(const [a,b] of options){
      const words=split(segments.slice(a,b+1).map(s=>s.source).join(''),dictionary);
      if(words&&(!chosen||words.length<chosen.words.length))chosen={a,b,words};
    }
    if(!chosen)continue;
    let offset=segments[chosen.a].lower;
    const replacement=chosen.words.map(word=>{const length=graphemes(word).length,segment={lower:offset,upper:offset+length,source:word,wordLike:true,reading:dictionary[word]};offset+=length;return segment;});
    segments.splice(chosen.a,chosen.b-chosen.a+1,...replacement);
    i=chosen.a+replacement.length-1;
  }
  return segments;
}
