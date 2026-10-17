import {createRequire} from 'node:module';
import chinese from 'chinese-conv';
import {revalidatedVocalLine} from './vocal-timing.js';
const require=createRequire(import.meta.url);
const roster=require('../data/lyric-performers.json');
export const LYRIC_NORMALIZATION_VERSION='lyric-annotations-3';
export const LYRIC_SELECTION_REVISION='lyrics-selection-2026-09-30-storefront-1';
export const reviewedSpeakerLabels=catalogID=>roster.reviewedRecordings[catalogID]??{};

// Raw and durable public DTOs share the same visible occurrence identity.
// Canonical source rows, hidden turns and provenance remain in metadata.
export function publicLyricStructure(structure) {
  if(!['lyric-annotations-1','lyric-annotations-2',LYRIC_NORMALIZATION_VERSION].includes(structure?.version))return null;
  return {version:'source-speakers-1',speakers:structure.speakers,
    occurrences:structure.occurrences.map(o=>({sourceID:o.sourceID,sourceText:o.lyricText,
      lyricText:o.lyricText,speakerID:o.speakerID,startsTurn:false,sourcePrefix:''}))};
}
export function publicRawLyrics(response) {
  if(response?.metadata?.lyric_structure?.version===LYRIC_NORMALIZATION_VERSION&&!validLyricStructure(response.metadata.lyric_structure,response.lines??[]))return response;
  const structure=publicLyricStructure(response?.metadata?.lyric_structure);
  // Preserve response object identity: verified provider evidence is held in a
  // server-only WeakMap and must survive this additive wire projection.
  if(structure)response.lyric_structure=structure;
  return response;
}

