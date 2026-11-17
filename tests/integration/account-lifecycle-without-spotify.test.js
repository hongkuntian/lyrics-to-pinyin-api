import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {libraryDB} from '../helpers/library-db.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {revokeKey,disableUser} from '../../api/utils/app-auth/admin.js';
import {digest} from '../../api/utils/song-library/store.js';

// Spotify is native-only: account lifecycle transactions keep every
// non-Spotify effect and never read, lock or write retired observer tables.
const policy={audience:'test',environment:'development',prefix:'9ESZX68J8U',bundles:['com.hongkuntian.Lyrica']},bundleID=policy.bundles[0];
const retired=['spotify_connections','spotify_outbox','spotify_snapshot_capabilities','spotify_provider_circuits'];
const sql=name=>readFile(new URL('../../db/'+name,import.meta.url),'utf8');
const apple=()=>({authenticate:async()=>({subjectHash:digest('subject'),refreshTokenEncrypted:'encrypted'}),revoke:async()=>{}});
const appleInput=nonce=>({...nonce,bundleID,identityToken:'fixture',authorizationCode:'fixture'});
function traced(db,trace,{afterQuery}={}){
 const run=(target,text,args)=>args===undefined?target.query(text):target.query(text,args);
 return {query:async(text,args)=>{trace.push(text);return run(db,text,args);},
  transaction:fn=>db.transaction(tx=>fn({query:async(text,args)=>{
   trace.push(text);const result=await run(tx,text,args);await afterQuery?.(text,tx);return result;
  }}))};
}
async function fixture(t,{legacy=false}={}){
 const f=await libraryDB();t.after(()=>f.db.close());
 // `legacy` models the window after this code deploys and before 038 runs.
 if(legacy)await f.db.exec(await sql('027-spotify-background.sql'));
 await f.db.exec(await sql('032-auth-token-row-locks.sql'));
 await f.db.query('UPDATE membership_settings SET public_access_enabled=true');
 const trace=[],db=traced(f.store.db,trace);
 const accounts=new AccountStore(db,{policy,apple:apple(),attestFn:()=>({publicKey:'proof',receipt:Buffer.from('proof')})});
 const auth=new AppAuthStore(f.store.db,{policy,assertionFn:({assertion})=>Number(assertion.toString())}),bearers=new WeakMap();
 let ordinal=1;
 async function session(credential,keyID,counter=1){
  const {challenge}=await auth.challenge(credential,{keyID,bundleID,purpose:'session'});
  const result=await auth.session(credential,{keyID,bundleID,challenge,assertion:Buffer.from(String(counter)).toString('base64')});
  const user=await auth.authenticate(result.token);bearers.set(user,result.token);return user;
 }
 async function guest(){
  const keyID=Buffer.alloc(32,ordinal++).toString('base64'),credential='lyrica_g_'+randomUUID().replaceAll('-','')+'abcdefghijk';
  const input={purpose:'guest',bundleID,keyID},{challenge}=await accounts.challenge(input,null,'fixture');
  await accounts.guest({...input,challenge,credential,attestation:'cHJvb2Y='});return session(credential,keyID);
 }
 async function appleAccount(){
  const user=await guest(),nonce=await accounts.challenge({purpose:'apple',bundleID},user);
  const signed=await accounts.signIn(user,appleInput(nonce),await accounts.prepareWriterAuthentication(bearers.get(user)));
  return {user,signed,current:await session(signed.credential,user.keyID,2)};
 }
 const one=async(text,args)=>(await f.db.query(text,args)).rows[0];
 return {...f,trace,accounts,auth,session,guest,appleAccount,one,bearer:user=>bearers.get(user)};
}
async function legacyRows(f,user){
 // Rows the retired observer wrote before this code deployed; returns their exact images.
 const id=randomUUID();
 await f.db.query('INSERT INTO spotify_connections(id,owner_id,key_id,credential_digest,enrollment_id,data) VALUES($1,$2,$3,$4,$5,$6)',
  [id,user.id,user.keyID,user.credentialDigest,randomUUID(),{id,status:'connected',refresh:{ciphertext:'sealed'}}]);
 await f.db.query("INSERT INTO spotify_outbox(id,connection_id,epoch,kind,due_at_ms,data,expires_at) VALUES($1,$2,'epoch','tick',0,'{}','2099-01-01T00:00:00Z')",['poll-'+id,id]);
 await f.db.query("INSERT INTO spotify_snapshot_capabilities(digest,connection_id,session_id,expires_at_ms) VALUES($1,$2,'live',9007199254740991)",['cap-'+id,id]);
 return Object.fromEntries(await Promise.all(retired.map(async table=>[table,(await f.db.query(
  `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE to_jsonb(t)->>${table==='spotify_connections'?"'id'":"'connection_id'"}=$1`,[id])).rows.map(row=>row.row)])));
}
const retiredImage=async f=>Object.fromEntries(await Promise.all(retired.map(async table=>
 [table,(await f.db.query(`SELECT to_jsonb(t)::text AS row FROM ${table} t ORDER BY 1`)).rows.map(row=>row.row)])));

