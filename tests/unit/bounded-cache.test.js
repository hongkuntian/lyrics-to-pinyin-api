import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedCache} from '../../api/utils/bounded-cache.js';
import {withDeadline} from '../../api/utils/fetch-json.js';
test('bounded cache expires, evicts least recently used entries and skips oversized payloads',()=>{
 let now=0;const cache=new BoundedCache({limit:2,ttlMs:10,now:()=>now,maxEntryBytes:30});
 cache.set('a',{a:1});cache.set('b',{b:1});assert.deepEqual(cache.get('a'),{a:1});cache.set('c',{c:1});assert.equal(cache.get('b'),null);
 cache.set('large','x'.repeat(40));assert.equal(cache.get('large'),null);
 now=11;assert.equal(cache.get('a'),null);assert.equal(cache.get('c'),null);
});
test('a shorter entry lifetime expires a fallback without shortening established results',()=>{
 let now=0;const cache=new BoundedCache({ttlMs:86400000,now:()=>now});
 cache.set('timed',{kind:'timed'});cache.set('plain',{kind:'plain'},{ttlMs:300000});
 now=299999;assert.equal(cache.get('plain').kind,'plain');
 now=300001;assert.equal(cache.get('plain'),null);assert.equal(cache.get('timed').kind,'timed');
 cache.set('expired',{kind:'plain'},{ttlMs:0});assert.equal(cache.get('expired'),null);
});
test('parent cancellation aborts underlying work and deadlines bound uncooperative operations',async()=>{
 const parent=new AbortController();let aborted=false;
 const pending=withDeadline(signal=>new Promise(()=>signal.addEventListener('abort',()=>aborted=true)),1000,parent.signal);
 await Promise.resolve();parent.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(aborted,true);
 await assert.rejects(withDeadline(()=>new Promise(()=>{}),5),{code:'provider_timeout'});
});
