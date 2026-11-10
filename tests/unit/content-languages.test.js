import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalTarget,languagePolicy,requireDirection,environmentLanguagePolicy} from '../../api/utils/song-library/languages.js';
import {requestBody,translationRecipe,LEGACY_RECIPE} from '../../api/utils/song-library/translation.js';
import {selectionV2,explanationBody,explanationKey,explanationRecipe} from '../../api/utils/song-library/study-explanation.js';
import {digest} from '../../api/utils/song-library/store.js';
import {source} from '../helpers/library-db.js';
import {readFile} from 'node:fs/promises';
import {lineBody,lineSelections} from '../../api/utils/song-library/study-line.js';

test('target matching is explicit and preserves script distinctions',()=>{
 for(const [input,expected] of [['EN-us','en'],['fr-CA','fr'],['zh-cn','zh-Hans'],['zh-Hant','zh-Hant'],['zh-TW','zh-Hant']])assert.equal(canonicalTarget(input),expected);
 for(const input of ['zh','pt','pt-PT','pt-BR','fr-XX','fr-x-prompt','en_US','',null,{},'toString','constructor'])assert.throws(()=>canonicalTarget(input),{code:'unsupported_target'});
 assert.equal(canonicalTarget(),'en');
});
test('languages are enabled by direction, independently for explanations, and default to English',()=>{
 const policy=languagePolicy({translation:['zh:fr','en:zh-Hans'],explanation:['zh-Hans:en']});
 requireDirection(policy,'translation','zh','fr');requireDirection(policy,'translation','en','zh-Hans');
 assert.throws(()=>requireDirection(policy,'translation','fr','zh-Hans'),{code:'unsupported_direction'});
 assert.throws(()=>requireDirection(policy,'explanation','zh-Hans','fr'),{code:'unsupported_direction'});
 assert.throws(()=>requireDirection(languagePolicy(),'translation','zh','fr'),{code:'unsupported_direction'});
 assert.throws(()=>environmentLanguagePolicy({LYRA_TRANSLATION_DIRECTIONS:'["*:bogus"]'}),{code:'invalid_language_policy'});
});
test('whole-song targets retain fidelity and use explicit target and uncertainty conventions',()=>{
 for(const [target,name,marker] of [['fr','French','[source incertaine]'],['es','Spanish','[original poco claro]'],['zh-Hans','Simplified Chinese','[原文不明]'],['zh-Hant','Traditional Chinese','[原文不明]']]){
  const body=requestBody(source,target);
  assert.match(body.instructions,new RegExp(name));assert.ok(body.instructions.includes(marker));
  assert.ok(!body.instructions.includes('English'));assert.match(body.instructions,/Preserve the scope of each clause/);
  assert.equal(JSON.parse(body.input[0].content).sourceDocument.occurrences[0].sourceText,source.structure.occurrences[0].sourceText);
 }
});
test('v2 rejects changed hashes and disjoint grapheme selections across scripts',()=>{
 for(const text of ['e\u0301té','A👩🏽‍💻B','किताब','你好吗','אבג A']){
  const doc=structuredClone(source);doc.structure.occurrences[0].lyricText=text;
  const end=Array.from(new Intl.Segmenter('und',{granularity:'grapheme'}).segment(text)).length;
  const input={studyText:{layer:'original',revisionID:doc.id,occurrenceID:'L0001'},selection:{offsetUnit:'grapheme',ranges:[{lower:0,upper:end}],textHash:digest(text)}};
  assert.equal(selectionV2(doc,input).text,text);
  assert.throws(()=>selectionV2(doc,{...input,selection:{...input.selection,ranges:[{lower:0,upper:1},{lower:2,upper:3}]}}),{code:'invalid_selection'});
  assert.throws(()=>selectionV2(doc,{...input,selection:{...input.selection,textHash:digest('different')}}),{code:'selection_changed'});
 }
});
test('translation selection is reconstructed from the translation revision, never the source or submitted text',()=>{
 const translation={id:'revision',target:'zh-Hans',lines:[{sourceID:'L0001',lyricText:'今天一起唱'}]};
 const input={studyText:{layer:'translation',target:'zh-Hans',revisionID:'revision',occurrenceID:'L0001'},selection:{offsetUnit:'grapheme',ranges:[{lower:2,upper:4}],textHash:digest('一起')}};
 const selection=selectionV2(source,input,translation);assert.equal(selection.text,'一起');
 assert.throws(()=>selectionV2(source,input,{...translation,id:'new-revision'}),{code:'translation_revision_superseded'});
 const body=explanationBody(source,translation,selection,'fr');assert.match(body.instructions,/natural French/);assert.match(body.instructions,/Distinguish translator choices/);
 assert.notEqual(explanationKey(source,translation,selection,'fr'),explanationKey(source,translation,selection,'en'));
 assert.notEqual(explanationKey(source,translation,selection),explanationKey(source,null,selection));
});

test('shared Swift/backend fixtures preserve exact grapheme selection boundaries',async()=>{
 const {readFile}=await import('node:fs/promises');
 const fixtures=JSON.parse(await readFile(new URL('../../contracts/study-selection-fixtures.json',import.meta.url),'utf8'));
 for(const {text,lower,upper,selected} of fixtures){
  const doc=structuredClone(source);doc.structure.occurrences[0].lyricText=text;
  assert.equal(selectionV2(doc,{studyText:{layer:'original',revisionID:doc.id,occurrenceID:'L0001'},
   selection:{offsetUnit:'grapheme',ranges:[{lower,upper}],textHash:digest(selected)}}).text,selected);
 }
});


