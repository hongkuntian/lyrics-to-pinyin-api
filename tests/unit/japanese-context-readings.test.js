import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {analyzeReading,renderReading} from '../../api/utils/pronunciation-aids.js';
const corpus=JSON.parse(readFileSync(new URL('../fixtures/japanese-context-development.json',import.meta.url)));
test('Japanese contextual readings preserve contrasting senses and numerical compounds',async()=>{
 for(const row of corpus.cases)assert.equal(renderReading(await analyzeReading(row.text,'ja'),'ja-kana').text,row.kana,row.text);
});
test('Japanese contextual replacements preserve source ranges and independent notation',async()=>{
 const source='👩🏽‍🎤 一人で辛い料理を食べよう yeah!';
 const reading=await analyzeReading(source,'ja');
 const chars=Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(source),s=>s.segment);
 assert.equal(reading.segments.map(s=>s.source).join(''),source);
 for(const s of reading.segments)assert.equal(chars.slice(s.lower,s.upper).join(''),s.source);
 assert.match(renderReading(reading,'ja-hepburn').text,/hitori de karai/);
 assert.match(renderReading(reading,'ja-kana').text,/ひとりでからい/);
 assert.equal(renderReading(await analyzeReading('歌おう','ja'),'ja-hepburn').text,'utaō');
 assert.equal(renderReading(await analyzeReading('思う','ja'),'ja-hepburn').text,'omou');
});
test('underdetermined Japanese alternatives keep the analyzer best effort',async()=>{
 assert.ok(['あした','あす','みょうにち'].includes(renderReading(await analyzeReading('明日','ja'),'ja-kana').text));
 assert.ok(['いく','ゆく'].includes(renderReading(await analyzeReading('行く','ja'),'ja-kana').text));
 assert.ok((await analyzeReading('𠮷𠮷','ja')).segments.some(s=>s.status==='unresolved'));
});
