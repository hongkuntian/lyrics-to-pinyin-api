export function timingQuality(candidate) {
 const lines=candidate?.lyrics?.lines??[],duration=candidate?.song?.duration;
 const times=lines.map(l=>l.timestamp),valid=times.filter(t=>Number.isFinite(t)&&t>=0&&(duration==null||t<=duration));
 const ordered=valid.every((t,i)=>!i||t>=valid[i-1]);
 const malformed=times.some(t=>t!=null&&(!Number.isFinite(t)||t<0||(duration!=null&&t>duration)));
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
import {validVocalTiming,MAX_LYRIC_SECONDS} from './vocal-timing.js';
export const VOCAL_SELECTION_CAPABILITY='measured-vocal-selection-1';

// A provider capability grants a lookup opportunity, never timing authority.
// Only validated cues from the selected source's own recording may outrank LRC.
export function hasMeasuredVocalTiming(candidate) {
 const {song,lyrics}=candidate??{},source=lyrics?.timingSource;
 return lyrics?.source==='netease' && /^\d{1,20}$/.test(String(song?.id))
  && String(lyrics.songId)===String(song.id) && source?.source===`netease:${song.id}:yrc`
  && /^[a-f0-9]{64}$/.test(source.revision??'')
  && lyrics.lines.some(line=>validVocalTiming(line,{duration:song.duration??MAX_LYRIC_SECONDS}));
}

export function chooseMeasuredLyricCandidate(current,candidate) {
 const selected=chooseLyricCandidate(current,candidate);
 if(selected!==current || !current || !candidate)return selected;
 if(current.lyrics.partial || candidate.lyrics.partial || current.lyrics.instrumental || candidate.lyrics.instrumental)return current;
 const a=timingQuality(current),b=timingQuality(candidate);
 if(a.usable&&b.usable&&a.alignment!=='listening_reviewed'&&current.timingCorrection?.status!=='replacement'
  && !hasMeasuredVocalTiming(current)&&hasMeasuredVocalTiming(candidate))return candidate;
 return current;
}
