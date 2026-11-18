import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
import {createWriterAuthContext} from '../../api/utils/app-auth/auth-context.js';
import {libraryDB} from '../helpers/library-db.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {MembershipStore,admitLibraryTranslation} from '../../api/utils/membership/store.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {createAccountHandler} from '../../api/account.js';
import {createMockRes} from '../helpers/mock-http.js';
import {digest} from '../../api/utils/song-library/store.js';
import {replayMembershipRoleGrants} from '../../scripts/membership-role-grants.js';
import {mockDeviceCheck,appleDeviceState,deviceToken} from '../helpers/device-check.js';

// Lyrica has no sign-in: anonymous (guest) enrollment and guest deletion.
// DeviceCheck is unconfigured unless a test says otherwise; its enrollment
// rules have their own file (guest-enrollment-device-check.test.js).
const policy={audience:'test',environment:'production',prefix:'9ESZX68J8U',bundles:['com.test.Lyrica']};
const bundleID=policy.bundles[0],credential='lyrica_g_'+'a'.repeat(43),keyID=Buffer.alloc(32,3).toString('base64');
const unconfigured={configured:false};
async function fixture(t,options={}){
  const f=await libraryDB();t.after(()=>f.db.close());await f.db.query('UPDATE membership_settings SET public_access_enabled=true');
  await f.db.exec(await readFile(new URL('../../db/032-auth-token-row-locks.sql',import.meta.url),'utf8'));
  const db=observedDatabase(f.store.db,options);
  const accounts=new AccountStore(db,{policy,deviceCheck:options.deviceCheck??unconfigured,logger:{},
    attestFn:()=>({publicKey:'proof',receipt:Buffer.from('receipt')})});
  const auth=new AppAuthStore(db,{policy,attestFn:()=>({publicKey:'proof',receipt:Buffer.from('receipt')}),assertionFn:({assertion})=>Number(assertion.toString())});
  return {...f,accounts,auth,sessionByUser:new WeakMap(),observedDB:db};
}
let address=1;
async function guest(f,key=keyID,token=credential,extra={}){
  const input={purpose:'guest',bundleID,keyID:key};
  const nonce=await f.accounts.challenge(input,'127.0.0.'+(address++%250));
  const body={bundleID,keyID:key,...nonce,credential:token,attestation:'cHJvb2Y=',...extra};
  await f.accounts.guest(body);return {body,token,key};
}
async function session(f,g,counter=1){
  const {challenge}=await f.auth.challenge(g.token,{keyID:g.key,bundleID,purpose:'session'});
  const result=await f.auth.session(g.token,{keyID:g.key,bundleID,challenge,assertion:Buffer.from(String(counter)).toString('base64')});
  const user=await f.auth.authenticate(result.token);f.sessionByUser.set(user,result.token);
  return {user,session:result.token};
}
async function authentication(f,user){return f.accounts.prepareWriterAuthentication(f.sessionByUser.get(user));}
async function sibling(f,g){
  const key=Buffer.alloc(32,77).toString('base64');
  const {challenge}=await f.auth.challenge(g.token,{keyID:key,bundleID,purpose:'register'});
  await f.auth.register(g.token,{keyID:key,bundleID,challenge,attestation:'cHJvb2Y='});
  return session(f,{...g,key});
}
async function guestAccount(f){const g=await guest(f);return {g,current:await session(f,g)};}
// Beta (access code) accounts come from the operator; reader-a holds token-a.
async function betaAccount(f){return {current:await session(f,{token:'token-a',key:await registerKey(f,'token-a',Buffer.alloc(32,41).toString('base64'))})};}
async function registerKey(f,token,key){
  const {challenge}=await f.auth.challenge(token,{keyID:key,bundleID,purpose:'register'});
  await f.auth.register(token,{keyID:key,bundleID,challenge,attestation:'cHJvb2Y='});return key;
}
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
async function accountState(f){
 const state={};
 for(const table of ['library_users','library_tokens','app_attest_keys','app_auth_sessions',
  'account_nonces','selected_source_access','live_lyrics_push_receipts','correction_reports','membership_grants','membership_usage'])
  state[table]=(await f.db.query(`SELECT to_jsonb(r) AS value FROM ${table} r ORDER BY to_jsonb(r)::text COLLATE "C"`)).rows;
 return state;
}
const denied={code:'app_access_revoked',status:403};
const notDeletable={code:'account_not_deletable',status:403};

