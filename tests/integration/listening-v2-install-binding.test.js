import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {libraryDB} from '../helpers/library-db.js';
import {AppAuthStore} from '../../api/utils/app-auth/store.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {digest} from '../../api/utils/song-library/store.js';
import {createInstallBinding,INSTALL_BINDING_VERSION} from '../../api/utils/listening-v2/install-binding.js';

// SOURCE-ONLY authored tests, not executed by the author. Real stores, SQL,
// nonce consumption, session replacement and exact-bearer AccountStore paths.
// Only external App Attest/assertion/Apple identity cryptography is fixtured.
// No fake successful SQL/auth rows, owner UPDATEs, or V2 enrollment/capture.
const policy={audience:'test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['com.test.Lyrica']};
const bundleID=policy.bundles[0],key=n=>Buffer.alloc(32,n).toString('base64');
const K3_SCOPE='339527c97c31d627a521a750158bc7c7e06ff4e3b97fab36a26ac2a170e5770d';
const K4_SCOPE='4296dc39ea889b9092c8c9fea7bc9d21e29de838b87632aa0858d16baae9fe15';
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
async function fixture(t,{v2Schema=false}={}){
 const f=await libraryDB();t.after(()=>f.db.close());
 for(const file of ['027-spotify-background.sql','029-listening-sessions.sql','032-auth-token-row-locks.sql'])
  await f.db.exec(await readFile(new URL('../../db/'+file,import.meta.url),'utf8'));
 if(v2Schema)for(const file of ['030-listening-v2-schema.sql','031-listening-v2-lifecycle-support.sql','033-listening-v2-lifecycle-composition.sql'])
  await f.db.exec(await readFile(new URL('../../db/'+file,import.meta.url),'utf8'));
 await f.db.query('UPDATE membership_settings SET public_access_enabled=true');
 const cryptoCalls={attest:0,assertion:0,apple:0};
 const external={attestFn:({attestation,challenge,keyId,bundleID:bundle,environment})=>{
  assert.equal(attestation.toString(),'external-crypto');assert.equal(typeof challenge,'string');
  assert.equal(Buffer.from(keyId,'base64').length,32);assert.equal(bundle,bundleID);assert.equal(environment,policy.environment);
  cryptoCalls.attest++;return {publicKey:'external-crypto',receipt:Buffer.from('external-crypto')};
 },assertionFn:({assertion,signCount})=>{
  const counter=Number(assertion.toString());assert.equal(counter,signCount+1);cryptoCalls.assertion++;return counter;
 }};
 const apple={authenticate:async input=>{
  assert.match(input.identityToken,/^external-apple-[AB]$/);assert.equal(input.authorizationCode,'external-crypto');
  cryptoCalls.apple++;return {subjectHash:digest(input.identityToken),refreshTokenEncrypted:'external-crypto'};
 }};
 // sessionsPrivacy deliberately omitted: current construction stays off even
 // when the unregistered030/031/033 schema is installed in this local fixture.
 return {...f,cryptoCalls,binding:createInstallBinding({policy}),
  auth:new AppAuthStore(f.store.db,{policy,...external}),
  accounts:new AccountStore(f.store.db,{policy,attestFn:external.attestFn,apple})};
}
async function mint(f,credential,keyID,counter){
 const {challenge}=await f.auth.challenge(credential,{keyID,bundleID,purpose:'session'});
 const result=await f.auth.session(credential,{keyID,bundleID,challenge,assertion:Buffer.from(String(counter)).toString('base64')});
 const user=await f.auth.authenticate(result.token);
 assert.equal(user.keyID,keyID);assert.equal(user.bundleID,bundleID);assert.equal(user.credentialDigest,digest(credential));
 const stored=await one(f.db,'SELECT * FROM app_auth_sessions WHERE digest=$1',[digest(result.token)]);
 assert.equal(stored.key_id,keyID);assert.equal(stored.credential_digest,user.credentialDigest);assert.equal(stored.revoked,false);
 return {user,bearer:result.token,credential,keyID,counter};
}
async function guest(f,n=3){
 const keyID=key(n),credential='lyra_g_'+'a'.repeat(43);
 const {challenge}=await f.accounts.challenge({purpose:'guest',bundleID,keyID},null,'fixture-install-binding');
 assert.deepEqual(await f.accounts.guest({keyID,bundleID,challenge,credential,attestation:'ZXh0ZXJuYWwtY3J5cHRv'}),{registered:true});
 assert.equal(Number((await one(f.db,'SELECT count(*) AS n FROM app_auth_sessions')).n),0);
 const enrolled=await one(f.db,'SELECT * FROM app_attest_keys WHERE key_id=$1',[keyID]);
 assert.match(enrolled.user_id,/^guest-/);assert.equal(Number(enrolled.sign_count),0);
 return mint(f,credential,keyID,1);
}
async function register(f,credential,keyID){
 const {challenge}=await f.auth.challenge(credential,{keyID,bundleID,purpose:'register'});
 assert.deepEqual(await f.auth.register(credential,{keyID,bundleID,challenge,attestation:'ZXh0ZXJuYWwtY3J5cHRv'}),{registered:true});
 return mint(f,credential,keyID,1);
}
async function storedTuple(f,current){
 // These are actual persisted fields, never auth.authenticate's smaller DTO or
 // reconstructed metadata. This selection alone is NOT locked capture proof.
 const tuple=await one(f.db,'SELECT key_id,bundle_id,audience,environment FROM app_attest_keys WHERE key_id=$1',[current.keyID]);
 const owner=await one(f.db,'SELECT user_id,sign_count,revoked FROM app_attest_keys WHERE key_id=$1',[current.keyID]);
 assert.equal(owner.user_id,current.user.id);assert.equal(owner.revoked,false);assert.equal(Number(owner.sign_count),current.counter);
 return tuple;
}
async function deriveStored(f,current){
 const tuple=await storedTuple(f,current);return {tuple,scope:f.binding.deriveScope(JSON.stringify(tuple))};
}
async function signIn(f,current,target){
 const handle=await f.accounts.prepareWriterAuthentication(current.bearer);
 const {challenge}=await f.accounts.challenge({purpose:'apple',bundleID},current.user);
 const result=await f.accounts.signIn(current.user,{bundleID,challenge,identityToken:'external-apple-'+target,authorizationCode:'external-crypto'},handle);
 const identity=await one(f.db,'SELECT * FROM account_identities WHERE subject_hash=$1',[digest('external-apple-'+target)]);
 assert.equal(identity.user_id,result.userID);assert.match(result.userID,/^apple-/);
 const oldCredential=await one(f.db,'SELECT revoked FROM library_tokens WHERE digest=$1',[current.user.credentialDigest]);
 assert.equal(oldCredential.revoked,true);
 await assert.rejects(f.auth.authenticate(current.bearer),{code:'session_expired'});
 assert.equal(Number((await one(f.db,'SELECT count(*) AS n FROM app_auth_sessions WHERE key_id=$1',[current.keyID])).n),0);
 return mint(f,result.credential,current.keyID,current.counter+1);
}
async function assertUnenrolled(f,v2Schema){
 const namespace=await one(f.db,"SELECT to_regnamespace('listening_v2')::text AS name");
 assert.equal(namespace.name,v2Schema?'listening_v2':null);
 const added=(await f.db.query(`SELECT column_name FROM information_schema.columns
  WHERE table_schema='public' AND table_name='app_attest_keys'
  AND column_name IN ('sessions_install_binding_version','sessions_authority_generation')`)).rows;
 assert.deepEqual(added,[],'the030/031/033 foundation has no install provenance/generation columns');
 if(v2Schema){
  for(const name of ['rooms','output_guards','privacy_personas','returning_grants','command_receipts','semantic_events','outbox','private_profile_assets'])
   assert.equal(Number((await one(f.db,'SELECT count(*) AS n FROM listening_v2.'+name)).n),0,name+' remains empty');
 }
}

test('actual AppAuth registration/assertion stored tuple matches the independent incremental frame vector',async t=>{
 const f=await fixture(t),keyID='AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
 const current=await register(f,'token-a',keyID),{tuple,scope}=await deriveStored(f,current);
 assert.deepEqual(tuple,{key_id:keyID,bundle_id:bundleID,audience:'test',environment:'development'});
 assert.equal(scope,'765a7e146db7177aad6de946fc3c76ab817d43ecc4caf44bfb494f03b9f5a456');
 assert.equal(f.cryptoCalls.attest,1);assert.equal(f.cryptoCalls.assertion,1);
 const snapshot=JSON.stringify((await f.db.query('SELECT to_jsonb(k) AS row FROM app_attest_keys k ORDER BY key_id')).rows);
 assert.equal(f.binding.deriveScope(JSON.stringify(tuple)),scope);
 assert.equal(JSON.stringify((await f.db.query('SELECT to_jsonb(k) AS row FROM app_attest_keys k ORDER BY key_id')).rows),snapshot);
 await assertUnenrolled(f,false);
});
for(const v2Schema of [false,true])test('sameK G to A to B keeps physical lookup across real exact-bearer moves; schema='+v2Schema,async t=>{
 const f=await fixture(t,{v2Schema});await assertUnenrolled(f,v2Schema);
 const g=await guest(f),initial=await deriveStored(f,g);
 assert.equal(initial.scope,K3_SCOPE);
 const sibling=await register(f,g.credential,key(4)),siblingStored=await deriveStored(f,sibling);
 assert.equal(sibling.user.id,g.user.id);assert.equal(sibling.user.credentialDigest,g.user.credentialDigest);
 assert.equal(siblingStored.scope,K4_SCOPE);assert.notEqual(siblingStored.scope,initial.scope);
 // Actual same-C bearer replacement changes S, not physical identity or C.
 const renewed=await mint(f,g.credential,g.keyID,2),renewedStored=await deriveStored(f,renewed);
 assert.notEqual(renewed.bearer,g.bearer);assert.equal(renewed.user.credentialDigest,g.user.credentialDigest);
 await assert.rejects(f.auth.authenticate(g.bearer),{code:'session_expired'});
 assert.deepEqual(renewedStored,initial);
 const a=await signIn(f,renewed,'A'),atA=await deriveStored(f,a);
 assert.notEqual(a.user.id,g.user.id);assert.notEqual(a.user.credentialDigest,g.user.credentialDigest);assert.notEqual(a.bearer,renewed.bearer);
 assert.deepEqual(atA,initial);
 // C closure really invalidates sibling auth, without moving sibling K4 to A.
 await assert.rejects(f.auth.authenticate(sibling.bearer),{code:'session_expired'});
 assert.equal((await one(f.db,'SELECT user_id FROM app_attest_keys WHERE key_id=$1',[sibling.keyID])).user_id,g.user.id);
 const b=await signIn(f,a,'B'),atB=await deriveStored(f,b);
 assert.notEqual(b.user.id,a.user.id);assert.notEqual(b.user.id,g.user.id);
 assert.notEqual(b.user.credentialDigest,a.user.credentialDigest);assert.notEqual(b.bearer,a.bearer);
 assert.deepEqual(atB,initial);assert.equal(typeof atB.scope,'string');assert.equal(INSTALL_BINDING_VERSION,1);
 const rows=(await f.db.query('SELECT user_id,revoked FROM library_tokens WHERE digest=ANY($1::text[]) ORDER BY digest',
  [[g.user.credentialDigest,a.user.credentialDigest,b.user.credentialDigest]])).rows;
 assert.equal(rows.length,3);assert.equal(rows.filter(row=>row.revoked).length,2);
 assert.equal(rows.find(row=>!row.revoked).user_id,b.user.id);
 assert.equal(f.cryptoCalls.apple,2);assert.equal(f.cryptoCalls.attest,2);assert.equal(f.cryptoCalls.assertion,5);
 await assertUnenrolled(f,v2Schema);
});
test('existing-key registration ACK and bearer renewal do not claim version1 capture/provenance',async t=>{
 const f=await fixture(t),g=await guest(f),before=await deriveStored(f,g);
 const count=f.cryptoCalls.attest;
 assert.deepEqual(await f.auth.register(g.credential,{keyID:g.keyID,bundleID,challenge:'unused-ack',attestation:'unused-ack'}),{registered:true});
 assert.equal(f.cryptoCalls.attest,count,'ACK does not invoke fresh attestation');
 const renewed=await mint(f,g.credential,g.keyID,2);
 assert.deepEqual(await deriveStored(f,renewed),before);
 await assertUnenrolled(f,false);
 // A digest is computable for a text tuple; it proves neither current liveness,
 // known binding provenance nor a generation/Release/permission receipt.
 assert.equal(f.binding.deriveScope(JSON.stringify(before.tuple)),K3_SCOPE);
 assert.equal(typeof before.scope,'string');
});
