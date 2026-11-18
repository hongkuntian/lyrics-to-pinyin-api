import test from 'node:test';
import assert from 'node:assert/strict';
import {libraryDB} from '../helpers/library-db.js';
import {createMockRes} from '../helpers/mock-http.js';
import {createMembershipHandler} from '../../api/membership.js';
import {createStoreNotificationHandler} from '../../api/store-notifications.js';
import {MembershipStore} from '../../api/utils/membership/store.js';
import {LibraryError} from '../../api/utils/song-library/store.js';

test('membership HTTP requires app sessions, verified purchase data and no starter action',async t=>{
 const f=await libraryDB();t.after(()=>f.db.close());
 await f.db.query("UPDATE library_users SET access_kind='guest' WHERE id='reader-a'");
 const store=new MembershipStore(f.store.db);
 const handler=createMembershipHandler({store,libraryStore:f.store,authStore:{authenticate:async()=>({id:'reader-a',bundleID:'com.hongkuntian.Lyrica'})},
   verifier:{transaction:async()=>{throw new LibraryError('purchase_unverified',403);}}});
 async function call(body,credential='lyrica_s_session') {
  const res=createMockRes();await handler({method:'POST',body,headers:{authorization:`Bearer ${credential}`}},res);return res;
 }
 assert.equal((await call({action:'status'},'guest')).statusCode,401);
 const status=(await call({action:'status'})).body;
 assert.equal(status.allowances.translation.remaining,0);assert.equal(status.account.kind,'guest');
 assert.match(status.account.appAccountToken,/^[0-9a-f-]{36}$/);
 assert.equal((await call({action:'transaction',signedTransaction:'forged'})).statusCode,403);
 assert.equal((await call({action:'status'})).body.tier,'free');
 assert.equal((await call({action:'claimStarter'})).statusCode,400);
 assert.equal((await call({action:'status'})).body.libraryTranslations.remaining,3);
 // Removed Sign in with Apple paths and unknown fields are refused.
 assert.equal((await call({action:'status',appleUser:'x'})).statusCode,400);
});

test('transaction restore is the literal string "true" and reaches the store; preview passes deviceToken and the session bundle',async t=>{
 const seen=[],store={recordTransaction:async(...args)=>{seen.push(['transaction',...args]);return {};},
  claimPreview:async(...args)=>{seen.push(['preview',...args]);return {};},snapshot:async()=>({})};
 const handler=createMembershipHandler({store,libraryStore:{rateLimit:async()=>{}},
  authStore:{authenticate:async()=>({id:'reader-a',bundleID:'com.hongkuntian.Lyrica.Debug'})},
  verifier:{transaction:async signed=>({originalID:signed})}});
 const call=async body=>{const res=createMockRes();await handler({method:'POST',body,headers:{authorization:'Bearer lyrica_s_session'}},res);return res.statusCode;};
 for(const restore of [true,'false','TRUE',1,''])assert.equal(await call({action:'transaction',signedTransaction:'s',restore}),400);
 assert.equal(await call({action:'transaction',signedTransaction:'sync'}),200);
 assert.equal(await call({action:'transaction',signedTransaction:'restore',restore:'true'}),200);
 assert.equal(await call({action:'preview',activityID:'a',recordingID:'r',deviceToken:'dG9rZW4='}),200);
 assert.equal(await call({action:'preview',activityID:'a',recordingID:'r',deviceToken:'dG9rZW4=',restore:'true'}),400);
 assert.deepEqual(seen,[['transaction','reader-a',{originalID:'sync'},{restore:false}],['transaction','reader-a',{originalID:'restore'},{restore:true}],
  ['preview','reader-a',{action:'preview',activityID:'a',recordingID:'r',deviceToken:'dG9rZW4='},{bundleID:'com.hongkuntian.Lyrica.Debug'}]]);
});

test('notification HTTP verifies the signed envelope before storing any event',async()=>{
 let writes=0;
 const handler=createStoreNotificationHandler({store:{applyNotification:async()=>writes++},
   verifier:{notification:async signed=>{
     if(signed!=='verified')throw new LibraryError('purchase_unverified',403);
     return {id:'event',transaction:{}};
   }}});
 for(const [body,status] of [[{},400],[{signedPayload:'forged'},403],[{signedPayload:'verified'},200]]){
  const res=createMockRes();await handler({method:'POST',body},res);assert.equal(res.statusCode,status);
 }
 assert.equal(writes,1);
});
