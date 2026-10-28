import {createRequire} from 'node:module';
import chinese from 'chinese-conv';
import {revalidatedVocalLine} from './vocal-timing.js';
import {classifyLyricNotice} from './lyric-notices.js';
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
  [["制作助理","助理制作","助理制作人"],["production assistant","assistant producer"]],
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
// Match complete instrument/engineering roles with bounded production
// modifiers. A colon or an arbitrary suffix never establishes a credit.
const composedRole=/^(?:(?:(?:[1-9][0-9]?(?:st|nd|rd|th)|first|second|third|principal|lead|solo|assistant))?(?:strings?|violins?|violas?|cellos?|doublebass|contrabass|c\.?bass|guitars?|bass|drums?|piano|keyboards?|percussion|flute|saxophone|trumpet|trombone|horn|orchestra)(?:assistant|arrangement|arranger|recording(?:engineer|assistant)?|engineer|technician|contractor|director|conductor)?|(?:assistant|additional|chief|head)?(?:recording|mixing|mastering)(?:engineer|assistant|studio)?|(?:第?[一二三四五六七八九十0-9]+|首席|助理)?(?:弦乐|管弦乐|小提琴|中提琴|大提琴|低音提琴|倍低音提琴|吉他|贝斯|鼓|钢琴|键盘|打击乐|长笛|萨克斯|小号|长号|圆号|二胡|古筝|琵琶)(?:编写|编曲|录音|录音师|录音助理|助理|技师|统筹|监制|指挥|团)?)$/u;
// Rights/release roles compose bounded semantic parts, not arbitrary colon
// labels. Keep the complete-label grammar aligned with native display cleanup.
const ownershipRole=new RegExp([
  '^(?:',
  '(?:(?:词曲|词|曲|歌曲|音乐|录音(?:作品)?|音像|母带|mv|musicvideo)(?:[/&+、及和](?:词曲|词|曲|歌曲|音乐|录音(?:作品)?|音像|母带|mv|musicvideo))*)?(?:版权|[著着]作权)(?:管理|代理|运营|授权|许可|归属|所有)?(?:方|人|公司)?',
  '|(?:联合|共同|独家|全球|执行|协同)?(?:出品|制作|发行|出版|宣发|策划|营销|推广)(?:人|方|公司|团队|统筹|协力|支持)?',
  '|(?:(?:lyrics?|music|composition|soundrecording|master|musicvideo)(?:(?:and|&|/)(?:lyrics?|music|composition|soundrecording|master|musicvideo))*)?copyright(?:management|administration|administrator|owner|holder|licensing)?',
  '|(?:co-?|joint|executive|exclusive|global|additional)?(?:production|producer|presentation|presenter|distribution|distributor|publishing|publisher)(?:company|team)?',
  ')$'
].join(''),'u');
const artworkRole=/^(?:(?:封面|视觉|平面|美术|海报|包装|字体|视频)(?:设计|制作|统筹|总监|指导|绘制|插画|剪辑|后期|拍摄)|(?:cover|artwork|visual|graphic|poster|packaging|video|typography)(?:design|illustration|direction|production|editing|photography|coordination))$/u;
const engineeringRole=/^(?:录音|混音|母带)(?:后期)?(?:处理|制作)(?:工程师|师|室|工作室)?$/u;
// Vocal production combines a bounded vocal role with an explicit arranging
// task or guest-credit modifier. Bare chorus/backing-vocal cues stay ambiguous.
const vocalProductionRole=/^(?:(?:和声|和音|合声|伴唱|背景人声|合唱)(?:编谱|编写|编曲|编排|编配|设计)(?:及演唱)?|(?:友情|特邀|特别|嘉宾|客串)(?:大?合唱|和声|和音|合声|伴唱|背景人声)|(?:(?:backing|background)vocals?|vocals?|harmony|choral|choir)(?:arrangement|arranger)|guest(?:(?:backing|background)?vocals?|choir|chorus))$/u;
function compositeProductionRole(key) {
  const atom=part=>!ambiguousRoles.has(part)
    && (roleLabels.has(part)||[composedRole,ownershipRole,artworkRole,engineeringRole,vocalProductionRole].some(pattern=>pattern.test(part)));
  if(atom(key))return true;
  // Admit role lists only when every component is a complete production role.
  const parts=key.split(/[\/&+、及]|and/u);
  return parts.length>1&&parts.every(part=>part&&atom(part));
}
// A whole-row recording code may omit the ISRC label. Never match a code
// embedded in prose, a partial code, or a different numeric identifier.
const isrcPattern=/^\s*(?:ISRC\s*[:：]?\s*)?([A-Z]{2}-?[A-Z0-9]{3}-?[0-9]{2}-?[0-9](?:-?[0-9]){4})\s*$/iu;
function recordingCode(text) {
  if(text.length>80 || /[\r\n\v\f\u0085\u2028\u2029]/u.test(text))return null;
  return text.normalize('NFKC').match(isrcPattern)?.[1]??null;
}
const ambiguousRoles=new Set(['chorus','和声','和音','合声','backingvocal','backingvocals']);
const sourceCredit=/^取材自歌曲[《〈].+[》〉]\s*[（(]\s*[词詞]\s*[:：].+曲\s*[:：].+[）)]$/u;
const wrappedInstrumentals=new Set(['music','instrumental','interlude','intro','outro','间奏','前奏','尾奏','伴奏','纯音乐']);
const isInstrumentalMarker=text=>{
  if(instrumental.test(text))return true;
  if(/[\r\n\v\f\u0085\u2028\u2029]/u.test(text))return false;
  const key=labelKey(text);
  return ((key.startsWith('(')&&key.endsWith(')'))||(key.startsWith('[')&&key.endsWith(']'))
    ||(key.startsWith('【')&&key.endsWith('】')))&&wrappedInstrumentals.has(key.slice(1,-1));
};
const instrumental=/^(?:纯音乐[，,。\s]*(?:请欣赏)?|純音樂[，,。\s]*(?:請欣賞)?|instrumental)[。.!\s]*$/iu;
// Provider placeholders describe a break, not performed words. Keep notes
// embedded in actual lyrics; presentation owns the instrumental indicator.
const musicNotes=/^[♩♪♫♬🎵🎶\s\uFE0E\uFE0F]+$/u;
export const isMusicNotePlaceholder=text=>typeof text==='string' && musicNotes.test(text.trim());
const genericLabels=new Map([['合','All'],['合唱','All'],['齐唱','All'],['all','All'],['chorus','All'],['男','Male'],['女','Female']]);