for(const legacy of [false,true])
test('sign-out, owner change, deletion, key revocation and user disable keep their effects '+(legacy?'and leave legacy Spotify rows for 038':'with no Spotify tables'),async t=>{
 const f=await fixture(t,{legacy});
 for(const table of retired)assert.equal((await f.one('SELECT to_regclass($1)::text AS name',[table])).name,legacy?table:null);
 const expected=Object.fromEntries(retired.map(table=>[table,[]]));
 const guest=async()=>{
  const user=await f.guest();
  if(legacy)for(const [table,rows] of Object.entries(await legacyRows(f,user)))expected[table].push(...rows);
  return user;
 };

 const signedOut=await guest();
 assert.deepEqual(await f.accounts.signOut(signedOut,await f.accounts.prepareWriterAuthentication(f.bearer(signedOut))),{signedOut:true});
 assert.equal((await f.one('SELECT revoked FROM library_tokens WHERE digest=$1',[signedOut.credentialDigest])).revoked,true);
 await assert.rejects(f.auth.authenticate(f.bearer(signedOut)));

 const moving=await guest(),nonce=await f.accounts.challenge({purpose:'apple',bundleID},moving);
 const signed=await f.accounts.signIn(moving,appleInput(nonce),await f.accounts.prepareWriterAuthentication(f.bearer(moving)));
 assert.notEqual(signed.userID,moving.id);assert.match(signed.credential,/^lyrica_a_[A-Za-z0-9_-]{43}$/);
 assert.equal((await f.one('SELECT user_id FROM app_attest_keys WHERE key_id=$1',[moving.keyID])).user_id,signed.userID);
 assert.equal((await f.one('SELECT revoked FROM library_tokens WHERE digest=$1',[moving.credentialDigest])).revoked,true);
 assert.equal((await f.one('SELECT count(*)::int AS n FROM app_auth_sessions WHERE key_id=$1',[moving.keyID])).n,0);

 const appleUser=await f.session(signed.credential,moving.keyID,2);
 await f.db.query("INSERT INTO live_lyrics_push_receipts(activity_id,user_id,token_digest,expires_at) VALUES('activity',$1,'push','2099-01-01T00:00:00Z')",[appleUser.id]);
 const deletion=await f.accounts.challenge({purpose:'delete',bundleID},appleUser);
 assert.deepEqual(await f.accounts.delete(appleUser,appleInput(deletion),await f.accounts.prepareWriterAuthentication(f.bearer(appleUser))),{deleted:true});
 assert.equal((await f.one('SELECT disabled FROM library_users WHERE id=$1',[appleUser.id])).disabled,true);
 assert.deepEqual(await f.one('SELECT revoked,public_key FROM app_attest_keys WHERE key_id=$1',[appleUser.keyID]),{revoked:true,public_key:''});
 assert.equal((await f.one('SELECT count(*)::int AS n FROM library_tokens WHERE user_id=$1 AND NOT revoked',[appleUser.id])).n,0);
 assert.deepEqual(await f.one('SELECT refresh_token_encrypted,apple_client_id,deleted_at IS NOT NULL AS deleted FROM account_identities WHERE user_id=$1',[appleUser.id]),
  {refresh_token_encrypted:null,apple_client_id:null,deleted:true});
 assert.equal((await f.one('SELECT count(*)::int AS n FROM live_lyrics_push_receipts WHERE user_id=$1',[appleUser.id])).n,0);
 await assert.rejects(f.auth.authenticate(f.bearer(appleUser)));

 const keyed=await guest();await revokeKey(f.store.db,keyed.keyID);
 assert.equal((await f.one('SELECT revoked FROM app_attest_keys WHERE key_id=$1',[keyed.keyID])).revoked,true);
 assert.equal((await f.one('SELECT bool_and(revoked) AS revoked FROM app_auth_sessions WHERE key_id=$1',[keyed.keyID])).revoked,true);
 assert.equal((await f.one('SELECT disabled FROM library_users WHERE id=$1',[keyed.id])).disabled,false);
 await assert.rejects(f.auth.authenticate(f.bearer(keyed)));

 const disabled=await guest();await disableUser(f.store.db,disabled.id);
 assert.equal((await f.one('SELECT disabled FROM library_users WHERE id=$1',[disabled.id])).disabled,true);
 assert.equal((await f.one('SELECT bool_and(revoked) AS revoked FROM library_tokens WHERE user_id=$1',[disabled.id])).revoked,true);
 assert.equal((await f.one('SELECT bool_and(revoked) AS revoked FROM app_attest_keys WHERE user_id=$1',[disabled.id])).revoked,true);
 assert.equal((await f.one('SELECT bool_and(revoked) AS revoked FROM app_auth_sessions WHERE key_id=$1',[disabled.keyID])).revoked,true);
 await assert.rejects(f.auth.authenticate(f.bearer(disabled)));

 assert.ok(f.trace.length>40);
 assert.equal(f.trace.some(text=>/spotify_/i.test(text)),false,'no account SQL reads, locks or writes Spotify observer state');
 if(legacy){
  // Every legacy row keeps its exact pre-operation image until 038 drops it.
  const after=await retiredImage(f);
  for(const table of retired)assert.deepEqual([...after[table]].sort(),[...expected[table]].sort(),table);
  assert.equal(after.spotify_connections.length,4);
 }
});

