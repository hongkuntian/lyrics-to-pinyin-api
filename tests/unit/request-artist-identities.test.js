import test from 'node:test';
import assert from 'node:assert/strict';
import {requestArtistIdentities} from '../../api/utils/request-artist-identities.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('providers share one fresh identity snapshot for the acquisition',async()=>{
 const gate=deferred(),calls=[];
 const identity=requestArtistIdentities(async(ids,options)=>{calls.push({ids,options});return gate.promise;},['artist'],{refresh:true});
 const a=identity.read(),b=identity.read();
 await Promise.resolve();assert.equal(calls.length,1);assert.equal(calls[0].options.refresh,true);
 gate.resolve([{names:['verified']}]);
 const first=await a,second=await b;first[0].names.push('mutation');
 assert.deepEqual(second,[{names:['verified']}]);assert.deepEqual(await identity.read(),second);
 assert.equal(calls.length,1);identity.close();
});

test('one provider cancelling cannot cancel another provider identity reader',async()=>{
 const gate=deferred();let ownerSignal;
 const identity=requestArtistIdentities(async(_,{signal})=>{ownerSignal=signal;return gate.promise;},['artist']);
 const provider=new AbortController(),a=identity.read({signal:provider.signal}),b=identity.read();
 await Promise.resolve();provider.abort();await assert.rejects(a,{name:'AbortError'});assert.equal(ownerSignal.aborted,false);
 gate.resolve([{names:['verified']}]);assert.deepEqual(await b,[{names:['verified']}]);identity.close();
});

test('request cancellation and completion retire speculative identity work',async()=>{
 for(const action of ['cancel','complete']){
  const parent=new AbortController();let ownerSignal;
  const identity=requestArtistIdentities(async(_,{signal})=>{ownerSignal=signal;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true}));},['artist'],{signal:parent.signal});
  const reader=identity.read();await Promise.resolve();
  if(action==='cancel')parent.abort();else identity.close();
  assert.equal(ownerSignal.aborted,true);assert.deepEqual(await reader,[]);identity.close();
 }
});

test('an unavailable identity fails closed once without preventing another source',async()=>{
 let calls=0;const identity=requestArtistIdentities(async()=>{calls++;throw new Error('offline');},['artist']);
 assert.deepEqual(await identity.read(),[]);assert.deepEqual(await identity.read(),[]);assert.equal(calls,1);identity.close();
});
