import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateSchema} from './schema-validator.js';
import {annotationFor} from '../../api/utils/pronunciation-aids.js';
const schema=JSON.parse(await readFile(new URL('../../contracts/pronunciation-aid.schema.json',import.meta.url)));
const envelope=JSON.parse(await readFile(new URL('../../contracts/song-library.schema.json',import.meta.url)));
test('generated pronunciation profiles satisfy the additive contract and require notation and ranges',async()=>{
 for(const [language,profile,text] of [['ja','ja-hepburn','歌おう'],['ja','ja-kana','歌おう'],['ko','ko-revised','같이 노래해']]){
  const doc={id:'a'.repeat(64),sourceHash:'b'.repeat(64),response:{song:{language}},structure:{occurrences:[{sourceID:'L0001',lyricText:text}]}};
  const pronunciation=await annotationFor(doc,profile);
  assert.deepEqual(validateSchema(schema,pronunciation),[]);
  assert.deepEqual(validateSchema(envelope,{version:1,state:'ready',pronunciation}),[]);
  const invalid=structuredClone(pronunciation);delete invalid.profile.notation;
  assert.ok(validateSchema(schema,invalid).length);
  const badRange=structuredClone(pronunciation);badRange.lines[0].segments[0].lower=-1;
  assert.ok(validateSchema(schema,badRange).length);
  const unknownStatus=structuredClone(pronunciation);unknownStatus.lines[0].segments[0].status='guessed';
  assert.ok(validateSchema(schema,unknownStatus).length);
 }
});