// Normalize labels for comparison only. Never rewrite the sung words.
const labelKey=text=>chinese.sify(text).normalize('NFKC').toLowerCase().replace(/\s+/gu,'');
// Each row is one role with equivalent names. Bilingual labels must consume the
// entire label and describe the same role; arbitrary English suffixes are unsafe.
const roles=[
  [["词","作词","填词","改编词"],["lyrics","lyrics by","lyricist"]],
  [["曲","作曲"],["composer","composed by","composition"]],
  [["词曲"],["music and lyrics","lyrics and music"]],
  [["编曲"],["arrangement","arranger","arranged by","music arrangement"]],
  [["制作人","制作"],["producer","produced by","production"]],
  [["配唱制作人","配唱制作"],["vocal producer","vocal production"]],
  [["监制","出品监制"],["executive producer","supervisor"]],
  [["统筹","制作统筹"],["coordinator","coordination"]],
  [["音乐统筹"],["music coordinator","music coordination"]],
  [["演唱","演唱者","歌手","主唱"],["singer","artist","vocals","performed by"]],
  [["出品人"],["presenter"]],
  [["录音","录音师","录音工程师"],["recorded by","recording engineer","recording"]],
  [["录音室","录音棚","录音工作室"],["recording studio"]],
  [["鼓录音室"],["drum recording studio"]],
  [["混音","混音师","混音工程师"],["mixed by","mixing engineer","mixing"]],
  [["混音室","混音工作室","混音录音室"],["mixing studio"]],
  [["母带","母带工程师","母带处理工程师","母带后期处理"],["mastered by","mastering engineer","mastering"]],
  [["母带工作室","母带处理工作室"],["mastering studio"]],
  [["混音/母带处理工作室","混音&母带处理工作室"],["mixing/mastering studio"]],
  [["和声编写","和声编写及演唱"],["backing vocals arrangement","background vocal arrangement"]],
  [["人声编辑"],["vocal editing","vocal editor"]],
  [["弦乐","弦乐编写","弦乐编曲","弦乐团"],["strings","string arrangement","strings arrangement","string orchestra"]],
  [["管弦乐编写","管弦乐编曲"],["orchestration","orchestral arrangement"]],
  [["管弦乐团"],["orchestra"]],
  [["小提琴"],["violin","violins"]],
  [["第一小提琴","一提","小提琴一"],["first violin","first violins","violin I","violin 1"]],
  [["第二小提琴","二提","小提琴二"],["second violin","second violins","violin II","violin 2"]],
  [["中提琴"],["viola","violas"]],
  [["大提琴"],["cello","cellos"]],
  [["低音提琴","倍低音提琴"],["double bass","contrabass"]],
  [["吉他"],["guitar"]],
  [["木吉他","原声吉他"],["acoustic guitar"]],
  [["电吉他"],["electric guitar"]],
  [["吉他独奏"],["guitar solo"]],
  [["贝斯","低音吉他"],["bass","bass guitar"]],
  [["鼓"],["drums"]],
  [["钢琴"],["piano"]],
  [["键盘"],["keyboard","keyboards"]],
  [["打击乐"],["percussion"]],
  [["笛","笛子","长笛"],["flute","dizi"]],
  [["萨克斯","萨克斯风"],["saxophone"]],
  [["小号"],["trumpet"]],
  [["长号"],["trombone"]],
  [["圆号"],["horn","French horn"]],
  [["二胡"],["erhu"]],
  [["古筝"],["guzheng"]],
  [["琵琶"],["pipa"]],
  [["音乐总监"],["music director"]],
  [["指挥"],["conductor"]],
  [["发行","发行公司"],["distribution","distributor"]],
  [["发行合作"],["distribution cooperation"]],
  [["出品","出品方","版权"],["copyright"]],
  [["制作公司"],["production company"]],
  [["后期制作"],["post production","post-production"]],
  [["母带管理"],["master management"]],
  [["艺人经纪"],["artist management"]],
  [["原唱"],["original artist","original singer"]],
  [["制作团队"],["production team"]],
  [["出品团队"],["presentation team"]],
  [["出版","出版公司","音乐出版"],["publisher","publishing","music publisher"]],
  [["词/曲OP"],["lyrics/music original publisher"]],
  [["词/曲SP"],["lyrics/music sub publisher"]],
  [[],["OP","SP","original publisher","sub publisher","sub-publisher","program","programming","PGM","programmer","programmed by"]],
  [["戏腔念白"],["theatrical vocals"]],
  [["和声"],["backing vocal","backing vocals"]],
  [["和声"],["background vocal","background vocals"]]
];
const roleLabels=new Set(roles.flatMap(([zh,en])=>[
  ...zh,...en,...zh.flatMap(a=>en.flatMap(b=>[a+b,b+a,a+'('+b+')',b+'('+a+')']))
]).map(labelKey));
const ambiguousRoles=new Set(['chorus','和声','和音','合声','backingvocal','backingvocals']);
const sourceCredit=/^取材自歌曲[《〈].+[》〉]\s*[（(]\s*[词詞]\s*[:：].+曲\s*[:：].+[）)]$/u;
const instrumental=/^(?:纯音乐[，,。\s]*(?:请欣赏)?|純音樂[，,。\s]*(?:請欣賞)?|instrumental)[。.!\s]*$/iu;
// Provider placeholders describe a break, not performed words. Keep notes
// embedded in actual lyrics; presentation owns the instrumental indicator.
const musicNotes=/^[♩♪♫♬🎵🎶\s\uFE0E\uFE0F]+$/u;
export const isMusicNotePlaceholder=text=>typeof text==='string' && musicNotes.test(text.trim());
const genericLabels=new Map([['合','All'],['合唱','All'],['齐唱','All'],['all','All'],['chorus','All'],['男','Male'],['女','Female']]);

export function performerAliases({artist='',catalogID,performers=[]}={}) {
  const result=new Map();
  const add=(name,aliases=[])=>{for(const alias of [name,...aliases]) if(alias?.trim()) result.set(labelKey(alias),name);};
  // Callers may pass explicitly structured performer identities. No lyric-text
  // name inference, title-based guessing, or unbounded profile lookup occurs.
  for(const p of performers) if(typeof p?.name==='string') add(p.name,p.aliases??[]);
  if(artist.trim()) {
    add(artist);
    for(const name of artist.split(/\s+(?:&|feat\.?|ft\.?)\s+|、/iu)) add(name.trim());
  }
  const group=roster.artists.find(a=>a.names.some(name=>labelKey(name)===labelKey(artist)));
  for(const member of group?.members??[]) add(member.name,member.aliases);
  for(const [source,name] of Object.entries(roster.reviewedRecordings[catalogID]??{})) add(name,[source]);
  return result;
}

