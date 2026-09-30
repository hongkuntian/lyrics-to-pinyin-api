import {francAll} from 'franc-min';

const toTag={eng:'en',spa:'es',fra:'fr',por:'pt',deu:'de',ita:'it',rus:'ru',ukr:'uk',bul:'bg',srp:'sr',hrv:'hr',pol:'pl',ces:'cs',slk:'sk',nld:'nl',swe:'sv',dan:'da',fin:'fi',nor:'no',nob:'nb',ron:'ro',hun:'hu',tur:'tr',ell:'el',ara:'ar',pes:'fa',urd:'ur',hin:'hi',ben:'bn',tam:'ta',tel:'te',mar:'mr',tha:'th',vie:'vi',ind:'id',tgl:'tl',heb:'he',jpn:'ja',kor:'ko',cmn:'zh',yue:'yue',cat:'ca',lit:'lt',lav:'lv',est:'et',sqi:'sq',kaz:'kk',uzn:'uz',aze:'az',bel:'be',mal:'ml',kan:'kn',guj:'gu',pan:'pa',nep:'ne',sin:'si',khm:'km',mya:'my',amh:'am',swh:'sw'};
const scriptsOf=text=>[
 ['Jpan',/[\p{Script=Hiragana}\p{Script=Katakana}]/u],['Kore',/\p{Script=Hangul}/u],['Hani',/\p{Script=Han}/u],
 ['Latn',/\p{Script=Latin}/u],['Cyrl',/\p{Script=Cyrillic}/u],['Arab',/\p{Script=Arabic}/u],['Deva',/\p{Script=Devanagari}/u],
 ['Thai',/\p{Script=Thai}/u],['Hebr',/\p{Script=Hebrew}/u],['Grek',/\p{Script=Greek}/u],['Taml',/\p{Script=Tamil}/u]
].filter(([,pattern])=>pattern.test(text)).map(([script])=>script).filter(s=>s!=='Hani'||!/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text));
function classify(text) {
 const scripts=scriptsOf(text);
 if(scripts.includes('Jpan'))return {language:'ja',confidence:'script',scripts};
 if(scripts.includes('Kore'))return {language:'ko',confidence:'script',scripts};
 if(scripts.includes('Hani'))return {language:'zh',confidence:'script_only',scripts};
 const ranked=francAll(text,{minLength:80});
 const [best,score]=ranked[0]??['und',0],second=ranked[1]?.[1]??0;
 // Long lyrics can have close normalized scores between related languages.
 // These remain estimates; short/near-tied passages stay explicitly unknown.
 const margin=[...text].filter(c=>/\p{L}/u.test(c)).length>=300?0.003:0.02;
 if(best==='und'||score-second<margin)return {language:'und',confidence:'unknown',scripts};
 return {language:toTag[best]??best,confidence:'estimated',scripts};
}
export function analyzeLyricLanguage(lines,{genres=[],verified=false}={}) {
 const text=lines.join('\n'),overall=classify(text),scripts=[...new Set(lines.flatMap(scriptsOf))];
 const rows=lines.map(line=>classify(line));
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
 return {version:1,primary:pronunciation==='yue'?'yue':overall.language,languages:mixed?languages:[pronunciation==='yue'?'yue':overall.language],
  scripts,mixed,confidence:overall.confidence,pronunciation_language:pronunciation,pronunciation_basis:basis,
  lines:rows.map((row,index)=>({sourceID:`L${String(index+1).padStart(4,'0')}`,language:row.language,confidence:row.confidence}))};
}
