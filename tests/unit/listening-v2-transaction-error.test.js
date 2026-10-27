import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionV2Error,transactionRetrySignal} from '../../api/utils/listening-v2/errors.js';
import {authError} from '../../api/utils/app-auth/http.js';

test('only the supported transactional SQL states yield a closed sanitized signal',()=>{
 for(const code of ['40001','40P01']){
  const raw=Object.assign(new Error('SQL secret message'),{code,detail:'SQL secret detail',hint:'SQL secret hint',
   query:'SQL secret query',constraint:'SQL secret constraint',cause:new Error('SQL secret cause')});
  const signal=transactionRetrySignal(raw);assert.ok(signal instanceof Error);assert.notEqual(signal,raw);
  assert.equal(signal.code,code);assert.equal(signal.message,'transaction_retry');assert.equal(signal.cause,undefined);
  assert.equal(transactionRetrySignal(signal),signal);assert.ok(Object.isFrozen(signal));
  assert.deepEqual(Object.keys(signal),['code']);
  assert.doesNotMatch(JSON.stringify(signal)+signal.stack,/SQL secret/);
 }
 for(const error of [null,undefined,{},new Error('x'),{code:'XX000'},{code:'42P01'},{code:'40000'},
  {code:40001},new SessionV2Error('unauthorized'),new SessionV2Error('forbidden'),
  new SessionV2Error('conflict'),new SessionV2Error('expired')])assert.equal(transactionRetrySignal(error),null);
 const semantic=new SessionV2Error('unauthorized');semantic.code='40001';assert.equal(transactionRetrySignal(semantic),null);
});

test('account HTTP boundary bounds the internal signal and emits no SQL details',()=>{
 const signal=transactionRetrySignal(Object.assign(new Error('private message'),{code:'40001',detail:'private detail'}));
 let status,body,log;const res={status(n){status=n;return this;},json(value){body=value;return value;},setHeader(){}};
 authError(res,signal,{error(message){log=message;}});
 assert.equal(status,503);assert.deepEqual(body,{version:1,code:'app_auth_unavailable'});
 assert.equal(log,'app_auth_unavailable');assert.doesNotMatch(JSON.stringify(body),/40001|private/);
});
