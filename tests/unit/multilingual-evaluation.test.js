import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {evaluate,evaluateLines,lineSelectionsForCase,runEvaluation,documentFor,selectionForCase,emitRecord,corpusFile} from '../../scripts/evaluate-multilingual.js';
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

test('second expansion corpus covers eight sources with exact selections inside the budget',async()=>{
 const expansion=JSON.parse(await readFile(corpusFile('expansion-2'),'utf8')),logs=[];
 assert.deepEqual(expansion.cases.map(c=>c.language),['de','it','id','vi','ru','hi-Latn','th','ms']);
 for(const item of expansion.cases){assert.equal(item.lines.length,10);selectionForCase(item,documentFor(item));}
 const translate=async doc=>({content:{lines:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:o.lyricText}))},actualMicros:1});
 await evaluate({apiKey:'fixture',corpus:expansion,translate,explain:async()=>({content:{},actualMicros:1}),log:s=>logs.push(JSON.parse(s)),onlyDirections:expansion.cases.flatMap(c=>['fr','es','zh-Hans'].map(t=>`${c.language}:${t}`))});
 assert.equal(new Set(logs.filter(l=>l.event==='multilingual_evaluation_chunk').map(l=>l.direction)).size,24);
});

test('names corpus covers Chinese, Japanese and Korean names with exact selections',async()=>{
 const names=JSON.parse(await readFile(corpusFile('names'),'utf8')),logs=[];
 assert.deepEqual(names.cases.map(c=>c.language),['zh','ja','ko']);
 for(const item of names.cases){const doc=documentFor(item),selection=selectionForCase(item,doc);assert.equal([...item.lines[item.selection.line]].slice(selection.lower,selection.upper).join(''),item.selection.text);}
 const translate=async doc=>({content:{lines:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:o.lyricText}))},actualMicros:1});
 await evaluate({apiKey:'fixture',corpus:names,translate,explain:async()=>({content:{},actualMicros:1}),log:s=>logs.push(JSON.parse(s))});
 // Chinese has no Chinese target: 3 + 4 + 4 directions.
 assert.equal(new Set(logs.filter(l=>l.event==='multilingual_evaluation_chunk').map(l=>l.direction)).size,11);
});

test('line mode asks for every word of the selected line once per target, with a bounded per-word comparison',async()=>{
 const expansion=JSON.parse(await readFile(corpusFile('expansion'),'utf8')),logs=[],lines=[],singles=[];
 for(const item of expansion.cases){const doc=documentFor(item),s=lineSelectionsForCase(item,doc),text=item.lines[item.selection.line],g=[...new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)].map(x=>x.segment);
  assert.ok(s.length>1&&s.length<=32);for(const [i,w] of s.entries()){assert.equal(g.slice(w.lower,w.upper).join(''),w.text);assert.equal(w.id,`w${w.lower}-${w.upper}`);assert.ok(i===0||w.lower>=s[i-1].upper);}}
 const explainLine=async(doc,translation,selections,options)=>{lines.push(options);assert.equal(translation,null);assert.equal(options.generationRequest.max_output_tokens,32768);
  return {content:{items:selections.map(s=>({id:s.id,meaning:'m',context:'c',uncertainty:'',grammar:'',sourceQuote:s.text}))},actualMicros:10};};
 const explain=async(doc,translation,selection,options)=>{singles.push(options);if(singles.length===1){const e=new Error('hidden');e.code='provider_incomplete';throw e;}return {content:{meaning:'m'},actualMicros:5};};
 await evaluateLines({apiKey:'fixture',corpus:expansion,explainLine,explain,compareSingles:2,log:s=>logs.push(JSON.parse(s))});
 assert.equal(lines.length,12);assert.equal(singles.length,18);assert.deepEqual([...new Set(lines.map(l=>l.explanationLanguage))].sort(),['en','es','fr','zh-Hans']);
 const start=logs.find(l=>l.event==='multilingual_evaluation_start');assert.equal(start.mode,'line');assert.ok(start.reservedMicros<5_000_000);
 const chunks=logs.filter(l=>l.event==='multilingual_evaluation_chunk'),first=chunks.filter(c=>c.direction===chunks.find(x=>!x.direction.endsWith(':en')).direction);
 const record=JSON.parse(Buffer.from(first.map(c=>c.data).join(''),'base64').toString('utf8'));
 assert.equal(record.event,'multilingual_evaluation_line');assert.equal(record.items.length,record.selections.length);assert.equal(record.single.length,2);assert.equal(record.single[0].code,'provider_incomplete');assert.equal(record.usageMicros,15);
 await assert.rejects(()=>evaluateLines({apiKey:'fixture',corpus:expansion,explainLine:async()=>{throw new Error('secret');},log:s=>logs.push(JSON.parse(s))}),/incomplete/);
 assert.ok(logs.every(l=>!JSON.stringify(l).includes('secret')));
 await assert.rejects(()=>evaluateLines({corpus:expansion}),/provider_key/);await assert.rejects(()=>evaluateLines({apiKey:'fixture',corpus:expansion,compareSingles:9}),/comparison/);
 await assert.rejects(()=>runEvaluation({OPENAI_API_KEY:'fixture',LYRA_EVALUATION_MODE:'other'}),/invalid_evaluation_mode/);
});

test('named targets review Traditional Chinese, including Chinese songs, without changing the default run',async()=>{
 const translate=async doc=>({content:{lines:doc.structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:o.lyricText}))},actualMicros:1});
 const run=async(options)=>{const logs=[],explained=[];await evaluate({apiKey:'fixture',corpus,translate,explain:async(doc,translation,selection,o)=>{explained.push([translation?.target??null,o.explanationLanguage]);return {content:{},actualMicros:1};},log:s=>logs.push(JSON.parse(s)),...options});
  return {directions:[...new Set(logs.filter(l=>l.event==='multilingual_evaluation_chunk').map(l=>l.direction))].sort(),explained};};
 const base=await run({});assert.equal(base.directions.length,12);assert.ok(base.directions.every(d=>!d.endsWith(':zh-Hant')&&d!=='zh:zh-Hans'));
 const named=await run({onlyTargets:['zh-Hant']});assert.deepEqual(named.directions,['en:zh-Hant','es:zh-Hant','fr:zh-Hant','zh:zh-Hant']);
 // The translated word is explained in every offered language, not only the one under review.
 assert.deepEqual(named.explained.filter(e=>e[0]==='zh-Hant').map(e=>e[1]).sort(),['en','es','fr','zh-Hans','zh-Hant']);
 const lines=[];await evaluateLines({apiKey:'fixture',corpus,onlyTargets:['zh-Hant'],explainLine:async(doc,t,selections,o)=>{lines.push(o.explanationLanguage);return {content:{items:[]},actualMicros:1};},log:()=>{}});
 assert.deepEqual(lines,['zh-Hant','zh-Hant','zh-Hant','zh-Hant']);
 for(const onlyTargets of [[],['de'],['zh-Hant','zh-Hant'],'zh-Hant'])await assert.rejects(()=>evaluate({apiKey:'fixture',corpus,translate,onlyTargets}),/invalid_evaluation_targets/);
});
