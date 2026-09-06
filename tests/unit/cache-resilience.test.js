import test from 'node:test';
import assert from 'node:assert/strict';
import {getCached,setCached} from '../../api/utils/cache.js';

test('a failed optional cache is bypassed for subsequent reads and writes',async()=> {
  let reads=0,writes=0;
  const redis={async get(){reads++;throw new Error('cache unreachable');},async setex(){writes++;}};
  assert.equal(await getCached(redis,'a'),null);
  await setCached(redis,'a',{ok:true},60);
  assert.equal(await getCached(redis,'b'),null);
  assert.equal(reads,1);
  assert.equal(writes,0);
});
test('healthy cache clients continue working independently of a failed client',async()=> {
  let stored;
  const redis={async get(){return stored;},async setex(key,ttl,value){stored=value;}};
  await setCached(redis,'a',{ok:true},60);
  assert.deepEqual(await getCached(redis,'a'),{ok:true});
});
