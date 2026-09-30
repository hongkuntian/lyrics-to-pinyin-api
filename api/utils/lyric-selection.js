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