test('guest enrollment is attested, bounded and retryable without issuing a session',async t=>{
  const f=await fixture(t),g=await guest(f);assert.deepEqual(await f.accounts.guest(g.body),{registered:true});
  const current=await session(f,g);assert.equal((await new MembershipStore(f.store.db).snapshot(current.user.id)).account.kind,'guest');
  await assert.rejects(f.auth.authenticate(g.token),{code:'session_expired'});
  await assert.rejects(f.accounts.guest({...g.body,credential:'lyrica_g_'+'b'.repeat(43)}),{code:'challenge_expired'});
  await f.db.query('UPDATE library_tokens SET expires_at=now() WHERE digest=$1',[digest(g.token)]);
  await assert.rejects(f.auth.authenticate(current.session),{code:'session_expired'});
});
test('guest nonce binds key and bundle and fails closed when access is disabled',async t=>{
  const f=await fixture(t),nonce=await f.accounts.challenge({purpose:'guest',bundleID,keyID},'test');
  const body={...nonce,bundleID,keyID,credential,attestation:'cHJvb2Y='};
  await assert.rejects(f.accounts.guest({...body,bundleID:'other.app'}),{code:'challenge_expired'});
  await f.db.query('UPDATE membership_settings SET public_access_enabled=false');
  await assert.rejects(f.accounts.guest(body),{code:'public_access_unavailable'});
});
test('enrollment is the only challenge purpose',async t=>{
  const f=await fixture(t);
  for(const purpose of ['apple','delete',undefined])
    await assert.rejects(f.accounts.challenge({purpose,bundleID,keyID},'test'),{code:'invalid_request',status:400});
  await assert.rejects(f.accounts.challenge({purpose:'guest',bundleID},'test'),{code:'invalid_request'});
  assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM account_nonces')).rows[0].n),0);
});
test('guest credential keeps exact 90-day DB issuance deadline and ACK does not extend it',async t=>{
 const f=await fixture(t),before=(await f.db.query('SELECT clock_timestamp() AS at')).rows[0].at,g=await guest(f);
 const expiry=(await f.db.query('SELECT expires_at FROM library_tokens WHERE digest=$1',[digest(g.token)])).rows[0].expires_at;
 const after=(await f.db.query('SELECT clock_timestamp() AS at')).rows[0].at;
 assert.ok(+expiry>=+before+90*86400000&&+expiry<=+after+90*86400000);
 await f.accounts.guest(g.body);
 assert.equal(+(await f.db.query('SELECT expires_at FROM library_tokens WHERE digest=$1',[digest(g.token)])).rows[0].expires_at,+expiry);
});

test('guest deletion revokes every device of the account, scrubs its data and preserves spent grant identity',async t=>{
  const f=await fixture(t),{g,current}=await guestAccount(f),other=await sibling(f,g),members=new MembershipStore(f.store.db);
  await admitLibraryTranslation(f.store.db,current.user.id,'opened-song',{unlock:true});
  await f.db.query("INSERT INTO live_lyrics_push_receipts(activity_id,user_id,token_digest,expires_at) VALUES('activity',$1,'push','2099-01-01T00:00:00Z')",[current.user.id]);
  assert.deepEqual(await f.accounts.delete(current.user,await authentication(f,current.user)),{deleted:true});
  for(const live of [current.session,other.session])await assert.rejects(f.auth.authenticate(live),{code:'session_expired'});
  const user=(await f.db.query('SELECT * FROM library_users WHERE id=$1',[current.user.id])).rows[0];
  assert.equal(user.disabled,true);assert.equal(user.access_kind,'guest');
  assert.deepEqual((await f.db.query('SELECT bool_and(revoked) AS revoked FROM library_tokens WHERE user_id=$1',[current.user.id])).rows[0],{revoked:true});
  assert.deepEqual((await f.db.query("SELECT bool_and(revoked AND public_key='' AND receipt=''::bytea) AS scrubbed,count(*)::int AS n FROM app_attest_keys WHERE user_id=$1",[current.user.id])).rows[0],{scrubbed:true,n:2});
  assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM app_auth_sessions s JOIN app_attest_keys k ON k.key_id=s.key_id WHERE k.user_id=$1',[current.user.id])).rows[0].n),0);
  assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM live_lyrics_push_receipts WHERE user_id=$1',[current.user.id])).rows[0].n),0);
  // The pseudonymous allowance ledger stays so opened songs and refunds stay consistent.
  assert.equal(Number((await f.db.query('SELECT count(*) AS n FROM membership_usage WHERE user_id=$1',[current.user.id])).rows[0].n),1);
  await assert.rejects(members.snapshot(current.user.id),{code:'unauthorized'});
  // The next use creates a new account with a new credential and key.
  const fresh=await guest(f,Buffer.alloc(32,5).toString('base64'),'lyrica_g_'+'c'.repeat(43));
  const next=await session(f,fresh);assert.notEqual(next.user.id,current.user.id);
});

