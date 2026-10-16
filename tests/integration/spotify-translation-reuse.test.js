import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB} from '../helpers/library-db.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {sourceCapsule,spotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {parseTranslation,requestBody,translationRecipe} from '../../api/utils/song-library/translation.js';

const policy='bridge-test',recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'Song',artists:['Artist'],duration_ms:240000}};
function response() {
  return {song:{id:'independent-42',title:{original:'Song'},artist:{original:'Artist'},duration:240,language:'zh',romanization_system:'pinyin'},
    lines:[{original:'風來了',romanized:'feng lai le',timestamp:12},{original:'海在這裡',romanized:'hai zai zhe li',timestamp:60}],
    quality:{synced:true,partial:false,instrumental:false},metadata:{source:'LRCAPI',selection_revision:policy}};
}
function documents({spotifyChange=()=>{}}={}) {
  const apple=makeDocument({catalog_id:'123',title:'Song',artist:'Artist',duration:240},response(),policy);
  const raw=response();spotifyChange(raw);raw.recordingBinding=spotifyBinding(recording,sourceCapsule(raw),policy,raw);
  return [apple,makeDocument(recording,raw,policy)];
}
async function save(store,doc) {
  const owner=await store.claimLookup(doc.requestKey,policy);
  try {return await store.saveDocument(doc,{lookupOwner:owner});}finally{await store.releaseLookup(doc.requestKey,policy,owner);}
}
async function ready(store,doc,{recipe=translationRecipe('en'),generationRequest=requestBody(doc)}={}) {
  const job=await store.reserve({userID:'reader-a',documentID:doc.id,target:'en',recipe,reservedMicros:10000,generationRequest});
  await store.claim(job.job.id);
  await store.complete(job.job.id,parseTranslation(JSON.stringify({translations:{L0001:'The wind comes.',L0002:'The sea is here.'},sourceNotes:[]}),doc),1000,{});
  return job.job.id;
}

for(const direction of ['apple-to-spotify','spotify-to-apple'])test(`independently verified identical model input reuses ${direction} without spending`,async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());const docs=documents();
  const [from,to]=direction==='apple-to-spotify'?docs:[...docs].reverse();
  await save(store,from);await save(store,to);assert.deepEqual(requestBody(from),requestBody(to));
  const id=await ready(store,from);await store.configure({enabled:false,dailyMicros:0,monthlyMicros:0});
  const result=await store.translation(to.id,'en');assert.equal(result?.id,id);
  assert.equal(result.documentID,to.id);assert.equal(result.sourceHash,to.sourceHash);
  assert.equal((await store.reserve({userID:'reader-b',documentID:to.id,target:'en',recipe:translationRecipe('en'),reservedMicros:10000})).kind,'ready');
  assert.equal(Number((await store.usage()).jobs),1);
  assert.equal((await db.query('SELECT verification FROM translation_reuse_events')).rows[0].verification,'verified_independent_model_input');
  assert.notEqual(from.recordingKey,to.recordingKey);assert.notEqual(from.timingRevision,to.timingRevision);
});

test('the bridge declines different model context, words, source identity, targets and incompatible recipes',async t=>{
  for(const change of [r=>{r.song.album='Additional model context';},r=>{r.song.title.original='Other title';},
    r=>{r.song.id='other-source';},r=>{r.lines[0].original='違う歌詞';}]) {
    const {db,store}=await libraryDB();t.after(()=>db.close());const [apple,spotify]=documents({spotifyChange:change});
    await save(store,apple);await save(store,spotify);await ready(store,apple);
    assert.equal(await store.translation(spotify.id,'en'),null);
  }
  const {db,store}=await libraryDB();t.after(()=>db.close());const [apple,spotify]=documents();
  await save(store,apple);await save(store,spotify);await ready(store,apple,{recipe:'legacy-incompatible'});
  assert.equal(await store.translation(spotify.id,'en'),null);assert.equal(await store.translation(spotify.id,'fr'),null);
});

test('the bridge follows corrected heads while preserving each document and source reference',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());const [apple,spotify]=documents();
  await save(store,apple);await save(store,spotify);const id=await ready(store,apple);
  assert.equal((await store.translation(spotify.id,'en'))?.id,id);
  const next=await store.publishRevision({expectedRevisionID:id,sourceHash:apple.sourceHash,publicationKey:'bridge-correction',actor:'test',reason:'Improve wording',
    candidate:{translations:{L0001:'Here comes the wind.',L0002:'The sea is here.'},sourceNotes:[]}});
  const corrected=await store.translation(spotify.id,'en');assert.equal(corrected.id,next.id);
  assert.equal(corrected.documentID,spotify.id);assert.equal(corrected.sourceHash,spotify.sourceHash);
});

test('a supplied generation request containing other metadata is not proof for reuse',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());const [apple,spotify]=documents();
  await save(store,apple);await save(store,spotify);
  const body=requestBody(apple),input=JSON.parse(body.input[0].content);input.title='Unverified context';
  await ready(store,apple,{generationRequest:{...body,input:[{role:'user',content:JSON.stringify(input)}]}});
  assert.equal(await store.translation(spotify.id,'en'),null);
});
