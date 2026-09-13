import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanLyrics} from '../../api/utils/lyric-quality.js';
import {publicDocument,publicTranslation} from '../../api/utils/song-library/public-content.js';

const normalized=cleanLyrics({lines:[{text:'张极Jeremy：',timestamp:4},{text:'一起唱',timestamp:5},
  {text:'张泽禹Zack：我说：别走',timestamp:9}]},{artist:'TOP Debut Boy Group'});
const doc={id:'immutable-document',sourceHash:'immutable-source',structure:normalized.lyricStructure,
  response:{lines:normalized.lines.map(l=>({original:l.text,timestamp:l.timestamp})),metadata:{lyric_structure:normalized.lyricStructure}}};
const translation={id:'saved-translation',recipe:'song-clause-4-vocal-text-1',
  lines:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:'I say: stay.',text:'I say: stay.',speakerID:o.speakerID,startsTurn:o.startsTurn})),
  sourceNotes:[{sourceID:'L0002',sourceQuote:'我说',kind:'ambiguous_reading',explanation:'Vocal note.'},
    {sourceID:'L0002',sourceQuote:'张泽禹Zack',kind:'ambiguous_reading',explanation:'Performer metadata.'}],rejectedNotes:[{private:true}]};

test('API v1 preserves its visible-row contract without changing canonical annotation evidence',()=>{
  const before=structuredClone(doc),wire=publicDocument(doc);
  assert.equal(wire.structure.version,'source-speakers-1');
  assert.equal(wire.id,doc.id);assert.equal(wire.sourceHash,doc.sourceHash);
  for(const [i,o] of wire.structure.occurrences.entries()) {
    assert.equal(o.sourceText,wire.response.lines[i].original);
    assert.equal(o.sourcePrefix+o.lyricText,o.sourceText);
    assert.equal(o.startsTurn,false);
    assert.equal(o.speakerID,doc.structure.occurrences[i].speakerID);
  }
  assert.deepEqual(wire.response.metadata.lyric_structure,doc.structure);
  assert.deepEqual(doc,before);
});
test('translation replies match vocal rows while stored performer turns and notes stay internal',()=>{
  const before=structuredClone(translation),wire=publicTranslation(translation,doc);
  assert.ok(wire.lines.every(l=>l.text===l.lyricText && !l.startsTurn));
  assert.equal(wire.rejectedNotes,undefined);
  assert.deepEqual(wire.sourceNotes,[translation.sourceNotes[0]]);
  assert.deepEqual(translation,before);
});
test('older saved documents retain the original API v1 speaker-prefix convention',()=>{
  const legacy={structure:{version:'source-speakers-1',speakers:[{id:'S1',displayName:'Lo'}],
    occurrences:[{sourceID:'L0001',sourceText:'卢：一起唱',lyricText:'一起唱',sourcePrefix:'卢：',speakerID:'S1',startsTurn:true}]}};
  assert.equal(publicDocument(legacy),legacy);
  for(const text of ['Sing together.','Lo: Sing together.']) {
    const saved={lines:[{sourceID:'L0001',lyricText:'Sing together.',text,speakerID:'S1',startsTurn:true}],sourceNotes:[]};
    assert.equal(publicTranslation(saved,legacy).lines[0].text,'Lo: Sing together.');
  }
});
