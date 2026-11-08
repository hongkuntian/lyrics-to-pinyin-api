import {francAll} from 'franc-min';
import {resolveProviderLanguageEvidence} from './provider-language-evidence.js';

const toTag={eng:'en',spa:'es',fra:'fr',por:'pt',deu:'de',ita:'it',rus:'ru',ukr:'uk',bul:'bg',srp:'sr',hrv:'hr',pol:'pl',ces:'cs',slk:'sk',nld:'nl',swe:'sv',dan:'da',fin:'fi',nor:'no',nob:'nb',ron:'ro',hun:'hu',tur:'tr',ell:'el',ara:'ar',pes:'fa',urd:'ur',hin:'hi',ben:'bn',tam:'ta',tel:'te',mar:'mr',tha:'th',vie:'vi',ind:'id',zlm:'ms',tgl:'tl',heb:'he',jpn:'ja',kor:'ko',cmn:'zh',yue:'yue',cat:'ca',lit:'lt',lav:'lv',est:'et',sqi:'sq',kaz:'kk',uzn:'uz',aze:'az',bel:'be',mal:'ml',kan:'kn',guj:'gu',pan:'pa',nep:'ne',sin:'si',khm:'km',mya:'my',amh:'am',swh:'sw'};
export const scriptsOf=text=>[
 ['Jpan',/[\p{Script=Hiragana}\p{Script=Katakana}]/u],['Kore',/\p{Script=Hangul}/u],['Hani',/\p{Script=Han}/u],
 ['Latn',/\p{Script=Latin}/u],['Cyrl',/\p{Script=Cyrillic}/u],['Arab',/\p{Script=Arabic}/u],['Deva',/\p{Script=Devanagari}/u],
 ['Thai',/\p{Script=Thai}/u],['Hebr',/\p{Script=Hebrew}/u],['Grek',/\p{Script=Greek}/u],['Taml',/\p{Script=Tamil}/u]
].filter(([,pattern])=>pattern.test(text)).map(([script])=>script).filter(s=>s!=='Hani'||!/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text));
// Hindi as providers deliver it, in Latin letters; franc calls it Hausa. A
// conservative lexical check mirrors the app's: frequent words that are rare as
// standalone words in other Latin-script languages, plus broad coverage. Urdu
// written the same way is indistinguishable by text alone.
const hindiCore=new Set(('hai hain nahi nahin mujhe tujhe mera meri mere tera teri tere kya kyun kyon yeh woh aur bhi dil pyaar pyar ishq tum tumhe tumhein tumse tumne tumhari tumhara hum humein kuch kabhi abhi phir saath zindagi jaana mein hoon tha thi raha rahi rahe gaya gayi kaise kahan yahan wahan jab karo chalo dekho aaja jaane haan koi kahin apna apni apne raat sapne khwab aankhein aankhon baat baatein dard jaan mohabbat duniya lagta lagti hota hoti hoga khuli khidki subah kehta kehti rukne ruk sun suno chahiye chahta chahti mohe piya sajna kaha kisi shayad').split(' '));
const hindiFunction=new Set('main ho na ke ki ka ko se to jo hi ye wo tak par bin ab'.split(' '));
const latinOnly=text=>!/[^\p{Script=Latin}\p{M}\p{P}\p{S}\p{Z}\p{N}\s]/u.test(text);
const latinWords=text=>text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
export function romanizedHindi(text,{line=false}={}) {
 if(!latinOnly(text))return false;
 const words=latinWords(text);if(!words.length)return line;
 const core=words.filter(w=>hindiCore.has(w)),covered=words.filter(w=>hindiCore.has(w)||hindiFunction.has(w)).length;
 return line?core.length>=1&&covered/words.length>=0.25:words.length>=6&&new Set(core).size>=3&&covered/words.length>=0.3;
}
// Indonesian and Malay share most of their vocabulary; franc often scores them
// within its tie margin. Words common in one standard and rare in the other
// decide; words both use in lyrics (tak, takkan, tiada, bila, boleh, saja,
// esok, kau) are deliberately left out. Without a decision, Indonesian.
const indonesianMarkers=new Set('nggak enggak ngga gak bisa aja karena banget sih dong kok lho deh udah gimana bilang kayak gue lo emang jendela besok kapan uang sore cewek cowok'.split(' '));
const malayMarkers=new Set('awak kerana sahaja faham nak mahu kat tingkap dah ni tu sikit jom pasal duit budak petang korang'.split(' '));
export function indonesianOrMalay(text) {
 const words=latinWords(text),id=words.filter(w=>indonesianMarkers.has(w)).length,ms=words.filter(w=>malayMarkers.has(w)).length;
 return ms>=2&&ms>id?'ms':id>=2&&id>ms?'id':null;
}
function classify(text) {
 const scripts=scriptsOf(text);
 if(scripts.includes('Jpan'))return {language:'ja',confidence:'script',scripts};
 if(scripts.includes('Kore'))return {language:'ko',confidence:'script',scripts};
 if(scripts.includes('Hani'))return {language:'zh',confidence:'script_only',scripts};
 if(romanizedHindi(text))return {language:'hi-Latn',confidence:'estimated',scripts};
 const ranked=francAll(text,{minLength:80});
 const [best,score]=ranked[0]??['und',0],second=ranked[1]?.[1]??0;
 // Long lyrics can have close normalized scores between related languages.
 // These remain estimates; short/near-tied passages stay explicitly unknown.
 const margin=[...text].filter(c=>/\p{L}/u.test(c)).length>=300?0.003:0.02;
 // franc also scores casual Indonesian as Madurese, Sundanese or Javanese by a
 // few hundredths. Decisive marker words settle the Malayic cluster when both
 // Indonesian and Malay are close to the top; an exact ind/zlm tie defaults to Indonesian.
 const near=code=>(ranked.find(([c])=>c===code)?.[1]??0)>=score-0.05,malayic=['ind','zlm','mad','sun','jav'].includes(best)&&near('ind')&&near('zlm');
 const marked=malayic?indonesianOrMalay(text):null;
 if(marked)return {language:marked,confidence:'estimated',scripts};
 if(['ind','zlm'].includes(best)&&['ind','zlm'].includes(ranked[1]?.[0])&&score-(ranked[2]?.[1]??0)>=margin)
  return {language:best==='zlm'&&score-second>=margin?'ms':'id',confidence:'estimated',scripts};
 if(best==='und'||score-second<margin)return {language:'und',confidence:'unknown',scripts};
 return {language:toTag[best]??best,confidence:'estimated',scripts};
}
export function analyzeLyricLanguage(lines,{genres=[],verified=false,providerEvidence,providerSource}={}) {
 const text=lines.join('\n'),overall=classify(text),scripts=[...new Set(lines.flatMap(scriptsOf))];
 // Within a romanized-Hindi song, a short Hindi line keeps the song's label.
 // Within an Indonesian or Malay song, a line classified as either keeps the song's label.
 const rows=lines.map(line=>{
  if(overall.language==='hi-Latn'&&romanizedHindi(line,{line:true}))return {language:'hi-Latn',confidence:'estimated',scripts:scriptsOf(line)};
  const row=classify(line);
  return ['id','ms'].includes(overall.language)&&['id','ms'].includes(row.language)?{...row,language:overall.language}:row;
 });
 const languages=[...new Set(rows.filter(r=>r.language!=='und').map(r=>r.language))];
 const significant=new Set(scripts.filter(s=>s!=='Hani'));
 const latinPassages=lines.filter(line=>(line.match(/\p{Script=Latin}/gu)??[]).length>=12 && !/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(line));
 const hanLatin=overall.language==='zh'&&latinPassages.length>=2;
 const mixed=hanLatin || significant.size>1 || (languages.length>1 && rows.filter(r=>r.language!==overall.language && r.language!=='und').length>=2);
 let pronunciation=['ja','ko','ru'].includes(overall.language)?overall.language:null,basis=overall.confidence;
 if(overall.language==='zh') {
  const markers=new Set('嘅咗咁啲嘢佢哋唔冇嚟喺'),used=new Set();let marked=0;
  for(const line of lines){const found=[...line].filter(c=>markers.has(c));if(found.length)marked++;found.forEach(c=>used.add(c));}
  const recurring=marked>=2&&used.size>=3;
  const category=verified?genres.join(' ').toLowerCase():'';
  const mandarin=/mandopop|mandarin pop|国语流行|國語流行|华语流行|華語流行/.test(category);
  const cantonese=/cantopop|cantonese pop|粤语流行|粵語流行|廣東流行|广东流行/.test(category);
  if(!significant.has('Jpan')&&!significant.has('Kore') && !(mandarin&&(cantonese||recurring))) {
   if(cantonese||recurring){pronunciation='yue';basis=cantonese?'catalog_category':'cantonese_wording';}
   else if(mandarin){pronunciation='zh';basis='catalog_category';}
  }
 }
 const result={version:1,primary:pronunciation==='yue'?'yue':overall.language,languages:mixed?languages:[pronunciation==='yue'?'yue':overall.language],
  scripts,mixed,confidence:overall.confidence,pronunciation_language:pronunciation,pronunciation_basis:basis,
  lines:rows.map((row,index)=>({sourceID:`L${String(index+1).padStart(4,'0')}`,language:row.language,confidence:row.confidence}))};
 if(providerEvidence!==undefined)result.provider_evidence=resolveProviderLanguageEvidence(lines,result,providerEvidence,providerSource);
 return result;
}