test('equivalent request field order and target aliases share one explanation key',()=>{
 const translation={id:'revision',target:'zh-Hans',lines:[{sourceID:'L0001',lyricText:'今天一起唱'}]};
 const selection={offsetUnit:'grapheme',ranges:[{lower:2,upper:4}],textHash:digest('一起')};
 const first=selectionV2(source,{studyText:{layer:'translation',target:'zh-Hans',revisionID:'revision',occurrenceID:'L0001'},selection},translation);
 const reordered=selectionV2(source,{studyText:{occurrenceID:'L0001',revisionID:'revision',target:'zh-CN',layer:'translation'},selection},translation);
 assert.equal(explanationKey(source,translation,first,'fr-CA'),explanationKey(source,translation,reordered,'fr'));
});

test('new fidelity recipes preserve named entities while legacy queued English prompts stay frozen',async()=>{
 const {readFile}=await import('node:fs/promises');
 const legacy=JSON.parse(await readFile(new URL('../../api/utils/song-library/prompt.json',import.meta.url),'utf8'));
 assert.equal(requestBody(source,'en',{legacy:true}).instructions,legacy.instructions);
 assert.notEqual(translationRecipe('en'),LEGACY_RECIPE);
 for(const target of ['en','fr','es','zh-Hans']){
  assert.match(requestBody(source,target).instructions,/personal and place names/);
  assert.match(requestBody(source,target).instructions,/did not is not never/);
 }
 assert.throws(()=>requestBody(source,'fr',{legacy:true}),{code:'generation_configuration_unavailable'});
});

test('new explanation languages use precise grammar rules without changing released English recipes',()=>{
 const selection={studyText:{layer:'original'},text:'Nadie'};
 assert.equal(explanationRecipe(selection,'en'),'study-text-1');
 assert.equal(explanationRecipe(selection,'zh-Hans'),'study-text-2');
 assert.equal(explanationRecipe({},'en'),'study-occurrence-2');
 assert.match(explanationBody(source,null,selection,'zh-Hans').instructions,/invariant pronoun/);
 assert.doesNotMatch(explanationBody(source,null,selection,'en').instructions,/invariant pronoun/);
});

test('Traditional Chinese states its script and name rule; other targets keep their request text',()=>{
 const doc={id:'d',sourceHash:'h',response:{song:{language:'zh',title:'Test',artist:'Test'}},structure:{version:'source-speakers-1',speakers:[],occurrences:[{sourceID:'L0001',sourceText:'我不走',lyricText:'我不走',speakerID:null,startsTurn:false,sourcePrefix:''}]}};
 const hans=requestBody(doc,'zh-Hans').instructions,hant=requestBody(doc,'zh-Hant').instructions;
 assert.ok(hans.includes('in Simplified Chinese, keep a name written in Han characters'));assert.ok(hant.includes('in Traditional Chinese, keep a name written in Han characters'));
 assert.equal(hans.replaceAll('Simplified','Traditional'),hant);
 for(const target of ['fr','es'])assert.ok(requestBody(doc,target).instructions.includes('in Simplified Chinese, keep a name'));
 const selection=selectionV2(doc,{studyText:{layer:'original',revisionID:'d',occurrenceID:'L0001'},selection:{offsetUnit:'grapheme',ranges:[{lower:1,upper:2}],textHash:digest('不')}},null);
 const script=/Write in Traditional Chinese characters throughout, including when the lyrics or a translation are in Simplified Chinese/;
 const selections=lineSelections(doc,{contractVersion:1,explanationLanguage:'zh-Hant',studyText:{layer:'original',revisionID:'d',occurrenceID:'L0001'},manifest:[{id:'w1-2',selection:{offsetUnit:'grapheme',ranges:[{lower:1,upper:2}],textHash:digest('不')}}]},null);
 assert.match(explanationBody(doc,null,selection,'zh-Hant').instructions,script);assert.match(lineBody(doc,null,selections,{language:'zh-Hant'}).instructions,script);
 for(const language of ['en','fr','es','zh-Hans']){assert.doesNotMatch(explanationBody(doc,null,selection,language).instructions,script);assert.doesNotMatch(lineBody(doc,null,selections,{language}).instructions,script);}
});
test('the admission file offers Traditional Chinese wherever Simplified is, except explaining it in Simplified',async()=>{
 const file=JSON.parse(await readFile(new URL('../../evaluation/multilingual/beta-policy.json',import.meta.url),'utf8')),policy=languagePolicy(file);
 for(const kind of ['translation','explanation'])for(const pair of file[kind].filter(p=>p.endsWith(':zh-Hans')&&!p.startsWith('zh-Han')))requireDirection(policy,kind,pair.split(':')[0],'zh-Hant');
 for(const [source,target] of [['zh-Hant','zh-Hant'],['zh-Hans','zh-Hant'],['zh-Hant','fr'],['zh-Hant','es'],['zh-Hant','en']])requireDirection(policy,'explanation',source,target);
 // One reviewed sample of a Traditional translation explained in Simplified came back in mixed, then Traditional, script.
 assert.throws(()=>requireDirection(policy,'explanation','zh-Hant','zh-Hans'),{code:'unsupported_direction'});
 assert.equal(file.translation.length,61);assert.equal(file.explanation.length,68);
});
