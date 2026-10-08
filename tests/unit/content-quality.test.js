import test from 'node:test';
import assert from 'node:assert/strict';
import {explanationBody,parseGroundedExplanation,generateExplanation} from '../../api/utils/song-library/study-explanation.js';
import {generate,requestBody,parseTranslation} from '../../api/utils/song-library/translation.js';
import {publicTranslation} from '../../api/utils/song-library/public-content.js';
const occurrence={sourceID:'L0001',sourceText:'甲：我沒有說你走了',lyricText:'我沒有說你走了',speakerID:'S1',startsTurn:true,sourcePrefix:'甲：'};
const doc={id:'doc',sourceHash:'source',response:{song:{language:'zh',title:{original:'test'},artist:{original:'test'}}},structure:{version:'lyric-annotations-3',speakers:[{id:'S1',displayName:'A',sourceLabel:'甲'}],occurrences:[occurrence]}};
const translation={id:'revision',lines:[{sourceID:'L0001',lyricText:'I did not say you left.'}]};
const selection={sourceID:'L0001',text:'沒有',studyText:{layer:'original',revisionID:'doc',occurrenceID:'L0001'}};
const content={meaning:'did not',context:'The speaker denies saying this, not the departure itself.',grammar:'沒有 negates 說.',uncertainty:'',sourceQuote:'沒有'};
const evidence=['meaning','context','grammar'].map(field=>({field,sourceID:'L0001',layer:'original',sourceQuote:occurrence.sourceText}));
const answer={...content,evidence};
const provider=(body,text)=>new Response(JSON.stringify({id:'response',model:body.model,service_tier:'default',status:'completed',usage:{input_tokens:100,output_tokens:200},output:[{type:'message',content:[{type:'output_text',text}]}]}));
test('grounded Study retains whole-song turns, selected layer, model and output budget',()=>{
 const body=explanationBody(doc,translation,selection,'en',{grounded:true});
 assert.equal(body.model,'gpt-6-luna');assert.equal(body.max_output_tokens,4096);assert.match(body.instructions,/fallible aid/);assert.match(body.instructions,/Never silently repair/);
 assert.deepEqual(JSON.parse(body.input[0].content).sourceDocument,doc.structure);
 assert.deepEqual(parseGroundedExplanation(JSON.stringify(answer),doc,translation,selection),content);
});
test('evidence must quote exact real rows, cover claims and retain occurrence identity',()=>{
 for(const changed of [undefined,[],[...evidence,{...evidence[0]}],evidence.slice(0,2),evidence.map(e=>({...e,sourceID:'missing'})),evidence.map(e=>({...e,sourceQuote:occurrence.lyricText})),evidence.map(e=>({...e,extra:'invented'}))]) {
  assert.throws(()=>parseGroundedExplanation(JSON.stringify({...answer,evidence:changed}),doc,translation,selection),{code:'invalid_explanation_evidence'});
 }
});
test('translated wording must ground its own meaning and grammar in that exact translated row',()=>{
 const selected={...selection,text:'say',studyText:{layer:'translation',revisionID:'revision',occurrenceID:'L0001',target:'en'}};
 const translated={...content,sourceQuote:'say',evidence:evidence.map(e=>e.field==='context'?e:{...e,layer:'translation',sourceQuote:translation.lines[0].lyricText})};
 assert.equal(parseGroundedExplanation(JSON.stringify(translated),doc,translation,selected).sourceQuote,'say');
 assert.throws(()=>parseGroundedExplanation(JSON.stringify({...translated,evidence}),doc,translation,selected),{code:'invalid_explanation_evidence'});
});
test('unclear source may leave grammar empty without fabricating a lesson',()=>{
 const unclear={...answer,grammar:'',uncertainty:'The wording is unresolved.',evidence:evidence.filter(e=>e.field!=='grammar')};
 assert.equal(parseGroundedExplanation(JSON.stringify(unclear),doc,null,selection).grammar,'');
});
test('new Study evidence errors retain billed usage and do not trigger a retry',async()=>{
 const body=explanationBody(doc,translation,selection,'en',{grounded:true});let calls=0;
 await assert.rejects(generateExplanation(doc,translation,selection,{apiKey:'fixture',generationRequest:body,fetchFn:async()=>{calls++;return provider(body,JSON.stringify({...content,evidence:[]}));}}),e=>e.code==='invalid_explanation_evidence'&&e.actualMicros>0);
 assert.equal(calls,1);
 const legacy=explanationBody(doc,translation,selection,'en',{grounded:false});
 assert.deepEqual((await generateExplanation(doc,translation,selection,{apiKey:'fixture',generationRequest:legacy,fetchFn:async()=>provider(legacy,JSON.stringify(content))})).content,content);
});
test('generation rejects discarded uncertainty evidence while saved parsing remains compatible',async()=>{
 const body=requestBody(doc),value={translations:{L0001:'I did not say you left.'},sourceNotes:[{sourceID:'L0001',sourceQuote:'invented',kind:'uncertain_source',explanation:'Unclear.'}]};
 assert.equal(parseTranslation(JSON.stringify(value),doc).rejectedNotes.length,1);
 await assert.rejects(generate(doc,{apiKey:'fixture',fetchFn:async()=>provider(body,JSON.stringify(value))}),e=>e.code==='invalid_source_evidence'&&e.actualMicros>0);
});
test('normalized public lyrics preserve valid raw-row uncertainty with an exact visible quote',()=>{
 const note={sourceID:'L0001',sourceQuote:occurrence.sourceText,kind:'ambiguous_reading',explanation:'The departure itself remains open.'};
 const original={...translation,lines:[{...translation.lines[0],text:'I did not say you left.',speakerID:'S1',startsTurn:true}],sourceNotes:[note],rejectedNotes:[]};
 const projected=publicTranslation(original,doc);
 assert.deepEqual(projected.sourceNotes,[{...note,sourceQuote:occurrence.lyricText}]);
 assert.equal(original.sourceNotes[0].sourceQuote,occurrence.sourceText);
 assert.equal(projected.lines[0].startsTurn,false);
});
