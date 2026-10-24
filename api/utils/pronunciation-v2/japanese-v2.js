import {japaneseEngine} from '../pronunciation-aids.js';
import {sourceSpans,egcs} from './source-spans.js';
import {classifyGroup,hira,engineVersion,speechSemanticsVersion} from './japanese-rules.js';
import {enumerateLexical} from './japanese-guards.js';
export {engineVersion as japaneseEngineVersion,speechSemanticsVersion as japaneseSpeechSemanticsVersion};
const active=char=>/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]/u.test(char);
const kana=text=>typeof text==='string'&&/^[\p{Script=Hiragana}ー]+$/u.test(text)&&!text.startsWith('ー');
const suggestion=(reading,attribution)=>({reading,readingScript:'Hira',basis:'unreviewed-candidate',attribution});
const speaking=(reading,spokenText,attribution)=>({reading,spokenText,spokenScript:'Hira',basis:'unreviewed-candidate',attribution});
// Pure analysis only. Effective language, trusted source, selection and personal authority are caller gates.
export async function analyzeJapaneseV2(text){
  const view=sourceSpans(text),segments=[];let engine;
  const plain=(lo,hi,reason,status='verbatim')=>({...view.span(lo,hi),reading:null,romanized:null,status,canonicalStatus:status,
    canonicalAdmission:'unavailable',readingBasis:'none',speechStatus:'unavailable',speechSemanticsVersion,
    reason,speechReason:reason,unknownHanBoundary:status==='unresolved'&&/\p{Script=Han}/u.test(view.span(lo,hi).source),alternatives:[],speakingAlternatives:[]});
  for(let lo=0;lo<view.chars.length;){
    let hi=lo+1;while(hi<view.chars.length&&active(view.chars[hi])===active(view.chars[lo]))hi++;
    if(!active(view.chars[lo])){segments.push(plain(lo,hi,'non-japanese-or-gap'));lo=hi;continue;}
    const run=view.span(lo,hi),normalized=run.source.normalize('NFC');engine??=await japaneseEngine();
    const tokens=await engine.analyzer.parse(normalized),normalizedChars=egcs(normalized);
    if(tokens.map(t=>t.surface_form).join('')!==normalized||normalizedChars.length!==hi-lo||
      normalizedChars.some((char,i)=>char!==view.chars[lo+i].normalize('NFC'))){segments.push(plain(lo,hi,'unsafe-active-run','unresolved'));lo=hi;continue;}
    const groups=[];
    for(const token of tokens){
      const native=token.reading??(!/\p{Script=Han}/u.test(token.surface_form)?token.surface_form:null),pronounced=token.pronunciation??native,previous=groups.at(-1);
      if(previous?.pronounced&&pronounced&&(/ッ$/.test(previous.pronounced)||token.pos==='助動詞'||token.pos_detail_1==='接尾'||
        (previous.pos==='動詞'&&token.pos_detail_1==='接続助詞'&&['て','で'].includes(token.surface_form)))){
        const ending=previous.conjugatedForm==='未然ウ接続'&&token.pos==='助動詞'&&pronounced==='ウ'?'ー':pronounced;
        previous.surface+=token.surface_form;previous.native+=native;previous.pronounced+=ending;previous.conjugatedForm=token.conjugated_form;previous.rawTokens.push(token);
      }else groups.push({surface:token.surface_form,native,pronounced,pos:token.pos,conjugatedForm:token.conjugated_form,rawTokens:[token]});
    }
    // A tokenizer cut may split one original EGC (IVS/combining marks). Prove
    // every group end before projecting any group; refuse the whole unsafe run.
    const originalAt=new Map([[0,lo]]);let offset=0;
    for(const [i,char]of normalizedChars.entries()){offset+=char.length;originalAt.set(offset,lo+i+1);}
    offset=0;const groupEnds=groups.map(group=>{offset+=group.surface.length;return originalAt.get(offset);});
    if(groupEnds.at(-1)!==hi||groupEnds.some((upper,i)=>!Number.isSafeInteger(upper)||upper<=(i?groupEnds[i-1]:lo))){segments.push(plain(lo,hi,'unsafe-active-run','unresolved'));lo=hi;continue;}
    let cursor=lo;
    for(const [i,group]of groups.entries()){
      const upper=groupEnds[i],span=view.span(cursor,upper);cursor=upper;
      let romanized=null,reading=null,status='unresolved';
      if(group.native&&group.pronounced&&!/\p{Script=Han}/u.test(group.pronounced)){
        romanized=engine.util.kanaToRomaji(group.pronounced,'hepburn');
        if(!/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(romanized)){reading=engine.util.kanaToHiragna(group.native);status='resolved';}
      }
      const g=classifyGroup({...span,reading,romanized,status},group,group.rawTokens,tokens,text),raw={...g,rawTokens:group.rawTokens};
      const s=plain(span.lower,span.upper,g.reason,g.canonicalStatus==='verbatim'?'verbatim':'unresolved');
      s.canonicalAdmission=g.canonicalAdmission;s.speechStatus=g.speechStatus;
      if(g.canonicalAdmission==='available')Object.assign(s,{reading:g.reading,romanized,status:'resolved',canonicalStatus:'resolved',readingBasis:'model-assisted-rules'});
      else if(g.canonicalAdmission==='requires-confirmation'){
        s.status=s.canonicalStatus='ambiguous';s.readingBasis='unreviewed-candidate';
        if(kana(g.reading)){
          s.alternatives.push(suggestion(g.reading,{kind:'chosen-analysis',engineVersion,reason:g.reason}));
          if(kana(hira(group.pronounced)))s.speakingAlternatives.push(speaking(g.reading,hira(group.pronounced),{kind:'chosen-dictionary-pronunciation',reason:g.reason}));
        }
      }
      if(g.speechStatus==='available')Object.assign(s,{spokenText:g.spokenText,spokenScript:'Hira',spokenBasis:'model-assisted-rules',rules:g.rules});
      if(g.reason==='loanword-pronunciation-variant'&&s.status==='resolved'){
        s.alternatives=[suggestion(g.reading,{kind:'chosen-analysis',engineVersion,reason:g.reason})];
        s.speakingAlternatives=[speaking(g.reading,g.reading,{kind:'lexical-kana-suggestion',reason:g.reason}),speaking(g.reading,hira(group.pronounced),{kind:'chosen-dictionary-pronunciation',reason:g.reason})];
      }
      // Freeze A's unknown-Han flag before the bounded A+ guard. Overflow cannot extend it.
      s.unknownHanBoundary=s.status==='unresolved'&&/\p{Script=Han}/u.test(s.source);
      const enumeration=enumerateLexical(engine.analyzer._analyzer,raw);
      s.lexicalEvidence={state:enumeration.state,reason:enumeration.reason,compositionCount:enumeration.compositionCount};
      if(['multiple','unknown'].includes(enumeration.state)){
        s.reading=null;s.romanized=null;s.status=s.canonicalStatus=enumeration.state==='multiple'?'ambiguous':'unresolved';
        s.canonicalAdmission=enumeration.state==='multiple'?'requires-confirmation':'unavailable';
        s.readingBasis=enumeration.state==='multiple'?'unreviewed-candidate':'none';s.reason=s.speechReason=enumeration.reason;
        s.speechStatus=enumeration.state==='multiple'?'ambiguous':'unavailable';
        for(const k of ['spokenText','spokenScript','spokenBasis','rules'])delete s[k];
        s.alternatives=enumeration.alternatives.map(a=>suggestion(a.reading,{kind:a.kind,label:a.label,evidence:a.evidence}));s.speakingAlternatives=[];
      }
      segments.push(s);
    }
    const runSegments=segments.filter(s=>s.lower>=lo&&s.upper<=hi),unknownHanRun=runSegments.some(s=>s.unknownHanBoundary);
    for(const s of runSegments)s.unknownHanRun=unknownHanRun;
    lo=hi;
  }
  return {language:'ja',source:text,engineVersion,speechSemanticsVersion,mode:'A+',quoteGuard:false,segments};
}
// Signals automatic eligibility only; no learned key, access or confirmation authority.
export function japaneseSelectionAnalysis(analysis,selection){
  const span=sourceSpans(analysis.source).span(selection.lower,selection.upper);
  if(span.source!==selection.source)throw new TypeError('Exact original selection required');
  const s=analysis.segments.find(s=>s.lower===span.lower&&s.upper===span.upper&&s.source===span.source);
  if(!s)return {automatic:false,reason:'complete-engine-group-required'};
  if(s.unknownHanRun)return {automatic:false,reason:'unknown-Han-active-run-requires-explicit-confirmation',segment:s};
  return {automatic:s.canonicalAdmission==='available',reason:s.reason,segment:s};
}
