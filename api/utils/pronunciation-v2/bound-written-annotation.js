import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {writtenProfileV2For} from './written-profiles.js';
import {analyzeRussianWritten} from './russian-written.js';
import {analyzeHindiWritten} from './hindi-written.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hex=/^[a-f0-9]{64}$/;
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const egcs=text=>Array.from(segmenter.segment(text),part=>part.segment);
const need=(condition,message)=>{if(!condition)throw new TypeError(message);};

// source is an independently reconstructed server/native snapshot, NOT fields
// recovered from the annotation being validated. Access/epoch checks belong to
// the caller before and after asynchronous persistence or consumption.
function sourceSnapshot(source){
  need(source&&typeof source==='object','Independent trusted source snapshot required');
  source=structuredClone(source);
  for(const name of ['documentID','sourceHash','textRevision','contextRevision'])
    need(typeof source[name]==='string'&&hex.test(source[name]),'Missing trusted source binding: '+name);
  need(Array.isArray(source.occurrences)&&source.occurrences.length>0&&source.occurrences.length<=250,'Invalid trusted occurrences');
  const order=new Map();
  for(const [index,row] of source.occurrences.entries()){
    need(row&&typeof row.sourceID==='string'&&row.sourceID.length>0&&!order.has(row.sourceID),'Invalid/duplicate occurrence');
    need(typeof row.lyricText==='string','Missing original lyric body');order.set(row.sourceID,index);
  }
  need(Array.isArray(source.resolvedRanges),'Trusted resolved language ranges required');
  let prior=[-1,-1];
  for(const range of source.resolvedRanges){
    const rank=order.get(range.sourceID),row=source.occurrences[rank];
    need(row&&Number.isInteger(range.lower)&&Number.isInteger(range.upper)&&range.lower>=0
      &&range.upper>range.lower&&range.upper<=egcs(row.lyricText).length,'Invalid trusted EGC language range');
    need(typeof range.language==='string'&&range.language.length>0,'Missing resolved range language');
    need(rank>prior[0]||rank===prior[0]&&range.lower>=prior[1],'Unordered/overlapping trusted ranges');
    prior=[rank,range.upper];
  }
  return source;
}

const binding=source=>({documentID:source.documentID,sourceHash:source.sourceHash,
  textRevision:source.textRevision,contextRevision:source.contextRevision});
const key=(source,profile)=>hash({namespace:'pronunciation-envelope-2',...binding(source),
  profileID:profile.id,profileVersion:profile.version,engineVersion:profile.engineVersion,
  dataRevision:profile.dataRevision,speechSemanticsVersion:profile.speechSemanticsVersion});
const readingRevision=annotation=>hash({namespace:'pronunciation-reading-2',...binding(annotation),
  engineVersion:annotation.profile.engineVersion,dataRevision:annotation.profile.dataRevision,
  canonicalReadingKind:annotation.profile.canonicalReadingKind,
  lines:annotation.lines.map(line=>({sourceID:line.sourceID,segments:line.segments.map(segment=>({
    lower:segment.lower,upper:segment.upper,source:segment.source,reading:segment.reading,
    status:segment.status,readingBasis:segment.readingBasis,entryRefs:[],alternatives:[]}))}))});
const speechRevision=annotation=>hash({namespace:'pronunciation-speech-1',readingRevision:annotation.readingRevision,
  semantics:annotation.profile.speechSemanticsVersion,
  lines:annotation.lines.map(line=>({sourceID:line.sourceID,segments:line.segments.map(segment=>({
    lower:segment.lower,upper:segment.upper,speechStatus:segment.speechStatus,
    speechSemanticsVersion:segment.speechSemanticsVersion,spokenText:null,spokenScript:null,spokenBasis:null}))}))});

function linesFor(source,profile){
  const analyze=profile.sourceLanguage==='ru'?analyzeRussianWritten:analyzeHindiWritten;
  return source.occurrences.map(row=>{
    const chars=egcs(row.lyricText),ranges=source.resolvedRanges.filter(range=>range.sourceID===row.sourceID
      &&range.language===profile.sourceLanguage),segments=[];let cursor=0;
    const plain=(lower,upper)=>({lower,upper,source:chars.slice(lower,upper).join(''),reading:null,aid:null,
      status:'verbatim',readingBasis:'none',speechStatus:'unavailable',speechSemanticsVersion:profile.speechSemanticsVersion});
    for(const range of ranges){
      if(cursor<range.lower)segments.push(plain(cursor,range.lower));
      const selected=chars.slice(range.lower,range.upper).join('');
      for(const segment of analyze(selected).segments)segments.push({...segment,
        lower:range.lower+segment.lower,upper:range.lower+segment.upper,
        speechStatus:'unavailable',speechSemanticsVersion:profile.speechSemanticsVersion});
      cursor=range.upper;
    }
    if(cursor<chars.length)segments.push(plain(cursor,chars.length));
    return {sourceID:row.sourceID,text:segments.map(segment=>segment.aid??segment.source).join(''),segments};
  });
}

export function writtenAnnotationV2(trustedSource,profileID){
  const source=sourceSnapshot(trustedSource),profile=writtenProfileV2For(profileID);
  const annotation={version:2,id:key(source,profile),...binding(source),profile,
    offsetUnit:'grapheme',textScope:'lyric-body',readingRevision:'',speechRevision:'',
    lines:linesFor(source,profile),entries:[],dataSources:[]};
  annotation.readingRevision=readingRevision(annotation);annotation.speechRevision=speechRevision(annotation);
  encodeWrittenReady(annotation);return annotation;
}

export function validateWrittenAnnotationV2(annotation,independentTrustedSource){
  // Reconstruction checks every field, complete row/range coverage and exact
  // transform, rather than trusting a payload's claimed status or own hashes.
  const expected=writtenAnnotationV2(independentTrustedSource,annotation?.profile?.id);
  need(isDeepStrictEqual(annotation,expected),'Written pronunciation v2 does not match trusted source/profile');
  return true;
}

export function encodeWrittenReady(annotation){
  const value=JSON.stringify({version:1,state:'ready',pronunciation:annotation});
  if(Buffer.byteLength(value,'utf8')>1_800_000){
    const error=new RangeError('Pronunciation envelope exceeds 1800000 bytes');
    error.code='pronunciation_envelope_too_large';throw error;
  }
  return value;
}