test('admin revocation helpers keep their exact two-argument shape',async()=>{
 assert.equal(disableUser.length,2);assert.equal(revokeKey.length,2);
 const source=await readFile(new URL('../../api/utils/membership/accounts.js',import.meta.url),'utf8')+
  await readFile(new URL('../../api/utils/app-auth/admin.js',import.meta.url),'utf8');
 assert.doesNotMatch(source,/spotify/i);
});

test('a failed deletion still rolls back every account write and keeps the session live',async t=>{
 const f=await fixture(t),{current}=await f.appleAccount();
 const deletion=await f.accounts.challenge({purpose:'delete',bundleID},current);
 const state=async()=>(await f.db.query(`SELECT
  (SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM library_users u) AS users,
  (SELECT jsonb_agg(to_jsonb(k) ORDER BY k.key_id) FROM app_attest_keys k) AS keys,
  (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.digest) FROM library_tokens t) AS tokens,
  (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.digest) FROM app_auth_sessions s) AS sessions,
  (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.user_id) FROM account_identities i) AS identities,
  (SELECT jsonb_agg(to_jsonb(n) ORDER BY n.digest) FROM account_nonces n) AS nonces`)).rows[0];
 const before=await state(),trace=[];let failed=false;
 const db=traced(f.store.db,trace,{afterQuery:async(text,tx)=>{if(!failed&&/^UPDATE correction_reports/.test(text)){failed=true;await tx.query('SELECT 1/0');}}});
 const store=new AccountStore(db,{policy,apple:apple()});
 await assert.rejects(store.delete(current,appleInput(deletion),await store.prepareWriterAuthentication(f.bearer(current))),{code:'22012'});
 assert.equal(failed,true);assert.deepEqual(await state(),before);
 assert.equal((await f.auth.authenticate(f.bearer(current))).id,current.id);
 assert.equal(trace.some(text=>/spotify_/i.test(text)),false);
});
