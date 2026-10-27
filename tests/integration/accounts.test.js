import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
import {createWriterAuthContext} from '../../api/utils/listening-v2/auth-context.js';
import {flushSpotifyCleanup} from '../../api/utils/spotify/revocation.js';
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
async function fixture(t,options={}){
  const f=await libraryDB();t.after(()=>f.db.close());await f.db.query('UPDATE membership_settings SET public_access_enabled=true');
  await f.db.exec(await readFile(new URL('../../db/032-auth-token-row-locks.sql',import.meta.url),'utf8'));
  const db=observedDatabase(f.store.db,options);
  const apple={authenticate:async()=>({subjectHash:digest('subject'),refreshTokenEncrypted:'encrypted'}),revoke:async()=>{}};
  const accounts=new AccountStore(db,{policy,apple,spotifyCleanupFn:async(...args)=>{options.onSpotifyCleanup?.();return flushSpotifyCleanup(...args);},attestFn:()=>({publicKey:'proof',receipt:Buffer.from('receipt')})});
  const auth=new AppAuthStore(db,{policy,attestFn:()=>({publicKey:'proof',receipt:Buffer.from('receipt')}),assertionFn:({assertion})=>Number(assertion.toString())});
  return {...f,accounts,auth,apple,sessionByUser:new WeakMap(),observedDB:db};
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
  const user=await f.auth.authenticate(result.token);f.sessionByUser.set(user,result.token);
  return {user,session:result.token};
}
async function authentication(f,user){return f.accounts.prepareWriterAuthentication(f.sessionByUser.get(user));}
async function login(f,user){const {challenge}=await f.accounts.challenge({purpose:'apple',bundleID},user);
 return f.accounts.signIn(user,{bundleID,challenge,identityToken:'identity',authorizationCode:'code'},await authentication(f,user));}
// Observe and fault real statements; never replace SQL results or the auth factory.
function observedDatabase(db,{trace=[],beforeQuery=async()=>{},afterQuery=async()=>{}}={}){
 let transactionID=0;
 const connection=(raw,id)=>({query:async(sql,args=[])=>{
  const entry={sql,args:[...args],transactionID:id};trace.push(entry);
  await beforeQuery(entry,raw);const result=await raw.query(sql,args);await afterQuery(entry,raw,result);return result;
 }});
 return {query:connection(db,null).query,transaction:fn=>{
  const id=++transactionID;trace.push({event:'BEGIN',transactionID:id});
  return db.transaction(async tx=>fn(connection(tx,id))).then(result=>{
   trace.push({event:'COMMIT',transactionID:id});return result;
  },error=>{trace.push({event:'ROLLBACK',transactionID:id});throw error;});
 }};
}
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
  await assert.rejects(f.accounts.delete(signed.user,body,await authentication(f,signed.user)),{code:'apple_identity_invalid'});f.apple.authenticate=authenticate;
  assert.deepEqual(await f.accounts.delete(signed.user,body,await authentication(f,signed.user)),{deleted:true});
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
  assert.deepEqual(await f.accounts.delete(active.user,{bundleID,challenge,identityToken:'i',authorizationCode:'c'},await authentication(f,active.user)),{deleted:true});
  await f.db.query('RESET ROLE');
});

