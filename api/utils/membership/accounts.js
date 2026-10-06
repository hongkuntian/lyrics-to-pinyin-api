import {randomBytes,randomUUID} from 'node:crypto';
import {digest,LibraryError} from '../song-library/store.js';
import {authPolicy} from '../app-auth/store.js';
import {attest} from '../app-auth/verification.js';
import {AppleIdentityService} from './apple-identity.js';
import {first} from './policy.js';

export class AccountStore {
  constructor(db,{policy,attestFn=attest,apple=new AppleIdentityService()}={}) {
    this.db=db;this.policy=policy??authPolicy();this.attest=attestFn;this.apple=apple;
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
        AND NOT consumed AND expires_at>now()${consume?' RETURNING *':''}`,[digest(challenge),purpose,bundleID,keyID,userID]);
    if(!row)throw new LibraryError('challenge_expired',401);
    return row;
  }
  async guest(input) {
    await this.enabled();
    const {credential,keyID,bundleID}=input;
    // A retry can ACK an already-enrolled key only with its original credential.
    // The credential cannot create an API session without a fresh key assertion.
    const existing=await first(this.db,`SELECT k.key_id FROM app_attest_keys k JOIN library_tokens t ON t.user_id=k.user_id
      JOIN library_users u ON u.id=k.user_id WHERE k.key_id=$1 AND t.digest=$2 AND k.bundle_id=$3 AND k.audience=$4
      AND k.environment=$5 AND u.access_kind='guest' AND NOT k.revoked AND NOT t.revoked AND NOT u.disabled
      AND t.expires_at>now()`,[keyID,digest(credential),bundleID,this.policy.audience,this.policy.environment]);
    if(existing)return {registered:true};
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
      await db.query("INSERT INTO library_tokens(digest,user_id,expires_at) VALUES($1,$2,now()+interval '90 days')",[digest(credential),id]);
      await db.query(`INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[keyID,id,this.policy.audience,bundleID,this.policy.environment,proof.publicKey,proof.receipt]);
    });
    return {registered:true};
  }
  async signIn(user,input) {
    await this.enabled();
    input={...input,keyID:user.keyID};
    await this.nonce(this.db,input,'apple',user.id);
    const verified=await this.apple.authenticate(input),credential='lyra_a_'+randomBytes(32).toString('base64url');
    let userID;
    await this.db.transaction(async db=>{
      // Serialize identity creation, deletion and starter claims across devices.
      await db.query('SELECT id FROM membership_settings WHERE id=1 FOR UPDATE');
      await this.enabled(db);await this.nonce(db,input,'apple',user.id,true);
      let identity=await first(db,'SELECT * FROM account_identities WHERE subject_hash=$1 FOR UPDATE',[verified.subjectHash]);
      if(!identity) {
        userID='apple-'+randomUUID();
        await db.query("INSERT INTO library_users(id,access_kind) VALUES($1,'apple')",[userID]);
        identity=await first(db,`INSERT INTO account_identities(subject_hash,user_id,app_account_token,apple_client_id,refresh_token_encrypted)
          VALUES($1,$2,$3,$4,$5) RETURNING *`,[verified.subjectHash,userID,randomUUID(),input.bundleID,verified.refreshTokenEncrypted]);
      } else {
        userID=identity.user_id;
        await db.query('UPDATE account_identities SET deleted_at=NULL,apple_client_id=$2,refresh_token_encrypted=$3 WHERE user_id=$1',
          [userID,input.bundleID,verified.refreshTokenEncrypted]);
        // A deleted account can return; its one-time spent grants do not reset.
        if(identity.deleted_at)await db.query('UPDATE library_users SET disabled=false WHERE id=$1',[userID]);
        const active=await first(db,'SELECT id FROM library_users WHERE id=$1 AND NOT disabled',[userID]);
        if(!active)throw new LibraryError('app_access_revoked',403);
      }
      const moved=await first(db,`UPDATE app_attest_keys SET user_id=$2 WHERE key_id=$1 AND user_id=$3 AND NOT revoked RETURNING key_id`,
        [user.keyID,userID,user.id]);
      if(!moved)throw new LibraryError('app_access_revoked',403);
      await db.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[user.credentialDigest]);
      await db.query('DELETE FROM app_auth_sessions WHERE key_id=$1',[user.keyID]);
      await db.query("INSERT INTO library_tokens(digest,user_id,expires_at) VALUES($1,$2,now()+interval '365 days')",[digest(credential),userID]);
    });
    return {credential,userID};
  }
  async signOut(user) {
    await this.db.query('UPDATE library_tokens SET revoked=true WHERE digest=$1',[user.credentialDigest]);
    return {signedOut:true};
  }
  async delete(user,input) {
    input={...input,keyID:user.keyID};
    await this.nonce(this.db,input,'delete',user.id);
    const identity=await first(this.db,'SELECT * FROM account_identities WHERE user_id=$1 AND deleted_at IS NULL',[user.id]);
    if(!identity)throw new LibraryError('sign_in_required',403);
    const verified=await this.apple.authenticate(input);
    if(verified.subjectHash!==identity.subject_hash)throw new LibraryError('apple_identity_invalid',403);
    await this.apple.revoke({...identity,apple_client_id:input.bundleID,refresh_token_encrypted:verified.refreshTokenEncrypted});
    await this.db.transaction(async db=>{
      await db.query('SELECT id FROM membership_settings WHERE id=1 FOR UPDATE');
      await this.nonce(db,input,'delete',user.id,true);
      await db.query('UPDATE library_users SET disabled=true WHERE id=$1',[user.id]);
      await db.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[user.id]);
      await db.query("UPDATE app_attest_keys SET revoked=true,receipt=''::bytea,public_key='' WHERE user_id=$1",[user.id]);
      await db.query('DELETE FROM app_auth_sessions WHERE key_id IN (SELECT key_id FROM app_attest_keys WHERE user_id=$1)',[user.id]);
      await db.query('UPDATE account_identities SET deleted_at=now(),refresh_token_encrypted=NULL,apple_client_id=NULL WHERE user_id=$1',[user.id]);
      await db.query('DELETE FROM live_lyrics_push_receipts WHERE user_id=$1',[user.id]);
      await db.query("UPDATE correction_reports SET detail='[Account deleted]',assessment=NULL WHERE user_id=$1",[user.id]);
    });
    return {deleted:true};
  }
}
