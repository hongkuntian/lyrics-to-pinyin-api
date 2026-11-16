import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,verify,createPublicKey} from 'node:crypto';
import {AppleIdentityService,sealToken} from '../../api/utils/membership/apple-identity.js';
import {digest} from '../../api/utils/song-library/store.js';

const signing=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const encryption=randomBytes(32),subject=digest('historical-apple-subject');
const active='com.example.Lyrica',historical='com.example.RetiredApp';
function setup({token='retained-refresh',client=historical,hash=subject,env:overrides={}}={}){
 const calls=[],env={LYRICA_ACCOUNT_ENCRYPTION_KEY:encryption.toString('base64'),LYRICA_APP_ID_PREFIX:'ABCDEFGHIJ',
  LYRICA_SIGN_IN_APPLE_KEY_ID:'0123456789',LYRICA_SIGN_IN_APPLE_PRIVATE_KEY:signing.privateKey.export({type:'pkcs8',format:'pem'}),LYRICA_APP_BUNDLE_IDS:active,...overrides};
 const service=new AppleIdentityService({env,now:()=>1700000000000,fetchFn:async(url,options)=>{
  calls.push({url,options});return {ok:true,text:async()=>''};
 }});
 return {service,calls,env,identity:{subject_hash:hash,apple_client_id:client,refresh_token_encrypted:sealToken(token,encryption,hash)}};
}
function clientSecret(value){
 const [header,payload,signature]=value.split('.');
 assert.equal(verify('sha256',Buffer.from(header+'.'+payload),{key:createPublicKey(signing.privateKey),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),true);
 return {header:JSON.parse(Buffer.from(header,'base64url')),payload:JSON.parse(Buffer.from(payload,'base64url'))};
}

test('retained encrypted Apple authorization revokes its original client without admitting that app',async()=>{
 const f=setup();
 await assert.rejects(f.service.authenticate({bundleID:historical,identityToken:'unused',authorizationCode:'unused',challenge:'unused'}),{code:'apple_sign_in_unavailable'});
 assert.throws(()=>f.service.clientSecret(historical),{code:'apple_sign_in_unavailable'});
 assert.equal(f.calls.length,0);
 await f.service.revoke(f.identity);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'https://appleid.apple.com/auth/revoke');
 assert.equal(f.calls[0].options.redirect,'error');
 const form=new URLSearchParams(f.calls[0].options.body);
 assert.equal(form.get('client_id'),historical);assert.equal(form.get('token'),'retained-refresh');assert.equal(form.get('token_type_hint'),'refresh_token');
 const secret=clientSecret(form.get('client_secret'));
 assert.equal(secret.header.kid,'0123456789');assert.equal(secret.payload.sub,historical);assert.equal(secret.payload.iss,'ABCDEFGHIJ');assert.equal(secret.payload.aud,'https://appleid.apple.com');
 assert.equal(secret.payload.exp-secret.payload.iat,300);
 assert.equal(f.env.LYRICA_APP_BUNDLE_IDS,active);assert.equal(f.identity.apple_client_id,historical);
});

test('active app client secrets retain the exact active allowlist',()=>{
 const f=setup(),secret=clientSecret(f.service.clientSecret(active));
 assert.equal(secret.payload.sub,active);
 for(const client of [historical,'com.example.Other','',null,undefined])assert.throws(()=>f.service.configuration(client),{code:'apple_sign_in_unavailable'});
 assert.equal(f.calls.length,0);
});

for(const [label,change] of [
 ['missing token',identity=>({...identity,refresh_token_encrypted:null})],
 ['different subject',identity=>({...identity,subject_hash:digest('different-subject')})],
 ['tampered ciphertext',identity=>({...identity,refresh_token_encrypted:identity.refresh_token_encrypted.slice(0,-2)+'xx'})],
 ['missing client',identity=>({...identity,apple_client_id:null})],
 ['URL client',identity=>({...identity,apple_client_id:'https://attacker.example/client'})],
 ['newline client',identity=>({...identity,apple_client_id:'com.example.Other\n'})],
 ['oversized client',identity=>({...identity,apple_client_id:'x'.repeat(257)})],
 ['malformed subject',identity=>({...identity,subject_hash:'untrusted'})],
 ['empty token',identity=>({...identity,refresh_token_encrypted:sealToken('',encryption,subject)})]
])test('historical revocation rejects '+label+' before external IO',async()=>{
 const f=setup();await assert.rejects(f.service.revoke(change(f.identity)),{code:'account_deletion_unavailable'});assert.equal(f.calls.length,0);
});

test('historical revocation requires the retained encryption key and current signing configuration',async()=>{
 const wrong=setup({env:{LYRICA_ACCOUNT_ENCRYPTION_KEY:randomBytes(32).toString('base64')}});
 await assert.rejects(wrong.service.revoke(wrong.identity),{code:'account_deletion_unavailable'});assert.equal(wrong.calls.length,0);
 const unsigned=setup({env:{LYRICA_SIGN_IN_APPLE_PRIVATE_KEY:undefined}});
 await assert.rejects(unsigned.service.revoke(unsigned.identity),{code:'apple_sign_in_unavailable'});assert.equal(unsigned.calls.length,0);
});


test('revocation stays available when active admission is disabled, without admitting an empty audience',async()=>{
 const f=setup({env:{LYRICA_APP_BUNDLE_IDS:undefined}});
 for(const client of ['',active,historical])assert.throws(()=>f.service.configuration(client),{code:'apple_sign_in_unavailable'});
 await f.service.revoke(f.identity);assert.equal(f.calls.length,1);
});
