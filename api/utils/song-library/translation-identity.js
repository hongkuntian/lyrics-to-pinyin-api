import {createHash} from 'node:crypto';

export const TRANSLATION_IDENTITY_VERSION='song-meaning-1';
const label=value=>typeof value==='string'?value.normalize('NFC').trim().replace(/\s+/gu,' '):'';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Translation text has no recording clock or pronunciation overlay. Preserve the
// complete ordered source and speaker semantics; names alone never establish reuse.
export function translationIdentity(doc) {
  const song=doc.response?.song,structure=doc.structure;
  if(!song?.language || !song.title?.original || !song.artist?.original || !structure?.occurrences?.length) return null;
  return hash({version:TRANSLATION_IDENTITY_VERSION,language:song.language,
    context:{title:label(song.title.original),artist:label(song.artist.original)},
    speakers:(structure.speakers??[]).map(s=>({id:s.id,sourceLabel:s.sourceLabel,displayName:s.displayName})),
    occurrences:structure.occurrences.map(o=>({sourceID:o.sourceID,sourceText:o.sourceText,lyricText:o.lyricText,
      speakerID:o.speakerID??null,startsTurn:Boolean(o.startsTurn),sourcePrefix:o.sourcePrefix??''}))});
}

// This is a cryptographic reconstruction check, not a guess that a similar song
// has the same lyrics. Exact legacy hashes also retain original timing/readings.
export function legacySourceCandidates(doc) {
  const lines=doc.response.lines.map(l=>({original:l.original,romanized:l.romanized,timestamp:l.timestamp??null}));
  const speakers=(doc.structure.speakers??[]).map(s=>({id:s.id,sourceLabel:s.sourceLabel,displayName:s.displayName}));
  const occurrences=doc.structure.occurrences;
  const legacy={version:'source-speakers-1',speakers,occurrences:occurrences.map(o=>({sourceID:o.sourceID,
    sourceText:o.sourceText,lyricText:o.lyricText,speakerID:o.speakerID??null,startsTurn:Boolean(o.startsTurn),sourcePrefix:o.sourcePrefix??''}))};
  const normalized=version=>({version,sourceRows:(doc.structure.sourceRows??lines.map(l=>({text:l.original,timestamp:l.timestamp}))).map(r=>({text:r.text,timestamp:r.timestamp??null})),
    annotations:(doc.structure.annotations??[]).map(a=>({sourceIndex:a.sourceIndex,kind:a.kind,speakerID:a.speakerID,sourceLabel:a.sourceLabel})),speakers,
    occurrences:occurrences.map((o,i)=>({sourceID:o.sourceID,sourceIndex:o.sourceIndex??i,sourceText:o.sourceText,
      lyricText:o.lyricText,sourcePrefix:o.sourcePrefix??'',speakerID:o.speakerID??null,startsTurn:Boolean(o.startsTurn)}))});
  return [legacy,normalized('lyric-annotations-1'),normalized('lyric-annotations-2')].map(structure=>({
    source:{language:doc.response.song.language,lines,structure},
    hash:hash({language:doc.response.song.language,lines,structure})}));
}