test('a reinstall after deletion on the same device gets a held allowance',async t=>{
  const NOW=Date.UTC(2026,10,17),apple=appleDeviceState(()=>NOW),mock=mockDeviceCheck({now:()=>NOW,respond:apple.respond});
  const f=await fixture(t,{deviceCheck:mock.device});
  const g=await guest(f,keyID,credential,{deviceToken}),current=await session(f,g);
  assert.equal((await f.db.query('SELECT free_allowance_held_until FROM library_users WHERE id=$1',[current.user.id])).rows[0].free_allowance_held_until,null);
  assert.deepEqual(await f.accounts.delete(current.user,await authentication(f,current.user)),{deleted:true});
  const again=await guest(f,Buffer.alloc(32,6).toString('base64'),'lyrica_g_'+'d'.repeat(43),{deviceToken}),next=await session(f,again);
  assert.ok((await f.db.query('SELECT free_allowance_held_until FROM library_users WHERE id=$1',[next.user.id])).rows[0].free_allowance_held_until);
  assert.equal((await new MembershipStore(f.store.db).snapshot(next.user.id)).libraryTranslations.remaining,0);
});

test('access code (beta) accounts are not deletable and keep every row and session',async t=>{
  const f=await fixture(t),{current}=await betaAccount(f),before=await accountState(f);
  assert.equal(current.user.id,'reader-a');
  await assert.rejects(f.accounts.delete(current.user,await authentication(f,current.user)),notDeletable);
  assert.deepEqual(await accountState(f),before);
  assert.equal((await f.auth.authenticate(current.session)).id,'reader-a');
});

test('an account that becomes beta after the preflight is refused inside the locked transaction',async t=>{
  let armed=false;
  const f=await fixture(t,{afterQuery:async({sql,transactionID},raw)=>{
    if(armed&&transactionID===null&&/^SELECT access_kind FROM library_users/.test(sql)){armed=false;await raw.query("UPDATE library_users SET access_kind='beta' WHERE id LIKE 'guest-%'");}
  }});
  const {current}=await guestAccount(f),prepared=await authentication(f,current.user),before=await accountState(f);armed=true;
  await assert.rejects(f.accounts.delete(current.user,prepared),notDeletable);
  const after=await accountState(f);
  assert.deepEqual(after.library_tokens,before.library_tokens);assert.deepEqual(after.app_attest_keys,before.app_attest_keys);
  assert.deepEqual(after.app_auth_sessions,before.app_auth_sessions);
});

test('public account HTTP: delete needs a session bearer and exactly {action:"delete"}; removed actions are refused',async t=>{
  const f=await fixture(t),handler=createAccountHandler({store:f.accounts,authStore:f.auth});
  const {current}=await guestAccount(f);
  const call=async(body,token)=>{const res=createMockRes();await handler({method:'POST',headers:token?{authorization:'Bearer '+token}:{},body,socket:{remoteAddress:'10.2.2.2'}},res);return res;};
  for(const [body,token,status] of [
    [{action:'delete'},null,401],[{action:'delete'},credential,401],
    [{action:'delete',bundleID},current.session,400],[{action:'delete',challenge:'x'.repeat(43)},current.session,400],
    [{action:'signOut'},current.session,400],[{action:'apple',bundleID,challenge:'x'.repeat(43),identityToken:'i',authorizationCode:'c'},current.session,400],
    [{action:'challenge',purpose:'apple',bundleID,keyID},null,400],[{action:'challenge',purpose:'delete',bundleID,keyID},current.session,400],
    [{action:'challenge',purpose:'guest',bundleID,keyID,admin:true},null,400],
    [{action:'guest',bundleID,keyID,credential,challenge:'x'.repeat(43),attestation:'invalid'},null,400]])
    assert.equal((await call(body,token)).statusCode,status,JSON.stringify(body));
  assert.equal((await f.auth.authenticate(current.session)).id,current.user.id);
  const removed=await call({action:'delete'},current.session);
  assert.equal(removed.statusCode,200);assert.deepEqual(removed.body,{version:1,deleted:true});
  await assert.rejects(f.auth.authenticate(current.session),{code:'session_expired'});
  const beta=await betaAccount(f),refused=await call({action:'delete'},beta.current.session);
  assert.equal(refused.statusCode,403);assert.deepEqual(refused.body,{version:1,code:'account_not_deletable'});
});

