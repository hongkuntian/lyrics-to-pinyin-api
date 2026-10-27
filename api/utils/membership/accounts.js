import {scrubListeningAccount} from '../listening/account.js';
import {prepareSpotifyRevocationInTransaction,persistSpotifyRevocationInTransaction,flushSpotifyCleanup} from '../spotify/revocation.js';
import {createAuthPrivacyWriters} from '../listening-v2/privacy-writers.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {digest,LibraryError,lockAuthWriter} from '../song-library/store.js';
import {AppAuthStore,authPolicy} from '../app-auth/store.js';
import {createWriterAuthContext} from '../listening-v2/auth-context.js';
import {SessionV2Error} from '../listening-v2/errors.js';
import {attest} from '../app-auth/verification.js';
import {AppleIdentityService} from './apple-identity.js';
import {first} from './policy.js';

// Guest enrollment keeps its existing credential/key checks and writer locks.
// Account mutations below use exact-bearer writer authentication instead.
async function sourceCredential(db,user,policy) {
  const row=await first(db,`SELECT t.expires_at::text AS deadline FROM library_users u
    JOIN library_tokens t ON t.user_id=u.id JOIN app_attest_keys k ON k.user_id=u.id
    WHERE u.id=$1 AND t.digest=$2 AND k.key_id=$3 AND k.bundle_id=$4 AND k.audience=$5 AND k.environment=$6
    AND NOT u.disabled AND NOT t.revoked AND NOT k.revoked
    AND (t.expires_at IS NULL OR t.expires_at>clock_timestamp())`,
    [user.id,user.credentialDigest,user.keyID,user.bundleID,policy.audience,policy.environment]);
  if(!row)throw new LibraryError('app_access_revoked',403);
  return row.deadline; // PostgreSQL text preserves sub-ms finite deadline exactly.
}
// Keep account HTTP's LibraryError mapping. Writer-auth errors never disclose
// opaque evidence, session/credential digests or a newly selected identity.
async function writerAuthorization(operation) {
  try{return await operation();}
  catch(error){
    if(!(error instanceof SessionV2Error))throw error;
    if(['unauthorized','forbidden','expired','conflict'].includes(error.code))
      throw new LibraryError('app_access_revoked',403);
    throw new LibraryError('app_auth_unavailable',503);
  }
}

