import {digest,LibraryError} from './song-library/store.js';

// A profile describes a notation, not a translation target or the UI language.
// Future phonetic approximations must declare a readerLanguage and limitations;
// no direction is inferred from the existence of two other profiles.
export const profiles=Object.freeze([
  {id:'ja-hepburn',version:'1',sourceLanguage:'ja',kind:'romanization',notation:'hepburn',outputScript:'Latn',readerLanguage:null,label:'Japanese · Romaji',engineVersion:'kuromoji-0.1.2-kuroshiro-1.2.0-lyra-1'},
  {id:'ja-kana',version:'1',sourceLanguage:'ja',kind:'native-reading',notation:'kana',outputScript:'Hira',readerLanguage:null,label:'Japanese · Kana',engineVersion:'kuromoji-0.1.2-kuroshiro-1.2.0-lyra-1'},
  {id:'ko-revised',version:'1',sourceLanguage:'ko',kind:'romanization',notation:'revised',outputScript:'Latn',readerLanguage:null,label:'Korean · Romanization',engineVersion:'koroman-1.0.16-lyra-1'}
].map(p=>Object.freeze({...p,status:'beta',basis:'text',limitations:['Text-derived reading; the recorded performance may differ.']})));
export function profileFor(id){const p=profiles.find(p=>p.id===id);if(!p)throw new LibraryError('unsupported_pronunciation_profile',422);return p;}
export function enabledProfiles(env=process.env){
  if(env.LYRA_PRONUNCIATION_PROFILES===undefined)return profiles;
  try{const ids=JSON.parse(env.LYRA_PRONUNCIATION_PROFILES);if(!Array.isArray(ids)||ids.some(id=>!profiles.some(p=>p.id===id)))throw new Error();
    return profiles.filter(p=>ids.includes(p.id));
  }catch{throw new LibraryError('invalid_pronunciation_policy',503);}
}
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const graphemes=text=>Array.from(segmenter.segment(text),x=>x.segment);
let japanese;
async function japaneseEngine(){
  if(!japanese)japanese=(async()=>{
    const [{default:ki},{default:ai}]=await Promise.all([import('kuroshiro'),import('kuroshiro-analyzer-kuromoji')]);
    const K=ki.default??ki,A=ai.default??ai,analyzer=new A();await analyzer.init();return {analyzer,util:K.Util};
  })().catch(error=>{japanese=null;throw error;});
  return japanese;
}
function script(char,language){return (language==='ja'?/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u:/[\p{Script=Hangul}]/u).test(char);}
function runs(text,language){
  const chars=graphemes(text),result=[];
  for(let i=0;i<chars.length;){let j=i+1,active=script(chars[i],language);while(j<chars.length&&script(chars[j],language)===active)j++;
    result.push({lower:i,upper:j,source:chars.slice(i,j).join(''),active});i=j;}
  return result;
}
const plain=run=>({lower:run.lower,upper:run.upper,source:run.source,reading:null,romanized:null,status:'verbatim'});
const unresolved=run=>({...plain(run),status:'unresolved'});