for(const loss of ['revoked','expired'])test('Apple sign-in rechecks source credential '+loss+' during external verification',async t=>{
 const f=await fixture(t),g=await guest(f),current=await session(f,g);
 const original=f.apple.authenticate;
 f.apple.authenticate=async input=>{
  if(loss==='revoked')await f.accounts.signOut(current.user,await authentication(f,current.user));
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


const denied={code:'app_access_revoked',status:403};
async function appleInput(f,user,purpose='apple'){
 const {challenge}=await f.accounts.challenge({purpose,bundleID},user);
 return {bundleID,challenge,identityToken:'identity',authorizationCode:'code'};
}
async function signedAccount(f){
 const g=await guest(f),source=await session(f,g),result=await login(f,source.user);
 const current=await session(f,{...g,token:result.credential},2);
 return {g:{...g,token:result.credential},current,result};
}
async function sibling(f,g){
 const key=Buffer.alloc(32,77).toString('base64');
 const {challenge}=await f.auth.challenge(g.token,{keyID:key,bundleID,purpose:'register'});
 await f.auth.register(g.token,{keyID:key,bundleID,challenge,attestation:'cHJvb2Y='});
 return session(f,{...g,key});
}
async function accountState(f){
 const state={};
 for(const table of ['library_users','library_tokens','app_attest_keys','app_auth_sessions','account_identities',
  'account_nonces','selected_source_access','live_lyrics_push_receipts','correction_reports','membership_grants','membership_usage'])
  state[table]=(await f.db.query(`SELECT to_jsonb(r) AS value FROM ${table} r ORDER BY to_jsonb(r)::text COLLATE "C"`)).rows;
 return state;
}

test('constructors perform no SQL and schema-absent account transitions never query V2 state or new fields',async t=>{
 const trace=[],f=await fixture(t,{trace});trace.length=0;
 const store=new AccountStore(f.observedDB,{policy,apple:f.apple});
 const writer=createWriterAuthContext({authStore:f.auth,environment:'production'});
 assert.equal(typeof writer.prepare,'function');assert.deepEqual(trace,[]);
 for(const table of ['privacy_personas','listening_v2_sessions','listening_v2_outbox'])
  assert.equal((await f.db.query('SELECT to_regclass($1) AS name',[table])).rows[0].name,null);
 assert.equal(Number((await f.db.query(`SELECT count(*) AS n FROM information_schema.columns
  WHERE column_name IN ('sessions_privacy_epoch','controller_privacy_epoch','private_transfer_from_generation')`)).rows[0].n),0);
 const {g,current}=await signedAccount(f);
 const input=await appleInput(f,current.user,'delete');
 assert.deepEqual(await f.accounts.delete(current.user,input,await authentication(f,current.user)),{deleted:true});
 const other=await guest(f,Buffer.alloc(32,9).toString('base64'),'lyra_g_'+'z'.repeat(43));
 const active=await session(f,other);
 assert.deepEqual(await f.accounts.signOut(active.user,await authentication(f,active.user)),{signedOut:true});
 assert.equal(trace.some(row=>/privacy_personas|listening_v2_|sessions_privacy_epoch|controller_privacy_epoch|private_transfer_from_generation/.test(row.sql??'')),false);
 assert.equal((await f.db.query('SELECT revoked FROM library_tokens WHERE digest=$1',[digest(g.token)])).rows[0].revoked,true);
 // The unused second store shares no handles with the first store.
 await assert.rejects(store.signOut(active.user,{}),denied);
});

for(const operation of ['signIn','delete','signOut'])test(operation+' rejects missing, fabricated, serialized and foreign-store handles before Apple IO',async t=>{
 const f=await fixture(t),{current}=await signedAccount(f),input=await appleInput(f,current.user,operation==='delete'?'delete':'apple');
 const own=await authentication(f,current.user),other=new AccountStore(f.observedDB,{policy,apple:f.apple});
 const foreign=await other.prepareWriterAuthentication(current.session);
 const factory=createWriterAuthContext({authStore:f.auth,environment:'production'});
 const raw=await factory.prepare(current.session);
 let calls=0;f.apple.authenticate=async()=>{calls++;throw Error('must not call Apple');};f.apple.revoke=async()=>{calls++;};
 const before=await accountState(f);
 for(const handle of [undefined,null,{},JSON.parse(JSON.stringify(own)),foreign,raw]){
  if(operation==='signOut')await assert.rejects(f.accounts.signOut(current.user,handle),denied);
  else await assert.rejects(f.accounts[operation](current.user,input,handle),denied);
 }
 for(const changed of [{...current.user,id:'reader-a'},{...current.user,keyID:Buffer.alloc(32,19).toString('base64')},
  {...current.user,bundleID:'other.bundle'}]){
  if(operation==='signOut')await assert.rejects(f.accounts.signOut(changed,own),denied);
  else await assert.rejects(f.accounts[operation](changed,input,own),denied);
 }
 assert.equal(calls,0);assert.deepEqual(await accountState(f),before);
 assert.equal(JSON.stringify(own).includes(current.session),false);
 assert.equal(JSON.stringify(own).includes(digest(current.session)),false);
});

for(const operation of ['signIn','delete'])for(const loss of ['replaced','revoked','deleted','expired'])
test(operation+' refuses exact source '+loss+' during Apple IO while sibling session remains live',async t=>{
 const f=await fixture(t);
 let g,current;
 if(operation==='delete')({g,current}=await signedAccount(f));
 else {g=await guest(f);current=await session(f,g);}
 const liveSibling=await sibling(f,g),input=await appleInput(f,current.user,operation==='delete'?'delete':'apple');
 const prepared=await authentication(f,current.user),original=f.apple.authenticate;
 let afterExternal,replacement;
 f.apple.authenticate=async value=>{
  if(loss==='replaced')replacement=await session(f,g,operation==='delete'?3:2);
  else if(loss==='revoked')await f.db.query('UPDATE app_auth_sessions SET revoked=true WHERE digest=$1',[digest(current.session)]);
  else if(loss==='deleted')await f.db.query('DELETE FROM app_auth_sessions WHERE digest=$1',[digest(current.session)]);
  else await f.db.query("UPDATE app_auth_sessions SET expires_at=clock_timestamp()-interval '1 ms' WHERE digest=$1",[digest(current.session)]);
  assert.equal((await f.auth.authenticate(liveSibling.session)).id,current.user.id);
  afterExternal=await accountState(f);return original(value);
 };
 await assert.rejects(f.accounts[operation](current.user,input,prepared),denied);
 assert.deepEqual(await accountState(f),afterExternal); // includes nonce, identity, token, key and data rollback
 assert.equal((await f.auth.authenticate(liveSibling.session)).id,current.user.id);
 if(replacement)assert.equal((await f.auth.authenticate(replacement.session)).keyID,current.user.keyID);
});

for(const operation of ['signIn','delete'])test(operation+' wins with the exact same source and later sibling revocation cannot undo its commit',async t=>{
 const f=await fixture(t);let g,current;
 if(operation==='delete')({g,current}=await signedAccount(f));else {g=await guest(f);current=await session(f,g);}
 const liveSibling=await sibling(f,g),input=await appleInput(f,current.user,operation==='delete'?'delete':'apple');
 const original=f.apple.authenticate;f.apple.authenticate=async value=>{
  assert.equal((await f.auth.authenticate(current.session)).keyID,current.user.keyID);
  assert.equal((await f.auth.authenticate(liveSibling.session)).id,current.user.id);return original(value);
 };
 const result=await f.accounts[operation](current.user,input,await authentication(f,current.user));
 await f.db.query('UPDATE app_auth_sessions SET revoked=true WHERE digest=$1',[digest(liveSibling.session)]);
 await assert.rejects(f.auth.authenticate(current.session),{code:'session_expired'});
 assert.equal((await f.db.query('SELECT revoked FROM library_tokens WHERE digest=$1',[current.user.credentialDigest])).rows[0].revoked,true);
 if(operation==='signIn'){
  assert.match(result.credential,/^lyra_a_[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.db.query('SELECT user_id FROM app_attest_keys WHERE key_id=$1',[g.key])).rows[0].user_id,result.userID);
 }else assert.deepEqual(result,{deleted:true});
});

test('signOut requires its submitted live session even when another session authenticates the same tuple',async t=>{
 const f=await fixture(t),g=await guest(f),current=await session(f,g),prepared=await authentication(f,current.user);
 const replacement=await session(f,g,2),before=await accountState(f);
 assert.deepEqual(replacement.user,current.user);
 await assert.rejects(f.accounts.signOut(current.user,prepared),denied);
 assert.deepEqual(await accountState(f),before);
 assert.deepEqual(await f.accounts.signOut(replacement.user,await authentication(f,replacement.user)),{signedOut:true});
 await assert.rejects(f.auth.authenticate(replacement.session),{code:'session_expired'});
});

test('failed delete rolls back consumed nonce and every account write after the last data mutation',async t=>{
 let armed=false,failed=false,flushes=0;
 const f=await fixture(t,{onSpotifyCleanup:()=>{flushes++;},afterQuery:async({sql},tx)=>{
  if(armed&&/^UPDATE correction_reports/.test(sql)){failed=true;await tx.query('SELECT 1/0');}
 }});
 const {current}=await signedAccount(f),input=await appleInput(f,current.user,'delete'),prepared=await authentication(f,current.user);
 const before=await accountState(f),beforeFlushes=flushes;armed=true;
 await assert.rejects(f.accounts.delete(current.user,input,prepared));
 assert.equal(failed,true);assert.deepEqual(await accountState(f),before);assert.equal(flushes,beforeFlushes);
 assert.equal((await f.auth.authenticate(current.session)).id,current.user.id);
 armed=false;
 assert.deepEqual(await f.accounts.delete(current.user,input,await authentication(f,current.user)),{deleted:true});
});

for(const operation of ['signIn','signOut','delete'])for(const relation of ['app_auth_sessions','library_tokens'])
test(operation+' final verification rolls back when captured '+relation+' deadline crosses after intentional mutation',async t=>{
 let armed=false,installed=false,crossed=false,deadline;
 const trace=[],f=await fixture(t,{trace,beforeQuery:async({sql},tx)=>{
  if(armed&&!installed&&/pg_current_xact_id/.test(sql)){
   installed=true;
   const value=(await tx.query(`UPDATE ${relation} SET expires_at=clock_timestamp()+interval '250 milliseconds'
    WHERE digest=$1 RETURNING expires_at::text AS deadline`,[relation==='app_auth_sessions'?digest(current.session):current.user.credentialDigest])).rows[0];
   deadline=value.deadline;
  }
 },afterQuery:async({sql},tx)=>{
  const lastMutation=operation==='signIn'?/^DELETE FROM app_auth_sessions/.test(sql):
   operation==='signOut'?/^UPDATE library_tokens SET revoked=true WHERE digest=/.test(sql):/^UPDATE correction_reports/.test(sql);
  if(armed&&installed&&!crossed&&lastMutation){
   crossed=true;await setTimeout(350);
   const time=(await tx.query('SELECT clock_timestamp()>=$1::timestamptz AS expired,now()<$1::timestamptz AS stale',[deadline])).rows[0];
   assert.equal(time.expired,true);assert.equal(time.stale,true);
  }
 }});
 let current,g;
 if(operation==='delete')({current,g}=await signedAccount(f));else {g=await guest(f);current=await session(f,g);}
 if(relation==='app_auth_sessions')await f.db.query('UPDATE library_tokens SET expires_at=NULL WHERE digest=$1',[current.user.credentialDigest]);
 const input=operation==='signOut'?null:await appleInput(f,current.user,operation==='delete'?'delete':'apple');
 const prepared=await authentication(f,current.user),before=await accountState(f);armed=true;trace.length=0;
 if(operation==='signOut')await assert.rejects(f.accounts.signOut(current.user,prepared),denied);
 else await assert.rejects(f.accounts[operation](current.user,input,prepared),denied);
 assert.equal(installed,true);assert.equal(crossed,true);assert.deepEqual(await accountState(f),before);
 assert.equal(trace.at(-1).event,'ROLLBACK');
});

for(const mismatch of ['C2 owner','target key owner'])test('final auth postimage rejects '+mismatch+' mismatch rather than authorizing a different Apple target',async t=>{
 const f=await fixture(t),g=await guest(f),current=await session(f,g),input=await appleInput(f,current.user);
 const prepared=await authentication(f,current.user);
 if(mismatch==='C2 owner')await f.db.exec(`CREATE FUNCTION account_test_wrong_owner() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.user_id LIKE 'apple-%' THEN NEW.user_id='reader-a'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER account_test_wrong_owner BEFORE INSERT ON library_tokens FOR EACH ROW EXECUTE FUNCTION account_test_wrong_owner()`);
 else await f.db.exec(`CREATE FUNCTION account_test_wrong_owner() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.user_id LIKE 'apple-%' THEN NEW.user_id='reader-a'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER account_test_wrong_owner BEFORE UPDATE ON app_attest_keys FOR EACH ROW EXECUTE FUNCTION account_test_wrong_owner()`);
 const before=await accountState(f);
 await assert.rejects(f.accounts.signIn(current.user,input,prepared),denied);
 assert.deepEqual(await accountState(f),before);
});

for(const operation of ['signIn','signOut','delete'])test(operation+' takes one ordered writer pass, locks all required keys before sessions and performs no IO after final auth SQL',async t=>{
 const trace=[],f=await fixture(t,{trace});let current,g;
 if(operation==='delete')({g,current}=await signedAccount(f));else {g=await guest(f);current=await session(f,g);}
 const other=await sibling(f,g),input=operation==='signOut'?null:await appleInput(f,current.user,operation==='delete'?'delete':'apple');
 const prepared=await authentication(f,current.user);
 const captured=(await f.db.query(`SELECT s.expires_at::text AS session_deadline,t.expires_at::text AS credential_deadline
  FROM app_auth_sessions s JOIN library_tokens t ON t.digest=s.credential_digest WHERE s.digest=$1`,[digest(current.session)])).rows[0];
 trace.length=0;let outcome;
 if(operation==='signOut')outcome=await f.accounts.signOut(current.user,prepared);
 else outcome=await f.accounts[operation](current.user,input,prepared);
 const tx=trace.find(row=>row.event==='BEGIN').transactionID,entries=trace.filter(row=>row.transactionID===tx);
 assert.equal(entries.at(-1).event,'COMMIT');
 const sql=entries.filter(row=>row.sql),locks=sql.filter(row=>/FOR (?:NO KEY )?UPDATE/.test(row.sql));
 const userLocks=locks.filter(row=>/FROM (?:public\.)?library_users/.test(row.sql));
 assert.ok(userLocks.length>0);assert.ok(userLocks.every(row=>/FOR NO KEY UPDATE/.test(row.sql)));
 for(const table of ['library_users','library_tokens','app_attest_keys','app_auth_sessions']){
  const individual=locks.filter(row=>new RegExp(`FROM (?:public\\.)?${table}\\b`).test(row.sql));
  const identities=individual.filter(row=>/WHERE (?:id|digest|key_id)=\$1\b/.test(row.sql)).map(row=>row.args[0]);
  assert.equal(new Set(identities).size,identities.length,'no repeated '+table+' row lock');
  assert.deepEqual(identities,[...identities].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
 }
 const rank=row=>/FROM (?:public\.)?library_users/.test(row.sql)?0:/FROM (?:public\.)?library_tokens/.test(row.sql)?1:
  /FROM (?:public\.)?app_attest_keys/.test(row.sql)?2:/FROM (?:public\.)?app_auth_sessions/.test(row.sql)?3:null;
 const categories=locks.map(rank).filter(value=>value!==null);
 assert.deepEqual(categories,[...categories].sort((a,b)=>a-b));
 const keyLocks=locks.filter(row=>/FROM (?:public\.)?app_attest_keys/.test(row.sql));
 assert.ok(keyLocks.some(row=>row.args.includes(current.user.keyID)));
 if(operation!=='signIn')assert.ok(keyLocks.some(row=>row.args.includes(other.user.keyID)));
 const sessionLocks=locks.filter(row=>/FROM (?:public\.)?app_auth_sessions/.test(row.sql));
 assert.ok(sessionLocks.some(row=>row.args.some(value=>value===digest(current.session)||Array.isArray(value)&&value.includes(digest(current.session)))));
 // Final auth sampling must be the last statement, followed directly by transaction return/COMMIT.
 assert.match(sql.at(-1).sql,/clock_timestamp\(\)/);
 // The exact S digest was proved in the session lock above. Final auth must
 // still check S's captured exact deadline after signIn/delete removed S.
 assert.equal(sql.at(-1).args[0],captured.session_deadline);
 assert.equal(sql.at(-1).args[1],captured.credential_deadline);
 const targetDeadline=operation==='signIn'?(await f.db.query('SELECT expires_at::text AS deadline FROM library_tokens WHERE digest=$1',
  [digest(outcome.credential)])).rows[0].deadline:null;
 assert.equal(sql.at(-1).args[2],targetDeadline);
});

test('fresh target credential unique failure rolls back identity creation and nonce consumption',async t=>{
 const f=await fixture(t),g=await guest(f),current=await session(f,g),input=await appleInput(f,current.user);
 const prepared=await authentication(f,current.user);
 await f.db.exec(`CREATE FUNCTION account_test_digest_collision() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.user_id LIKE 'apple-%' THEN NEW.digest='${current.user.credentialDigest}'; END IF; RETURN NEW; END $$;
  CREATE TRIGGER account_test_digest_collision BEFORE INSERT ON library_tokens FOR EACH ROW EXECUTE FUNCTION account_test_digest_collision()`);
 const before=await accountState(f);
 await assert.rejects(f.accounts.signIn(current.user,input,prepared),{code:'23505'});
 assert.deepEqual(await accountState(f),before);
});

for(const sameOwner of [true,false])test('Apple '+(sameOwner?'A-to-A':'A-to-B')+' preserves original starter and user data while moving only the exact device',async t=>{
 const f=await fixture(t),{current,g}=await signedAccount(f),members=new MembershipStore(f.store.db);
 const original=await members.claimStarter(current.user.id);
 await f.db.query('UPDATE library_users SET unlimited_generation=true WHERE id=$1',[current.user.id]);
 const other=await sibling(f,g);
 if(!sameOwner)f.apple.authenticate=async()=>({subjectHash:digest('second-subject'),refreshTokenEncrypted:'second-encrypted'});
 const result=await login(f,current.user);
 assert.equal(result.userID===current.user.id,sameOwner);
 const retained=await members.snapshot(current.user.id);
 assert.equal(retained.account.appAccountToken,original.account.appAccountToken);assert.equal(retained.starter.claimed,true);
 assert.equal((await f.db.query('SELECT unlimited_generation FROM library_users WHERE id=$1',[current.user.id])).rows[0].unlimited_generation,true);
 assert.equal((await f.db.query('SELECT user_id FROM app_attest_keys WHERE key_id=$1',[other.user.keyID])).rows[0].user_id,current.user.id);
 assert.equal((await f.db.query('SELECT user_id FROM app_attest_keys WHERE key_id=$1',[current.user.keyID])).rows[0].user_id,result.userID);
});

test('HTTP prepares each exact bearer once and preserves V1 Apple, signOut and delete DTOs',async t=>{
 const f=await fixture(t),g=await guest(f),current=await session(f,g),preparedTokens=[];
 const prepare=f.accounts.prepareWriterAuthentication.bind(f.accounts);
 f.accounts.prepareWriterAuthentication=async token=>{preparedTokens.push(token);return prepare(token);};
 const handler=createAccountHandler({store:f.accounts,authStore:f.auth}),request=async(token,body)=>{
  const res=createMockRes();await handler({method:'POST',headers:{authorization:'Bearer '+token},body},res);return res;
 };
 const challenge=await request(current.session,{action:'challenge',purpose:'apple',bundleID});
 assert.equal(challenge.statusCode,200);assert.deepEqual(preparedTokens,[]);
 const apple=await request(current.session,{action:'apple',bundleID,challenge:challenge.body.challenge,identityToken:'identity',authorizationCode:'code'});
 assert.equal(apple.statusCode,200);assert.deepEqual(Object.keys(apple.body).sort(),['credential','userID','version']);
 const active=await session(f,{...g,token:apple.body.credential},2);
 const deleting=await appleInput(f,active.user,'delete');
 const removed=await request(active.session,{action:'delete',...deleting});
 assert.equal(removed.statusCode,200);assert.deepEqual(removed.body,{version:1,deleted:true});
 const other=await guest(f,Buffer.alloc(32,13).toString('base64'),'lyra_g_'+'q'.repeat(43)),out=await session(f,other);
 const signedOut=await request(out.session,{action:'signOut'});
 assert.equal(signedOut.statusCode,200);assert.deepEqual(signedOut.body,{version:1,signedOut:true});
 assert.deepEqual(preparedTokens,[current.session,active.session,out.session]);
});

test('HTTP maps stale exact evidence to existing app_access_revoked and leaks no bearer or digest',async t=>{
 const f=await fixture(t),g=await guest(f),current=await session(f,g),input=await appleInput(f,current.user);
 const original=f.apple.authenticate;f.apple.authenticate=async value=>{await session(f,g,2);return original(value);};
 const handler=createAccountHandler({store:f.accounts,authStore:f.auth}),res=createMockRes();
 await handler({method:'POST',headers:{authorization:'Bearer '+current.session},body:{action:'apple',...input}},res);
 assert.equal(res.statusCode,403);assert.deepEqual(res.body,{version:1,code:'app_access_revoked'});
 for(const secret of [current.session,digest(current.session),current.user.credentialDigest])assert.equal(JSON.stringify(res.body).includes(secret),false);
});

test('Sessions lifecycle constructor is optional, closed and pure on the actual AccountStore',()=>{
 const db={query(){throw Error('construction SQL');},transaction(){throw Error('construction SQL');}};
 new AccountStore(db,{policy});new AccountStore(db,{policy,sessionsPrivacy:{coordinatorEnvironment:'test'}});
 assert.throws(()=>new AccountStore(db,{policy,sessionsPrivacy:{coordinatorEnvironment:'test',permit:true}}),{code:'sessions_privacy_unavailable'});
});
