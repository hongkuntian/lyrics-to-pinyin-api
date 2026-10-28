import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateSchema} from './schema-validator.js';
import {recordingRequest,makeDocument} from '../../api/utils/song-library/document.js';
import {sourceCapsule,spotifyBinding,verifySpotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
const schema=name=>JSON.parse(readFileSync(new URL('../../contracts/'+name+'.schema.json',import.meta.url)));
const fixture=JSON.parse(readFileSync(new URL('../fixtures/spotify-recording-vectors.json',import.meta.url))).fixtures[0];
const response={song:{id:fixture.source.itemID,title:{original:fixture.source.title},artist:{original:fixture.source.artist},language:'zh',romanization_system:'pinyin',duration:240},
  lines:fixture.source.lines,quality:{synced:true,partial:false,instrumental:false},metadata:{source:'LRCAPI',selection_revision:fixture.selectionRevision}};
test('artist-ID requests and emitted durable documents satisfy the shared wire contract',()=>{
  const vector=JSON.parse(readFileSync(new URL('../fixtures/spotify-artist-id-vector.json',import.meta.url)));
  const recording=recordingRequest(vector.recording),source=sourceCapsule(response);
  const fallback={...response,recordingBinding:spotifyBinding(recording,source,fixture.selectionRevision,response)};
  const doc=publicDocument(makeDocument(recording,fallback,fixture.selectionRevision),recording);
  assert.deepEqual(validateSchema(schema('spotify-recording'),recording),[]);
  assert.deepEqual(validateSchema(schema('spotify-recording-binding'),doc.recordingBinding),[]);
  assert.deepEqual(validateSchema(schema('song-library'),{version:1,state:'ready',document:doc}),[]);
  assert.equal(doc.recordingBinding.requestHash,vector.hashes.requestHash);
  assert.equal(doc.id,vector.hashes.documentID);
});
test('additive Spotify binding contract retains v1 and binds both fallback and durable responses',()=>{
  const recording=recordingRequest(fixture.recording),source=sourceCapsule(response);
  const fallback={...response,recordingBinding:spotifyBinding(recording,source,fixture.selectionRevision,response)};
  assert.deepEqual(validateSchema(schema('spotify-recording'),recording),[]);
  assert.deepEqual(validateSchema(schema('spotify-recording-binding'),fallback.recordingBinding),[]);
  assert.equal(fallback.recordingBinding.documentID,null);assert.equal(fallback.library,undefined);
  const doc=publicDocument(makeDocument(recording,fallback,fixture.selectionRevision),recording);
  assert.deepEqual(validateSchema(schema('song-library'),{version:1,state:'ready',document:doc}),[]);
  assert.deepEqual(validateSchema(schema('spotify-recording-binding'),doc.recordingBinding),[]);
  assert.equal(doc.recordingBinding.documentID,doc.id);assert.equal(doc.response.recordingBinding,undefined);
  for(const changed of [{...doc.recordingBinding,version:1},{...doc.recordingBinding,source:{...doc.recordingBinding.source,provider:'spotify'}},
    {...doc.recordingBinding,match:{...doc.recordingBinding.match,acousticVerified:true}}]) {
    assert.ok(validateSchema(schema('spotify-recording-binding'),changed).length);
    assert.throws(()=>verifySpotifyBinding(changed,recording,source,fixture.selectionRevision,response,{durable:true}),{code:'recording_mismatch'});
  }
});
