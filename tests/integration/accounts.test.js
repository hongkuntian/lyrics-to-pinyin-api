import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {libraryDB} from '../helpers/library-db.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {MembershipStore} from '../../api/utils/membership/store.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {createAccountHandler} from '../../api/account.js';
import {createMockRes} from '../helpers/mock-http.js';
import {digest} from '../../api/utils/song-library/store.js';
import {replayMembershipRoleGrants} from '../../scripts/membership-role-grants.js';
const policy={audience:'test',environment:'production',prefix:'9ESZX68J8U',bundles:['com.test.Lyrica']};
const bundleID=policy.bundles[0],credential='lyra_g_'+'a'.repeat(43),keyID=Buffer.alloc(32,3).toString('base64');
async function fixture(t){
  const f=await libraryDB();t.after(()=>f.db.close());await f.db.query('UPDATE membership_settings SET public_access_enabled=true');
  const apple={authenticate:async()=>({subjectHash:digest('subject'),refreshTokenEncrypted:'encrypted'}),revoke:async()=>{}};
  const accounts=new AccountStore(f.store.db,{policy,apple,attestFn:()=>({publicKey:'proof',receipt:Buffer.from('receipt')})});
  const auth=new AppAuthStore(f.store.db,{policy,assertionFn:({assertion})=>Number(assertion.toString())});
  return {...f,accounts,auth,apple};
}
async function guest(f,key=keyID,token=credential){
  const input={purpose:'guest',bundleID,keyID:key};
  const nonce=await f.accounts.challenge(input,null,'127.0.0.1');
  const body={...input,...nonce,credential:token,attestation:'cHJvb2Y='};
  await f.accounts.guest(body);return {body,token,key};
}
async function session(f,g,counter=1){
  const {challenge}=await f.auth.challenge(g.token,{keyID:g.key,bundleID,purpose:'session'});
  const result=await f.auth.session(g.token,{keyID:g.key,bundleID,challenge,assertion:Buffer.from(String(counter)).toString('base64')});
  return {user:await f.auth.authenticate(result.token),session:result.token};
}
async function login(f,user){const {challenge}=await f.accounts.challenge({purpose:'apple',bundleID},user);return f.accounts.signIn(user,{bundleID,challenge,identityToken:'identity',authorizationCode:'code'});}
test('guest enrollment is attested, bounded and retryable without issuing a session',async t=>{
  const f=await fixture(t),g=await guest(f);assert.deepEqual(await f.accounts.guest(g.body),{registered:true});
  const current=await session(f,g);assert.equal((await new MembershipStore(f.store.db).snapshot(current.user.id)).account.kind,'guest');
  await assert.rejects(f.auth.authenticate(g.token),{code:'session_expired'});
  await assert.rejects(f.accounts.guest({...g.body,credential:'lyra_g_'+'b'.repeat(43)}),{code:'challenge_expired'});
  await f.db.query('UPDATE library_tokens SET expires_at=now() WHERE digest=$1',[digest(g.token)]);
  await assert.rejects(f.auth.authenticate(current.session),{code:'session_expired'});
});
test('guest nonce binds key and bundle and fails closed when access is disabled',async t=>{
  const f=await fixture(t),nonce=await f.accounts.challenge({purpose:'guest',bundleID,keyID},null,'test');
  const body={...nonce,bundleID,keyID,credential,attestation:'cHJvb2Y='};
  await assert.rejects(f.accounts.guest({...body,bundleID:'other.app'}),{code:'challenge_expired'});
  await f.db.query('UPDATE membership_settings SET public_access_enabled=false');
  await assert.rejects(f.accounts.guest(body),{code:'public_access_unavailable'});
});
test('Apple login migrates only this device and converges on the same account and starter',async t=>{
  const f=await fixture(t),g=await guest(f),a=await session(f,g),first=await login(f,a.user);
  await assert.rejects(f.auth.authenticate(a.session),{code:'session_expired'});
  const appleSession=await session(f,{...g,token:first.credential},2);
  const members=new MembershipStore(f.store.db),snapshot=await members.claimStarter(first.userID);
  assert.equal(snapshot.allowances.translation.remaining,2);
  const other=await guest(f,Buffer.alloc(32,4).toString('base64'),'lyra_g_'+'b'.repeat(43));
  const second=await login(f,(await session(f,other)).user);
  assert.equal(first.userID,second.userID);assert.equal((await members.snapshot(second.userID)).account.appAccountToken,snapshot.account.appAccountToken);
  assert.equal((await f.auth.authenticate(appleSession.session)).id,first.userID);
  assert.equal((await members.claimStarter(second.userID)).allowances.translation.limit,2);
});
test('account deletion requires matching fresh Apple proof, revokes devices and preserves spent grant identity',async t=>{
  const f=await fixture(t),g=await guest(f),loginResult=await login(f,(await session(f,g)).user);
  const signed=await session(f,{...g,token:loginResult.credential},2),members=new MembershipStore(f.store.db);
  await members.claimStarter(signed.user.id);
  const {challenge}=await f.accounts.challenge({purpose:'delete',bundleID},signed.user);
  const body={challenge,bundleID,identityToken:'identity',authorizationCode:'code'};
  const authenticate=f.apple.authenticate;f.apple.authenticate=async()=>({subjectHash:'other',refreshTokenEncrypted:'encrypted'});
  await assert.rejects(f.accounts.delete(signed.user,body),{code:'apple_identity_invalid'});f.apple.authenticate=authenticate;
  assert.deepEqual(await f.accounts.delete(signed.user,body),{deleted:true});
  await assert.rejects(f.auth.authenticate(signed.session),{code:'session_expired'});
  const retained=(await f.db.query('SELECT * FROM account_identities')).rows[0];assert.equal(retained.refresh_token_encrypted,null);assert.ok(retained.deleted_at);
  const returning=await guest(f,Buffer.alloc(32,5).toString('base64'),'lyra_g_'+'c'.repeat(43));
  const result=await login(f,(await session(f,returning)).user);assert.equal(result.userID,signed.user.id);
  assert.equal((await members.snapshot(result.userID)).starter.claimed,true);
});
test('public account HTTP rejects anonymous identity operations, surplus fields and malformed attestations',async t=>{
  const f=await fixture(t),handler=createAccountHandler({store:f.accounts,authStore:f.auth});
  for(const [body,status] of [[{action:'signOut'},401],[{action:'challenge',purpose:'apple',bundleID},401],
    [{action:'challenge',purpose:'guest',bundleID,keyID,admin:true},400],
    [{action:'guest',bundleID,keyID,credential,challenge:'x'.repeat(43),attestation:'invalid'},400]]){
    const res=createMockRes();await handler({method:'POST',headers:{},body},res);assert.equal(res.statusCode,status);}
});
test('the separate account login can enroll and sign in but cannot change generation budgets or grants',async t=>{
  const f=await fixture(t);
  // This partial-schema fixture must install the guarded anchor before late
  // role provisioning; replay deliberately refuses an unmigrated database.
  await f.db.exec(await readFile(new URL('../../db/032-auth-token-row-locks.sql',import.meta.url),'utf8'));
  await f.db.query('CREATE ROLE lyra_account_v1');
  await replayMembershipRoleGrants(f.db);
  await replayMembershipRoleGrants(f.db); // Late provisioning is idempotent.
  await f.db.query('SET ROLE lyra_account_v1');
  const g=await guest(f);
  await assert.rejects(f.db.query("UPDATE library_users SET unlimited_generation=true"),e=>e.code==='42501');
  await assert.rejects(f.db.query("UPDATE membership_settings SET purchases_enabled=true"),e=>e.code==='42501');
  await assert.rejects(f.db.query("UPDATE library_settings SET enabled=true"),e=>e.code==='42501');
  await f.db.query('RESET ROLE');
  const signed=await session(f,g);
  await f.db.query('SET ROLE lyra_account_v1');
  const apple=await login(f,signed.user);assert.match(apple.credential,/^lyra_a_/);
  await f.db.query('RESET ROLE');
  const active=await session(f,{...g,token:apple.credential},2);
  await f.db.query('SET ROLE lyra_account_v1');
  const {challenge}=await f.accounts.challenge({purpose:'delete',bundleID},active.user);
  assert.deepEqual(await f.accounts.delete(active.user,{bundleID,challenge,identityToken:'i',authorizationCode:'c'}),{deleted:true});
  await f.db.query('RESET ROLE');
});

