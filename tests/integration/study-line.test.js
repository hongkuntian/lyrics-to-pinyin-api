import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {libraryDB,source} from '../helpers/library-db.js';
import {createSongLibraryService} from '../../api/song-library.js';
import {digest} from '../../api/utils/song-library/store.js';
const recording={catalog_id:'123',artist:'Test artist',title:'Original test song',duration:12};
async function fixture(t,options={}){
 const {db,store}=await libraryDB();t.after(()=>db.close());let calls=0,translations=0;const pending=[];
 const handler=createSongLibraryService({store,selectionRevision:'test',apiKey:'test',loadLyrics:async()=>source.response,
  waitUntilFn:p=>pending.push(p),logger:{error(){}},lineFn:async(doc,translation,selections)=>{calls++;return {content:{items:selections.map(s=>({id:s.id,meaning:'Selected meaning',context:'The exact occurrence.',grammar:'',uncertainty:'',sourceQuote:s.text}))},actualMicros:1000,response:{id:'batch'}};},
  generateFn:async(doc,o)=>{translations++;const lines=doc.structure.occurrences.map(r=>({sourceID:r.sourceID,text:'Let us sing.',lyricText:'Let us sing.',speakerID:null,startsTurn:false}));for(const line of lines)o.onLine?.(line);return {content:{lines,sourceNotes:[]},actualMicros:1000,response:{id:'t'}};},...options});
 const call=async(body,token='token-a',backpressure=false)=>{
  const res=new EventEmitter();Object.assign(res,{code:200,headers:{},frames:[],setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;},write(line){this.frames.push(JSON.parse(line));return !backpressure;},end(){this.ended=true;},destroy(){this.destroyed=true;this.emit('close');}});
  await handler({method:'POST',lyricaUser:await store.authenticate(token),body},res);return res;
 };
 const doc=(await call({action:'lyrics',recording})).body.document;
 const request={action:'explain_line',contractVersion:1,explanationLanguage:'en',documentID:doc.id,sourceHash:doc.sourceHash,studyText:{layer:'original',revisionID:doc.id,occurrenceID:'L0001'},manifest:[{id:'w0-1',selection:{offsetUnit:'grapheme',ranges:[{lower:0,upper:1}],textHash:digest('把')}},{id:'w1-3',selection:{offsetUnit:'grapheme',ranges:[{lower:1,upper:3}],textHash:digest('今天')}}]};
 return {db,store,call,doc,request,pending,calls:()=>calls,translations:()=>translations};
}
test('line cache-only/resume-only do not admit; concurrent generation settles one batch',async t=>{
 const f=await fixture(t);assert.equal((await f.call({...f.request,readOnly:true})).body.state,'missing');assert.equal((await f.call({...f.request,resumeOnly:true})).body.state,'missing');assert.equal(f.calls(),0);
 await Promise.all([f.call(f.request),f.call(f.request)]);await Promise.all(f.pending);
 const result=await f.call({...f.request,readOnly:true},'token-b');assert.equal(result.body.batch.items.length,2);assert.equal(result.body.batch.items[1].sourceQuote,'今天');assert.equal(result.body.explanation,undefined);assert.equal(f.calls(),1);
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM study_explanations')).rows[0].n),1);assert.equal(Number((await f.store.budget()).daily),1000);
});
test('line authorization, malformed ranges, wrong source/context and language fail without spend',async t=>{
 const f=await fixture(t);assert.equal((await f.call(f.request,'bad')).code,401);
 for(const patch of [{sourceHash:'wrong'},{explanationLanguage:'fr'},{contractVersion:2},{manifest:[...f.request.manifest,...f.request.manifest]},{manifest:[{...f.request.manifest[0],id:'w9-10'}]},{contextTranslation:{target:'en',revisionID:'wrong'}}])assert.ok((await f.call({...f.request,...patch})).code>=400);
 assert.equal(f.calls(),0);assert.equal(Number((await f.store.budget()).daily),0);
});
test('unknown batch never retries and singleton remains a different cache identity',async t=>{
 let calls=0;const f=await fixture(t,{lineFn:async()=>{calls++;throw Error('transport');}});await f.call(f.request);await Promise.all(f.pending);
 assert.equal((await f.call({...f.request,resumeOnly:true})).code,409);assert.equal(calls,1);
 const singleton={action:'explain',contractVersion:2,explanationLanguage:'en',documentID:f.doc.id,sourceHash:f.doc.sourceHash,studyText:f.request.studyText,selection:f.request.manifest[0].selection,readOnly:true};
 assert.equal((await f.call(singleton)).body.state,'missing');
});
test('progressive translation keeps durable worker ownership after observer backpressure',async t=>{
 const f=await fixture(t);const r=await f.call({action:'translate',documentID:f.doc.id,sourceHash:f.doc.sourceHash,target:'en',delivery:'progressive-v1'},'token-a',true);await Promise.all(f.pending);
 assert.equal(r.frames[0].event,'start');assert.equal(r.destroyed,true);assert.equal(f.translations(),1);
 const saved=await f.call({action:'current',documentID:f.doc.id,sourceHash:f.doc.sourceHash,target:'en'});assert.equal(saved.body.state,'ready');assert.equal(f.translations(),1);
});
test('progressive translation final is persisted before complete and cached replies stay JSON',async t=>{
 const f=await fixture(t);const request={action:'translate',documentID:f.doc.id,sourceHash:f.doc.sourceHash,target:'en',delivery:'progressive-v1'};
 const r=await f.call(request);assert.deepEqual(r.frames.map(x=>x.event),['start','line','complete']);assert.deepEqual(r.frames.map(x=>x.sequence),[1,2,3]);assert.equal(r.ended,true);
 assert.equal(r.frames[2].translation.id,(await f.store.translation(f.doc.id,'en')).id);
 assert.equal((await f.call(request)).body.state,'ready');assert.equal(f.translations(),1);
});
test('one line batch consumes one existing member Study allowance, never one per word',async t=>{
 const f=await fixture(t);
 await f.db.query("UPDATE library_users SET access_kind='apple' WHERE id='reader-a'");
 const {MembershipStore}=await import('../../api/utils/membership/store.js');const membership=new MembershipStore(f.store.db);await membership.claimStarter('reader-a');
 assert.equal((await membership.snapshot('reader-a')).allowances.study.remaining,10);
 assert.equal((await f.call(f.request)).body.code,'generation_required');
 await f.call({...f.request,allowGeneration:true});await Promise.all(f.pending);
 assert.equal((await membership.snapshot('reader-a')).allowances.study.remaining,9);
 await f.call({...f.request,readOnly:true});assert.equal((await membership.snapshot('reader-a')).allowances.study.remaining,9);assert.equal(f.calls(),1);
});
