import {assertRetainedAccountDeletionAvailable,scrubRetainedAccountData} from './account-data-privacy.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {digest,LibraryError,lockAuthWriter} from '../song-library/store.js';
import {AppAuthStore,authPolicy} from '../app-auth/store.js';
import {createWriterAuthContext} from '../app-auth/auth-context.js';
import {AuthContextError} from '../app-auth/errors.js';
import {attest} from '../app-auth/verification.js';
import {DeviceCheckError,defaultDeviceCheck,recentlyUpdated,rejectedDeviceToken} from './device-check.js';
import {first} from './policy.js';

// Guest enrollment keeps its existing credential/key checks and writer locks.
// Guest deletion uses exact-bearer writer authentication instead.
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
// Enrollment never inserts a credential the server already holds (the digest
// is library_tokens' primary key). A synced credential reaches a device with
// no App Attest key; a live guest one belongs to an existing account, so that
// device adds its key with register. Any other known credential (revoked,
// expired, disabled or not a guest) is refused for good.
async function knownCredential(db,credentialDigest) {
  const row=await first(db,`SELECT NOT t.revoked AND NOT u.disabled AND u.access_kind='guest'
    AND (t.expires_at IS NULL OR t.expires_at>clock_timestamp()) AS live
    FROM library_tokens t JOIN library_users u ON u.id=t.user_id WHERE t.digest=$1`,[credentialDigest]);
  if(row)throw row.live?new LibraryError('credential_registered',409):new LibraryError('app_access_revoked',403);
}
// Keep account HTTP's LibraryError mapping. Writer-auth errors never disclose
// opaque evidence, session/credential digests or a newly selected identity.
async function writerAuthorization(operation) {
  try{return await operation();}
  catch(error){
    if(!(error instanceof AuthContextError))throw error;
    if(['unauthorized','forbidden','expired','conflict'].includes(error.code))
      throw new LibraryError('app_access_revoked',403);
    throw new LibraryError('app_auth_unavailable',503);
  }
}