function labelPrefix(text) {
  const bracket=text.match(/^(?:\[([^\]]{1,120})\]|【([^】]{1,120})】|\(([^)]{1,120})\)|（([^）]{1,120})）)[ \t]*(?:[:：][ \t]*)?/u);
  if(bracket) return {label:bracket.slice(1).find(Boolean).trim(),prefix:bracket[0],body:text.slice(bracket[0].length)};
  const colon=text.match(/^([^:：\r\n]{1,120})[:：][ \t]*/u);
  return colon?{label:colon[1].trim(),prefix:colon[0],body:text.slice(colon[0].length)}:null;
}
function namedPerformers(label,aliases) {
  const parts=label.split(/\s*[/／&、]\s*/u);
  const names=parts.map(part=>aliases.get(labelKey(part)));
  return names.length && names.every(Boolean)?[...new Set(names)]:null;
}
function creditRole(text,aliases) {
  if(sourceCredit.test(text)) return 'source_credit';
  const parts=text.match(/^([^:：]+)[:：](.*)$/u);
  if(!parts || !parts[2].trim()) return null;
  const key=labelKey(parts[1]);
  if(ambiguousRoles.has(key)) {
    // Explicit Chinese/English backing-vocal role plus a compact roster; an
    // unlabelled sung chorus and long spoken sentences are not production credits.
    const roster=parts[2].trim();
    const compactNames=/^[\p{Script=Han}]{2,4}(?:[ 、/／&,，]+[\p{Script=Han}]{2,4})+$/u.test(roster);
    return namedPerformers(roster,aliases) || (key!=='chorus' && compactNames)?'production_credit':null;
  }
  return roleLabels.has(key)?'production_credit':null;
}

const performanceRoles=new Set(['男声','女声','戏腔']);
const surnames=new Set('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛范彭鲁韦马苗方俞任袁柳史唐费薛雷贺倪汤罗毕郝安常傅齐康伍余黄萧姚邵汪毛戴宋熊纪舒董梁杜阮蓝闵席季麻强贾江颜郭林钟徐邱骆高夏蔡田樊胡凌霍万程陆崔曾洪廖赖温庄叶刘黎白顾龙邓关石卢莫丁谭梅尹段侯单');
// Short role labels can also introduce sung words. Require a compact personal
// name and corroboration from the surrounding credits, never a fixed header size.
export function lyricCreditRoles(lines,options={},protectedIndices=new Set()) {
  const aliases=performerAliases(options),result=new Map(),candidates=new Map();
  lines.forEach((line,i)=>{
    if(protectedIndices.has(i)) return;
    const text=(line.text??'').trim(),direct=creditRole(text,aliases);
    if(direct) {result.set(i,direct);return;}
    const parts=text.match(/^([^:：]+)[:：]\s*(.+)$/u);
    if(!parts) return;
    const key=labelKey(parts[1]),body=labelKey(parts[2]);
    if(!performanceRoles.has(key) && !ambiguousRoles.has(key)) return;
    const known=namedPerformers(parts[2].trim(),aliases);
    const name=body.replace(/(?:@[^\s@/／&,，、]+|[（(][a-z0-9][a-z0-9._-]{0,39}[）)])$/u,'');
    const personalName=/^[\p{Script=Han}]{2,4}$/u.test(name) && surnames.has([...name][0]);
    if(!known && !personalName) return;
    if(performanceRoles.has(key) && known) result.set(i,'production_credit');
    else candidates.set(i,{key,body});
  });
  // Distinct adjacent roles naming the same performer establish a roster even
  // when the primary recording artist does not list that guest (e.g. 男声/戏腔).
  for(const [i,candidate] of candidates) {
    const next=candidates.get(i+1);
    if(performanceRoles.has(candidate.key) && next && performanceRoles.has(next.key)
      && candidate.key!==next.key && candidate.body===next.body) {
      result.set(i,'production_credit');result.set(i+1,'production_credit');
    }
  }
  let changed=true;
  while(changed) {
    changed=false;
    for(const i of candidates.keys()) if(!result.has(i)
      && ((result.has(i-2)&&result.has(i-1)) || (result.has(i-1)&&result.has(i+1)) || (result.has(i+1)&&result.has(i+2)))) {
      result.set(i,'production_credit');changed=true;
    }
  }
  return result;
}

export function hasEmbeddedLyricCredits(response,options={}) {
  const lines=(response?.lines??[]).map(line=>({text:line.original}));
  const structure=response?.metadata?.lyric_structure;
  const protectedIndices=new Set((structure?.occurrences??[]).flatMap((o,i)=>o.lyricText===lines[i]?.text && o.sourcePrefix?[i]:[]));
  return lyricCreditRoles(lines,options,protectedIndices).size>0;
}