// A cue annotation must name its referenced performer, not merely repeat the
// bracket/colon label on an arbitrary source row. Canonical names, the captured
// source-label components and reviewed member aliases provide bounded context.
function speakerLabelMatches(speaker,label) {
  if(labelKey(speaker.sourceLabel)===labelKey(label))return true;
  const generic=genericLabels.get(labelKey(speaker.sourceLabel));
  if(generic===speaker.displayName)return genericLabels.get(labelKey(label))===generic;
  const names=speaker.displayName.split(' / '),parts=speaker.sourceLabel.split(/\s*[/／&、]\s*/u),aliases=new Map();
  names.forEach((name,i)=>{
    aliases.set(labelKey(name),name);
    if(parts.length===names.length)aliases.set(labelKey(parts[i]),name);
    for(const artist of roster.artists)for(const member of artist.members??[])
      if(labelKey(member.name)===labelKey(name))for(const alias of member.aliases??[])aliases.set(labelKey(alias),name);
  });
  const matched=namedPerformers(label,aliases);
  return matched!==null&&labelKey(matched.join(' / '))===labelKey(speaker.displayName);
}

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
  if(/[\r\n\v\f\u0085\u2028\u2029]/u.test(text))return null;
  if(sourceCredit.test(text)) return 'source_credit';
  if(recordingCode(text)) return 'production_credit';
  const parts=text.match(/^([^:：]+)[:：](.*)$/u);
  if(!parts || parts[1].length>120 || !parts[2].trim()) return null;
  const key=labelKey(parts[1]);
  if(ambiguousRoles.has(key)) {
    // Explicit Chinese/English backing-vocal role plus a compact roster; an
    // unlabelled sung chorus and long spoken sentences are not production credits.
    const roster=parts[2].trim();
    const compactNames=/^[\p{Script=Han}]{2,4}(?:[ 、/／&,，]+[\p{Script=Han}]{2,4})+$/u.test(roster);
    return namedPerformers(roster,aliases) || (key!=='chorus' && compactNames)?'production_credit':null;
  }
  return roleLabels.has(key)||composedRole.test(key)
    || (compositeProductionRole(key)&&!namedPerformers(parts[1],aliases))?'production_credit':null;
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