for(const loss of ['revoked','expired'])test('Apple sign-in rechecks source credential '+loss+' during external verification',async t=>{
 const f=await fixture(t),g=await guest(f),current=await session(f,g);
 const original=f.apple.authenticate;
 f.apple.authenticate=async input=>{
  if(loss==='revoked')await f.accounts.signOut(current.user);
  else await f.db.query('UPDATE library_tokens SET expires_at=clock_timestamp() WHERE digest=$1',[current.user.credentialDigest]);
  return original(input);
 };
 await assert.rejects(login(f,current.user),{code:'app_access_revoked',status:403});
 assert.equal((await f.db.query('SELECT user_id FROM app_attest_keys WHERE key_id=$1',[g.key])).rows[0].user_id,current.user.id);
 assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM account_identities')).rows[0].n),0);
});
test('guest credential keeps exact 90-day DB issuance deadline and ACK does not extend it',async t=>{
 const f=await fixture(t),before=(await f.db.query('SELECT clock_timestamp() AS at')).rows[0].at,g=await guest(f);
 const expiry=(await f.db.query('SELECT expires_at FROM library_tokens WHERE digest=$1',[digest(g.token)])).rows[0].expires_at;
 const after=(await f.db.query('SELECT clock_timestamp() AS at')).rows[0].at;
 assert.ok(+expiry>=+before+90*86400000&&+expiry<=+after+90*86400000);
 await f.accounts.guest(g.body);
 assert.equal(+(await f.db.query('SELECT expires_at FROM library_tokens WHERE digest=$1',[digest(g.token)])).rows[0].expires_at,+expiry);
});
