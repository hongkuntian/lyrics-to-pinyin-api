import test from 'node:test';
import assert from 'node:assert/strict';
import {JSONLeaves,responseStream} from '../../api/utils/song-library/response-stream.js';
import {translationDelivery} from '../../api/utils/song-library/translation-delivery.js';
import {executeTranslationJob} from '../../api/utils/song-library/translation-worker.js';
const text=JSON.stringify({translations:{L0001:'你好 "moon" 🌙',L0002:'No.'},sourceNotes:[]});
const events=(terminalPatch={},output=text)=>[
 {type:'response.created',response:{id:'r'}},
 {type:'response.output_item.added',output_index:1,item:{type:'message',id:'m'}},
 ...[output.slice(0,25),output.slice(25)].map(delta=>({type:'response.output_text.delta',item_id:'m',output_index:1,content_index:0,delta})),
 {type:'response.output_text.done',item_id:'m',output_index:1,content_index:0,text:output},
 {type:'response.completed',response:{id:'r',status:'completed',output:[{type:'reasoning'},{type:'message',id:'m',content:[{type:'output_text',text:output}]}]},...terminalPatch}];
const response=(list,split)=>{const raw=Buffer.from(list.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join(''));return new Response(new ReadableStream({start(c){for(let i=0;i<raw.length;i+=split)c.enqueue(raw.subarray(i,i+split));c.close();}}),{headers:{'content-type':'text/event-stream'}});};
test('incremental JSON string leaves at every character boundary',()=>{
 for(let cut=0;cut<=text.length;cut++){
  const found=[];const p=new JSONLeaves((path,value)=>found.push([path,value]));p.feed(text.slice(0,cut));p.feed(text.slice(cut));p.finish();
  assert.deepEqual(found,[[['translations','L0001'],'你好 "moon" 🌙'],[['translations','L0002'],'No.']]);
 }
});
test('JSON lexer rejects duplicate escaped keys, trailing commas, broken nesting and depth',()=>{
 for(const raw of ['{"a":1,"\\u0061":2}','{"a":1,}','[1,]','{"a":]','{}{}','{"a":"unterminated', '['.repeat(25)+']'.repeat(25)])assert.throws(()=>{const p=new JSONLeaves(()=>{});p.feed(raw);p.finish();});
});
test('SSE handles UTF8, CRLF and arbitrary byte boundaries',async()=>{
 for(const split of [1,2,3,7,1000]){let output='';const r=await responseStream(response(events(),split),{onText:delta=>output+=delta});assert.equal(r.status,'completed');assert.equal(output,text);}
});
test('SSE refuses truncated, failed and wrong message/part/index/terminal identities',async()=>{
 const variants=[events().slice(0,-1),events({type:'response.failed'}),events({response:{...events().at(-1).response,id:'other'}})];
 for(const patch of [{item_id:'other'},{output_index:-1},{output_index:0},{content_index:true},{content_index:1.5}]){const e=events();e[2]={...e[2],...patch};variants.push(e);}
 const mismatch=events();mismatch.at(-1).response.output[1].content[0].text='other';variants.push(mismatch);
 for(const e of variants)await assert.rejects(()=>responseStream(response(e,3),{onText(){}}));
});
test('backpressure detaches observer and never throws into generation',()=>{
 const frames=[];let destroyed=0;const res={status(){},setHeader(){},write(l){frames.push(JSON.parse(l));return false;},destroy(){destroyed++;}};
 const d=translationDelivery(res,{id:'d',sourceHash:'h'},'en',{id:'j'});d.onStart();d.onLine({sourceID:'L0001',lyricText:'x'});d.complete({});d.end();assert.equal(frames.length,1);assert.equal(destroyed,1);
});
test('worker claims once and settles despite an observer exception',async()=>{
 let claims=0,complete=0,provider=0;const doc={id:'d'};
 const store={claim:async()=>++claims===1?{id:'j',document_id:'d',target:'en',generation_request:{}}:null,complete:async()=>complete++,fail:async()=>assert.fail()};
 const opts={doc,observer:{onStart(){throw Error('reader');},onLine(){throw Error('closed');}},generateFn:async(_,o)=>{provider++;o.onLine({});return {content:{},actualMicros:1,response:{}};}};
 await Promise.all([executeTranslationJob(store,'j',opts),executeTranslationJob(store,'j',opts)]);assert.equal(provider,1);assert.equal(complete,1);
});
test('provisional text cannot qualify a refusal, bad notes or a different terminal model',async()=>{
 const {makeDocument}=await import('../../api/utils/song-library/document.js');
 const {generate}=await import('../../api/utils/song-library/translation.js');
 const source={song:{id:'test',title:{original:'Test'},artist:{original:'Test'},language:'zh',romanization_system:'pinyin'},quality:{synced:false,partial:false,instrumental:false},metadata:{source:'test'},lines:[{original:'你好',romanized:'nǐ hǎo',timestamp:null},{original:'再见',romanized:'zài jiàn',timestamp:null}]};
 const doc=makeDocument({catalog_id:'123',artist:'Test',title:'Test',duration:12},source,'test');
 let drafts=0;
 const normal=events();Object.assign(normal.at(-1).response,{model:'gpt-6-luna',service_tier:'default',usage:{input_tokens:10,output_tokens:10}});
 const good=await generate(doc,{apiKey:'test',fetchFn:async()=>response(normal,1),onLine:()=>drafts++});assert.equal(good.content.lines.length,2);assert.equal(drafts,2);
 const wrong=structuredClone(normal);wrong.at(-1).response.model='other';
 await assert.rejects(()=>generate(doc,{apiKey:'test',fetchFn:async()=>response(wrong,2),onLine(){}}),e=>e.code==='provider_configuration_changed'&&e.actualMicros===null);
 const refused=structuredClone(normal);refused.at(-1).response.output[1].content[0]={type:'refusal',refusal:'No'};
 await assert.rejects(()=>generate(doc,{apiKey:'test',fetchFn:async()=>response(refused,3),onLine(){}}),e=>e.code==='provider_refused'&&e.actualMicros!==null);
 const bad=JSON.parse(text);bad.sourceNotes=[{sourceID:'L0001',sourceQuote:'invented',kind:'uncertain_source',explanation:'A guess'}];
 const badNotes=events({},JSON.stringify(bad));Object.assign(badNotes.at(-1).response,{model:'gpt-6-luna',service_tier:'default',usage:{input_tokens:10,output_tokens:10}});
 await assert.rejects(()=>generate(doc,{apiKey:'test',fetchFn:async()=>response(badNotes,3),onLine(){}}),e=>e.code==='invalid_source_evidence');
 const incomplete=structuredClone(normal);incomplete.at(-1).type='response.incomplete';incomplete.at(-1).response.status='incomplete';
 await assert.rejects(()=>generate(doc,{apiKey:'test',fetchFn:async()=>response(incomplete,2),onLine(){}}),e=>e.code==='provider_incomplete'&&e.actualMicros!==null);
});
test('async observer rejection and throwing teardown cannot prevent settlement',async()=>{
 let complete=0;const store={claim:async()=>({id:'j',document_id:'d',target:'en',generation_request:{}}),complete:async()=>complete++,fail:async()=>assert.fail()};
 await executeTranslationJob(store,'j',{doc:{id:'d'},observer:{async onLine(){await Promise.resolve();throw Error('closed');}},generateFn:async(_,o)=>{o.onLine({});return {content:{},actualMicros:1,response:{}};}});
 assert.equal(complete,1);
 const res={status(){},setHeader(){},write(){throw Error('disconnected');},destroy(){throw Error('already destroyed');},off(){throw Error('closed');}};
 const observer=translationDelivery(res,{id:'d',sourceHash:'h'},'en',{id:'j'});
 assert.doesNotThrow(()=>{observer.onStart();observer.onLine({});observer.failed('x');observer.end();});
});
