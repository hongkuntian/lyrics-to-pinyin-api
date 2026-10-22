// Optional measured cues must describe the exact emitted text. Gaps are valid;
// a grapheme, surrogate pair or source token is never split to manufacture cues.
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
export const MAX_LYRIC_SECONDS=7200;
// QQ's authoritative interval is whole seconds. Explicit precision evidence
// admits only the unreported fraction below the next second, never a rescale.
export function timingDurationLimit(duration,resolution=0) {
 if(!Number.isFinite(duration)||duration<=0||duration>MAX_LYRIC_SECONDS
  ||![0,1].includes(resolution)||resolution===1&&!Number.isInteger(duration))return null;
 return duration+resolution;
}
export function validTimingTimestamp(time,{duration=MAX_LYRIC_SECONDS,durationResolution=0}={}) {
 const limit=timingDurationLimit(duration,durationResolution);
 return limit!==null&&Number.isFinite(time)&&time>=0&&time<=MAX_LYRIC_SECONDS
  &&(durationResolution===1?time<limit:time<=limit);
}
export function validVocalTiming(line,{duration=MAX_LYRIC_SECONDS,durationResolution=0}={}) {
 const text=line?.original??line?.text,t=line?.vocalTiming,start=line?.timestamp;
 const bounds={duration,durationResolution};
 if(typeof text!=='string'||text.length>2000||/\p{Surrogate}/u.test(text)||!t||!validTimingTimestamp(start,bounds)
  ||!validTimingTimestamp(t.end,bounds)||t.end<=start
  ||!Array.isArray(t.segments)||!t.segments.length||t.segments.length>1024)return false;
 const boundaries=new Set([...segmenter.segment(text)].map(s=>s.index).concat(text.length));
 let previousTime=start,previousRange=0;
 for(const s of t.segments){
  if(!Number.isSafeInteger(s?.utf16Start)||!Number.isSafeInteger(s.utf16Length)||s.utf16Start<previousRange||s.utf16Length<=0
   ||!boundaries.has(s.utf16Start)||!boundaries.has(s.utf16Start+s.utf16Length)
   ||text.slice(s.utf16Start,s.utf16Start+s.utf16Length)!==s.text
   ||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<previousTime||s.end<=s.start||s.end>t.end)return false;
  previousTime=s.end;previousRange=s.utf16Start+s.utf16Length;
 }
 return true;
}
export function revalidatedVocalLine(line,text=line.text,options={}) {
 const {vocalTiming,...rest}=line;
 if(!validVocalTiming(line,options))return {...rest,text};
 if(text===line.text)return {...rest,text,vocalTiming};
 // Outer whitespace is display cleanup, not a different sung token. Preserve
 // every source interval while projecting its exact UTF16 range onto the
 // trimmed text. No other text edit (including a speaker prefix) grants cues.
 if(typeof text!=='string'||!text||text!==line.text.trim())return {...rest,text};
 const offset=line.text.length-line.text.trimStart().length,end=offset+text.length;
 const boundaries=new Set([...segmenter.segment(line.text)].map(s=>s.index).concat(line.text.length));
 if(!boundaries.has(offset)||!boundaries.has(end))return {...rest,text};
 const segments=vocalTiming.segments.flatMap(segment=>{
  const start=Math.max(offset,segment.utf16Start),stop=Math.min(end,segment.utf16Start+segment.utf16Length);
  return start<stop?[{...segment,utf16Start:start-offset,utf16Length:stop-start,text:line.text.slice(start,stop)}]:[];
 });
 const projected={...rest,text,vocalTiming:{...vocalTiming,segments}};
 return validVocalTiming(projected,options)?projected:{...rest,text};
}
const sourceFormats={netease:'yrc',kugou:'krc',qq:'qrc'};
const sourcePattern=/^(?:netease:\d{1,20}:yrc|kugou:\d{1,20}:krc|qq:\d{1,20}:qrc)$/;
const validResolution=(value,source)=>value===undefined||value===1&&/^qq:\d{1,20}:qrc$/.test(source??'');
export function validSourceTiming(lyrics,sourceID=lyrics?.songId) {
 return /^\d{1,20}$/.test(String(sourceID??''))&&String(lyrics?.songId)===String(sourceID)
  &&Object.hasOwn(sourceFormats,lyrics?.source??'')
  &&lyrics.timingSource?.source===`${lyrics.source}:${sourceID}:${sourceFormats[lyrics.source]}`
  &&validResolution(lyrics.durationResolution,lyrics.timingSource?.source)
  &&/^[a-f0-9]{64}$/.test(lyrics.timingSource?.revision??'');
}
export const sourceDurationResolution=(lyrics,sourceID=lyrics?.songId)=>
 validSourceTiming(lyrics,sourceID)&&lyrics.durationResolution===1?1:0;
