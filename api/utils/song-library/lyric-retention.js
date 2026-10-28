import {chooseMeasuredLyricCandidate,hasMeasuredVocalTiming,measuredSelectionProtected} from '../lyric-selection.js';
import {validTimingProvenance} from '../vocal-timing.js';
import {independentProvider,isSpotifyRecording} from './spotify-recording.js';

function candidate(response,recording) {
 const timing=response.metadata?.lyric_timing,source=independentProvider(response.metadata?.source),id=String(response.song.id);
 const spotify=isSpotifyRecording(recording);
 const bound=validTimingProvenance(timing)&&timing.provider===(spotify?'spotify':'appleMusic')
  &&timing.recordingID===(spotify?recording.item_id:recording.catalog_id)
  &&timing.source.split(':')[0]===source&&timing.source.split(':')[1]===id;
 return {song:{id,duration:response.song.duration},timingCorrection:response.metadata?.timing_correction,
  lyrics:{lines:response.lines.map(line=>({...line,text:line.original})),partial:response.quality.partial,instrumental:response.quality.instrumental,
   ...(bound?{source,songId:id,timingSource:{source:timing.source,revision:timing.revision},
    ...(timing.durationResolution!==undefined?{durationResolution:timing.durationResolution}:{})}:{})}};
}

// Compare whole admitted editions, never graft cues onto a different document.
// Put the incoming edition first so an ordinary quality tie permits the reload.
export function isMeasuredTimingDowngrade(current,incoming,recording) {
 const before=candidate(current,recording),after=candidate(incoming,recording);
 if(before.lyrics.partial||before.lyrics.instrumental||!hasMeasuredVocalTiming(before)||measuredSelectionProtected(after))return false;
 return measuredSelectionProtected(before)||chooseMeasuredLyricCandidate(after,before)===before;
}
