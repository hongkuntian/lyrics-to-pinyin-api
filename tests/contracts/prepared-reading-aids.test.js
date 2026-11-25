import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateSchema} from './schema-validator.js';
import {readingBundle,readingInputs} from '../helpers/prepared-reading-edition.js';
import {validateBundle} from '../../api/utils/prepared-editions/core.js';
import {nativeExporterInput} from '../../api/utils/prepared-editions/preparation.js';
const aid=JSON.parse(await readFile(new URL('../../contracts/pronunciation-aid.schema.json',import.meta.url))),document=JSON.parse(await readFile(new URL('../../contracts/prepared-document.schema.json',import.meta.url))),response=JSON.parse(await readFile(new URL('../../contracts/music-romanize-success.schema.json',import.meta.url)));
test('JA/KO document artifact reuses ordinary pronunciation DTOs and identical native operator input',async()=>{
 for(const language of ['ja','ko']){
  const b=await readingBundle(language);validateBundle(b);const d=b.artifacts.find(a=>a.kind==='document').content;
  assert.deepEqual(validateSchema(document,d),[]);assert.deepEqual(validateSchema(response,d.response),[]);
  assert.equal(Object.hasOwn(d.response,'preparedReadingAids'),false);
  for(const value of Object.values(d.preparedReadingAids))assert.deepEqual(validateSchema(aid,value),[]);
  const f=await readingInputs(language),input=await nativeExporterInput({doc:f.doc,spec:f.spec},f.translations);
  assert.deepEqual(input.document.preparedReadingAids,d.preparedReadingAids);assert.equal(input.document.id,d.id);assert.equal(input.document.sourceHash,d.sourceHash);
 }
});
