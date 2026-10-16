import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {libraryDB} from '../helpers/library-db.js';
import {makeDocument,requestKey} from '../../api/utils/song-library/document.js';
import {sourceCapsule,spotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {createSongLibraryService} from '../../api/song-library.js';
const A={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'Song',artists:['Artist'],duration_ms:240001}};
const B={...A,market:'US',metadata:{...A.metadata,album:'Album',isrc:'USABC2600001',explicit:false}};
const policy='spotify-test-selection';
const response=(id='source-1')=>({song:{id,title:{original:'Song'},artist:{original:'Artist'},album:'Album',duration:240,language:'zh',romanization_system:'pinyin'},
  lines:[{original:'風來了',romanized:'fēng lái le',timestamp:12.5},{original:'海在這裡',romanized:'hǎi zài zhè lǐ',timestamp:60.125}],
  quality:{synced:true,partial:false,instrumental:false},metadata:{source:'LRCAPI',selection_revision:policy}});
function doc(r,id) {const value=response(id);value.recordingBinding=spotifyBinding(r,sourceCapsule(value),policy,value);return makeDocument(r,value,policy);}
async function save(store,r,id='source-1',replaceID=null) {
  const value=doc(r,id),lookupOwner=await store.claimLookup(value.requestKey,policy);
  try{return await store.saveDocument(value,{lookupOwner,replaceID});}finally{await store.releaseLookup(value.requestKey,policy,lookupOwner);}
}
test('Spotify source, exact request, context and revisions survive reopen and preserve admitted jobs',async t=>{
  const path=await mkdtemp(join(tmpdir(),'spotify-library-'));t.after(()=>rm(path,{recursive:true,force:true}));
  let {db,store}=await libraryDB(path);const original=await save(store,A),job=await store.reserve({userID:'reader-a',documentID:original.id,target:'en',recipe:'test',reservedMicros:10000});
  const other=await save(store,B);assert.equal(other.id,original.id);assert.notEqual(requestKey(A),requestKey(B));
  await db.close();({db,store}=await libraryDB(path));t.after(()=>db.close());
  const restored=await store.documentForRequest(requestKey(A),policy);
  assert.deepEqual(restored.requestRecording,A);assert.deepEqual(restored.sourceCapsule,original.sourceCapsule);assert.deepEqual(restored.modelContext,original.modelContext);
  assert.equal(restored.canonicalRecordingID,null);for(const key of ['textRevision','timingRevision','readingRevision'])assert.equal(restored[key],original[key]);
  assert.equal(publicDocument(restored,A).recordingBinding.requestHash,requestKey(A));
  assert.equal(publicDocument(await store.documentForRequest(requestKey(B),policy),B).recordingBinding.requestHash,requestKey(B));
  assert.equal((await store.existingTranslationJob(restored,'en')).id,job.job.id);assert.equal(Number((await store.usage()).accounted_micros),10000);
  assert.equal((await db.query('SELECT count(*) AS n FROM catalog_recording_bindings')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*) AS n FROM recording_lyric_heads')).rows[0].n,0);
});
test('Spotify refresh advances only the leased fingerprint and leaves shared saved source current',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());const original=await save(store,A);await save(store,B);
  const oldB=await store.documentForRequest(requestKey(B),policy),newA=doc(A,'source-2');
  const owner=await store.claimLookup(requestKey(A),policy);
  const [updated,concurrentB]=await Promise.all([store.saveDocument(newA,{replaceID:original.id,lookupOwner:owner}),store.documentForRequest(requestKey(B),policy)]);
  assert.equal(updated.id,newA.id);assert.equal(concurrentB.id,original.id);
  const stillB=await store.documentForRequest(requestKey(B),policy);assert.equal(stillB.id,oldB.id);assert.equal(stillB.requestEvidence.source.itemID,'source-1');
  assert.equal(publicDocument(stillB,B).recordingBinding.source.itemID,'source-1');assert.equal(await store.isCurrentDocument(original.id,policy),true);
  assert.equal((await store.document(original.id)).response.song.id,'source-1');
  assert.equal((await db.query('SELECT superseded_by FROM lyric_documents WHERE id=$1',[original.id])).rows[0].superseded_by,null);
  await assert.rejects(store.saveDocument(doc(B,'source-2'),{replaceID:oldB.id,lookupOwner:owner}),{code:'lookup_superseded'});
  await assert.rejects(store.saveDocument(doc(B,'source-2'),{replaceID:oldB.id}),{code:'lookup_superseded'});
  const ownerB=await store.claimLookup(requestKey(B),policy);await db.query("UPDATE lyric_lookups SET expires_at=now()-interval '1 second' WHERE owner=$1",[ownerB]);
  await assert.rejects(store.saveDocument(doc(B,'source-2'),{replaceID:oldB.id,lookupOwner:ownerB}),{code:'lookup_superseded'});
  const changedB=await save(store,B,'source-2',oldB.id);assert.equal(changedB.id,newA.id);
  assert.equal(publicDocument(changedB,B).recordingBinding.requestHash,requestKey(B));
});
test('request-bound public projection refuses fresh bindings for another fingerprint or immutable document',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());const first=await save(store,A);
  assert.throws(()=>publicDocument(first,B),{code:'recording_mismatch'});
  assert.throws(()=>publicDocument({...first,requestEvidence:{...first.requestEvidence,sourceHash:'wrong'}},A),{code:'recording_mismatch'});
  assert.throws(()=>publicDocument({...first,requestEvidence:{...first.requestEvidence,source:{...first.requestEvidence.source,itemID:'wrong'}}},A),{code:'recording_mismatch'});
  const changed=structuredClone(first);changed.response.song.id='wrong';assert.throws(()=>publicDocument(changed,A),{code:'recording_mismatch'});
});
test('library DI returns explicit 202 contention, v1 bound ready document and saved old admission recovery',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());let loads=0;
  const service=createSongLibraryService({store,selectionRevision:policy,apiKey:null,loadLyrics:async r=>{loads++;const value=response();value.recordingBinding=spotifyBinding(r,sourceCapsule(value),policy,value);return value;},logger:{error(){}}});
  const call=async body=>{const res={setHeader(){},status(n){this.code=n;return this;},json(value){this.body=value;}};await service({method:'POST',lyricaUser:{id:'reader-a'},body},res);return res;};
  const owner=await store.claimLookup(requestKey(A),policy),busy=await call({action:'lyrics',recording:A});
  assert.equal(busy.code,202);assert.deepEqual(busy.body,{version:1,state:'loading_lyrics'});assert.equal(loads,0);
  await store.releaseLookup(requestKey(A),policy,owner);const ready=await call({action:'lyrics',recording:A});
  assert.equal(ready.code,200);assert.equal(ready.body.version,1);assert.equal(ready.body.document.recordingBinding.requestHash,requestKey(A));
  const value=ready.body.document;assert.equal(value.response.recordingBinding,undefined);assert.equal(value.sourceCapsule,undefined);assert.equal(value.requestRecording,undefined);
});
