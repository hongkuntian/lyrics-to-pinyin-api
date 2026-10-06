import {createPublicKey,verify,sign,randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {digest,LibraryError} from '../song-library/store.js';

const fail=()=>{throw new LibraryError('apple_identity_invalid',403);};
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
export function verifyIdentity(token,{keys,bundleID,challenge,now=Date.now()}) {
  if(typeof token!=='string'||token.length>16000)fail();
  const parts=token.split('.');if(parts.length!==3||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))fail();
  let header,payload;try{header=JSON.parse(Buffer.from(parts[0],'base64url'));payload=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{fail();}
  const key=keys.find(k=>k.kid===header.kid&&k.kty==='RSA'&&k.alg==='RS256'&&k.use==='sig');
  if(header.alg!=='RS256'||header.crit||!key)fail();
  try{if(!verify('RSA-SHA256',Buffer.from(parts.slice(0,2).join('.')),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))fail();}catch{fail();}
  const seconds=Math.floor(now/1000);
  if(payload.iss!=='https://appleid.apple.com'||payload.aud!==bundleID||payload.nonce!==digest(challenge)||
    !Number.isSafeInteger(payload.exp)||!Number.isSafeInteger(payload.iat)||payload.exp<=seconds||payload.iat>seconds+60||payload.iat<seconds-600||
    typeof payload.sub!=='string'||!payload.sub||payload.sub.length>256)fail();
  return {subjectHash:digest('apple:'+payload.sub)};
}

// Refresh tokens exist only to revoke Apple's authorization on account deletion.
// Authenticated encryption keeps a database export from exposing usable tokens.
export function sealToken(value,key,subjectHash) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(subjectHash));
  const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [iv,cipher.getAuthTag(),bytes].map(b=>b.toString('base64url')).join('.');
}
export function openToken(value,key,subjectHash) {
  const [iv,tag,bytes]=value.split('.').map(s=>Buffer.from(s,'base64url'));
  const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(subjectHash));cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes),cipher.final()]).toString('utf8');
}

export class AppleIdentityService {
  constructor({env=process.env,fetchFn=fetch,now=Date.now}={}){this.env=env;this.fetch=fetchFn;this.now=now;this.cached=null;}
  configuration(bundleID) {
    const env=this.env,key=Buffer.from(env.LYRA_ACCOUNT_ENCRYPTION_KEY??'','base64');
    if(!/^[A-Z0-9]{10}$/.test(env.LYRA_APP_ID_PREFIX??'')||!/^[A-Z0-9]{10}$/.test(env.LYRA_SIGN_IN_APPLE_KEY_ID??'')||
      !env.LYRA_SIGN_IN_APPLE_PRIVATE_KEY||key.length!==32||!(env.LYRA_APP_BUNDLE_IDS??'').split(',').includes(bundleID))
      throw new LibraryError('apple_sign_in_unavailable',503);
    return {key,team:env.LYRA_APP_ID_PREFIX,keyID:env.LYRA_SIGN_IN_APPLE_KEY_ID,privateKey:env.LYRA_SIGN_IN_APPLE_PRIVATE_KEY};
  }
  clientSecret(bundleID) {
    const config=this.configuration(bundleID),now=Math.floor(this.now()/1000);
    const message=encode({alg:'ES256',kid:config.keyID})+'.'+encode({iss:config.team,iat:now,exp:now+300,aud:'https://appleid.apple.com',sub:bundleID});
    return message+'.'+sign('sha256',Buffer.from(message),{key:config.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  }
  async json(url,options) {
    const response=await this.fetch(url,{...options,redirect:'error',signal:AbortSignal.timeout(10000)});
    const text=await response.text();if(text.length>32768)throw new LibraryError('apple_sign_in_unavailable',503);
    let body;try{body=text?JSON.parse(text):{};}catch{throw new LibraryError('apple_sign_in_unavailable',503);}
    if(!response.ok)throw new LibraryError('apple_sign_in_unavailable',503);
    return body;
  }
  async keys() {
    if(this.cached&&this.cached.until>this.now())return this.cached.keys;
    const result=await this.json('https://appleid.apple.com/auth/keys');
    if(!Array.isArray(result.keys)||result.keys.length>10)throw new LibraryError('apple_sign_in_unavailable',503);
    this.cached={keys:result.keys,until:this.now()+300000};return result.keys;
  }
  async authenticate({identityToken,authorizationCode,bundleID,challenge}) {
    const config=this.configuration(bundleID),keys=await this.keys();
    const identity=verifyIdentity(identityToken,{keys,bundleID,challenge,now:this.now()});
    const result=await this.json('https://appleid.apple.com/auth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:bundleID,client_secret:this.clientSecret(bundleID),code:authorizationCode,grant_type:'authorization_code'}).toString()});
    // The authorization code and ID token must belong to the same Apple identity.
    const exchanged=verifyIdentity(result.id_token,{keys,bundleID,challenge,now:this.now()});
    if(exchanged.subjectHash!==identity.subjectHash||typeof result.refresh_token!=='string'||!result.refresh_token)fail();
    return {...identity,refreshTokenEncrypted:sealToken(result.refresh_token,config.key,identity.subjectHash)};
  }
  async revoke(identity) {
    const config=this.configuration(identity.apple_client_id);
    if(!identity.refresh_token_encrypted)throw new LibraryError('account_deletion_unavailable',503);
    await this.json('https://appleid.apple.com/auth/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({client_id:identity.apple_client_id,client_secret:this.clientSecret(identity.apple_client_id),
        token:openToken(identity.refresh_token_encrypted,config.key,identity.subject_hash),token_type_hint:'refresh_token'}).toString()});
  }
}
