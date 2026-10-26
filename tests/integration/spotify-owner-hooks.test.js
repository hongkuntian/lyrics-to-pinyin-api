import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {libraryDB} from '../helpers/library-db.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {revokeKey,disableUser} from '../../api/utils/app-auth/admin.js';
import {SpotifyStore} from '../../api/utils/spotify/store.js';
import {digest} from '../../api/utils/song-library/store.js';
import {recipe} from '../helpers/spotify.js';
const policy={audience:'test',environment:'development',prefix:'9ESZX68J8U',bundles:['com.hongkuntian.Lyra']},bundleID=policy.bundles[0];
test('signout, guest-to-Apple key move, account deletion and operator key/user revoke close Spotify atomically',async t=>{
 const f=await libraryDB();t.after(()=>f.db.close());await f.db.exec(await readFile(new URL('../../db/027-spotify-background.sql',import.meta.url),'utf8'));await f.db.query('UPDATE membership_settings SET public_access_enabled=true');
 const flushed=[],spotifyCleanupFn=async(_,ids)=>flushed.push(...ids),spotify=new SpotifyStore(f.store.db),apple={authenticate:async()=>({subjectHash:digest('subject'),refreshTokenEncrypted:'encrypted'}),revoke:async()=>{}};
 const accounts=new AccountStore(f.store.db,{policy,apple,attestFn:()=>({publicKey:'proof',receipt:Buffer.from('proof')}),spotifyCleanupFn});
 let ordinal=1;
 async function guest(){const keyID=Buffer.alloc(32,ordinal++).toString('base64'),credential='lyra_g_'+randomUUID().replaceAll('-','')+'abcdefghijk';const input={purpose:'guest',bundleID,keyID};const {challenge}=await accounts.challenge(input,null,'fixture');await accounts.guest({...input,challenge,credential,attestation:'cHJvb2Y='});const row=(await f.db.query('SELECT user_id FROM app_attest_keys WHERE key_id=$1',[keyID])).rows[0];return {id:row.user_id,keyID,bundleID,credentialDigest:digest(credential)};}
 async function seed(user){const id=randomUUID(),sessionID=randomUUID(),epoch=randomUUID();await spotify.create({id,epoch,enrollmentID:randomUUID(),ownerID:user.id,keyID:user.keyID,credentialDigest:user.credentialDigest,status:'connected',access:{ciphertext:'not-plaintext'},refresh:{ciphertext:'not-plaintext'},consumers:{[sessionID]:{sessionID,activityID:randomUUID(),status:'armed',generation:1,tokenVersion:1,token:{ciphertext:'retained-terminal-only'},vaultEpoch:epoch,recipe,sequence:1,lastTimestamp:Math.floor(Date.now()/1000),expiresAt:Date.now()+600000}}});await spotify.addCapability('cap-'+id,id,sessionID,Date.now()+600000);return id;}
 async function closed(id,reason){const c=await spotify.read(id);assert.equal(c.status,'disconnected');assert.equal(c.reason,reason);assert.equal(c.access,null);assert.equal(c.refresh,null);assert.equal(Object.values(c.consumers)[0].status,'ended');assert.equal((await spotify.pending(id))[0].kind,'cleanup');assert.equal(await spotify.capability('cap-'+id),null);assert(flushed.includes(id));}
 const signedOut=await guest(),a=await seed(signedOut);await accounts.signOut(signedOut);await closed(a,'signedOut');
 const moving=await guest(),b=await seed(moving),nonce=await accounts.challenge({purpose:'apple',bundleID},moving);const signed=await accounts.signIn(moving,{...nonce,bundleID,identityToken:'fixture',authorizationCode:'fixture'});await closed(b,'ownerChanged');assert.notEqual(signed.userID,moving.id);
 const appleUser={...moving,id:signed.userID,credentialDigest:digest(signed.credential)},c=await seed(appleUser),deletion=await accounts.challenge({purpose:'delete',bundleID},appleUser);await accounts.delete(appleUser,{...deletion,bundleID,identityToken:'fixture',authorizationCode:'fixture'});await closed(c,'accountDeleted');
 const keyed=await guest(),d=await seed(keyed);await revokeKey(f.store.db,keyed.keyID,{spotifyCleanupFn});await closed(d,'keyRevoked');
 const disabled=await guest(),e=await seed(disabled);await disableUser(f.store.db,disabled.id,{spotifyCleanupFn});await closed(e,'ownerDisabled');
});

for(const method of ['create','adopt'])test('Spotify '+method+' rolls back if its credential expires after a write',async t=>{
 const f=await libraryDB();t.after(()=>f.db.close());await f.db.exec(await readFile(new URL('../../db/027-spotify-background.sql',import.meta.url),'utf8'));
 const keyID=Buffer.alloc(32,44).toString('base64'),user={id:'reader-a',keyID,bundleID,credentialDigest:digest('token-a')};
 await f.db.query(`INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt)
  VALUES($1,$2,$3,$4,$5,'fixture','fixture')`,[keyID,user.id,policy.audience,bundleID,policy.environment]);
 const connection={id:randomUUID(),epoch:randomUUID(),enrollmentID:randomUUID(),ownerID:user.id,keyID,credentialDigest:user.credentialDigest,status:'connected',consumers:{}};
 const normal=new SpotifyStore(f.store.db);if(method==='adopt')await normal.create(connection);
 const db={query:(...args)=>f.store.db.query(...args),transaction:fn=>f.store.db.transaction(async tx=>fn({async query(sql,args){
  const result=await tx.query(sql,args);
  if(/(?:INSERT INTO|UPDATE) spotify_connections/.test(sql))await tx.query('UPDATE library_tokens SET expires_at=clock_timestamp() WHERE digest=$1',[user.credentialDigest]);
  return result;
 }}))};
 const store=new SpotifyStore(db);
 await assert.rejects(method==='create'?store.create(connection):store.adopt(connection.id,user,c=>{c.marker='must roll back';}),{code:'app_access_revoked'});
 assert.deepEqual(await normal.read(connection.id),method==='create'?null:connection);
 assert.equal((await f.db.query('SELECT expires_at FROM library_tokens WHERE digest=$1',[user.credentialDigest])).rows[0].expires_at,null);
});