// A verified performer cue is parsed before metadata. Its body is performed
// text even when it happens to spell a complete credit or notice.
function performedCueIndices(lines,aliases) {
  const prefixes=lines.map(line=>labelPrefix(line.text.trim()));
  const named=prefixes.some(prefix=>prefix&&namedPerformers(prefix.label,aliases));
  return new Set(prefixes.flatMap((prefix,i)=>prefix&&(namedPerformers(prefix.label,aliases)
    ||(named&&genericLabels.has(labelKey(prefix.label))))?[i]:[]));
}
export function hasEmbeddedLyricCredits(response,options={}) {
  const lines=(response?.lines??[]).map(line=>({text:line.original??''}));
  const structure=response?.metadata?.lyric_structure;
  const context={artist:response?.song?.artist?.original??'',...options};
  const protectedIndices=performedCueIndices(lines,performerAliases(context));
  // Public speaker IDs and unchecked prefix flags are not canonical evidence.
  const canonicalValid=validLyricStructure(structure,response?.lines??[]);
  if(canonicalValid)
    structure.occurrences.forEach((o,i)=>{if(o.sourcePrefix)protectedIndices.add(i);});
  const canonicalCues=canonicalValid?new Set(structure.annotations.map(a=>a.sourceIndex)):new Set();
  return lyricCreditRoles(lines,context,protectedIndices).size>0
    ||lines.some((line,i)=>!protectedIndices.has(i)&&classifyLyricNotice(line.text))
    ||(Array.isArray(structure?.sourceRows)&&structure.sourceRows.some((row,i)=>!canonicalCues.has(i)&&classifyLyricNotice(row?.text)));
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
  const reusable=validLyricStructure(previous,input.map(line=>({original:line.text})));
  const sourceRows=reusable?previous.sourceRows:input.map(line=>({text:line.text,timestamp:Number.isFinite(line.timestamp)?line.timestamp:null}));
  const aliases=performerAliases(options);
  const protectedIndices=performedCueIndices(input,aliases);
  if(reusable)previous.occurrences.forEach((o,i)=>{if(o.sourcePrefix)protectedIndices.add(i);});
  const creditRoles=lyricCreditRoles(input,options,protectedIndices);
  const hasNamedCue=input.some(line=>{
    const prefix=labelPrefix(line.text.trim());
    return prefix && namedPerformers(prefix.label,aliases);
  });
  const annotations=reusable?[...previous.annotations]:[];
  const speakers=reusable?previous.speakers.map(s=>({...s})):[];
  const speakerFor=(label,names)=>{
    const displayName=names.join(' / ');
    let speaker=speakers.find(s=>s.displayName===displayName&&speakerLabelMatches(s,label));
    if(!speaker) {speaker={id:`S${speakers.length+1}`,sourceLabel:label,displayName};speakers.push(speaker);}
    return speaker.id;
  };
  const canonicalCues=new Set(reusable?previous.annotations.map(a=>a.sourceIndex):protectedIndices);
  const lines=[],occurrences=[],translationInputs=[],credits=[...(data.credits??[])],
    removed=new Set(sourceRows.flatMap((row,i)=>!canonicalCues.has(i)&&classifyLyricNotice(row.text)?[i]:[]));
  let active=null,pendingTurn=false;
  input.forEach((line,i)=>{
    const original=reusable?previous.occurrences[i]:null;
    const sourceIndex=original?.sourceIndex??i,sourceText=original?.sourceText??line.text;
    const strippedPrefix=Boolean(original?.sourcePrefix);
    const text=/[\r\n\v\f\u0085\u2028\u2029]/u.test(line.text)?line.text:line.text.trim();
    const heading=options.title && options.artist && labelKey(text)===labelKey(`${options.title} - ${options.artist}`);
    const notice=protectedIndices.has(i)?null:classifyLyricNotice(line.text);
    const role=protectedIndices.has(i)?null:notice??(heading?'recording_heading':creditRoles.get(i));
    if(!text || role || (!strippedPrefix && (isInstrumentalMarker(text) || isMusicNotePlaceholder(text)))) {
      if(role && !notice) {
        const match=text.match(/^([^:：]+)[:：]\s*(.+)$/u);
        const isrc=recordingCode(text);
        const credit={role:role==='recording_heading'?'Recording':isrc?'ISRC':match?.[1].trim()??'Source',contributors:isrc?[isrc]:match?match[2].split(/\s*[、/／&，,]\s*/u).filter(Boolean):[],
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
    translationInputs.push(i);
    occurrences.push({sourceID:`L${String(lines.length).padStart(4,'0')}`,sourceIndex,sourceText,
      lyricText,sourcePrefix,speakerID:active,startsTurn});
  });
  // Credits and empty/instrumental markers have no hidden copy in a source
  // array. Keep performed speaker cues and remap positions after extraction.
  const retained=sourceRows.map((row,index)=>({row,index})).filter(({index})=>!removed.has(index));
  const positions=new Map(retained.map(({index},i)=>[index,i]));
  const translationByInput=new Map((paired.providerTranslation?.lines??[]).map(row=>[row.sourceID,row]));
  const providerLines=occurrences.flatMap((o,i)=>{
    // Translations address the current visible input, including on a repair
    // pass whose canonical source indices still contain hidden speaker rows.
    const row=translationByInput.get(`L${String(translationInputs[i]+1).padStart(4,'0')}`);
    return row?[{...row,sourceID:o.sourceID,sourceText:o.lyricText}]:[];
  });
  const providerTranslation=providerLines.length?{...paired.providerTranslation,lines:providerLines}:undefined;
  return {...data,lines,credits,...(paired.providerTranslation?{providerTranslation}:{}),lyricStructure:{version:LYRIC_NORMALIZATION_VERSION,
    sourceRows:retained.map(({row})=>row),annotations:annotations.filter(a=>positions.has(a.sourceIndex)).map(a=>({...a,sourceIndex:positions.get(a.sourceIndex)})),
    speakers,occurrences:occurrences.map(o=>({...o,sourceIndex:positions.get(o.sourceIndex)}))}};
}

export function validLyricStructure(structure,lines) {
  if(structure?.version!==LYRIC_NORMALIZATION_VERSION || !Array.isArray(structure.sourceRows)
    || structure.sourceRows.length>1000 || !Array.isArray(structure.speakers)
    || !Array.isArray(structure.annotations) || !Array.isArray(structure.occurrences)
    || structure.occurrences.length!==lines.length) return false;
  const text=value=>typeof value==='string' && value.length<=4000 && !/[\r\n\v\f\u0085\u2028\u2029]/u.test(value);
  if(structure.sourceRows.some(r=>!text(r?.text) || (r.timestamp!==null && !Number.isFinite(r.timestamp)))) return false;
  const ids=new Set();
  for(const speaker of structure.speakers) {
    if(!/^S[1-9]\d*$/u.test(speaker?.id??'') || ids.has(speaker.id)
      || !text(speaker.sourceLabel) || !speaker.sourceLabel || !text(speaker.displayName) || !speaker.displayName) return false;
    ids.add(speaker.id);
  }
  const index=value=>Number.isInteger(value) && value>=0 && value<structure.sourceRows.length;
  if(structure.annotations.some(a=>{
    if(!index(a?.sourceIndex)||a.kind!=='performer_cue'||!ids.has(a.speakerID)||!text(a.sourceLabel))return true;
    const parsed=labelPrefix(structure.sourceRows[a.sourceIndex].text.trim());
    const speaker=structure.speakers.find(s=>s.id===a.speakerID);
    return !parsed||labelKey(parsed.label)!==labelKey(a.sourceLabel)||!speakerLabelMatches(speaker,a.sourceLabel);
  }))return false;
  const prefixProof=o=>{
    if(!o.sourcePrefix)return true;
    const parsed=labelPrefix(o.sourceText.trim());
    if(!parsed||!o.speakerID||parsed.body.trim()!==o.lyricText)return false;
    const leading=o.sourceText.length-o.sourceText.trimStart().length;
    const length=leading+parsed.prefix.length+(parsed.body.match(/^\s*/u)?.[0].length??0);
    return o.sourcePrefix===o.sourceText.slice(0,length)
      &&structure.annotations.some(a=>a.sourceIndex===o.sourceIndex&&a.speakerID===o.speakerID
        &&labelKey(a.sourceLabel)===labelKey(parsed.label));
  };
  return structure.occurrences.every((o,i)=>index(o?.sourceIndex)
    && (!i || o.sourceIndex>structure.occurrences[i-1].sourceIndex)
    && o.sourceID===`L${String(i+1).padStart(4,'0')}` && o.lyricText===lines[i].original
    && o.sourceText===structure.sourceRows[o.sourceIndex].text && text(o.sourcePrefix)
    && o.sourceText.startsWith(o.sourcePrefix) && o.sourceText.slice(o.sourcePrefix.length).trim()===o.lyricText
    && (o.speakerID===null || ids.has(o.speakerID)) && typeof o.startsTurn==='boolean'
    && (!o.startsTurn || o.speakerID!==null) && prefixProof(o));
}