// Only a repeated Chinese^English provider convention is admitted. A stray
// caret, inline English sung phrase, mixed script target, or empty half stays intact.
export function separateProviderTranslation(data) {
  if(data.providerTranslation) return data;
  const rows=data.lines??[];
  const pairs=rows.map(row=>{
    const parts=row.text?.split('^');
    if(parts?.length!==2) return null;
    const [source,target]=parts.map(x=>x.trim());
    return /\p{Script=Han}/u.test(source) && !/[A-Za-z]/u.test(source)
      && /[A-Za-z]/u.test(target) && !/\p{Script=Han}/u.test(target)?{source,target}:null;
  });
  if(pairs.filter(Boolean).length<3 || pairs.filter(Boolean).length<rows.filter(r=>r.text?.trim()).length*.8) return data;
  return {...data,lines:rows.map((row,i)=>pairs[i]?revalidatedVocalLine(row,pairs[i].source):row),providerTranslation:{language:'en',
    source:data.source??'unknown',kind:'provider',lines:pairs.flatMap((pair,i)=>pair?[{sourceID:`L${String(i+1).padStart(4,'0')}`,
      sourceText:pair.source,text:pair.target,original:rows[i].text}]:[])}};
}

// Retain performed source rows and a positional map across repeated cleaning.
// Timing correction may change timestamps without changing the source wording.
export function normalizeLyricAnnotations(data,options={}) {
  if(!data) return null;
  const paired=separateProviderTranslation(data);
  const input=(paired.lines??[]).filter(line=>typeof line.text==='string');
  const previous=data.lyricStructure;
  const reusable=previous?.version===LYRIC_NORMALIZATION_VERSION && previous.occurrences?.length===input.length
    && previous.occurrences.every((o,i)=>o.lyricText===input[i].text);
  const sourceRows=reusable?previous.sourceRows:input.map(line=>({text:line.text,timestamp:Number.isFinite(line.timestamp)?line.timestamp:null}));
  const aliases=performerAliases(options);
  const protectedIndices=new Set(reusable?previous.occurrences.flatMap((o,i)=>o.sourcePrefix?[i]:[]):[]);
  const creditRoles=lyricCreditRoles(input,options,protectedIndices);
  const hasNamedCue=input.some(line=>{
    const prefix=labelPrefix(line.text.trim());
    return prefix && namedPerformers(prefix.label,aliases);
  });
  const annotations=reusable?[...previous.annotations]:[];
  const speakers=reusable?previous.speakers.map(s=>({...s})):[];
  const speakerFor=(label,names)=>{
    const displayName=names.join(' / ');
    let speaker=speakers.find(s=>s.displayName===displayName);
    if(!speaker) {speaker={id:`S${speakers.length+1}`,sourceLabel:label,displayName};speakers.push(speaker);}
    return speaker.id;
  };
  const lines=[],occurrences=[],credits=[...(data.credits??[])],removed=new Set();
  let active=null,pendingTurn=false;
  input.forEach((line,i)=>{
    const original=reusable?previous.occurrences[i]:null;
    const sourceIndex=original?.sourceIndex??i,sourceText=original?.sourceText??line.text;
    const strippedPrefix=Boolean(original?.sourcePrefix);
    const text=line.text.trim();
    const heading=options.title && options.artist && labelKey(text)===labelKey(`${options.title} - ${options.artist}`);
    const rights=/^[【\[]?本作品声明[，,].*(?:著作权|著作權).*权利保留.*[】\]]?$/u.test(text);
    const role=strippedPrefix?null:heading?'recording_heading':rights?'rights_notice':creditRoles.get(i);
    if(!text || role || (!strippedPrefix && (instrumental.test(text) || isMusicNotePlaceholder(text)))) {
      if(role) {
        const match=text.match(/^([^:：]+)[:：]\s*(.+)$/u);
        const credit={role:role==='recording_heading'?'Recording':role==='rights_notice'?'Rights':match?.[1].trim()??'Source',contributors:match?match[2].split(/\s*[、/／&，,]\s*/u).filter(Boolean):[],
          source:data.source??'unknown',original:text};
        if(!credits.some(c=>c.original===text && c.source===credit.source)) credits.push(credit);
      }
      removed.add(sourceIndex);return;
    }
    const prefix=strippedPrefix?null:labelPrefix(text);
    const names=prefix && (namedPerformers(prefix.label,aliases)
      ?? (hasNamedCue && genericLabels.has(labelKey(prefix.label))?[genericLabels.get(labelKey(prefix.label))]:null));
    let lyricText=text,sourcePrefix=original?.sourcePrefix??'',startsTurn=original?.startsTurn??false;
    if(names) {
      active=speakerFor(prefix.label,names);pendingTurn=true;startsTurn=true;
      annotations.push({sourceIndex,kind:'performer_cue',speakerID:active,sourceLabel:prefix.label});
      lyricText=prefix.body.trim();sourcePrefix=sourceText.slice(0,sourceText.indexOf(text)+text.length-prefix.body.length+(prefix.body.match(/^\s*/u)?.[0]?.length??0));
      if(!lyricText) return;
    } else if(original?.speakerID) active=original.speakerID;
    startsTurn=startsTurn||pendingTurn;pendingTurn=false;
    lines.push(revalidatedVocalLine(line,lyricText));
    occurrences.push({sourceID:`L${String(lines.length).padStart(4,'0')}`,sourceIndex,sourceText,
      lyricText,sourcePrefix,speakerID:active,startsTurn});
  });
  // Credits and empty/instrumental markers have no hidden copy in a source
  // array. Keep performed speaker cues and remap positions after extraction.
  const retained=sourceRows.map((row,index)=>({row,index})).filter(({index})=>!removed.has(index));
  const positions=new Map(retained.map(({index},i)=>[index,i]));
  const translationByInput=new Map((paired.providerTranslation?.lines??[]).map(row=>[row.sourceID,row]));
  const providerLines=occurrences.flatMap(o=>{
    const row=translationByInput.get(`L${String(o.sourceIndex+1).padStart(4,'0')}`);
    return row?[{...row,sourceID:o.sourceID,sourceText:o.lyricText}]:[];
  });
  const providerTranslation=reusable?data.providerTranslation:providerLines.length?{...paired.providerTranslation,lines:providerLines}:undefined;
  return {...data,lines,credits,...(providerTranslation?{providerTranslation}:{}),lyricStructure:{version:LYRIC_NORMALIZATION_VERSION,
    sourceRows:retained.map(({row})=>row),annotations:annotations.filter(a=>positions.has(a.sourceIndex)).map(a=>({...a,sourceIndex:positions.get(a.sourceIndex)})),
    speakers,occurrences:occurrences.map(o=>({...o,sourceIndex:positions.get(o.sourceIndex)}))}};
}