export class AccountStore {
  #writerAuth;
  #privacyWriters;
  #writerAuthentications=new WeakMap();
  constructor(db,{policy,attestFn=attest,apple=new AppleIdentityService(),spotifyCleanupFn=flushSpotifyCleanup,sessionsPrivacy}={}) {
    this.spotifyCleanup=spotifyCleanupFn;this.db=db;this.policy=policy??authPolicy();this.attest=attestFn;this.apple=apple;
    this.#privacyWriters=createAuthPrivacyWriters(db,sessionsPrivacy);
    // Pure construction: no SQL or namespace activation.
    this.#writerAuth=createWriterAuthContext({authStore:new AppAuthStore(this.db,{policy:this.policy}),
      environment:this.policy.environment==='production'?'production':'development'});
  }
  async prepareWriterAuthentication(exactBearer) {
    const authentication=await writerAuthorization(()=>this.#writerAuth.prepare(exactBearer));
    const handle=Object.freeze({});
    this.#writerAuthentications.set(handle,authentication);
    return handle;
  }
  #writerAuthentication(user,handle) {
    const authentication=this.#writerAuthentications.get(handle);
    if(!authentication||!user||user.id!==authentication.principalID||user.keyID!==authentication.keyID||
      user.bundleID!==authentication.bundleID||typeof user.credentialDigest!=='string'||!/^[a-f0-9]{64}$/.test(user.credentialDigest))
      throw new LibraryError('app_access_revoked',403);
    // Capture the HTTP tuple synchronously, before any external await. It is
    // checked again against the locked, actual exact-bearer scope below.
    const source=Object.freeze({id:user.id,keyID:user.keyID,bundleID:user.bundleID,credentialDigest:user.credentialDigest});
    return {source,authentication};
  }
  async #lockWriter(db,user,authentication,operationRawJSON,{userIDs=[user.id],allTokens=false,allKeys=false,additionalDigests=[]}={}) {
    // Nonlocking collection only. The frozen writer owns the sole auth lock
    // pass and refuses changed discovery; never append a former owner/key.
    const tokenIDs=async()=>(await db.query('SELECT digest FROM library_tokens WHERE user_id=$1 ORDER BY digest COLLATE "C" LIMIT 65',[user.id])).rows.map(row=>row.digest);
    const attestIDs=async()=>(await db.query('SELECT key_id FROM app_attest_keys WHERE user_id=$1 ORDER BY key_id COLLATE "C" LIMIT 65',[user.id])).rows.map(row=>row.key_id);
    const credentialDigests=allTokens?await tokenIDs():[],keyIDs=allKeys?await attestIDs():[];
    const requiredScopes={userIDs,credentialDigests:[...new Set([user.credentialDigest,...credentialDigests,...additionalDigests])],
      keyIDs:[...new Set([user.keyID,...keyIDs])]};
    if(Object.values(requiredScopes).some(list=>list.length>64))throw new LibraryError('app_auth_unavailable',503);
    const discovery=await writerAuthorization(()=>this.#writerAuth.discover({tx:db,authentication,operationRawJSON,requiredScopes}));
    const scope=await writerAuthorization(()=>this.#writerAuth.lock({tx:db,discovery}));
    if(scope.principalID!==user.id||scope.keyID!==user.keyID||scope.bundleID!==user.bundleID||scope.credentialDigest!==user.credentialDigest)
      throw new LibraryError('app_access_revoked',403);
    // These are read-only completeness checks under the now-held user anchor.
    // New enrollment/rotation before locking refuses; it never appends a pass.
    if(allTokens&&JSON.stringify(await tokenIDs())!==JSON.stringify(credentialDigests)||
      allKeys&&JSON.stringify(await attestIDs())!==JSON.stringify(keyIDs))throw new LibraryError('app_access_revoked',403);
    return scope;
  }
  async enabled(db=this.db) {
    const settings=await first(db,'SELECT public_access_enabled FROM membership_settings WHERE id=1');
    if(!settings?.public_access_enabled)throw new LibraryError('public_access_unavailable',503);
  }
  async limit(scope,limit) {
    const row=await first(this.db,`INSERT INTO account_rate_windows(scope,window_start,count)
      VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(scope,window_start)
      DO UPDATE SET count=account_rate_windows.count+1 RETURNING count`,[scope]);
    if(row.count>limit)throw new LibraryError('rate_limited',429);
  }
  async challenge({purpose,bundleID,keyID},user,clientAddress) {
    await this.enabled();
    if(!this.policy.bundles.includes(bundleID)||!['guest','apple','delete'].includes(purpose)||
      (purpose==='guest'?(!keyID||user):!user))throw new LibraryError('invalid_request',400);
    await this.limit('global',120);
    await this.limit(user?'user:'+user.id:'ip:'+digest(clientAddress??'unknown'),10);
    const value=randomBytes(32).toString('base64url');
    await this.db.query('DELETE FROM account_nonces WHERE expires_at<now()');
    await this.db.query("DELETE FROM account_rate_windows WHERE window_start<now()-interval '1 day'");
    await this.db.query(`INSERT INTO account_nonces(digest,purpose,bundle_id,key_id,user_id,expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')`,[digest(value),purpose,bundleID,keyID??user?.keyID??null,user?.id??null]);
    return {challenge:value};
  }
  async nonce(db,{challenge,bundleID,keyID},purpose,userID=null,consume=false) {
    const row=await first(db,`${consume?'UPDATE account_nonces SET consumed=true':'SELECT * FROM account_nonces'}
      WHERE digest=$1 AND purpose=$2 AND bundle_id=$3 AND key_id=$4 AND user_id IS NOT DISTINCT FROM $5
        AND NOT consumed AND expires_at>clock_timestamp()${consume?' RETURNING *':''}`,[digest(challenge),purpose,bundleID,keyID,userID]);
    if(!row)throw new LibraryError('challenge_expired',401);
    return row;
  }
  async guest(input) {
    await this.enabled();
    const {credential,keyID,bundleID}=input;
    // A retry can ACK an already-enrolled key only with its original credential.
    // The credential cannot create an API session without a fresh key assertion.
    const existing=await first(this.db,`SELECT k.key_id,k.user_id FROM app_attest_keys k JOIN library_tokens t ON t.user_id=k.user_id
      JOIN library_users u ON u.id=k.user_id WHERE k.key_id=$1 AND t.digest=$2 AND k.bundle_id=$3 AND k.audience=$4
      AND k.environment=$5 AND u.access_kind='guest' AND NOT k.revoked AND NOT t.revoked AND NOT u.disabled
      AND t.expires_at>clock_timestamp()`,[keyID,digest(credential),bundleID,this.policy.audience,this.policy.environment]);
    if(existing)return this.db.transaction(async db=>{
      await lockAuthWriter(db,{userIDs:[existing.user_id],credentialDigests:[digest(credential)],keyIDs:[keyID]});
      const current=await first(db,`SELECT u.id FROM library_users u JOIN library_tokens t ON t.user_id=u.id
        JOIN app_attest_keys k ON k.user_id=u.id WHERE u.id=$1 AND u.access_kind='guest'
        AND t.digest=$2 AND k.key_id=$3 AND k.bundle_id=$4 AND k.audience=$5 AND k.environment=$6
        AND NOT u.disabled AND NOT t.revoked AND NOT k.revoked AND t.expires_at>clock_timestamp()`,
        [existing.user_id,digest(credential),keyID,bundleID,this.policy.audience,this.policy.environment]);
      if(!current)throw new LibraryError('app_access_revoked',403);
      return {registered:true};
    });
    await this.nonce(this.db,input,'guest');
    let proof;try{proof=this.attest({attestation:Buffer.from(input.attestation,'base64'),challenge:input.challenge,keyId:keyID,bundleID,...this.policy});}
    catch{throw new LibraryError('app_attestation_invalid',403);}
    await this.db.transaction(async db=>{
      await db.query('SELECT id FROM membership_settings WHERE id=1 FOR UPDATE');
      await this.enabled(db);await this.nonce(db,input,'guest',null,true);
      if(await first(db,'SELECT 1 FROM app_attest_keys WHERE key_id=$1',[keyID]))throw new LibraryError('app_access_revoked',403);
      const total=await first(db,"SELECT count(*) AS n FROM library_users WHERE access_kind='guest' AND created_at>now()-interval '1 day'");
      if(Number(total.n)>=5000)throw new LibraryError('public_access_temporarily_unavailable',503);
      const id='guest-'+randomUUID();
      await db.query("INSERT INTO library_users(id,access_kind) VALUES($1,'guest')",[id]);
      await db.query("INSERT INTO library_tokens(digest,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '90 days')",[digest(credential),id]);
      await db.query(`INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[keyID,id,this.policy.audience,bundleID,this.policy.environment,proof.publicKey,proof.receipt]);
      await sourceCredential(db,{id,keyID,bundleID,credentialDigest:digest(credential)},this.policy);
    });
    return {registered:true};
  }
  async signIn(user,input,handle) {
    const prepared=this.#writerAuthentication(user,handle);user=prepared.source;
    input=Object.freeze({...input,keyID:user.keyID});
    await this.enabled();
    await this.nonce(this.db,input,'apple',user.id);
    const verified=await this.apple.authenticate(input),credential='lyra_a_'+randomBytes(32).toString('base64url');
    let userID,spotifyCleanup=[];
    await this.db.transaction(async db=>{
      // Serialize identity creation, deletion and starter claims across devices.
      await db.query('SELECT id FROM membership_settings WHERE id=1 FOR UPDATE');
      await this.enabled(db);await this.nonce(db,input,'apple',user.id,true);
      let identity=await first(db,'SELECT * FROM account_identities WHERE subject_hash=$1 FOR UPDATE',[verified.subjectHash]);
      if(!identity) {
        // Fresh random user/identity rows are not visible to any other tx.
        // Existing source/target users are locked together below, never target
        // first. The new-row FKs refer only to this transaction's own user.
        userID='apple-'+randomUUID();
        await db.query("INSERT INTO library_users(id,access_kind) VALUES($1,'apple')",[userID]);
        identity=await first(db,`INSERT INTO account_identities(subject_hash,user_id,app_account_token,apple_client_id,refresh_token_encrypted)
          VALUES($1,$2,$3,$4,$5) RETURNING *`,[verified.subjectHash,userID,randomUUID(),input.bundleID,verified.refreshTokenEncrypted]);
      } else userID=identity.user_id;
      // C2 is server minted; capture this closed raw intent once, before
      // discovery or any subsequent await can observe a different target.
      const targetCredentialDigest=digest(credential);
      const operationRawJSON=JSON.stringify({kind:'signIn',targetPrincipalID:userID,targetCredentialDigest});
      const scope=await this.#lockWriter(db,user,prepared.authentication,operationRawJSON,{userIDs:[user.id,userID]});
      await writerAuthorization(()=>scope.revalidate({tx:db}));
      const spotifyPlan=await prepareSpotifyRevocationInTransaction(db,{ownerID:user.id,keyID:user.keyID},'ownerChanged');
      const privacyPlan=this.#privacyWriters?await this.#privacyWriters.prepareSignIn(db,scope,userID):null;
      if(privacyPlan)await this.#privacyWriters.applyBeforeAuth(db,privacyPlan);
      await db.query('UPDATE account_identities SET deleted_at=NULL,apple_client_id=$2,refresh_token_encrypted=$3 WHERE user_id=$1',
        [userID,input.bundleID,verified.refreshTokenEncrypted]);
      // Configured target reenable passed permanent-withdrawal refusal above.
      if(identity.deleted_at)await db.query('UPDATE library_users SET disabled=false WHERE id=$1',[userID]);
      if(!await first(db,'SELECT id FROM library_users WHERE id=$1 AND NOT disabled',[userID]))throw new LibraryError('app_access_revoked',403);
      const moved=await first(db,`UPDATE app_attest_keys SET user_id=$2 WHERE key_id=$1 AND user_id=$3 AND NOT revoked RETURNING key_id`,
        [user.keyID,userID,user.id]);
      if(!moved)throw new LibraryError('app_access_revoked',403);
      await db.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[user.credentialDigest]);
      await db.query('DELETE FROM app_auth_sessions WHERE key_id=$1',[user.keyID]);
      // C2 was proved absent by the bound writer intent. Insert only after
      // the locked preimage check; unique collision still rolls everything back.
      await db.query("INSERT INTO library_tokens(digest,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '365 days')",[targetCredentialDigest,userID]);
      spotifyCleanup=await persistSpotifyRevocationInTransaction(db,spotifyPlan);
      let privacyNotAfterMS;
      if(privacyPlan){await this.#privacyWriters.persistAfterAuth(db,privacyPlan);privacyNotAfterMS=await this.#privacyWriters.verifyPostimage(db,privacyPlan);}
      // The retained privacy cutoff and exact S/C/C2 share this LAST SQL clock.
      await writerAuthorization(()=>scope.verifyPostimage({tx:db,notAfterMS:privacyNotAfterMS}));
      // Return directly to the transaction wrapper's COMMIT; no further IO.
    });
    await this.spotifyCleanup(this.db,spotifyCleanup);
    return {credential,userID};
  }
  async signOut(user,handle) {
    const prepared=this.#writerAuthentication(user,handle);user=prepared.source;
    const operationRawJSON=JSON.stringify({kind:'signOut'});
    let spotifyCleanup;
    await this.db.transaction(async db=>{
      // credentialDigest narrows connections, not the helper's owner key set.
      const scope=await this.#lockWriter(db,user,prepared.authentication,operationRawJSON,{allKeys:true});
      await writerAuthorization(()=>scope.revalidate({tx:db}));
      const spotifyPlan=await prepareSpotifyRevocationInTransaction(db,{ownerID:user.id,credentialDigest:user.credentialDigest},'signedOut');
      const privacyPlan=this.#privacyWriters?await this.#privacyWriters.prepareSignOut(db,scope):null;
      if(privacyPlan)await this.#privacyWriters.applyBeforeAuth(db,privacyPlan);
      await db.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[user.credentialDigest]);
      spotifyCleanup=await persistSpotifyRevocationInTransaction(db,spotifyPlan);
      if(privacyPlan){await this.#privacyWriters.persistAfterAuth(db,privacyPlan);await this.#privacyWriters.verifyPostimage(db,privacyPlan);}
      // Exact source deadline SQL, then direct COMMIT.
      await writerAuthorization(()=>scope.verifyPostimage({tx:db}));
    });
    await this.spotifyCleanup(this.db,spotifyCleanup);
    return {signedOut:true};
  }
  async delete(user,input,handle) {
    const prepared=this.#writerAuthentication(user,handle);user=prepared.source;
    input=Object.freeze({...input,keyID:user.keyID});
    const operationRawJSON=JSON.stringify({kind:'delete'});
    await this.nonce(this.db,input,'delete',user.id);
    const identity=await first(this.db,'SELECT * FROM account_identities WHERE user_id=$1 AND deleted_at IS NULL',[user.id]);
    if(!identity)throw new LibraryError('sign_in_required',403);
    const verified=await this.apple.authenticate(input);
    if(verified.subjectHash!==identity.subject_hash)throw new LibraryError('apple_identity_invalid',403);
    await this.apple.revoke({...identity,apple_client_id:input.bundleID,refresh_token_encrypted:verified.refreshTokenEncrypted});
    let spotifyCleanup=[];
    await this.db.transaction(async db=>{
      await db.query('SELECT id FROM membership_settings WHERE id=1 FOR UPDATE');
      await this.nonce(db,input,'delete',user.id,true);
      const currentIdentity=await first(db,'SELECT * FROM account_identities WHERE user_id=$1 FOR UPDATE',[user.id]);
      if(!currentIdentity||currentIdentity.subject_hash!==verified.subjectHash)throw new LibraryError('apple_identity_invalid',403);
      const scope=await this.#lockWriter(db,user,prepared.authentication,operationRawJSON,{allTokens:true,allKeys:true});
      await writerAuthorization(()=>scope.revalidate({tx:db}));
      const spotifyPlan=await prepareSpotifyRevocationInTransaction(db,{ownerID:user.id},'accountDeleted');
      const privacyPlan=this.#privacyWriters?await this.#privacyWriters.prepareDelete(db,scope):null;
      if(privacyPlan)await this.#privacyWriters.applyBeforeAuth(db,privacyPlan);
      await scrubListeningAccount(db,user.id);
      await db.query('UPDATE library_users SET disabled=true WHERE id=$1',[user.id]);
      await db.query('DELETE FROM selected_source_access WHERE user_id=$1',[user.id]);
      await db.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[user.id]);
      await db.query("UPDATE app_attest_keys SET revoked=true,receipt=''::bytea,public_key='' WHERE user_id=$1",[user.id]);
      await db.query('DELETE FROM app_auth_sessions WHERE key_id IN (SELECT key_id FROM app_attest_keys WHERE user_id=$1)',[user.id]);
      await db.query('UPDATE account_identities SET deleted_at=now(),refresh_token_encrypted=NULL,apple_client_id=NULL WHERE user_id=$1',[user.id]);
      await db.query('DELETE FROM live_lyrics_push_receipts WHERE user_id=$1',[user.id]);
      await db.query("UPDATE correction_reports SET detail='[Account deleted]',assessment=NULL WHERE user_id=$1",[user.id]);
      spotifyCleanup=await persistSpotifyRevocationInTransaction(db,spotifyPlan);
      if(privacyPlan){await this.#privacyWriters.persistAfterAuth(db,privacyPlan);await this.#privacyWriters.verifyPostimage(db,privacyPlan);}
      // Exact source session and credential deadlines survive deliberate deletion
      // as captured auth evidence. Privacy verification must come before this.
      await writerAuthorization(()=>scope.verifyPostimage({tx:db}));
    });
    await this.spotifyCleanup(this.db,spotifyCleanup);
    return {deleted:true};
  }
}
