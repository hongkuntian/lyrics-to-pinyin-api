import {LibraryError} from './store.js';
import {canonicalJSON,modelContextFromSource,independentContextHash,spotifyHash} from './spotify-recording.js';
import {isRejectedRecordingLyrics} from '../rejected-lyrics.js';

// All Spotify prompt/reuse callers use this one provenance boundary. A renamed
// origin flag on request metadata never creates independently sourced context.
export function independentModelContext(doc) {
  const s=doc.sourceCapsule,c=doc.modelContext;
  if(!s||!c||canonicalJSON(c)!==canonicalJSON(modelContextFromSource(s)))throw new LibraryError('source_context_unavailable');
  const hash=spotifyHash(['spotify-source-2',s.provider,s.itemID,independentContextHash(s),s.language,s.romanizationSystem,s.lines,s.structure,s.lyricTiming??null]);
  if(hash!==doc.sourceHash||canonicalJSON(doc.structure)!==canonicalJSON(s.structure)||canonicalJSON(doc.response.lines)!==canonicalJSON(s.lines)||doc.response.song.language!==s.language)throw new LibraryError('source_context_unavailable');
  if(isRejectedRecordingLyrics(s.lines.map(l=>({text:l.original})),{recordingProvider:'spotify',recordingKey:doc.recordingKey}))throw new LibraryError('recording_mismatch');
  return c;
}
export const hasIndependentContext=doc=>Boolean(doc.sourceCapsule||doc.modelContext||doc.recordingBinding?.provider==='spotify'||doc.response?.metadata?.spotify_response_version!==undefined);
export function modelNames(doc) {
  if(hasIndependentContext(doc)) {
    const context=independentModelContext(doc);
    return Object.fromEntries(['title','artist','album'].flatMap(key=>context[key]===undefined?[]:[[key,context[key]]]));
  }
  // Existing Apple documents predate source capsules; retain their old inputs.
  return {title:doc.response.song.title.original,artist:doc.response.song.artist.original};
}
export function modelStudyTranslation(doc,translation) {
  if(!doc.sourceCapsule||!translation)return translation;
  return {target:translation.target,lines:translation.lines,sourceNotes:translation.sourceNotes??[]};
}
export function modelSelection(doc,selection) {
  if(!doc.sourceCapsule)return selection;
  const {sourceID,lower,upper,text,studyText}=selection;
  return {sourceID,lower,upper,text,...(studyText?{studyText:{layer:studyText.layer}}:{})};
}
