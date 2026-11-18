import {test} from 'node:test';
import assert from 'node:assert/strict';
import {monthlyPeriod,transactionFields,PRODUCTS} from '../../api/utils/membership/policy.js';
test('annual allowances renew at monthly anniversaries without drifting short months',()=>{
  const anchor='2026-01-31T10:20:30Z';
  assert.equal(monthlyPeriod(anchor,'2026-02-28T10:20:29Z').start.toISOString(),'2026-01-31T10:20:30.000Z');
  const p=monthlyPeriod(anchor,'2026-03-01T00:00:00Z');
  assert.equal(p.start.toISOString(),'2026-02-28T10:20:30.000Z');
  assert.equal(p.end.toISOString(),'2026-03-31T10:20:30.000Z');
  assert.equal(monthlyPeriod('2024-02-29T00:00:00Z','2025-03-01T00:00:00Z').start.toISOString(),'2025-02-28T00:00:00.000Z');
});
const now=new Date('2026-10-06T00:00:00Z'),options={bundleID:'com.hongkuntian.Lyrica',environment:'Production',now};
const fixture=()=>({productId:'com.hongkuntian.Lyrica.pro.monthly',bundleId:options.bundleID,environment:'Production',
  type:'Auto-Renewable Subscription',originalTransactionId:'1000',transactionId:'1001',
  appAccountToken:'7b140eca-8ed0-4b17-87f9-a2c7de61ca00',purchaseDate:+now-1000,expiresDate:+now+86400000,
  signedDate:+now,inAppOwnershipType:'PURCHASED'});
test('verified transaction claims are still checked against this app, products, account and environment',()=>{
  assert.equal(transactionFields(fixture(),options).tier,'pro');
  for(const replacement of [{bundleId:'another.app'},{environment:'Sandbox'},{appAccountToken:'not-a-uuid'},{appAccountToken:''},{productId:'unknown'},
    {productId:'com.hongkuntian.Lyrica.plus.monthly'},{type:'Consumable'},{inAppOwnershipType:'FAMILY_SHARED'},{expiresDate:0},{signedDate:+now+600000}])
    assert.throws(()=>transactionFields({...fixture(),...replacement},options));
  assert.equal(transactionFields({...fixture(),revocationDate:+now},options).revoked,true);
  assert.deepEqual(Object.values(PRODUCTS).map(p=>p.tier),['pro','pro']);
});
test('offer-code transactions without an appAccountToken are accepted with a null token',()=>{
  const {appAccountToken,...offer}=fixture();
  assert.equal(transactionFields(offer,options).appAccountToken,null);
  assert.equal(transactionFields({...offer,appAccountToken:null},options).appAccountToken,null);
  assert.equal(transactionFields({...fixture(),appAccountToken:'7B140ECA-8ED0-4B17-87F9-A2C7DE61CA00'},options).appAccountToken,'7b140eca-8ed0-4b17-87f9-a2c7de61ca00');
});