test('HTTP prepares the exact bearer once and maps stale exact evidence to app_access_revoked without leaking it',async t=>{
  const f=await fixture(t),{g,current}=await guestAccount(f),prepared=[];
  const prepare=f.accounts.prepareWriterAuthentication.bind(f.accounts);
  // The source session is replaced right after the handler prepares it.
  f.accounts.prepareWriterAuthentication=async token=>{prepared.push(token);const handle=await prepare(token);await session(f,g,2);return handle;};
  const handler=createAccountHandler({store:f.accounts,authStore:f.auth}),res=createMockRes();
  await handler({method:'POST',headers:{authorization:'Bearer '+current.session},body:{action:'delete'}},res);
  assert.deepEqual(prepared,[current.session]);
  assert.equal(res.statusCode,403);assert.deepEqual(res.body,{version:1,code:'app_access_revoked'});
  for(const secret of [current.session,digest(current.session),current.user.credentialDigest])assert.equal(JSON.stringify(res.body).includes(secret),false);
  assert.equal((await f.db.query('SELECT disabled FROM library_users WHERE id=$1',[current.user.id])).rows[0].disabled,false);
});

test('the separate account login can enroll with a hold and delete but cannot change generation budgets or grants',async t=>{
  const f=await fixture(t,{deviceCheck:mockDeviceCheck().device});
  await f.db.query('CREATE ROLE lyrica_account_v1');
  await replayMembershipRoleGrants(f.db);
  await replayMembershipRoleGrants(f.db); // Late provisioning is idempotent.
  await f.db.query('SET ROLE lyrica_account_v1');
  // Configured DeviceCheck without a token holds: the INSERT needs the 039 column grant.
  const g=await guest(f);
  await assert.rejects(f.db.query("UPDATE library_users SET unlimited_generation=true"),e=>e.code==='42501');
  await assert.rejects(f.db.query("UPDATE library_users SET free_allowance_held_until=NULL"),e=>e.code==='42501');
  await assert.rejects(f.db.query("UPDATE membership_settings SET purchases_enabled=true"),e=>e.code==='42501');
  await assert.rejects(f.db.query("UPDATE membership_settings SET relay_access='everyone'"),e=>e.code==='42501');
  await assert.rejects(f.db.query("UPDATE library_settings SET enabled=true"),e=>e.code==='42501');
  await assert.rejects(f.db.query("SELECT public.slide_guest_credential_expiry('x')"),e=>e.code==='42501');
  await f.db.query('RESET ROLE');
  const signed=await session(f,g);
  assert.ok((await f.db.query('SELECT free_allowance_held_until FROM library_users WHERE id=$1',[signed.user.id])).rows[0].free_allowance_held_until);
  await f.db.query('SET ROLE lyrica_account_v1');
  assert.deepEqual(await f.accounts.delete(signed.user,await authentication(f,signed.user)),{deleted:true});
  await f.db.query('RESET ROLE');
});

test('constructors perform no SQL and schema-absent deletion never queries V2 state or new fields',async t=>{
 const trace=[],f=await fixture(t,{trace});trace.length=0;
 const store=new AccountStore(f.observedDB,{policy,deviceCheck:unconfigured});
 const writer=createWriterAuthContext({authStore:f.auth,environment:'production'});
 assert.equal(typeof writer.prepare,'function');assert.deepEqual(trace,[]);
 for(const table of ['privacy_personas','listening_v2_sessions','listening_v2_outbox'])
  assert.equal((await f.db.query('SELECT to_regclass($1) AS name',[table])).rows[0].name,null);
 const {g,current}=await guestAccount(f);
 assert.deepEqual(await f.accounts.delete(current.user,await authentication(f,current.user)),{deleted:true});
 assert.equal(trace.some(row=>/privacy_personas|listening_v2_|sessions_privacy_epoch|controller_privacy_epoch|private_transfer_from_generation/.test(row.sql??'')),false);
 assert.equal((await f.db.query('SELECT revoked FROM library_tokens WHERE digest=$1',[digest(g.token)])).rows[0].revoked,true);
 // The unused second store shares no handles with the first store.
 await assert.rejects(store.delete(current.user,{}),denied);
});

