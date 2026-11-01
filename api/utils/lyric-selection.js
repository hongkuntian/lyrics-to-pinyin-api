import {lyricScriptFit,isLatinScriptFallback} from './lyric-script.js';
import {timingRejectionReason,responseTimingNeedsRefresh} from './timing-plausibility.js';
export function timingQuality(candidate) {
 const lines=candidate?.lyrics?.lines??[],duration=candidate?.song?.duration;
 const bounds={duration:duration??MAX_LYRIC_SECONDS,durationResolution:sourceDurationResolution(candidate?.lyrics,candidate?.song?.id)};
 const times=lines.map(l=>l.timestamp),valid=times.filter(t=>validTimingTimestamp(t,bounds));
 const ordered=valid.every((t,i)=>!i||t>=valid[i-1]);
 const malformed=times.some(t=>t!=null&&!validTimingTimestamp(t,bounds));
 const coverage=lines.length?valid.length/lines.length:0;
 const usable=!timingRejectionReason(candidate)&&!malformed&&ordered&&coverage>=0.8&&new Set(valid).size>=Math.min(2,lines.length);
 return {usable,coverage,alignment:candidate?.timingCorrection?.basis==='recording_listening_review'?'listening_reviewed':'provider'};
}
export function chooseLyricCandidate(current,candidate) {
 if(!current)return candidate;if(!candidate)return current;
 if(candidate.lyrics.instrumental)return current;
 if(current.lyrics.instrumental)return candidate;
 const currentScript=lyricScriptFit(current),candidateScript=lyricScriptFit(candidate);
 if(currentScript===-1&&candidateScript===1)return candidate;
 if(currentScript===1&&candidateScript===-1)return current;
 if(Boolean(current.lyrics.partial)!==Boolean(candidate.lyrics.partial))return current.lyrics.partial?candidate:current;
 const a=timingQuality(current),b=timingQuality(candidate);
 if(a.usable!==b.usable)return b.usable?candidate:current;
 return current;
}
import {validVocalTiming,validSourceTiming,validTimingProvenance,vocalCoverage,sourceDurationResolution,validTimingTimestamp,MAX_LYRIC_SECONDS} from './vocal-timing.js';
export const VOCAL_SELECTION_CAPABILITY='measured-vocal-selection-7:outer-whitespace-1:qrc-literal-ampersands-1:kugou-krc-2:qq-qrc-4:plain-word-window-1:native-script-1:temporal-plausibility-1:ja-reading-2';

// A provider capability grants a lookup opportunity, never timing authority.
// Only validated cues from the selected source's own recording may outrank LRC.
export function hasMeasuredVocalTiming(candidate) {
 const {song,lyrics}=candidate??{};
 return !timingRejectionReason(candidate)&&validSourceTiming(lyrics,song?.id)
  && lyrics.lines.some(line=>validVocalTiming(line,{duration:song.duration??MAX_LYRIC_SECONDS,durationResolution:sourceDurationResolution(lyrics,song.id)}));
}
export function measuredVocalCoverage(candidate) {
 return vocalCoverage(candidate?.lyrics?.lines,{duration:candidate?.song?.duration??MAX_LYRIC_SECONDS,
  durationResolution:sourceDurationResolution(candidate?.lyrics,candidate?.song?.id),
   provenance:!timingRejectionReason(candidate)&&validSourceTiming(candidate?.lyrics,candidate?.song?.id)});
}
export const hasCompleteMeasuredVocalTiming=candidate=>measuredVocalCoverage(candidate).complete;
export const measuredSelectionProtected=candidate=>timingQuality(candidate).alignment==='listening_reviewed'
 ||candidate?.timingCorrection?.status==='replacement';

// Readable rows and complete measured words are separate acquisition goals.
// Use the same stopping rule for catalog names and freshly validated ID hints.
export function needsTimingDiscovery(candidate,{measured=true}={}) {
 if(!candidate)return true;
 if(candidate.lyrics.instrumental)return false;
 if(isLatinScriptFallback(candidate))return true;
 if(measuredSelectionProtected(candidate))return false;
 return candidate.lyrics.partial||!timingQuality(candidate).usable
  ||(measured&&!hasCompleteMeasuredVocalTiming(candidate));
}

// A readable positive must not hide a recoverable word-timing miss for a day.
// Apply the same lifetime to memory, canonical and persistent response caches.
export function lyricResponseLifetimeMs(response) {
 if(responseTimingNeedsRefresh(response))return 300000;
 if(isLatinScriptFallback(response))return 300000;
 if(response.quality?.partial===true||(response.quality?.synced===false&&response.quality?.instrumental!==true))return 300000;
 if(response.metadata?.word_timing_upgrade_supported===true) {
  const timing=response.metadata.lyric_timing;
  const complete=vocalCoverage((response.lines??[]).map(line=>({...line,text:line.original})),{
   duration:response.song?.duration??MAX_LYRIC_SECONDS,durationResolution:timing?.durationResolution??0,
   provenance:validTimingProvenance(timing)&&timing.source.split(':')[1]===String(response.song?.id)}).complete;
  if(!complete)return 300000;
 }
 return 86400000;
}

export function chooseMeasuredLyricCandidate(current,candidate) {
 const selected=chooseLyricCandidate(current,candidate);
 if(selected!==current || !current || !candidate)return selected;
 if(current.lyrics.partial || candidate.lyrics.partial || current.lyrics.instrumental || candidate.lyrics.instrumental)return current;
 if(lyricScriptFit(current)===1&&isLatinScriptFallback(candidate))return current;
 const a=timingQuality(current),b=timingQuality(candidate);
 if(a.usable&&b.usable&&!measuredSelectionProtected(current)) {
  const left=measuredVocalCoverage(current),right=measuredVocalCoverage(candidate);
  if(right.covered*Math.max(1,left.total)>left.covered*Math.max(1,right.total))return candidate;
 }
 return current;
}
