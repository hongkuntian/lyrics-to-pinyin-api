export function timingQuality(candidate) {
 const lines=candidate?.lyrics?.lines??[],duration=candidate?.song?.duration;
 const bounds={duration:duration??MAX_LYRIC_SECONDS,durationResolution:sourceDurationResolution(candidate?.lyrics,candidate?.song?.id)};
 const times=lines.map(l=>l.timestamp),valid=times.filter(t=>validTimingTimestamp(t,bounds));
 const ordered=valid.every((t,i)=>!i||t>=valid[i-1]);
 const malformed=times.some(t=>t!=null&&!validTimingTimestamp(t,bounds));
 const coverage=lines.length?valid.length/lines.length:0;
 const usable=!malformed&&ordered&&coverage>=0.8&&new Set(valid).size>=Math.min(2,lines.length);
 return {usable,coverage,alignment:candidate?.timingCorrection?.basis==='recording_listening_review'?'listening_reviewed':'provider'};
}
export function chooseLyricCandidate(current,candidate) {
 if(!current)return candidate;if(!candidate)return current;
 if(candidate.lyrics.instrumental)return current;
 if(current.lyrics.instrumental)return candidate;
 if(Boolean(current.lyrics.partial)!==Boolean(candidate.lyrics.partial))return current.lyrics.partial?candidate:current;
 const a=timingQuality(current),b=timingQuality(candidate);
 if(a.usable!==b.usable)return b.usable?candidate:current;
 return current;
}
import {validVocalTiming,validSourceTiming,vocalCoverage,sourceDurationResolution,validTimingTimestamp,MAX_LYRIC_SECONDS} from './vocal-timing.js';
export const VOCAL_SELECTION_CAPABILITY='measured-vocal-selection-3:kugou-krc-1:qq-qrc-3';

// A provider capability grants a lookup opportunity, never timing authority.
// Only validated cues from the selected source's own recording may outrank LRC.
export function hasMeasuredVocalTiming(candidate) {
 const {song,lyrics}=candidate??{};
 return validSourceTiming(lyrics,song?.id)
  && lyrics.lines.some(line=>validVocalTiming(line,{duration:song.duration??MAX_LYRIC_SECONDS,durationResolution:sourceDurationResolution(lyrics,song.id)}));
}
export function measuredVocalCoverage(candidate) {
 return vocalCoverage(candidate?.lyrics?.lines,{duration:candidate?.song?.duration??MAX_LYRIC_SECONDS,
  durationResolution:sourceDurationResolution(candidate?.lyrics,candidate?.song?.id),
  provenance:validSourceTiming(candidate?.lyrics,candidate?.song?.id)});
}
export const hasCompleteMeasuredVocalTiming=candidate=>measuredVocalCoverage(candidate).complete;
export const measuredSelectionProtected=candidate=>timingQuality(candidate).alignment==='listening_reviewed'
 ||candidate?.timingCorrection?.status==='replacement';

export function chooseMeasuredLyricCandidate(current,candidate) {
 const selected=chooseLyricCandidate(current,candidate);
 if(selected!==current || !current || !candidate)return selected;
 if(current.lyrics.partial || candidate.lyrics.partial || current.lyrics.instrumental || candidate.lyrics.instrumental)return current;
 const a=timingQuality(current),b=timingQuality(candidate);
 if(a.usable&&b.usable&&!measuredSelectionProtected(current)) {
  const left=measuredVocalCoverage(current),right=measuredVocalCoverage(candidate);
  if(right.covered*Math.max(1,left.total)>left.covered*Math.max(1,right.total))return candidate;
 }
 return current;
}
