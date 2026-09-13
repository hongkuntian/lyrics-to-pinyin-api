import {createRequire} from 'node:module';
import chinese from 'chinese-conv';
const require=createRequire(import.meta.url);
const roster=require('../data/lyric-performers.json');
export const LYRIC_NORMALIZATION_VERSION='lyric-annotations-1';
export const LYRIC_SELECTION_REVISION='lyrics-selection-2026-09-13-vocal-text';
export const reviewedSpeakerLabels=catalogID=>roster.reviewedRecordings[catalogID]??{};

// Normalize labels for comparison only. Never rewrite the sung words.
const labelKey=text=>chinese.sify(text).normalize('NFKC').toLowerCase().replace(/\s+/gu,'');
// Each row is one role with equivalent names. Bilingual labels must consume the
// entire label and describe the same role; arbitrary English suffixes are unsafe.
const roles=[
  [['词','作词','填词','改编词'],['lyrics','lyrics by','lyricist']],
  [['曲','作曲'],['composer','composed by','composition']],
  [['词曲'],['music and lyrics','lyrics and music']],
  [['编曲'],['arrangement','arranger','arranged by']],
  [['制作人','制作'],['producer','produced by','production']],
  [['配唱制作人','配唱制作'],['vocal producer','vocal production']],
  [['监制'],['executive producer','supervisor']],
  [['统筹'],['coordinator','coordination']],
  [['出品人'],['presenter']],
  [['录音','录音师','录音工程师'],['recorded by','recording engineer','recording']],
  [['录音室','录音棚'],['recording studio']],
  [['混音','混音师','混音工程师'],['mixed by','mixing engineer','mixing']],
  [['母带','母带工程师','母带处理工程师'],['mastered by','mastering engineer','mastering']],
  [['混音/母带处理工作室'],['mixing/mastering studio']],
  [['和声'],['backing vocal','backing vocals']],
  [['人声编辑'],['vocal editing','vocal editor']],
  [['弦乐'],['strings']], [['吉他'],['guitar']],
  [['木吉他','原声吉他'],['acoustic guitar']], [['吉他独奏'],['guitar solo']],
  [['贝斯'],['bass']], [['鼓'],['drums']], [['钢琴'],['piano']],
  [['音乐总监'],['music director']], [['发行','发行公司'],['distribution','distributor']],
  [['出品','版权'],['copyright']], [['制作公司'],['production company']],
  [[],['programming','publisher']]
];
const roleLabels=new Set(roles.flatMap(([zh,en])=>[
  ...zh,...en,...zh.flatMap(a=>en.flatMap(b=>[a+b,b+a,a+'('+b+')',b+'('+a+')']))
]).map(labelKey));
const ambiguousRoles=new Set(['chorus','和声','backingvocal','backingvocals']);
const sourceCredit=/^取材自歌曲[《〈].+[》〉]\s*[（(]\s*[词詞]\s*[:：].+曲\s*[:：].+[）)]$/u;
const instrumental=/^(?:纯音乐[，,。\s]*(?:请欣赏)?|純音樂[，,。\s]*(?:請欣賞)?|instrumental)[。.!\s]*$/iu;
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
  if(ambiguousRoles.has(key)) return namedPerformers(parts[2].trim(),aliases)?'production_credit':null;
  return roleLabels.has(key)?'production_credit':null;
}

// Retain source rows and an explicit positional map across repeated cleaning.
// Timing correction may change timestamps without changing the source wording.
export function normalizeLyricAnnotations(data,options={}) {
  if(!data) return null;
  const input=(data.lines??[]).filter(line=>typeof line.text==='string');
  const previous=data.lyricStructure;
  const reusable=previous?.version===LYRIC_NORMALIZATION_VERSION && previous.occurrences?.length===input.length
    && previous.occurrences.every((o,i)=>o.lyricText===input[i].text);
  const sourceRows=reusable?previous.sourceRows:input.map(line=>({text:line.text,timestamp:Number.isFinite(line.timestamp)?line.timestamp:null}));
  const aliases=performerAliases(options);
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
  const lines=[],occurrences=[];
  let active=null,pendingTurn=false;
  input.forEach((line,i)=>{
    const original=reusable?previous.occurrences[i]:null;
    const sourceIndex=original?.sourceIndex??i,sourceText=original?.sourceText??line.text;
    const text=line.text.trim(),role=creditRole(text,aliases);
    if(!text || role || instrumental.test(text)) {
      annotations.push({sourceIndex,kind:role??(text?'instrumental_marker':'empty')});return;
    }
    const prefix=original?.speakerID?null:labelPrefix(text);
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
    lines.push({...line,text:lyricText});
    occurrences.push({sourceID:`L${String(lines.length).padStart(4,'0')}`,sourceIndex,sourceText,
      lyricText,sourcePrefix,speakerID:active,startsTurn});
  });
  return {...data,lines,lyricStructure:{version:LYRIC_NORMALIZATION_VERSION,sourceRows,annotations,speakers,occurrences}};
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
    || !['production_credit','source_credit','performer_cue','instrumental_marker','empty'].includes(a.kind)
    || (a.kind==='performer_cue' && (!ids.has(a.speakerID) || !text(a.sourceLabel))))) return false;
  return structure.occurrences.every((o,i)=>index(o?.sourceIndex)
    && (!i || o.sourceIndex>structure.occurrences[i-1].sourceIndex)
    && o.sourceID===`L${String(i+1).padStart(4,'0')}` && o.lyricText===lines[i].original
    && o.sourceText===structure.sourceRows[o.sourceIndex].text && text(o.sourcePrefix)
    && o.sourceText.startsWith(o.sourcePrefix) && o.sourceText.slice(o.sourcePrefix.length).trim()===o.lyricText
    && (o.speakerID===null || ids.has(o.speakerID)) && typeof o.startsTurn==='boolean'
    && (!o.startsTurn || o.speakerID!==null));
}
