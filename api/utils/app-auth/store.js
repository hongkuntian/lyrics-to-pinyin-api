import {randomBytes} from 'node:crypto';
import {digest,LibraryError} from '../song-library/store.js';
import {attest,assertion} from './verification.js';
const first=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0]??null;
const fail=(code='unauthorized',status=401)=>{throw new LibraryError(code,status);};
export function authPolicy(env=process.env) {
  const audience=env.LYRA_APP_AUTH_AUDIENCE,environment=env.LYRA_APP_ATTEST_ENVIRONMENT,prefix=env.LYRA_APP_ID_PREFIX;
  const bundles=(env.LYRA_APP_BUNDLE_IDS??'').split(',').filter(Boolean);
  if(!audience||!/^[A-Za-z0-9_-]{1,64}$/.test(audience)||!['production','development'].includes(environment)||
    !/^[A-Z0-9]{10}$/.test(prefix??'')||!bundles.length||bundles.some(b=>!/^[A-Za-z0-9.-]{1,128}$/.test(b))||
    (env.VERCEL_ENV==='production'&&environment!=='production')||
    (env.VERCEL_ENV&&env.VERCEL_ENV!=='production'&&(environment!=='development'||audience==='lyra-production')))
    fail('app_auth_not_configured',503);
  return {audience,environment,prefix,bundles};
}
export class AppAuthStore {
  constructor(db,{policy,attestFn=attest,assertionFn=assertion}={}) {this.db=db;this.policy=policy??authPolicy();this.attestFn=attestFn;this.assertionFn=assertionFn;}
  async credential(token,db=this.db) {
    const row=await first(db,`SELECT u.id,t.digest FROM library_tokens t JOIN library_users u ON u.id=t.user_id
      WHERE t.digest=$1 AND NOT t.revoked AND NOT u.disabled AND (t.expires_at IS NULL OR t.expires_at>now())`,[digest(token)]);
    if(!row)fail();return row;
  }
  async limit(userID,refresh=false) {
    const field=refresh?'refresh':'auth';
    const row=await first(this.db,`UPDATE library_users SET ${field}_count=CASE WHEN ${field}_window=date_trunc('minute',now()) THEN ${field}_count+1 ELSE 1 END,
      ${field}_window=date_trunc('minute',now()) WHERE id=$1 AND NOT disabled RETURNING ${field}_count AS count`,[userID]);
    if(!row)fail();if(row.count>(refresh?6:30))fail('rate_limited',429);
  }
  async challenge(token,{keyID,bundleID,purpose}) {
    const user=await this.credential(token);await this.limit(user.id);
    if(!this.policy.bundles.includes(bundleID)||!['register','session'].includes(purpose))fail('invalid_request',400);
    const value=randomBytes(32).toString('base64url');
    await this.db.transaction(async db=>{
      // Serialize challenge creation for this account; bound pending state across instances.
      await db.query('SELECT id FROM library_users WHERE id=$1 FOR UPDATE',[user.id]);
      await this.credential(token,db);
      await db.query('DELETE FROM app_auth_challenges WHERE expires_at<now()');
      await db.query('DELETE FROM app_auth_sessions WHERE expires_at<now()');
      const count=await first(db,'SELECT count(*) AS n FROM app_auth_challenges WHERE user_id=$1 AND NOT consumed',[user.id]);
      if(Number(count.n)>=8)fail('rate_limited',429);
      await db.query(`INSERT INTO app_auth_challenges(digest,user_id,credential_digest,key_id,audience,bundle_id,purpose,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '120 seconds')`,[digest(value),user.id,user.digest,keyID,this.policy.audience,bundleID,purpose]);
    });
    return {challenge:value};
  }
  async register(token,{keyID,bundleID,challenge,attestation}) {
    const user=await this.credential(token);await this.limit(user.id);
    return this.db.transaction(async db=>{
      await this.credential(token,db);
      const existing=await first(db,'SELECT * FROM app_attest_keys WHERE key_id=$1',[keyID]);
      if(existing){this.matchKey(existing,user,bundleID);return {registered:true};} // ACK only; never issues a session.
      await this.consume(db,user,{keyID,bundleID,challenge,purpose:'register'});
      let result;try {result=this.attestFn({attestation:Buffer.from(attestation,'base64'),challenge,keyId:keyID,bundleID,...this.policy});}
      catch{fail('app_attestation_invalid',403);}
      await db.query(`INSERT INTO app_attest_keys(key_id,user_id,audience,bundle_id,environment,public_key,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[keyID,user.id,this.policy.audience,bundleID,this.policy.environment,result.publicKey,result.receipt]);
      return {registered:true};
    });
  }
  matchKey(key,user,bundleID) {
    if(key.revoked||key.user_id!==user.id||key.bundle_id!==bundleID||key.audience!==this.policy.audience||key.environment!==this.policy.environment)fail('app_access_revoked',403);
  }
  async consume(db,user,{keyID,bundleID,challenge,purpose}) {
    const row=await first(db,`UPDATE app_auth_challenges SET consumed=true WHERE digest=$1 AND user_id=$2 AND credential_digest=$3
      AND key_id=$4 AND bundle_id=$5 AND audience=$6 AND purpose=$7 AND NOT consumed AND expires_at>now() RETURNING digest`,
      [digest(challenge),user.id,user.digest,keyID,bundleID,this.policy.audience,purpose]);
    if(!row)fail('challenge_expired');
  }
  async session(token,{keyID,bundleID,challenge,assertion}) {
    const user=await this.credential(token);await this.limit(user.id);
    return this.db.transaction(async db=>{
      await this.credential(token,db);
      const key=await first(db,'SELECT * FROM app_attest_keys WHERE key_id=$1 FOR UPDATE',[keyID]);if(!key)fail('app_key_not_registered');
      this.matchKey(key,user,bundleID);
      await this.consume(db,user,{keyID,bundleID,challenge,purpose:'session'});
      let counter;try {counter=this.assertionFn({assertion:Buffer.from(assertion,'base64'),challenge,publicKey:key.public_key,bundleID,
        prefix:this.policy.prefix,signCount:Number(key.sign_count)});}catch{fail('app_assertion_invalid',403);}
      if(!Number.isSafeInteger(counter)||counter<=Number(key.sign_count))fail('app_assertion_invalid',403);
      await db.query('UPDATE app_attest_keys SET sign_count=$2 WHERE key_id=$1',[keyID,counter]);
      const value='lyra_s_'+randomBytes(32).toString('base64url');
      await db.query('DELETE FROM app_auth_sessions WHERE key_id=$1',[keyID]);
      const row=await first(db,`INSERT INTO app_auth_sessions(digest,key_id,credential_digest,audience,expires_at)
        VALUES($1,$2,$3,$4,now()+interval '15 minutes') RETURNING expires_at`,[digest(value),keyID,user.digest,this.policy.audience]);
      return {token:value,expiresAt:new Date(row.expires_at).toISOString()};
    });
  }
  async authenticate(token) {
    const row=await first(this.db,`SELECT u.id,k.key_id AS "keyID",k.bundle_id AS "bundleID",t.digest AS "credentialDigest" FROM app_auth_sessions s JOIN app_attest_keys k ON k.key_id=s.key_id
      JOIN library_tokens t ON t.digest=s.credential_digest JOIN library_users u ON u.id=k.user_id
      WHERE s.digest=$1 AND s.audience=$2 AND k.audience=$2 AND k.environment=$3 AND k.bundle_id=ANY($4::text[])
      AND t.user_id=u.id AND NOT s.revoked AND NOT k.revoked AND NOT t.revoked AND NOT u.disabled AND s.expires_at>now()
      AND (t.expires_at IS NULL OR t.expires_at>now())`,
      [digest(token),this.policy.audience,this.policy.environment,this.policy.bundles]);
    if(!row)fail('session_expired');return row;
  }
}
