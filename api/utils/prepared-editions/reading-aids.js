// Prepared-only deterministic reading help. The ordinary pronunciation API is unchanged.
import {annotationFor,profileFor,pronunciationKey} from '../pronunciation-aids.js';
import {LibraryError} from '../song-library/store.js';
import {canonicalJSON} from '../song-library/spotify-recording.js';
const requirements=Object.freeze({ja:['ja-hepburn','ja-kana'],ko:['ko-revised']});
export function requiredReadingProfiles(doc){
 const language=doc.response?.song?.language;let canonical;try{canonical=Intl.getCanonicalLocales(language)[0]?.split('-')[0];}catch{}
 if(['ja','ko'].includes(canonical)&&language!==canonical)fail('unsupported_prepared_source_language');
 return requirements[language]??[];
}
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).sort().join()===keys.sort().join();
const fail=(code='invalid_prepared_reading_aids')=>{throw new LibraryError(code,422);};
const graphemes=text=>Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text),s=>s.segment);
const native=(text,language)=>(language==='ja'?/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u:/\p{Script=Hangul}/u).test(text);
const canonicalLines=aid=>aid.lines.map(line=>({sourceID:line.sourceID,segments:line.segments.map(({lower,upper,source,status,reading})=>({lower,upper,source,status,reading}))}));
export function validateReadingAids(doc){
 const ids=requiredReadingProfiles(doc),map=doc.preparedReadingAids;
 if(!ids.length){if(map!==undefined&&(!object(map)||Object.keys(map).length))fail();return doc;}
 if(map===undefined)fail('prepared_reading_aids_required');
 if(!exact(map,ids))fail();
 const occurrences=doc.structure?.occurrences;if(!Array.isArray(occurrences)||!occurrences.length)fail();
 for(const id of ids){
  const aid=map[id],profile=profileFor(id);
  if(!exact(aid,['version','id','documentID','sourceHash','profile','offsetUnit','textScope','readingRevision','lines'])||aid.version!==1||aid.id!==pronunciationKey(doc,id)||aid.documentID!==doc.id||aid.sourceHash!==doc.sourceHash||
   canonicalJSON(aid.profile)!==canonicalJSON(profile)||aid.offsetUnit!=='grapheme'||aid.textScope!=='lyric-body'||!hash(aid.readingRevision)||!Array.isArray(aid.lines)||aid.lines.length!==occurrences.length)fail();
  let useful=0;
  for(const [i,line] of aid.lines.entries()){
   const occurrence=occurrences[i],chars=graphemes(occurrence.lyricText);
   if(!exact(line,['sourceID','text','segments'])||line.sourceID!==occurrence.sourceID||typeof line.text!=='string'||!Array.isArray(line.segments)||!line.segments.length||line.segments.length>chars.length)fail();
   let cursor=0,text='';
   for(const [index,s] of line.segments.entries()){
    if(!exact(s,['lower','upper','source','reading','aid','status'])||!Number.isSafeInteger(s.lower)||!Number.isSafeInteger(s.upper)||s.lower!==cursor||s.upper<=s.lower||s.upper>chars.length||s.source!==chars.slice(s.lower,s.upper).join(''))fail();
    const active=native(s.source,profile.sourceLanguage);
    if(active){
     if(s.status!=='resolved'||typeof s.reading!=='string'||!s.reading.trim()||typeof s.aid!=='string'||!s.aid.trim())fail();
     if(profile.sourceLanguage==='ja'){
      if(!/^[\p{Script=Hiragana}\p{M}ー]+$/u.test(s.reading)||!/\p{Script=Hiragana}/u.test(s.reading))fail();
      if(id==='ja-kana'?s.aid!==s.reading:!/[\p{Script=Latin}]/u.test(s.aid)||/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(s.aid))fail();
     }else if(s.reading!==s.source.normalize('NFC')||!/[\p{Script=Latin}]/u.test(s.aid)||/[\p{Script=Hangul}\p{Script=Han}]/u.test(s.aid))fail();
     useful++;
    }else if(s.status!=='verbatim'||s.reading!==null||s.aid!==null)fail();
    if(profile.kind==='romanization'&&index>0&&line.segments[index-1].status==='resolved'&&s.status==='resolved')text+=' ';
    text+=s.aid??s.source;cursor=s.upper;
   }
   if(cursor!==chars.length||text!==line.text)fail();
  }
  if(!useful)fail();
 }
 if(ids.length===2){const a=map['ja-hepburn'],b=map['ja-kana'];if(a.readingRevision!==b.readingRevision||canonicalJSON(canonicalLines(a))!==canonicalJSON(canonicalLines(b)))fail();}
 return doc;
}
export async function prepareReadingAids(doc,{annotationFn=annotationFor}={}){
 const ids=requiredReadingProfiles(doc);if(!ids.length)return validateReadingAids(doc);
 const map={};for(const id of ids)map[id]=await annotationFn(doc,id);
 const result={...doc,preparedReadingAids:map};validateReadingAids(result);return result;
}
export async function verifyReadingAids(doc,{annotationFn=annotationFor}={}){
 validateReadingAids(doc);
 for(const id of requiredReadingProfiles(doc))if(canonicalJSON(await annotationFn(doc,id))!==canonicalJSON(doc.preparedReadingAids[id]))fail('prepared_reading_aids_changed');
 return doc;
}
