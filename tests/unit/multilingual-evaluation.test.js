import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluate,documentFor,selectionForCase,emitRecord,corpusFile} from '../../scripts/evaluate-multilingual.js';
import {buildFailureCode} from '../../scripts/vercel-library-build.js';
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

test('expansion corpus evaluates ja/ko/pt into every beta target with exact original selections',async()=>{
 const expansion=JSON.parse(await readFile(corpusFile('expansion'),'utf8')),calls=[],logs=[];
 assert.deepEqual(expansion.cases.map(c=>c.language),['ja','ko','pt']);
 for(const item of expansion.cases){assert.equal(item.lines.length,10);const doc=documentFor(item),selection=selectionForCase(item,doc);assert.equal([...item.lines[item.selection.line]].slice(selection.lower,selection.upper).join(''),item.selection.text);}
 const translate=async(doc,options)=>{calls.push(['translation',options.target]);return {content:{lines:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:o.lyricText}))},actualMicros:100};};
 const explain=async(doc,translation,selection,options)=>{calls.push(['explanation',options.explanationLanguage]);assert.equal(translation,null);return {content:{},actualMicros:50};};
 await evaluate({apiKey:'fixture',corpus:expansion,translate,explain,log:s=>logs.push(JSON.parse(s))});
 const directions=new Set(logs.filter(l=>l.event==='multilingual_evaluation_chunk').map(l=>l.direction));
 assert.deepEqual([...directions].sort(),['ja','ko','pt'].flatMap(s=>['en','es','fr','zh-Hans'].map(t=>`${s}:${t}`)).sort());
 assert.equal(calls.length,24);
 assert.throws(()=>corpusFile('../secret'),/invalid_evaluation_corpus/);
 assert.equal(buildFailureCode(new Error('evaluation_only_complete')),'evaluation_only_complete');
});

test('second expansion corpus covers seven sources with exact selections inside the budget',async()=>{
 const expansion=JSON.parse(await readFile(corpusFile('expansion-2'),'utf8')),logs=[];
 assert.deepEqual(expansion.cases.map(c=>c.language),['de','it','id','vi','ru','hi-Latn','th']);
 for(const item of expansion.cases){assert.equal(item.lines.length,10);selectionForCase(item,documentFor(item));}
 const translate=async doc=>({content:{lines:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:o.lyricText}))},actualMicros:1});
 await evaluate({apiKey:'fixture',corpus:expansion,translate,explain:async()=>({content:{},actualMicros:1}),log:s=>logs.push(JSON.parse(s)),onlyDirections:expansion.cases.flatMap(c=>['fr','es','zh-Hans'].map(t=>`${c.language}:${t}`))});
 assert.equal(new Set(logs.filter(l=>l.event==='multilingual_evaluation_chunk').map(l=>l.direction)).size,21);
});
