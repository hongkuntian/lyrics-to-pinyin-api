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