test('delete rejects missing, fabricated, serialized and foreign-store handles before any write',async t=>{
 const f=await fixture(t),{current}=await guestAccount(f);
 const own=await authentication(f,current.user),other=new AccountStore(f.observedDB,{policy,deviceCheck:unconfigured});
 const foreign=await other.prepareWriterAuthentication(current.session);
 const raw=await createWriterAuthContext({authStore:f.auth,environment:'production'}).prepare(current.session);
 const before=await accountState(f);
 for(const handle of [undefined,null,{},JSON.parse(JSON.stringify(own)),foreign,raw])
  await assert.rejects(f.accounts.delete(current.user,handle),denied);
 for(const changed of [{...current.user,id:'reader-a'},{...current.user,keyID:Buffer.alloc(32,19).toString('base64')},
  {...current.user,bundleID:'other.bundle'}])
  await assert.rejects(f.accounts.delete(changed,own),denied);
 assert.deepEqual(await accountState(f),before);
 assert.equal(JSON.stringify(own).includes(current.session),false);
 assert.equal(JSON.stringify(own).includes(digest(current.session)),false);
});

for(const loss of ['replaced','revoked','deleted','expired'])
test('delete refuses exact source '+loss+' after prepare while a sibling session remains live',async t=>{
 const f=await fixture(t),{g,current}=await guestAccount(f),liveSibling=await sibling(f,g);
 const prepared=await authentication(f,current.user);
 let replacement;
 if(loss==='replaced')replacement=await session(f,g,2);
 else if(loss==='revoked')await f.db.query('UPDATE app_auth_sessions SET revoked=true WHERE digest=$1',[digest(current.session)]);
 else if(loss==='deleted')await f.db.query('DELETE FROM app_auth_sessions WHERE digest=$1',[digest(current.session)]);
 else await f.db.query("UPDATE app_auth_sessions SET expires_at=clock_timestamp()-interval '1 ms' WHERE digest=$1",[digest(current.session)]);
 const before=await accountState(f);
 await assert.rejects(f.accounts.delete(current.user,prepared),denied);
 assert.deepEqual(await accountState(f),before);
 assert.equal((await f.auth.authenticate(liveSibling.session)).id,current.user.id);
 if(replacement)assert.equal((await f.auth.authenticate(replacement.session)).keyID,current.user.keyID);
});

test('delete wins with the exact same source and later sibling revocation cannot undo its commit',async t=>{
 const f=await fixture(t),{g,current}=await guestAccount(f),liveSibling=await sibling(f,g);
 assert.deepEqual(await f.accounts.delete(current.user,await authentication(f,current.user)),{deleted:true});
 await f.db.query('UPDATE app_auth_sessions SET revoked=true WHERE digest=$1',[digest(liveSibling.session)]);
 await assert.rejects(f.auth.authenticate(current.session),{code:'session_expired'});
 assert.equal((await f.db.query('SELECT revoked FROM library_tokens WHERE digest=$1',[current.user.credentialDigest])).rows[0].revoked,true);
});

test('failed delete rolls back every account write after the last data mutation',async t=>{
 let armed=false,failed=false;
 const f=await fixture(t,{afterQuery:async({sql},tx)=>{
  if(armed&&/^UPDATE correction_reports/.test(sql)){failed=true;await tx.query('SELECT 1/0');}
 }});
 const {current}=await guestAccount(f),prepared=await authentication(f,current.user);
 const before=await accountState(f);armed=true;
 await assert.rejects(f.accounts.delete(current.user,prepared));
 assert.equal(failed,true);assert.deepEqual(await accountState(f),before);
 assert.equal((await f.auth.authenticate(current.session)).id,current.user.id);
 armed=false;
 assert.deepEqual(await f.accounts.delete(current.user,await authentication(f,current.user)),{deleted:true});
});