export class AccountStore {
  #writerAuth;
  #writerAuthentications=new WeakMap();
  constructor(db,{policy,attestFn=attest,deviceCheck=defaultDeviceCheck(),logger=console,now=Date.now}={}) {
    this.db=db;this.policy=policy??authPolicy();this.attest=attestFn;this.deviceCheck=deviceCheck;this.logger=logger;this.now=now;
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
  // Deletion covers every credential and key of the source account.
  async #lockWriter(db,user,authentication,operationRawJSON) {
    // Nonlocking collection only. The frozen writer owns the sole auth lock
    // pass and refuses changed discovery; never append a former owner/key.
    const tokenIDs=async()=>(await db.query('SELECT digest FROM library_tokens WHERE user_id=$1 ORDER BY digest COLLATE "C" LIMIT 65',[user.id])).rows.map(row=>row.digest);
    const attestIDs=async()=>(await db.query('SELECT key_id FROM app_attest_keys WHERE user_id=$1 ORDER BY key_id COLLATE "C" LIMIT 65',[user.id])).rows.map(row=>row.key_id);
    const credentialDigests=await tokenIDs(),keyIDs=await attestIDs();
    const requiredScopes={userIDs:[user.id],credentialDigests:[...new Set([user.credentialDigest,...credentialDigests])],
      keyIDs:[...new Set([user.keyID,...keyIDs])]};
    if(Object.values(requiredScopes).some(list=>list.length>64))throw new LibraryError('app_auth_unavailable',503);
    const discovery=await writerAuthorization(()=>this.#writerAuth.discover({tx:db,authentication,operationRawJSON,requiredScopes}));
    const scope=await writerAuthorization(()=>this.#writerAuth.lock({tx:db,discovery}));
    if(scope.principalID!==user.id||scope.keyID!==user.keyID||scope.bundleID!==user.bundleID||scope.credentialDigest!==user.credentialDigest)
      throw new LibraryError('app_access_revoked',403);
    // These are read-only completeness checks under the now-held user anchor.
    // New enrollment/rotation before locking refuses; it never appends a pass.
    if(JSON.stringify(await tokenIDs())!==JSON.stringify(credentialDigests)||
      JSON.stringify(await attestIDs())!==JSON.stringify(keyIDs))throw new LibraryError('app_access_revoked',403);
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
  // Enrollment is the only challenge purpose; it is never authenticated.
  async challenge({purpose,bundleID,keyID},clientAddress) {
    await this.enabled();
    if(!this.policy.bundles.includes(bundleID)||purpose!=='guest'||!keyID)throw new LibraryError('invalid_request',400);
    await this.limit('global',120);
    await this.limit('ip:'+digest(clientAddress??'unknown'),10);
    const value=randomBytes(32).toString('base64url');
    await this.db.query('DELETE FROM account_nonces WHERE expires_at<now()');
    await this.db.query("DELETE FROM account_rate_windows WHERE window_start<now()-interval '1 day'");
    await this.db.query(`INSERT INTO account_nonces(digest,purpose,bundle_id,key_id,user_id,expires_at)
      VALUES($1,$2,$3,$4,NULL,now()+interval '5 minutes')`,[digest(value),purpose,bundleID,keyID]);
    return {challenge:value};
  }
  async nonce(db,{challenge,bundleID,keyID},consume=false) {
    const row=await first(db,`${consume?'UPDATE account_nonces SET consumed=true':'SELECT * FROM account_nonces'}
      WHERE digest=$1 AND purpose='guest' AND bundle_id=$2 AND key_id=$3 AND user_id IS NULL
        AND NOT consumed AND expires_at>clock_timestamp()${consume?' RETURNING *':''}`,[digest(challenge),bundleID,keyID]);
    if(!row)throw new LibraryError('challenge_expired',401);
    return row;
  }
  async guest(input) {
    await this.enabled();
    const {credential,keyID,bundleID}=input,credentialDigest=digest(credential);
    // A retry can ACK an already-enrolled key only with its original credential.
    // The credential cannot create an API session without a fresh key assertion.
    const existing=await first(this.db,`SELECT k.key_id,k.user_id FROM app_attest_keys k JOIN library_tokens t ON t.user_id=k.user_id
      JOIN library_users u ON u.id=k.user_id WHERE k.key_id=$1 AND t.digest=$2 AND k.bundle_id=$3 AND k.audience=$4
      AND k.environment=$5 AND u.access_kind='guest' AND NOT k.revoked AND NOT t.revoked AND NOT u.disabled
      AND t.expires_at>clock_timestamp()`,[keyID,credentialDigest,bundleID,this.policy.audience,this.policy.environment]);
    if(existing)return this.db.transaction(async db=>{
      await lockAuthWriter(db,{userIDs:[existing.user_id],credentialDigests:[credentialDigest],keyIDs:[keyID]});
      const current=await first(db,`SELECT u.id FROM library_users u JOIN library_tokens t ON t.user_id=u.id
        JOIN app_attest_keys k ON k.user_id=u.id WHERE u.id=$1 AND u.access_kind='guest'
        AND t.digest=$2 AND k.key_id=$3 AND k.bundle_id=$4 AND k.audience=$5 AND k.environment=$6
        AND NOT u.disabled AND NOT t.revoked AND NOT k.revoked AND t.expires_at>clock_timestamp()`,
        [existing.user_id,credentialDigest,keyID,bundleID,this.policy.audience,this.policy.environment]);
      if(!current)throw new LibraryError('app_access_revoked',403);
      return {registered:true};
    });
    // Before any nonce, attestation or DeviceCheck work: consume nothing.
    await knownCredential(this.db,credentialDigest);
    await this.nonce(this.db,input);
    let proof;try{proof=this.attest({attestation:Buffer.from(input.attestation,'base64'),challenge:input.challenge,keyId:keyID,bundleID,...this.policy});}
    catch{throw new LibraryError('app_attestation_invalid',403);}
    // DeviceCheck runs only for a new account, outside the transaction.
    const device=await this.#enrollmentDeviceCheck(input);
    try{await this.db.transaction(async db=>{
      await db.query('SELECT id FROM membership_settings WHERE id=1 FOR UPDATE');
      // A competing enrollment of this credential committed since the check.
      await this.enabled(db);await knownCredential(db,credentialDigest);await this.nonce(db,input,true);
      if(await first(db,'SELECT 1 FROM app_attest_keys WHERE key_id=$1',[keyID]))throw new LibraryError('app_access_revoked',403);
      const total=await first(db,"SELECT count(*) AS n FROM library_users WHERE access_kind='guest' AND created_at>now()-interval '1 day'");
      if(Number(total.n)>=5000)throw new LibraryError('public_access_temporarily_unavailable',503);
      const id='guest-'+randomUUID();
      await db.query(`INSERT INTO library_users(id,access_kind,free_allowance_held_until)
        VALUES($1,'guest',CASE WHEN $2::boolean THEN now()+interval '7 days' END)`,[id,device.hold]);
      await db.query("INSERT INTO library_tokens(digest,user_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '90 days')",[credentialDigest,id]);
      await db.query(`INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[keyID,id,this.policy.audience,bundleID,this.policy.environment,proof.publicKey,proof.receipt]);
      await sourceCredential(db,{id,keyID,bundleID,credentialDigest},this.policy);
    });}
    catch(error){
      // One still in flight at the insert above wins the primary key once it
      // commits (unique_violation). Answer as if it had committed first.
      if(error?.code==='23505')await knownCredential(this.db,credentialDigest);
      throw error;
    }
    // Mark the device only once an account exists, so a refused or failed
    // enrollment can never hold this device's next attempt.
    if(device.mark)try{await this.deviceCheck.setBit(input.deviceToken,{bundleID,bit:0});}
    catch(error){this.#deviceCheckUnavailable(error,'enrollment_mark');}
    return {registered:true};
  }
  #deviceCheckUnavailable(error,stage) {
    // Never the device token, JWT or Apple's response body. A refused key is
    // our configuration, so it is logged at error level.
    const event={event:'devicecheck_unavailable',stage,
      reason:error===null?'unconfigured':error instanceof DeviceCheckError?error.reason:'error'};
    if(error instanceof DeviceCheckError&&error.kind==='credentials')this.logger.error?.(event);else this.logger.warn?.(event);
  }
  // Hold a new account's free allowance when this device created an account
  // in the current or previous UTC month, or when a configured service gets
  // no token (a token Apple rejects on both hosts counts as none).
  // Unconfigured or failing DeviceCheck never holds.
  async #enrollmentDeviceCheck({deviceToken,bundleID}) {
    if(!this.deviceCheck.configured){this.#deviceCheckUnavailable(null,'enrollment');return {hold:false,mark:false};}
    if(deviceToken===undefined){this.logger.info?.({event:'devicecheck_enrollment',token:false,hold:true});return {hold:true,mark:false};}
    let bits;
    try{bits=await this.deviceCheck.query(deviceToken,{bundleID});}
    catch(error){
      if(rejectedDeviceToken(error)){this.logger.info?.({event:'devicecheck_enrollment',token:'rejected',hold:true});return {hold:true,mark:false};}
      this.#deviceCheckUnavailable(error,'enrollment');return {hold:false,mark:false};
    }
    const hold=bits.bit0&&recentlyUpdated(bits.lastUpdateTime,this.now());
    this.logger.info?.({event:'devicecheck_enrollment',token:true,hold});
    return {hold,mark:true};
  }
  // Deletes the anonymous (guest) account behind this exact session. Access
  // code (beta) accounts are operator-managed and are never deleted here.
  async delete(user,handle) {
    const prepared=this.#writerAuthentication(user,handle);user=prepared.source;
    const operationRawJSON=JSON.stringify({kind:'delete'});
    const kind=await first(this.db,'SELECT access_kind FROM library_users WHERE id=$1 AND NOT disabled',[user.id]);
    if(!kind)throw new LibraryError('app_access_revoked',403);
    if(kind.access_kind!=='guest')throw new LibraryError('account_not_deletable',403);
    await assertRetainedAccountDeletionAvailable(this.db);
    await this.db.transaction(async db=>{
      const scope=await this.#lockWriter(db,user,prepared.authentication,operationRawJSON);
      await writerAuthorization(()=>scope.revalidate({tx:db}));
      // The locked exact source decides; revalidate pinned its access kind.
      if(scope.accessKind!=='guest')throw new LibraryError('account_not_deletable',403);
      await scrubRetainedAccountData(db,user.id);
      await db.query('UPDATE library_users SET disabled=true WHERE id=$1',[user.id]);
      await db.query('DELETE FROM selected_source_access WHERE user_id=$1',[user.id]);
      await db.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[user.id]);
      await db.query("UPDATE app_attest_keys SET revoked=true,receipt=''::bytea,public_key='' WHERE user_id=$1",[user.id]);
      await db.query('DELETE FROM app_auth_sessions WHERE key_id IN (SELECT key_id FROM app_attest_keys WHERE user_id=$1)',[user.id]);
      await db.query('DELETE FROM live_lyrics_push_receipts WHERE user_id=$1',[user.id]);
      await db.query("UPDATE correction_reports SET detail='[Account deleted]',assessment=NULL WHERE user_id=$1",[user.id]);
      // Exact source session and credential deadlines survive deliberate deletion
      // as captured auth evidence. Privacy verification must come before this.
      await writerAuthorization(()=>scope.verifyPostimage({tx:db}));
    });
    return {deleted:true};
  }
}
