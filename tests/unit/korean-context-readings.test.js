import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyzeReading,renderReading} from '../../api/utils/pronunciation-aids.js';
const corpus=JSON.parse(readFileSync(new URL('../fixtures/korean-context-development.json',import.meta.url)));
test('Korean verb cluster exceptions preserve nouns and ordinary endings',async()=>{
 for(const row of corpus.cases)assert.ok(row.romanizations.includes(renderReading(await analyzeReading(row.text,'ko'),'ko-revised').text),row.text);
});
test('Korean correction leaves canonical spelling and original grapheme ranges intact',async()=>{
 for(const text of ['맑게', '맑게'.normalize('NFD'), '👩🏽‍🎤 맑게, 읽고 yeah!']){
  const reading=await analyzeReading(text,'ko');
  assert.equal(reading.segments.map(s=>s.source).join(''),text);
  for(const segment of reading.segments.filter(s=>s.status==='resolved'))assert.equal(segment.reading,segment.source.normalize('NFC'));
  assert.match(renderReading(reading,'ko-revised').text,/malge/);
 }
});
