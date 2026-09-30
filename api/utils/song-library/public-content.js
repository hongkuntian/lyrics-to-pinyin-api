import {LYRIC_NORMALIZATION_VERSION} from '../lyric-annotations.js';
import {digest} from './store.js';

const normalizedVersions=new Set(['lyric-annotations-1','lyric-annotations-2',LYRIC_NORMALIZATION_VERSION]);
const normalized=doc=>normalizedVersions.has(doc.structure.version);

// API v1 ties sourceText to the visible lyric row and startsTurn to a printed
// prefix. Keep that wire contract while canonical documents retain raw rows,
// performer turns and clean-to-source indices for translation and provenance.
export function publicDocument(doc,request=null) {
  if(request && doc.canonicalRecordingID) {
    // The wire binding describes the caller's original item; immutable text and
    // document references retain their identity across verified catalog aliases.
    const recordingKey=digest({catalogID:request.catalog_id,storefront:request.storefront??null});
    doc={...doc,recordingKey,response:{...doc.response,metadata:{...doc.response.metadata,
      recording_match:{method:'catalog_alias',catalog_id:request.catalog_id,artist:request.artist,title:request.title,album:request.album??undefined,duration:request.duration},
      catalog_resolution:{...doc.response.metadata.catalog_resolution,requested:{catalog_id:request.catalog_id,storefront:request.storefront??null},
        accepted_request:{catalog_id:request.catalog_id,artist:request.artist,title:request.title,album:request.album??null,duration:request.duration}}}}};
  }
  if(!normalized(doc)) return doc;
  return {...doc,structure:{version:'source-speakers-1',speakers:doc.structure.speakers,
    occurrences:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,sourceText:o.lyricText,
      lyricText:o.lyricText,speakerID:o.speakerID,startsTurn:false,sourcePrefix:''}))}};
}

export function publicTranslation(translation,doc) {
  const {rejectedNotes,...value}=translation;
  const vocalTextOnly=normalized(doc);
  const occurrences=new Map(doc.structure.occurrences.map(o=>[o.sourceID,o]));
  return {...value,lines:value.lines.map(line=> {
    const speaker=doc.structure.speakers.find(s=>s.id===line.speakerID);
    return {...line,startsTurn:vocalTextOnly?false:line.startsTurn,
      text:!vocalTextOnly && line.startsTurn?`${speaker.displayName}: ${line.lyricText}`:line.lyricText};
  }),sourceNotes:value.sourceNotes.filter(note=>!vocalTextOnly || occurrences.get(note.sourceID)?.lyricText.includes(note.sourceQuote))};
}
