import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchJSON} from '../../api/utils/fetch-json.js';
test('one bounded retry recovers a transient upstream failure',async()=>{
 let calls=0;
 assert.deepEqual(await fetchJSON('https://fixture.invalid',{fetchFn:async()=>++calls===1 ? {ok:false,status:503}:{ok:true,json:async()=>({ok:true})}}),{ok:true});
 assert.equal(calls,2);
});
test('persistent upstream failures and client errors never retry indefinitely',async()=>{
 for(const [status,expected] of [[503,2],[404,1],[429,1]]){
  let calls=0;await assert.rejects(()=>fetchJSON('https://fixture.invalid',{fetchFn:async()=>{calls++;return {ok:false,status}}}),/HTTP/);
  assert.equal(calls,expected);
 }
});
test('cancellation prevents a queued retry',async()=>{
 let calls=0;const controller=new AbortController();
 await assert.rejects(()=>fetchJSON('https://fixture.invalid',{signal:controller.signal,fetchFn:async()=>{calls++;controller.abort();return {ok:false,status:503}}}),{name:'AbortError'});
 assert.equal(calls,1);
});

test('short Retry-After is honored once and sends a descriptive user agent',async()=>{
 let calls=0;
 const result=await fetchJSON('https://fixture.invalid',{fetchFn:async(_,init)=>{
  assert.equal(init.headers['User-Agent'],'Lyra/2.3.0');calls++;
  return calls===1 ? {ok:false,status:429,headers:{get:()=> '0'}}:{ok:true,json:async()=>({ok:true})};
 }});
 assert.deepEqual(result,{ok:true});assert.equal(calls,2);
});
test('rate limit waits beyond the budget or invalid headers do not retry early',async()=>{
 for(const value of ['2','-1','invalid','',new Date(Date.now()+60000).toUTCString()]) {
  let calls=0;
  await assert.rejects(()=>fetchJSON('https://fixture.invalid',{fetchFn:async()=>{
   calls++;return {ok:false,status:429,headers:{get:()=>value}};
  }}),{status:429});
  assert.equal(calls,1);
 }
});
test('caller cancellation aborts a Retry-After delay instead of issuing another request',async()=>{
 let calls=0;const controller=new AbortController();
 await assert.rejects(()=>fetchJSON('https://fixture.invalid',{signal:controller.signal,fetchFn:async()=>{
  calls++;controller.abort();return {ok:false,status:429,headers:{get:()=> '1'}};
 }}),{name:'AbortError'});
 assert.equal(calls,1);
});
