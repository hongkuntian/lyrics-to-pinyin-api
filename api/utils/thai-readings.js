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
// Sung and typed Thai stretches a word by repeating a letter (มากกกก, นะะะ, เธอออ)
// and sometimes types แ as two เ. The word is read as its plain spelling and the
// extra letters stay inside it. A doubled consonant can be a real spelling
// (งง, กก) and อ can meet itself across words (รอออก), so those are kept.
const stretchedVowel=new Set(['ะ','า','ำ','ๅ']),consonant=/^[\u0E01-\u0E2E]$/u,thaiLetter=/^[\u0E01-\u0E3A\u0E40-\u0E4E]/u;
function plainSpelling(chars){
  const kept=[],origin=[];
  for(let i=0;i<chars.length;){
    let n=1;while(chars[i+n]===chars[i])n++;
    const c=chars[i],next=chars[i+n];
    if(c==='เ'&&n===2){kept.push('แ');origin.push(i);i+=2;continue;}
    const stretched=stretchedVowel.has(c)?n>=2:c==='อ'?n>=4||(n===3&&!(next&&thaiLetter.test(next))):consonant.test(c)&&n>=3;
    for(let k=0;k<(stretched?1:n);k++){kept.push(c);origin.push(i+k);}
    i+=n;
  }
  origin.push(chars.length);
  return {text:kept.join(''),origin};
}
// A word the list lacks is read from listed words that spell it, then without a
// doubled last letter (อืมม = อืม).
function read(word,dictionary){
  const direct=dictionary[word]??compose(word,dictionary);
  if(direct)return direct;
  const chars=graphemes(word);
  return chars.length>2&&chars.at(-1)===chars.at(-2)?read(chars.slice(0,-1).join(''),dictionary):null;
}
const repeated=(reading,times)=>reading&&Array(times+1).fill(reading).join('-');
/// Thai words with grapheme offsets and Paiboon readings. ๆ repeats the
/// preceding word, so it joins that word and repeats its reading once per ๆ.
export function thaiSegments(text){
  const dictionary=entries(),result=[],original=graphemes(text.normalize('NFC')),{text:spelling,origin}=plainSpelling(original);let offset=0;
  for(const part of words.segment(spelling)){
    const source=part.segment,length=graphemes(source).length,previous=result.at(-1);
    // A spaced ๆ (เด็ก ๆ) also repeats the word before the space.
    const owner=result.findLastIndex(r=>!/^\s*$/u.test(r.source));
    if(/^ๆ+$/u.test(source)&&result[owner]?.wordLike){
      const word=result[owner];result.splice(owner+1).forEach(r=>{word.source+=r.source;});
      word.upper=offset+length;word.source+=source;word.times=(word.times??0)+length;word.reading=repeated(word.once??word.reading,word.times);
      offset+=length;continue;
    }
    // A silenced letter split off its word (แดน|ซ์) is part of that word and adds no sound.
    if(/^[\u0E01-\u0E2E]{1,2}[\u0E34\u0E38]?\u0E4C$/u.test(source)&&previous?.wordLike&&previous.upper===offset&&!/\s/u.test(previous.source)){
      previous.source+=source;previous.upper=offset+length;previous.reading=dictionary[previous.source]??previous.reading;
      offset+=length;continue;
    }
    const wordLike=part.isWordLike&&/\p{Script=Thai}/u.test(source)&&/\p{L}/u.test(source);
    const marks=source.match(/(\s*ๆ)+$/u)?.[0]??'',base=marks?source.slice(0,-marks.length):source,times=[...marks].filter(c=>c==='ๆ').length;
    const once=wordLike&&base?read(base,dictionary):null;
    // A doubled last letter left over as its own piece (รัก|ก) stretches the word before it.
    if(wordLike&&!once&&!marks&&previous?.reading&&previous.upper===offset&&graphemes(source).every(c=>c===graphemes(previous.source).at(-1))){
      previous.source+=source;previous.upper=offset+length;offset+=length;continue;
    }
    result.push({lower:offset,upper:offset+length,source,wordLike,reading:repeated(once,times),once,times});
    offset+=length;
  }
  // Offsets and sources return to the text as written, stretched letters included.
  return repair(result,dictionary).map(({lower,upper,wordLike,reading})=>
    ({lower:origin[lower],upper:origin[upper],source:original.slice(origin[lower],origin[upper]).join(''),wordLike,reading:reading??null}));
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