// Count meaningful graphemes on the exact cleaned source edition. Silent
// punctuation/space does not require a cue; every letter/number does. An
// invalid row extension contributes no coverage, never guessed durations.
export function vocalCoverage(lines,{duration=MAX_LYRIC_SECONDS,durationResolution=0,provenance=true}={}) {
 let covered=0,total=0;
 for(const line of lines??[]) {
  const text=line?.original??line?.text;
  if(typeof text!=='string')continue;
  const segments=provenance&&validVocalTiming(line,{duration,durationResolution})?line.vocalTiming.segments:[];
  let at=0;
  for(const g of segmenter.segment(text)) {
   if(!/[\p{L}\p{N}]/u.test(g.segment))continue;
   total++;
   while(at<segments.length&&segments[at].utf16Start+segments[at].utf16Length<=g.index)at++;
   const s=segments[at];
   if(s&&s.utf16Start<=g.index&&s.utf16Start+s.utf16Length>=g.index+g.segment.length)covered++;
  }
 }
 return {covered,total,complete:total>0&&covered===total};
}
export function validTimingProvenance(value) {
 return value?.version===1&&['spotify','appleMusic'].includes(value.provider)
  &&(value.provider==='spotify'?/^[a-zA-Z0-9]{22}$/:/^\d{1,20}$/).test(value.recordingID??'')
  &&sourcePattern.test(value.source??'')&&/^[a-f0-9]{64}$/.test(value.revision??'')
  &&validResolution(value.durationResolution,value.source);
}
export function attachVocalTiming(response,lyrics,{provider,recordingID,sourceID}) {
 const source=lyrics?.timingSource;
 const provenance={version:1,provider,recordingID,source:source?.source,revision:source?.revision,
  ...(lyrics?.durationResolution!==undefined?{durationResolution:lyrics.durationResolution}:{})};
 const accepted=validSourceTiming(lyrics,sourceID)&&validTimingProvenance(provenance);
 response.lines=response.lines.map(line=>{
  const {vocalTiming,...rest}=line;
  return {...rest,...(accepted&&validVocalTiming(line,{duration:response.song.duration??MAX_LYRIC_SECONDS,
   durationResolution:sourceDurationResolution(lyrics,sourceID)})?{vocalTiming}:{} )};
 });
 delete response.metadata.lyric_timing;
 if(response.lines.some(l=>l.vocalTiming))response.metadata.lyric_timing=provenance;
 // Keep the durable 160 KB limit available to readable lyrics. Optional word
 // data must never turn an otherwise usable recording into source_too_large.
 if(Buffer.byteLength(JSON.stringify(response))>160_000)stripVocalTiming(response);
 return response;
}
export function stripVocalTiming(response) {
 response.lines=response.lines.map(({vocalTiming,...line})=>line);
 delete response.metadata.lyric_timing;
 return response;
}

// Both proofs are server-owned: the stored canonical relationship and the
// current accepted catalog request must agree before rebinding measured cues.
export function verifiedTimingAlias(proof,request,canonicalID) {
 const accepted=proof?.accepted_request;
 return /^apple:\d{1,20}$/.test(canonicalID??'')&&proof?.version==='catalog-recording-1'
  &&proof.canonical_recording_id===canonicalID&&/^\d{1,20}$/.test(request?.catalog_id??'')
  &&proof.catalog_items?.some(i=>i.catalog_id===request.catalog_id&&(i.storefront??null)===(request.storefront??null))
  &&accepted?.catalog_id===request.catalog_id&&accepted.artist===request.artist&&accepted.title===request.title
  &&(accepted.album??null)===(request.album??null)&&accepted.duration===request.duration
  &&proof.requested?.catalog_id===request.catalog_id&&(proof.requested?.storefront??null)===(request.storefront??null);
}
