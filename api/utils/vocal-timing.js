// Optional measured cues must describe the exact emitted text. Gaps are valid;
// a grapheme, surrogate pair or source token is never split to manufacture cues.
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
export const MAX_LYRIC_SECONDS=7200;
export function validVocalTiming(line,{duration=MAX_LYRIC_SECONDS}={}) {
 const text=line?.original??line?.text,t=line?.vocalTiming,start=line?.timestamp;
 if(typeof text!=='string'||text.length>2000||/\p{Surrogate}/u.test(text)||!t||!Number.isFinite(start)||start<0||!Number.isFinite(duration)||duration<=0
  ||!Number.isFinite(t.end)||t.end<=start||t.end>Math.min(duration,MAX_LYRIC_SECONDS)
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
 return {...rest,text,...(text===line.text&&validVocalTiming(line,options)?{vocalTiming}:{} )};
}
const sourcePattern=/^netease:\d{1,20}:yrc$/;
export function validTimingProvenance(value) {
 return value?.version===1&&['spotify','appleMusic'].includes(value.provider)
  &&(value.provider==='spotify'?/^[a-zA-Z0-9]{22}$/:/^\d{1,20}$/).test(value.recordingID??'')
  &&sourcePattern.test(value.source??'')&&/^[a-f0-9]{64}$/.test(value.revision??'');
}
export function attachVocalTiming(response,lyrics,{provider,recordingID,sourceID}) {
 const source=lyrics?.timingSource;
 const provenance={version:1,provider,recordingID,source:source?.source,revision:source?.revision};
 const accepted=lyrics?.source==='netease'&&String(lyrics.songId)===String(sourceID)
  &&source?.source===`netease:${sourceID}:yrc`&&validTimingProvenance(provenance);
 response.lines=response.lines.map(line=>{
  const {vocalTiming,...rest}=line;
  return {...rest,...(accepted&&validVocalTiming(line,{duration:response.song.duration??MAX_LYRIC_SECONDS})?{vocalTiming}:{} )};
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
