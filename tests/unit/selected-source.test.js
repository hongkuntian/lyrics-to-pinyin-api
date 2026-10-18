import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedTextHash,selectedSourceRequest,makeSelectedDocument,validateSelectedDocument} from '../../api/utils/song-library/selected-source.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {requestBody} from '../../api/utils/song-library/translation.js';

const candidate={provider:'netease',itemID:'123',title:'Provider title (Live)',artist:'Provider artist',album:'Source album',duration:180,
  lines:[{text:'exact 👩🏽‍🎤 é',timestamp:3},{text:' repeated ',timestamp:6},{text:' repeated ',timestamp:8}]};
const request=()=>({provider:'netease',itemID:'123',expectedTextHash:selectedTextHash(candidate.lines)});
test('selected text hashes preserve ordered bytes, repeated rows, and framing',()=>{
  const h=selectedTextHash(candidate.lines);
  assert.notEqual(h,selectedTextHash(candidate.lines.slice(1)));
  assert.notEqual(h,selectedTextHash(candidate.lines.map(l=>({...l,text:l.text.normalize('NFC')}))));
  assert.notEqual(selectedTextHash([{original:'a'},{original:'bc'}]),selectedTextHash([{original:'ab'},{original:'c'}]));
});
test('selected requests reject caller lyric/context/URL/consent fields before I/O',()=>{
  for(const extra of [{url:'https://bad'}, {lines:[]},{allowGeneration:true},{catalog_id:'123'},{accesskey:'secret'}])
    assert.throws(()=>selectedSourceRequest({...request(),...extra}),/invalid_selected_source/);
  assert.throws(()=>selectedSourceRequest({...request(),provider:'kugou'}),/invalid_selected_source/);
  assert.equal(selectedSourceRequest({...request(),provider:'kugou',query:'source artist'}).query,'source artist');
});
test('selected documents use source labels and untimed exact rows; timing alters immutable identity',async()=>{
  const doc=await makeSelectedDocument(candidate,request());
  assert.equal(doc.response.song.id,'123');
  assert.equal(doc.response.song.title.original,candidate.title);
  assert.equal(doc.response.metadata.music_api,'netease');
  assert.equal(doc.response.metadata.source,'NetEase');
  assert.deepEqual(doc.response.lines.map(l=>l.original),candidate.lines.map(l=>l.text));
  assert.ok(doc.response.lines.every(l=>l.timestamp===null&&!l.vocalTiming));
  assert.equal(doc.sourceCapsule,undefined);assert.equal(doc.requestKey,undefined);
  assert.equal(validateSelectedDocument(doc).title,candidate.title);
  const changed=await makeSelectedDocument({...candidate,lines:candidate.lines.map(l=>({...l,timestamp:l.timestamp+1}))},request());
  assert.notEqual(changed.id,doc.id);assert.notEqual(changed.timingRevision,doc.timingRevision);
  assert.equal(changed.textRevision,doc.textRevision);
  const publicValue=publicDocument(doc);
  assert.deepEqual(publicValue.selectedSource,doc.selectedSource);
  assert.equal(publicValue.selectedSourceCapsule,undefined);assert.equal(publicValue.modelContext,undefined);
  const prompt=JSON.stringify(requestBody(doc,'en'));
  assert.ok(prompt.includes(candidate.title));assert.ok(!prompt.includes('catalog_id'));
});
test('changed preview text fails closed; forged labels/revisions/rows cannot admit learning',async()=>{
  await assert.rejects(makeSelectedDocument({...candidate,lines:[{text:'changed'}]},request()),/selected_source_changed/);
  const doc=await makeSelectedDocument(candidate,request());
  for(const mutate of [d=>d.response.song.title.original='Target title',d=>d.response.lines[0].original='changed',d=>d.sourceHash='0'.repeat(64),d=>d.selectedSource.textHash='0'.repeat(64),d=>d.modelContext.title='forged']){
    const altered=structuredClone(doc);mutate(altered);assert.throws(()=>validateSelectedDocument(altered),/source_context_unavailable/);
  }
  assert.doesNotThrow(()=>validateSelectedDocument(JSON.parse(JSON.stringify(doc))));
});
test('selected pronunciation resolves the existing registry after its module initializes',async()=>{
  const source={...candidate,lines:[{text:'君が好き',timestamp:1},{text:'今日は学校へ行く',timestamp:3}]};
  const doc=await makeSelectedDocument(source,{...request(),expectedTextHash:selectedTextHash(source.lines)});
  assert.equal(doc.response.song.language,'ja');assert.equal(doc.response.song.romanization_system,'hepburn');
  assert.equal(doc.response.lines[0].original,'君が好き');assert.notEqual(doc.response.lines[0].romanized,'君が好き');
  assert.doesNotThrow(()=>validateSelectedDocument(doc));
});
