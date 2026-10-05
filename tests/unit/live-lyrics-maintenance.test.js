import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanupExpiredPushState} from '../../api/utils/live-lyrics/maintenance.js';

test('overlapping requests sharing a pool do not fan out maintenance transactions',async()=>{
  let release,calls=0;
  const pending=new Promise(resolve=>release=resolve);
  const db={transaction:async fn=>{
    calls++;await pending;
    return fn({query:async sql=>({rows:sql.includes('WITH expired_receipts')?[{receipts:0,rateWindows:0}]:[]})});
  }};
  const first=cleanupExpiredPushState(db,{now:()=>1000});
  try {
    assert.deepEqual(await cleanupExpiredPushState(db,{now:()=>1001}),{state:'skipped'});
    assert.equal(calls,1);
  }finally{release();}
  assert.deepEqual(await first,{state:'completed',receipts:0,rateWindows:0});
});