for(const relation of ['app_auth_sessions','library_tokens'])
test('delete final verification rolls back when captured '+relation+' deadline crosses after intentional mutation',async t=>{
 let armed=false,installed=false,crossed=false,deadline,current;
 const trace=[],f=await fixture(t,{trace,beforeQuery:async({sql},tx)=>{
  if(armed&&!installed&&/pg_current_xact_id/.test(sql)){
   installed=true;
   const value=(await tx.query(`UPDATE ${relation} SET expires_at=clock_timestamp()+interval '250 milliseconds'
    WHERE digest=$1 RETURNING expires_at::text AS deadline`,[relation==='app_auth_sessions'?digest(current.session):current.user.credentialDigest])).rows[0];
   deadline=value.deadline;
  }
 },afterQuery:async({sql},tx)=>{
  if(armed&&installed&&!crossed&&/^UPDATE correction_reports/.test(sql)){
   crossed=true;await setTimeout(350);
   const time=(await tx.query('SELECT clock_timestamp()>=$1::timestamptz AS expired,now()<$1::timestamptz AS stale',[deadline])).rows[0];
   assert.equal(time.expired,true);assert.equal(time.stale,true);
  }
 }});
 ({current}=await guestAccount(f));
 if(relation==='app_auth_sessions')await f.db.query('UPDATE library_tokens SET expires_at=NULL WHERE digest=$1',[current.user.credentialDigest]);
 const prepared=await authentication(f,current.user),before=await accountState(f);armed=true;trace.length=0;
 await assert.rejects(f.accounts.delete(current.user,prepared),denied);
 assert.equal(installed,true);assert.equal(crossed,true);assert.deepEqual(await accountState(f),before);
 assert.equal(trace.at(-1).event,'ROLLBACK');
});

test('delete takes one ordered writer pass, locks all required keys before sessions and performs no IO after final auth SQL',async t=>{
 const trace=[],f=await fixture(t,{trace}),{g,current}=await guestAccount(f),other=await sibling(f,g);
 const prepared=await authentication(f,current.user);
 const captured=(await f.db.query(`SELECT s.expires_at::text AS session_deadline,t.expires_at::text AS credential_deadline
  FROM app_auth_sessions s JOIN library_tokens t ON t.digest=s.credential_digest WHERE s.digest=$1`,[digest(current.session)])).rows[0];
 trace.length=0;
 assert.deepEqual(await f.accounts.delete(current.user,prepared),{deleted:true});
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
 assert.ok(keyLocks.some(row=>row.args.includes(other.user.keyID)));
 const sessionLocks=locks.filter(row=>/FROM (?:public\.)?app_auth_sessions/.test(row.sql));
 assert.ok(sessionLocks.some(row=>row.args.some(value=>value===digest(current.session)||Array.isArray(value)&&value.includes(digest(current.session)))));
 // Final auth sampling must be the last statement, followed directly by COMMIT,
 // and it checks S and C's captured exact deadlines after deletion removed S.
 assert.match(sql.at(-1).sql,/clock_timestamp\(\)/);
 assert.deepEqual(sql.at(-1).args,[captured.session_deadline,captured.credential_deadline]);
});

for(const state of ['empty','populated'])test('account deletion refuses '+state+' retained V2 schema before any write',async t=>{
 const f=await fixture(t),{current}=await guestAccount(f);
 await f.db.exec('CREATE SCHEMA listening_v2');
 if(state==='populated')await f.db.exec("CREATE TABLE listening_v2.output_guards(id text PRIMARY KEY, data jsonb); INSERT INTO listening_v2.output_guards VALUES('guard','{\"retained\":true}')");
 const before=await accountState(f);
 await assert.rejects(f.accounts.delete(current.user,await authentication(f,current.user)),{code:'account_data_cleanup_required',status:503});
 assert.deepEqual(await accountState(f),before);
 if(state==='populated')assert.deepEqual((await f.db.query('SELECT * FROM listening_v2.output_guards')).rows,[{id:'guard',data:{retained:true}}]);
});

test('retained schema appearing after the preflight rolls back every transactional deletion write',async t=>{
 let armed=false;
 const f=await fixture(t,{beforeQuery:async({transactionID},raw)=>{
  if(armed&&transactionID!==null){armed=false;await raw.query('CREATE SCHEMA listening_v2');}
 }});
 const {current}=await guestAccount(f),prepared=await authentication(f,current.user),before=await accountState(f);armed=true;
 await assert.rejects(f.accounts.delete(current.user,prepared),{code:'account_data_cleanup_required',status:503});
 assert.deepEqual(await accountState(f),before);
 assert.equal((await f.db.query("SELECT to_regnamespace('listening_v2')::text AS name")).rows[0].name,null);
});

test('AccountStore construction performs no database work',()=>{
 const db={query(){throw Error('construction SQL');},transaction(){throw Error('construction SQL');}};
 new AccountStore(db,{policy});
});

test('Sign in with Apple and sign-out are gone from the account store',async t=>{
 const f=await fixture(t);
 for(const method of ['signIn','signOut'])assert.equal(f.accounts[method],undefined);
 const source=await readFile(new URL('../../api/utils/membership/accounts.js',import.meta.url),'utf8')+
  await readFile(new URL('../../api/account.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/apple-identity|identityToken|authorizationCode|account_identities|lyrica_a_/);
});
