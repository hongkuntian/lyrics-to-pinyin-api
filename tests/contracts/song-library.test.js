import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateSchema} from './schema-validator.js';
import {libraryDB,source} from '../helpers/library-db.js';
import {createSongLibraryHandler} from '../../api/song-library.js';
import {parseTranslation} from '../../api/utils/song-library/translation.js';

const schema=JSON.parse(await readFile(new URL('../../contracts/song-library.schema.json',import.meta.url)));
test('song library document, job, translation, status, report and error follow the versioned contract',async t=> {
  const {db,store}=await libraryDB();t.after(()=>db.close());const pending=[];
  const handler=createSongLibraryHandler({store,selectionRevision:'contract',apiKey:'test',loadLyrics:async()=>source.response,
    generateFn:async doc=>({content:parseTranslation(JSON.stringify({translations:{L0001:'Make a song of today.'},sourceNotes:[]}),doc),actualMicros:1000,response:{}}),
    waitUntilFn:task=>pending.push(task)});
  async function call(body) {
    const res={setHeader(){},status(code){this.code=code;return this;},json(value){this.body=value;}};
    await handler({method:'POST',headers:{authorization:'Bearer token-a'},body},res);
    assert.deepEqual(validateSchema(schema,res.body),[]);return res.body;
  }
  const {document}=await call({action:'lyrics',recording:{catalog_id:'123',artist:'Test artist',title:'Original test song',duration:12}});
  const {job}=await call({action:'translate',documentID:document.id,sourceHash:document.sourceHash});
  await Promise.all(pending);
  const ready=await call({action:'translate',documentID:document.id,sourceHash:document.sourceHash});
  assert.equal(ready.state,'ready');assert.equal(ready.translation.rejectedNotes,undefined);
  const status=await call({action:'status',jobID:job.id});
  assert.deepEqual(status.translation,ready.translation);
  await call({action:'report',documentID:document.id,translationID:ready.translation.id,sourceID:'L0001',category:'translation',detail:'Review the meaning.'});
  await call({action:'invalid'});
  assert.ok(validateSchema(schema,{...ready,version:2}).length);
  const missingLineText=structuredClone(ready);delete missingLineText.translation.lines[0].text;
  assert.ok(validateSchema(schema,missingLineText).length);
});
