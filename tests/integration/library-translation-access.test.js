import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {libraryDB} from '../helpers/library-db.js';
import {createSongLibraryService} from '../../api/song-library.js';
import {admitLibraryTranslation} from '../../api/utils/membership/store.js';
import {validateSchema} from '../contracts/schema-validator.js';

const schema=JSON.parse(await readFile(new URL('../../contracts/song-library.schema.json',import.meta.url),'utf8'));
const recording={catalog_id:'123',artist:'Test artist',title:'Original song',duration:15};
const response={song:{id:'source-1',title:{original:'Original song'},artist:{original:'Test artist'},language:'zh',romanization_system:'pinyin'},
  lines:[{original:'一起唱',romanized:'yī qǐ chàng',timestamp:0}],metadata:{source:'test',selection_revision:'test'},quality:{synced:true,partial:false,instrumental:false}};
const fakeGeneration=async()=>({content:{lines:[{sourceID:'L0001',lyricText:'Sing together.',text:'Sing together.',speakerID:null,startsTurn:false}],sourceNotes:[],rejectedNotes:[]},actualMicros:1000,response:{id:'test-response'}});

async function setup(t) {
  const {db,store}=await libraryDB();t.after(()=>db.close());const pending=[];
  const handler=createSongLibraryService({store,selectionRevision:'test',loadLyrics:async()=>response,generateFn:fakeGeneration,
    apiKey:'test',waitUntilFn:task=>pending.push(task),logger:{error(){}}});
  const call=async(body,token='token-a')=>{
    const res={code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
    await handler({method:'POST',lyricaUser:await store.authenticate(token),headers:{authorization:`Bearer ${token}`},body},res);return res;
  };
  return {db,store,call,pending};
}

test('free accounts see a shared translation only after explicitly opening that song',async t=>{
  const {db,store,call,pending}=await setup(t);
  const doc=(await call({action:'lyrics',recording})).body.document;
  const ref={documentID:doc.id,sourceHash:doc.sourceHash};
  // reader-a is a beta account and prepares the shared translation.
  const job=(await call({action:'translate',...ref,allowGeneration:true})).body.job;
  await Promise.all(pending);
  assert.equal((await call({action:'current',...ref})).body.state,'ready');

  await db.query("UPDATE library_users SET access_kind='guest' WHERE id='reader-b'");
  for(const body of [{action:'current',...ref},{action:'translate',...ref}]) {
    const reply=await call(body,'token-b');
    assert.equal(reply.code,200);assert.equal(reply.body.state,'locked');assert.equal(reply.body.translation,undefined);
    assert.equal(reply.body.documentID,doc.id);assert.equal(reply.body.sourceHash,doc.sourceHash);assert.equal(reply.body.target,'en');
    assert.deepEqual(validateSchema(schema,reply.body),[]);
  }
  const status=await call({action:'status',jobID:job.id},'token-b');
  assert.equal(status.body.state,'locked');assert.equal(status.body.translation,undefined);
  assert.equal((await call({action:'current',...ref,unlock:'maybe'},'token-b')).code,400);

  const opened=await call({action:'current',...ref,unlock:'true'},'token-b');
  assert.equal(opened.body.state,'ready');assert.equal(opened.body.translation.lines[0].text,'Sing together.');
  assert.equal((await call({action:'current',...ref},'token-b')).body.state,'ready');
  assert.equal((await call({action:'translate',...ref},'token-b')).body.state,'ready');
  assert.equal((await call({action:'status',jobID:job.id},'token-b')).body.translation.lines[0].text,'Sing together.');
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM membership_usage WHERE user_id='reader-b'")).rows[0].n),1);
  assert.equal(Number((await store.usage()).jobs),1);
});

test('a free account at its weekly limit keeps opened songs and cannot open another',async t=>{
  const {db,call,pending}=await setup(t);
  const doc=(await call({action:'lyrics',recording})).body.document;
  const ref={documentID:doc.id,sourceHash:doc.sourceHash};
  await call({action:'translate',...ref,allowGeneration:true});await Promise.all(pending);
  await db.query("UPDATE library_users SET access_kind='guest' WHERE id='reader-b'");
  for(const id of ['other-1','other-2','other-3'])await admitLibraryTranslation(db,'reader-b',id,{unlock:true});
  const denied=await call({action:'current',...ref,unlock:true},'token-b');
  assert.equal(denied.code,403);assert.equal(denied.body.code,'library_translation_limit');
  assert.equal((await call({action:'current',...ref},'token-b')).body.state,'locked');
  assert.equal(await admitLibraryTranslation(db,'reader-b','other-2'),'open');
});
