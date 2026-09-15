import test from 'node:test';
import assert from 'node:assert/strict';
import {selectionFor,explanationBody,parseExplanation,explanationKey} from '../../api/utils/song-library/study-explanation.js';
import {digest} from '../../api/utils/song-library/store.js';
const doc={id:'d',sourceHash:'h',response:{song:{language:'zh',title:{original:'song'},artist:{original:'artist'}}},structure:{occurrences:[{sourceID:'L0001',sourceText:'把今天唱成一首歌'},{sourceID:'L0002',sourceText:'把今天唱成一首歌'}]}};
const translation={id:'revision',lines:[{sourceID:'L0001',text:'Turn today into a song.'},{sourceID:'L0002',text:'Sing today into a song.'}]};
test('revised grammar and ambiguity recipe cannot reuse the earlier explanation cache',()=>{
 const selection=selectionFor(doc,{sourceID:'L0002',lower:'3',upper:'5'});
 const oldKey=digest({documentID:doc.id,sourceHash:doc.sourceHash,translationID:translation.id,selection,target:'en',recipe:'study-occurrence-1'});
 assert.notEqual(explanationKey(doc,translation,selection),oldKey);
});
test('binds grapheme offsets to an exact occurrence and keeps the full source context',()=>{
 const selection=selectionFor(doc,{sourceID:'L0002',lower:'3',upper:'5'});
 assert.equal(selection.text,'唱成'); assert.equal(selection.sourceID,'L0002');
 const body=explanationBody(doc,translation,selection),input=JSON.parse(body.input[0].content);
 assert.equal(input.sourceDocument.occurrences.length,2);assert.equal(input.acceptedTranslation.id,'revision');
 assert.equal(body.store,false); assert.match(body.instructions,/untrusted/i);
});
test('rejects missing, noninteger, negative and oversized source selections',()=>{
 for(const input of [{sourceID:'L9999',lower:'0',upper:'1'},{sourceID:'L0001',lower:'-1',upper:'2'},{sourceID:'L0001',lower:'1.5',upper:'2'},{sourceID:'L0001',lower:'0',upper:'99'}]) assert.throws(()=>selectionFor(doc,input));
});
test('requires a complete bounded contextual answer with exact source quote',()=>{
 const selected=selectionFor(doc,{sourceID:'L0001',lower:'3',upper:'5'});
 const answer={meaning:'turn into through singing',context:'Singing transforms today.',grammar:'成 marks a result.',uncertainty:'',sourceQuote:'唱成'};
 assert.equal(parseExplanation(JSON.stringify(answer),selected).meaning,answer.meaning);
 assert.throws(()=>parseExplanation(JSON.stringify({...answer,sourceQuote:'成'}),selected));
 assert.throws(()=>parseExplanation(JSON.stringify({...answer,extra:'x'}),selected));
});
