import {isSpotifyRecording,spotifyHashes,spotifyBinding,canonicalJSON,sourceCapsule,spotifyHash} from './spotify-recording.js';
import {LYRIC_NORMALIZATION_VERSION,publicLyricStructure,publicRawLyrics} from '../lyric-annotations.js';
import {digest,LibraryError} from './store.js';
import {isRejectedRecordingLyrics} from '../rejected-lyrics.js';
import {appleVocalHashes,appleTimingRequest,hasVocalTiming} from './apple-vocal-timing.js';
import {requestKey} from './document.js';

const normalizedVersions=new Set(['lyric-annotations-1','lyric-annotations-2',LYRIC_NORMALIZATION_VERSION]);
const normalized=doc=>normalizedVersions.has(doc.structure.version);

// API v1 ties sourceText to the visible lyric row and startsTurn to a printed
// prefix. Keep that wire contract while canonical documents retain raw rows,
// performer turns and clean-to-source indices for translation and provenance.
export function publicDocument(doc,request=null) {
  if(!doc.sourceCapsule&&hasVocalTiming(doc.response)){
    let hashes;
    try{hashes=appleVocalHashes(doc.response,doc.structure,doc);}catch{throw new LibraryError('recording_mismatch');}
    if(hashes.sourceHash!==doc.sourceHash||hashes.timingRevision!==doc.timingRevision
      ||digest({recordingKey:doc.recordingKey,sourceHash:doc.sourceHash})!==doc.id)throw new LibraryError('recording_mismatch');
    if(request&&appleTimingRequest(doc)!==requestKey(request))throw new LibraryError('recording_mismatch');
    const p=doc.response.metadata.lyric_timing;
    if(request&&p.recordingID!==request.catalog_id){
      const proof=doc.response.metadata.catalog_resolution;
      if(!doc.canonicalRecordingID||proof?.canonical_recording_id!==doc.canonicalRecordingID
        ||!proof.catalog_items?.some(i=>i.catalog_id===request.catalog_id&&(i.storefront??null)===(request.storefront??null)))throw new LibraryError('recording_mismatch');
      doc={...doc,response:{...doc.response,metadata:{...doc.response.metadata,lyric_timing:{...p,recordingID:request.catalog_id}}}};
    }
  }
  if(doc.sourceCapsule||isSpotifyRecording(request)) {
    if(!isSpotifyRecording(request)||!doc.sourceCapsule||!doc.requestEvidence)throw new LibraryError('recording_mismatch');
    if(isRejectedRecordingLyrics(doc.response.lines.map(l=>({text:l.original})),request))throw new LibraryError('recording_mismatch');
    const h=spotifyHashes(request,doc.sourceCapsule,doc.selectionRevision),e=doc.requestEvidence;
    const binding=spotifyBinding(request,doc.sourceCapsule,doc.selectionRevision,doc.response,{durable:true});
    if(doc.canonicalRecordingID!=null||canonicalJSON(e.source)!==canonicalJSON(binding.source)||canonicalJSON(e.match)!==canonicalJSON(binding.match)
      ||e.requestHash!==h.requestHash||doc.requestKey!==h.requestHash||e.sourceHash!==h.sourceHash||doc.sourceHash!==h.sourceHash
      ||doc.id!==h.documentID||doc.recordingKey!==h.recordingKey||doc.textRevision!==h.textRevision||doc.timingRevision!==h.timingRevision||doc.readingRevision!==h.readingRevision
      ||canonicalJSON(doc.requestRecording)!==canonicalJSON(request)||canonicalJSON(doc.sourceCapsule)!==canonicalJSON(sourceCapsule(doc.response))
      ||canonicalJSON(doc.structure)!==canonicalJSON(doc.sourceCapsule.structure))throw new LibraryError('recording_mismatch');
    const {sourceCapsule:source,modelContext,requestRecording,requestEvidence,requestKey,...value}=doc;
    doc={...value,recordingBinding:binding};
  }

  if(request && doc.canonicalRecordingID) {
    // The wire binding describes the caller's original item; immutable text and
    // document references retain their identity across verified catalog aliases.
    const recordingKey=digest({catalogID:request.catalog_id,storefront:request.storefront??null});
    doc={...doc,recordingKey,response:{...doc.response,metadata:{...doc.response.metadata,
      recording_match:{method:'catalog_alias',catalog_id:request.catalog_id,artist:request.artist,title:request.title,album:request.album??undefined,duration:request.duration},
      catalog_resolution:{...doc.response.metadata.catalog_resolution,requested:{catalog_id:request.catalog_id,storefront:request.storefront??null},
        accepted_request:{catalog_id:request.catalog_id,artist:request.artist,title:request.title,album:request.album??null,duration:request.duration}}}}};
  }
  if(!normalized(doc)) return doc.structure.version==='source-speakers-1'
    ?{...doc,response:{...doc.response,lyric_structure:doc.structure}}:doc;
  return {...doc,response:publicRawLyrics({...doc.response}),structure:publicLyricStructure(doc.structure)};
}

export function publicTranslation(translation,doc) {
  const {rejectedNotes,contentFingerprint:ignoredFingerprint,...value}=translation;
  const vocalTextOnly=normalized(doc);
  const occurrences=new Map(doc.structure.occurrences.map(o=>[o.sourceID,o]));
  const projected={...value,lines:value.lines.map(line=> {
    const speaker=doc.structure.speakers.find(s=>s.id===line.speakerID);
    return {...line,startsTurn:vocalTextOnly?false:line.startsTurn,
      text:!vocalTextOnly && line.startsTurn?`${speaker.displayName}: ${line.lyricText}`:line.lyricText};
  }),sourceNotes:value.sourceNotes.flatMap(note=> {
    if(!vocalTextOnly)return [note];
    const occurrence=occurrences.get(note.sourceID);
    // Canonical evidence quotes the raw source row. API v1 exposes vocal text;
    // project an exact raw-row quote through the same source-owned mapping.
    if(occurrence && note.sourceQuote===occurrence.sourceText)return [{...note,sourceQuote:occurrence.lyricText}];
    return occurrence?.lyricText.includes(note.sourceQuote)?[note]:[];
  })};
  // The exact public content, rather than a device-generated reconstruction,
  // admits an already-ready translation into Spotify's background recipe.
  // Keep the existing Apple projection byte-for-byte unchanged.
  return doc.sourceCapsule?{...projected,contentFingerprint:spotifyHash(projected)}:projected;
}
