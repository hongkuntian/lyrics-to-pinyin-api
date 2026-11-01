import {chooseMeasuredLyricCandidate,hasMeasuredVocalTiming,measuredSelectionProtected} from '../lyric-selection.js';
import {validTimingProvenance} from '../vocal-timing.js';
import {qualifyLyricCompleteness} from '../lyric-completeness.js';
import {independentProvider,isSpotifyRecording,spotifySearchRequest} from './spotify-recording.js';
import {appleTimingRequest} from './apple-vocal-timing.js';

function candidate(response,recording) {
 const timing=response.metadata?.lyric_timing,source=independentProvider(response.metadata?.source),id=String(response.song.id);
 const spotify=isSpotifyRecording(recording);
 const bound=validTimingProvenance(timing)&&timing.provider===(spotify?'spotify':'appleMusic')
  &&timing.recordingID===(spotify?recording.item_id:recording.catalog_id)
  &&timing.source.split(':')[0]===source&&timing.source.split(':')[1]===id;
 return {song:{id,duration:response.song.duration,title:response.song.title?.original,artist:response.song.artist?.original,album:response.song.album},
  target:spotify?spotifySearchRequest(recording):recording,timingCorrection:response.metadata?.timing_correction,
  lyrics:{lines:response.lines.map(line=>({...line,text:line.original})),partial:response.quality.partial,instrumental:response.quality.instrumental,
   ...(bound?{source,songId:id,timingSource:{source:timing.source,revision:timing.revision},
    ...(timing.durationResolution!==undefined?{durationResolution:timing.durationResolution}:{})}:{})}};
}

function documentCandidate(document,recording) {
 const value=candidate(document.response,recording);
 if(isSpotifyRecording(recording)&&document.requestEvidence?.candidate)value.song={...value.song,...document.requestEvidence.candidate};
 if(!isSpotifyRecording(recording)&&document.canonicalRecordingID) {
  value.recordingTarget=document.canonicalRecordingID;
  value.target={...value.target,title:value.song.title,artist:value.song.artist,album:value.song.album};
 }
 return value;
}

export function shouldRetainLyricDocument(current,incoming,recording) {
 const key=document=>isSpotifyRecording(recording)?document.requestKey:appleTimingRequest(document);
 if(key(current)&&key(current)===key(incoming)) {
  const before=documentCandidate(current,recording),after=documentCandidate(incoming,recording);
  const beforePartial=Boolean(qualifyLyricCompleteness(before,after).lyrics.partial);
  const afterPartial=Boolean(qualifyLyricCompleteness(after,before).lyrics.partial);
  if(beforePartial!==afterPartial)return afterPartial;
 }
 return current.response.quality.synced&&!incoming.response.quality.synced
  ||isMeasuredTimingDowngrade(current.response,incoming.response,recording);
}

// Compare whole admitted editions, never graft cues onto a different document.
// Put the incoming edition first so an ordinary quality tie permits the reload.
export function isMeasuredTimingDowngrade(current,incoming,recording) {
 const before=candidate(current,recording),after=candidate(incoming,recording);
 if(before.lyrics.partial||before.lyrics.instrumental||!hasMeasuredVocalTiming(before)||measuredSelectionProtected(after))return false;
 return measuredSelectionProtected(before)||chooseMeasuredLyricCandidate(after,before)===before;
}