export async function analyzeReading(text,language){
  if(typeof text!=='string'||!['ja','ko'].includes(language))throw new LibraryError('invalid_pronunciation_source',422);
  const segments=[];
  for(const run of runs(text,language)){
    if(!run.active){segments.push(plain(run));continue;}
    if(language==='ko'){
      const {romanize}=await import('koroman');
      const romanized=romanize(run.source.normalize('NFC'),{usePronunciationRules:true,useHyphen:false});
      if(/[\p{Script=Hangul}\p{Script=Han}]/u.test(romanized))segments.push(unresolved(run));
      else segments.push({...plain(run),reading:run.source.normalize('NFC'),romanized,status:'resolved'});
      continue;
    }
    const {analyzer,util}=await japaneseEngine();
    const tokens=await analyzer.parse(run.source.normalize('NFC'));
    // Some analyzers drop unsupported Unicode. Never repair their offsets by guessing.
    if(tokens.map(t=>t.surface_form).join('')!==run.source.normalize('NFC')||graphemes(run.source.normalize('NFC')).length!==run.upper-run.lower){segments.push(unresolved(run));continue;}
    const groups=[];
    for(const token of tokens){
      const native=token.reading??(!/\p{Script=Han}/u.test(token.surface_form)?token.surface_form:null);
      const pronounced=token.pronunciation??native;
      const previous=groups.at(-1);
      // Keep auxiliary endings and gemination within a single reading group.
      if(previous?.pronounced&&pronounced&&(/ッ$/.test(previous.pronounced)||token.pos==='助動詞'||token.pos_detail_1==='接尾'||
          (previous.pos==='動詞'&&token.pos_detail_1==='接続助詞'&&['て','で'].includes(token.surface_form)))){
        // Volitional ウ lengthens the preceding vowel; ordinary 思う remains omou.
        const ending=previous.conjugatedForm==='未然ウ接続'&&token.pos==='助動詞'&&pronounced==='ウ'?'ー':pronounced;
        previous.surface+=token.surface_form;previous.native+=native;previous.pronounced+=ending;
        previous.conjugatedForm=token.conjugated_form;
      }else groups.push({surface:token.surface_form,native,pronounced,pos:token.pos,conjugatedForm:token.conjugated_form});
    }
    let offset=run.lower;
    for(const group of groups){
      const length=graphemes(group.surface).length,source=graphemes(run.source).slice(offset-run.lower,offset-run.lower+length).join('');
      const span={lower:offset,upper:offset+length,source};offset+=length;
      if(!group.native||!group.pronounced||/\p{Script=Han}/u.test(group.pronounced)){segments.push(unresolved(span));continue;}
      const romanized=util.kanaToRomaji(group.pronounced,'hepburn');
      if(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(romanized)){segments.push(unresolved(span));continue;}
      segments.push({...span,reading:util.kanaToHiragna(group.native),romanized,status:'resolved'});
    }
  }
  return {language,segments};
}
export function renderReading(reading,profileID){
  const profile=profileFor(profileID);
  if(reading.language!==profile.sourceLanguage)throw new LibraryError('unsupported_pronunciation_direction',422);
  const segments=reading.segments.map(s=>({lower:s.lower,upper:s.upper,source:s.source,reading:s.reading,
    aid:s.status==='resolved'?(profile.kind==='native-reading'?s.reading:s.romanized):null,status:s.status}));
  let text='';
  for(let i=0;i<segments.length;i++){
    const s=segments[i],previous=segments[i-1];
    if(profile.kind==='romanization'&&previous?.status==='resolved'&&s.status==='resolved')text+=' ';
    text+=s.aid??s.source;
  }
  return {text,segments};
}
export const pronunciationKey=(doc,profileID)=>{
  const p=profileFor(profileID);
  if(doc.response.song.language!==p.sourceLanguage)throw new LibraryError('unsupported_pronunciation_direction',422);
  return digest({documentID:doc.id,sourceHash:doc.sourceHash,profileID,version:p.version,engineVersion:p.engineVersion});
};
export async function annotationFor(doc,profileID){
  const id=pronunciationKey(doc,profileID),profile=profileFor(profileID),readings=[];
  // Bound work per request and initialize the dictionary once per warm instance.
  for(const line of doc.structure.occurrences)readings.push({sourceID:line.sourceID,...await analyzeReading(line.lyricText,profile.sourceLanguage)});
  return {version:1,id,documentID:doc.id,sourceHash:doc.sourceHash,profile,offsetUnit:'grapheme',textScope:'lyric-body',
    readingRevision:digest({engine:profile.engineVersion,readings}),
    lines:readings.map(r=>({sourceID:r.sourceID,...renderReading(r,profileID)}))};
}
