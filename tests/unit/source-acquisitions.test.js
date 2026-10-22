import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceAcquisitions,canonicalAcquisitionKey} from '../../api/utils/source-acquisitions.js';
const gate=()=>{let release;return {promise:new Promise(r=>release=r),release:()=>release()};};
const tick=()=>new Promise(r=>setImmediate(r));
const realDate=Date,realSetTimeout=setTimeout;
function mockClock(t){
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 t.after(()=>{t.mock.timers.reset();assert.equal(Date,realDate);assert.equal(setTimeout,realSetTimeout);});
}
test('canonical source owner replays snapshots and survives first reader cancellation during owned formatting',async()=>{
 const registry=new SourceAcquisitions(),format=gate(),a=new AbortController(),b=new AbortController(),seen=[];let scope,calls=0;
 const start=async context=>{calls++;scope=context;context.publish({text:'plain'});await context.own(format.promise);context.signal.throwIfAborted();return {status:200,body:{text:'timed'}};};
 const deadline=Date.now()+1000,first=registry.join('same',{signal:a.signal,deadlineAtMS:deadline,start}).catch(e=>e.name);
 await tick();const second=registry.join('same',{signal:b.signal,deadlineAtMS:deadline+5000,start,onSnapshot:value=>seen.push(value.text)});await tick();a.abort();assert.equal(scope.signal.aborted,false);format.release();
 assert.equal(await first,'AbortError');const finished=await second;assert.equal(finished.result.body.text,'timed');assert.equal(finished.deadlineAtMS,deadline);assert.equal(calls,1);assert.deepEqual(seen,['plain']);
});
test('a near-deadline join shares the source owner without restarting its clock',{timeout:2000},async t=>{
 mockClock(t);
 const registry=new SourceAcquisitions(),ready=gate(),abortedAt=[];let scope,calls=0,settled=0;
 const start=async context=>{
  calls++;scope=context;
  await new Promise(resolve=>{
   context.signal.addEventListener('abort',()=>{abortedAt.push(Date.now());resolve();},{once:true});
   ready.release();
  });
  return {status:504};
 };
 const deadline=Date.now()+15;
 const first=registry.join('same',{deadlineAtMS:deadline,start}).then(result=>{settled++;return result;});
 await ready.promise;t.mock.timers.tick(14);
 const second=registry.join('same',{deadlineAtMS:Date.now()+10000,start}).then(result=>{settled++;return result;});
 assert.equal(scope.signal.aborted,false);assert.equal(settled,0);assert.deepEqual(abortedAt,[]);
 t.mock.timers.tick(1);assert.equal(scope.signal.aborted,true);assert.deepEqual(abortedAt,[deadline]);
 const [a,b]=await Promise.all([first,second]);
 assert.equal(a.result.status,504);assert.equal(b.result.status,504);
 assert.equal(a.joined,false);assert.equal(b.joined,true);
 assert.equal(a.sourceAcquisitionID,scope.acquisitionID);assert.equal(b.sourceAcquisitionID,a.sourceAcquisitionID);
 assert.equal(a.deadlineAtMS,deadline);assert.equal(b.deadlineAtMS,deadline);
 assert.equal(calls,1);assert.equal(settled,2);assert.equal(registry.owners.size,0);
 t.mock.timers.tick(10000);assert.equal(calls,1);assert.deepEqual(abortedAt,[deadline]);
});
test('only the last reader cancellation aborts shared source work',{timeout:2000},async t=>{
 mockClock(t);
 const registry=new SourceAcquisitions(),ready=gate(),aborted=gate(),a=new AbortController(),b=new AbortController();let scope,calls=0,aborts=0,secondSettled=false;
 const start=async context=>{
  calls++;scope=context;
  await new Promise(resolve=>{
   context.signal.addEventListener('abort',()=>{aborts++;aborted.release();resolve();},{once:true});
   ready.release();
  });
  return {status:504};
 };
 const deadline=Date.now()+1000,first=registry.join('same',{signal:a.signal,deadlineAtMS:deadline,start});
 const firstCancelled=assert.rejects(first,{name:'AbortError'});
 await ready.promise;
 const second=registry.join('same',{signal:b.signal,deadlineAtMS:deadline,start}).finally(()=>{secondSettled=true;});
 const secondCancelled=assert.rejects(second,{name:'AbortError'});
 a.abort();await firstCancelled;
 assert.equal(scope.signal.aborted,false);assert.equal(secondSettled,false);assert.equal(aborts,0);assert.equal(calls,1);assert.equal(registry.owners.size,1);
 b.abort();await aborted.promise;await secondCancelled;
 assert.equal(scope.signal.aborted,true);assert.equal(secondSettled,true);assert.equal(aborts,1);assert.equal(calls,1);assert.equal(registry.owners.size,0);
});
test('source owner tests restore Date and setTimeout',{timeout:2000},async()=>{
 assert.equal(Date,realDate);assert.equal(setTimeout,realSetTimeout);
 await new Promise(resolve=>setTimeout(resolve,1));
});
test('canonical owner eligibility includes policy and all source-affecting catalog context',()=>{
 const request={catalog_id:'123',storefront:'us',artist:'Artist',title:'Song',album:'Album',duration:240};
 const resolution={version:'catalog-recording-1',requested:{catalog_id:'123',storefront:'us'},accepted_request:{catalog_id:'123',artist:'Artist',title:'Song',album:'Album',duration:240},canonical_recording_id:'apple:123',catalog_items:[{catalog_id:'123'}],searches:[{catalog_id:'123',artist:'Artist',title:'Song',album:'Album',duration:240}],genres:[],artist_entities:[]};
 const options={selection:'policy1',normalization:'norm1',reading:'pinyin',sources:['LRCAPI']},key=canonicalAcquisitionKey(request,resolution,options);
 const ca={...request,storefront:'ca'},caProof={...resolution,requested:{...resolution.requested,storefront:'ca'}};assert.equal(canonicalAcquisitionKey(ca,caProof,options),key);
 for(const changed of [{...options,selection:'policy2'},{...options,normalization:'norm2'},{...options,reading:'none'},{...options,sources:['KugouAPI']}])assert.notEqual(canonicalAcquisitionKey(request,resolution,changed),key);
 for(const changed of [{...resolution,genres:['C-pop']},{...resolution,artist_entities:[{id:'a',name:'Artist'}]},{...resolution,searches:[{...resolution.searches[0],album:'Other'}]}])assert.notEqual(canonicalAcquisitionKey(request,changed,options),key);
 const other={...request,catalog_id:'124'},otherProof={...resolution,requested:{...resolution.requested,catalog_id:'124'},accepted_request:{...resolution.accepted_request,catalog_id:'124'},catalog_items:[{catalog_id:'124'}]};assert.notEqual(canonicalAcquisitionKey(other,otherProof,options),key);
 assert.equal(canonicalAcquisitionKey(request,{canonical_recording_id:'apple:123'},options),null);
});
test('one rejecting snapshot subscriber cannot interrupt another reader or source completion',async()=>{
 const registry=new SourceAcquisitions(),ready=gate(),finish=gate(),seen=[];
 const start=async context=>{await ready.promise;context.publish({text:'valid'});await finish.promise;return {status:200};};
 const a=registry.join('same',{deadlineAtMS:Date.now()+1000,start,onSnapshot:()=>{throw new Error('closed sink');}}),b=registry.join('same',{deadlineAtMS:Date.now()+1000,start,onSnapshot:value=>seen.push(value.text)});ready.release();await tick();finish.release();assert.equal((await a).result.status,200);assert.equal((await b).result.status,200);assert.deepEqual(seen,['valid']);
});
