import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '../../api/utils/song-library/store.js';
import {lineSelections,lineKey,lineBody,parseLine,LINE_RECIPE} from '../../api/utils/song-library/study-line.js';
const doc={id:'d',sourceHash:'h',response:{song:{language:'zh',title:'Test',artist:'Test'}},structure:{speakers:[],occurrences:[{sourceID:'L0001',sourceText:'我不走',lyricText:'我不走'}]}};
const range=(lower,upper,text)=>({id:`w${lower}-${upper}`,selection:{offsetUnit:'grapheme',ranges:[{lower,upper}],textHash:digest(text)}});
const input={contractVersion:1,explanationLanguage:'en',studyText:{layer:'original',revisionID:'d',occurrenceID:'L0001'},manifest:[range(0,1,'我'),range(1,2,'不')]};
const selections=()=>lineSelections(doc,input,null);
const output=()=>({items:selections().map(s=>({id:s.id,meaning:'selected meaning',context:'contextual use',uncertainty:'',evidence:['meaning','context'].map(field=>({field,sourceID:'L0001',layer:'original',sourceQuote:'我不走'}))}))});
test('line manifest binding, stable key, lean schema and host-owned quotes',()=>{
 const s=selections(),body=lineBody(doc,null,s);assert.equal(body.text.format.name,'study_line_1');assert.equal(body.reasoning.effort,'high');assert.ok(!body.text.format.schema.properties.items.items.properties.grammar);
 assert.equal(lineKey(doc,null,s),lineKey(doc,null,selections()));assert.notEqual(lineKey(doc,null,s),lineKey(doc,null,[s[0]]));
 const parsed=parseLine(JSON.stringify(output()),doc,null,s);assert.equal(parsed.items[1].sourceQuote,'不');assert.equal(parsed.items[0].grammar,'');assert.equal(LINE_RECIPE,'study-line-1');
});
test('tampered manifests fail before generation',()=>{
 for(const patch of [{manifest:[]},{manifest:Array(33).fill(input.manifest[0])},{manifest:[input.manifest[1],input.manifest[0]]},{manifest:[input.manifest[0],input.manifest[0]]},{manifest:[{...input.manifest[0],id:'x'}]},{explanationLanguage:'de'},{explanationLanguage:'fr-FR'},{explanationLanguage:undefined},{studyText:{...input.studyText,revisionID:'other'}}])assert.throws(()=>lineSelections(doc,{...input,...patch},null));
});
test('another explanation language has its own key and request; English is unchanged',()=>{
 const s=selections(),english=lineBody(doc,null,s);
 assert.deepEqual(lineSelections(doc,{...input,explanationLanguage:'fr'},null),s);
 assert.equal(lineKey(doc,null,s,'en'),lineKey(doc,null,s));
 assert.equal(lineKey(doc,null,s),digest({recipe:LINE_RECIPE,documentID:doc.id,sourceHash:doc.sourceHash,translationID:null,selections:s,language:'en'}));
 assert.equal(new Set(['en','fr','es','zh-Hans','zh-Hant'].map(l=>lineKey(doc,null,s,l))).size,5);
 assert.deepEqual(lineBody(doc,null,s,{language:'en'}),english);
 assert.match(english.instructions,/^Explain each supplied selection in concise natural English for a language learner\./);assert.ok(english.instructions.endsWith('Do not reproduce unrelated lyrics in learner-facing fields.'));
 for(const [language,name] of [['fr','French'],['es','Spanish'],['zh-Hans','Simplified Chinese']]) {
  const body=lineBody(doc,null,s,{language});
  assert.ok(body.instructions.startsWith(`Explain each supplied selection in concise natural ${name} `));assert.ok(body.instructions.includes(`Write meaning, context and uncertainty in ${name}`));
  assert.deepEqual({...body,instructions:''},{...english,instructions:''});
 }
});
test('whole-batch validation rejects incomplete, duplicate, unknown, ungrounded and extra fields',()=>{
 for(const mutate of [v=>v.items.pop(),v=>v.items[1]=v.items[0],v=>v.items[0].id='other',v=>v.items[0].meaning='',v=>v.items[0].meaning='a'.repeat(401),v=>v.items[0].grammar='invented',v=>v.items[0].evidence[0].sourceQuote='wrong',v=>v.items[0].evidence=[]]){const v=output();mutate(v);assert.throws(()=>parseLine(JSON.stringify(v),doc,null,selections()));}
});
