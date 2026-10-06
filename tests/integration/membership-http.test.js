import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {libraryDB} from '../helpers/library-db.js';
import {createMockRes} from '../helpers/mock-http.js';
import {createMembershipHandler} from '../../api/membership.js';
import {createStoreNotificationHandler} from '../../api/store-notifications.js';
import {MembershipStore} from '../../api/utils/membership/store.js';
import {LibraryError} from '../../api/utils/song-library/store.js';

test('membership HTTP requires app sessions, verified purchase data and explicit starter claims',async t=>{
 const f=await libraryDB();t.after(()=>f.db.close());
 await f.db.query("UPDATE library_users SET access_kind='apple' WHERE id='reader-a'");
 const token=randomUUID();await f.db.query("INSERT INTO account_identities(subject_hash,user_id,app_account_token) VALUES('subject','reader-a',$1)",[token]);
 const store=new MembershipStore(f.store.db);
 const handler=createMembershipHandler({store,libraryStore:f.store,authStore:{authenticate:async()=>({id:'reader-a'})},
   verifier:{transaction:async()=>{throw new LibraryError('purchase_unverified',403);}}});
 async function call(body,credential='lyra_s_session') {
  const res=createMockRes();await handler({method:'POST',body,headers:{authorization:`Bearer ${credential}`}},res);return res;
 }
 assert.equal((await call({action:'status'},'guest')).statusCode,401);
 assert.equal((await call({action:'status'})).body.allowances.translation.remaining,0);
 assert.equal((await call({action:'transaction',signedTransaction:'forged'})).statusCode,403);
 assert.equal((await call({action:'status'})).body.tier,'free');
 assert.equal((await call({action:'claimStarter'})).body.allowances.translation.remaining,2);
 assert.equal((await call({action:'claimStarter',allowance:100})).statusCode,400);
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
