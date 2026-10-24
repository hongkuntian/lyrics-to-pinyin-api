// Correctable A+ beta rules. Source and lexical/speech authority stay separate.
import {createHash} from 'node:crypto';
export const sha=x=>createHash('sha256').update(typeof x==='string'||Buffer.isBuffer(x)?x:JSON.stringify(x)).digest('hex');
export const egcs=x=>[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(x)].map(x=>x.segment);
export const hira=x=>x?.normalize('NFC').replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-96));
export const engineVersion='kuromoji-0.1.2-kuroshiro-1.2.0-lyrica-ja-beta-3';
export const speechSemanticsVersion='ja-spoken-kana-beta-3';
export const homographs=new Set(['生','人気','一日','市場','明日','上手','大人','一人','今日','昨日','明後日','何人','二人','日本','行方','風車','紅葉','角','行','間','方','下手']);
const kana=/^[\p{Script=Hiragana}\p{Script=Katakana}ー]+$/u;
const spokenKana=/^[\p{Script=Hiragana}ー]+$/u;
const allowedPOS=new Set(['名詞','動詞','形容詞','副詞','連体詞','接続詞','感動詞','助詞','助動詞','接頭詞','フィラー']);
function classifyGroupInternal(segment,tappedGroup,rawTokens,runTokens,lineSource){
 const out={lower:segment.lower,upper:segment.upper,source:segment.source,reading:segment.reading,canonicalStatus:segment.status,speechStatus:'unavailable',reason:'unresolved-analysis',speechSemanticsVersion};
 if(!tappedGroup||segment.status!=='resolved'||!segment.reading||!rawTokens.length)return out;
 if(hira(tappedGroup.native)!==segment.reading||!spokenKana.test(segment.reading))return {...out,reason:'lexical-alignment'};
 // Character names in metalinguistic context are not the same claim as grammatical particles.
 const prefix=egcs(lineSource).slice(0,segment.lower).join(''),suffix=egcs(lineSource).slice(segment.upper).join('');
 if(/^[はへをヲ]$/u.test(segment.source.normalize('NFC'))&&((/[「『]$/u.test(prefix)&&/^[」』](?:という|の文字)/u.test(suffix))||/^という.*文字/u.test(suffix)))return {...out,speechStatus:'ambiguous',reason:'character-name-versus-particle'};
 const literalKatakana=rawTokens.length===1&&rawTokens[0].verbose?.word_type==='UNKNOWN'&&/^[\p{Script=Katakana}ー]+$/u.test(segment.source.normalize('NFC'));
 if(!literalKatakana&&rawTokens.some(t=>[t.pos_detail_1,t.pos_detail_2,t.pos_detail_3].includes('固有名詞')))return {...out,speechStatus:'ambiguous',reason:'proper-noun-requires-confirmation'};
 if(homographs.has(segment.source.normalize('NFC'))||rawTokens.some(t=>homographs.has(t.surface_form)||homographs.has(t.basic_form)))return {...out,speechStatus:'ambiguous',reason:'known-heteronym-requires-confirmation'};
 if(runTokens.some(t=>t.verbose?.word_type==='UNKNOWN'&&/[\p{Script=Hiragana}]/u.test(t.surface_form)))return {...out,reason:'unknown-hiragana-boundary'};
 if(/^[ゃゅょぁぃぅぇぉゎっャュョァィゥェォヮッー]/u.test(segment.source.normalize('NFC')))return {...out,reason:'invalid-initial-mora'};
 if(rawTokens.some(t=>/ヴ/u.test(t.reading??'')&&!/ヴ/u.test(t.pronunciation??'')))return {...out,speechStatus:'ambiguous',reason:'loanword-pronunciation-variant'};
 if(rawTokens.some(t=>!allowedPOS.has(t.pos)||t.pos_detail_1==='数'))return {...out,reason:'unsupported-token-class'};
 if(rawTokens.some(t=>t.verbose?.word_type!=='KNOWN'&&!kana.test(t.surface_form)))return {...out,reason:'unknown-nonkana'};
 if(rawTokens.some(t=>/\p{Script=Han}/u.test(t.surface_form)&&(!t.reading||!t.pronunciation)))return {...out,reason:'missing-han-reading'};
 if(/[0-9０-９]$/u.test(prefix)||/^[0-9０-９]/u.test(suffix))return {...out,reason:'numeric-context-outside-scope'};
 const content=runTokens.some(t=>!['助詞','助動詞','記号'].includes(t.pos));
 if(rawTokens.every(t=>['助詞','助動詞'].includes(t.pos))&&!content)return {...out,reason:'particle-only-run'};
 const particle=rawTokens.length===1&&rawTokens[0].pos==='助詞'&&['は','へ','を'].includes(rawTokens[0].surface_form);
 if(particle){
  const index=runTokens.indexOf(rawTokens[0]);let cursor=index-1;
  while(cursor>=0&&runTokens[cursor].pos==='助詞'&&!['は','へ','を'].includes(runTokens[cursor].surface_form))cursor--;
  const host=runTokens[cursor];
  if(!host||['助詞','助動詞','記号'].includes(host.pos))return {...out,speechStatus:'ambiguous',reason:'particle-without-local-host'};
 }
 let spoken=hira(tappedGroup.pronounced),applied=['grouped-dictionary-pronunciation'];
 if(rawTokens.length===1&&rawTokens[0].pos==='助詞'&&rawTokens[0].surface_form==='を'&&rawTokens[0].pronunciation==='ヲ'){
  spoken='お';applied.push('pos-particle-wo-to-o');
 }
 if(rawTokens.some(t=>t.pos==='助詞'&&t.surface_form==='は'&&t.pronunciation==='ワ'))applied.push('dictionary-pos-ha-to-wa');
 if(rawTokens.some(t=>t.pos==='助詞'&&t.surface_form==='へ'&&t.pronunciation==='エ'))applied.push('dictionary-pos-he-to-e');
 if(tappedGroup.pronounced?.endsWith('ー')&&rawTokens.at(-1)?.pos==='助動詞'&&rawTokens.at(-1)?.pronunciation==='ウ'&&rawTokens.at(-2)?.conjugated_form==='未然ウ接続')applied.push('typed-volitional-u-lengthening');
 if(!spoken||!spokenKana.test(spoken)||spoken.startsWith('ー'))return {...out,reason:'unsupported-spoken-script'};
 return {...out,speechStatus:'available',reason:rawTokens.some(t=>t.verbose?.word_type!=='KNOWN')?'literal-kana-beta':'dictionary-rules-beta',spokenText:spoken,spokenScript:'Hira',spokenBasis:'model-assisted-rules',rules:applied};
}
export function classifyGroup(...args){
 const result=classifyGroupInternal(...args);
 result.canonicalAdmission=result.speechStatus==='available'||result.reason==='loanword-pronunciation-variant'?'available':
 ['proper-noun-requires-confirmation','known-heteronym-requires-confirmation','character-name-versus-particle'].includes(result.reason)?'requires-confirmation':'unavailable';
 // reading is retained as diagnostic dictionary output; it is not admitted merely by being present.
 return result;
}
