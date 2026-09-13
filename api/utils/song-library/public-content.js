import {LYRIC_NORMALIZATION_VERSION} from '../lyric-annotations.js';

const normalized=doc=>doc.structure.version===LYRIC_NORMALIZATION_VERSION;

// API v1 ties sourceText to the visible lyric row and startsTurn to a printed
// prefix. Keep that wire contract while canonical documents retain raw rows,
// performer turns and clean-to-source indices for translation and provenance.
export function publicDocument(doc) {
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