export function validLyricStructure(structure,lines) {
  if(structure?.version!==LYRIC_NORMALIZATION_VERSION || !Array.isArray(structure.sourceRows)
    || structure.sourceRows.length>1000 || !Array.isArray(structure.speakers)
    || !Array.isArray(structure.annotations) || !Array.isArray(structure.occurrences)
    || structure.occurrences.length!==lines.length) return false;
  const text=value=>typeof value==='string' && value.length<=4000 && !/[\r\n]/u.test(value);
  if(structure.sourceRows.some(r=>!text(r?.text) || (r.timestamp!==null && !Number.isFinite(r.timestamp)))) return false;
  const ids=new Set();
  for(const speaker of structure.speakers) {
    if(!/^S[1-9]\d*$/u.test(speaker?.id??'') || ids.has(speaker.id)
      || !text(speaker.sourceLabel) || !speaker.sourceLabel || !text(speaker.displayName) || !speaker.displayName) return false;
    ids.add(speaker.id);
  }
  const index=value=>Number.isInteger(value) && value>=0 && value<structure.sourceRows.length;
  if(structure.annotations.some(a=>!index(a?.sourceIndex)
    || !['performer_cue'].includes(a.kind)
    || (a.kind==='performer_cue' && (!ids.has(a.speakerID) || !text(a.sourceLabel))))) return false;
  return structure.occurrences.every((o,i)=>index(o?.sourceIndex)
    && (!i || o.sourceIndex>structure.occurrences[i-1].sourceIndex)
    && o.sourceID===`L${String(i+1).padStart(4,'0')}` && o.lyricText===lines[i].original
    && o.sourceText===structure.sourceRows[o.sourceIndex].text && text(o.sourcePrefix)
    && o.sourceText.startsWith(o.sourcePrefix) && o.sourceText.slice(o.sourcePrefix.length).trim()===o.lyricText
    && (o.speakerID===null || ids.has(o.speakerID)) && typeof o.startsTurn==='boolean'
    && (!o.startsTurn || o.speakerID!==null));
}
