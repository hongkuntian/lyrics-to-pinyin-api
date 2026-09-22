import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluate,documentFor,selectionForCase,emitRecord} from '../../scripts/evaluate-multilingual.js';
const corpus=JSON.parse(await readFile(new URL('../../evaluation/multilingual/corpus.json',import.meta.url),'utf8'));
test('evaluation uses whole songs and exact original selections with bounded explicit calls',async()=>{
 const calls=[],logs=[];
 const translate=async(doc,options)=>{calls.push(['translation',doc,options]);return {content:{lines:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:o.lyricText}))},actualMicros:100};};
 const explain=async(doc,translation,selection,options)=>{calls.push(['explanation',doc,options]);if(!translation)assert.equal(selection.text,corpus.cases.find(c=>documentFor(c).id===doc.id).selection.text);return {content:{},actualMicros:50};};
 await evaluate({apiKey:'fixture',corpus,translate,explain,log:s=>logs.push(JSON.parse(s))});
 assert.equal(calls.filter(c=>c[0]==='explanation').length,24);assert.equal(calls.length,36);assert.equal(new Set(logs.filter(l=>l.event==='multilingual_evaluation_chunk').map(l=>l.direction)).size,12);
 for(const [,doc,options] of calls){assert.equal(doc.structure.occurrences.length,10);assert.equal(options.generationRequest.store,false);}
 await assert.rejects(()=>evaluate({corpus,translate,explain}),/provider_key/);
 assert.equal(calls.length,36);
 const doc=documentFor(corpus.cases[3]);assert.equal(selectionForCase(corpus.cases[3],doc).lower,7);
});
test('provider failure is retained and cannot produce a successful receipt',async()=>{
 const logs=[];
 await assert.rejects(()=>evaluate({apiKey:'fixture',corpus,translate:async()=>{throw new Error('secret must not be logged');},log:s=>logs.push(s)}),/incomplete/);
 assert.equal(logs.filter(l=>l.includes('evaluation_failure')).length,12);
 assert.ok(logs.every(l=>!l.includes('secret')));
});

test('long Unicode review records survive bounded build log chunks exactly',()=>{
 const record={direction:'en:zh-Hans',text:'窗🙂é'.repeat(5000)},chunks=[];
 emitRecord(s=>chunks.push(JSON.parse(s)),record);
 assert.ok(chunks.length>1&&chunks.every(c=>JSON.stringify(c).length<2300));
 const decoded=JSON.parse(Buffer.from(chunks.map(c=>c.data).join(''),'base64').toString('utf8'));
 assert.deepEqual(decoded,record);
});
