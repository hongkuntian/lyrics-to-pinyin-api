import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {LibraryError} from '../song-library/store.js';
import {spotifyHash} from '../song-library/spotify-recording.js';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export function createVault(input) {
 const config=input===undefined?(()=>{try{return JSON.parse(process.env.LYRA_SPOTIFY_VAULT_KEYRING);}catch{}})():input;
 if(!config||typeof config.active!=='string'||!config.keys||Object.keys(config.keys).length>4||!Object.hasOwn(config.keys,config.active))throw new LibraryError('spotify_not_configured',503);
 const keys={};for(const [id,key] of Object.entries(config.keys)){
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)||typeof key!=='string'||Buffer.from(key,'base64').length!==32||Buffer.from(key,'base64').toString('base64')!==key)throw new LibraryError('spotify_not_configured',503);
  keys[id]=Buffer.from(key,'base64');
 }
 const aad=context=>Buffer.from(JSON.stringify(['spotify-vault-2',...['ownerID','keyID','connectionID','epoch','clientID','environment','ownerEnvironment','apnsEnvironment','purpose'].map(k=>context[k]??null)]));
 return {active:config.active,seal(value,context){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keys[config.active],nonce);cipher.setAAD(aad(context));
  const bytes=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return {version:2,keyID:config.active,nonce:nonce.toString('base64'),ciphertext:bytes.toString('base64'),tag:cipher.getAuthTag().toString('base64')};},
 open(value,context){try{if(value.version!==2||!keys[value.keyID])throw Error();const decipher=createDecipheriv('aes-256-gcm',keys[value.keyID],Buffer.from(value.nonce,'base64'));decipher.setAAD(aad(context));decipher.setAuthTag(Buffer.from(value.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(value.ciphertext,'base64')),decipher.final()]).toString('utf8');}catch{throw new LibraryError('spotify_vault_unavailable',503);}}};
}
export function spotifyConfiguration(env=process.env){
 const apnsEnvironment=env.LYRA_SPOTIFY_APNS_ENVIRONMENT===undefined?'production':env.LYRA_SPOTIFY_APNS_ENVIRONMENT;
 if(!/^[a-fA-F0-9]{32}$/.test(env.LYRA_SPOTIFY_CLIENT_ID??'')||!env.LYRA_SPOTIFY_RATE_BUCKET||!['production','preview','development'].includes(env.VERCEL_ENV??'development')||!['production','development'].includes(apnsEnvironment))throw new LibraryError('spotify_not_configured',503);
 let keyring=null;try{keyring=JSON.parse(env.LYRA_SPOTIFY_VAULT_KEYRING);}catch{}
 return {clientID:env.LYRA_SPOTIFY_CLIENT_ID,environment:env.VERCEL_ENV??'development',apnsEnvironment,rateBucket:env.LYRA_SPOTIFY_RATE_BUCKET,vault:createVault(keyring)};
}
export const vaultContext=c=>({ownerID:c.ownerID,keyID:c.keyID,connectionID:c.id,epoch:c.epoch,clientID:c.clientID,environment:c.environment,ownerEnvironment:c.ownerEnvironment,apnsEnvironment:c.apnsEnvironment});

// Public reference DTOs may expose the digest itself as an additive field.
export function contentFingerprint(value){const {contentFingerprint:ignored,...dto}=value;return spotifyHash(dto);}
