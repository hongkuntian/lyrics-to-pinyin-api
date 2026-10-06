import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {verifyIdentity,sealToken,openToken} from '../../api/utils/membership/apple-identity.js';
import {ApplePurchaseVerifier} from '../../api/utils/membership/apple-purchases.js';
import {digest} from '../../api/utils/song-library/store.js';
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const keys=[{...publicKey.export({format:'jwk'}),kid:'test',use:'sig',alg:'RS256'}],now=Date.now();
const claims={iss:'https://appleid.apple.com',aud:'com.test.Lyrica',sub:'apple-subject',nonce:digest('challenge'),iat:Math.floor(now/1000),exp:Math.floor(now/1000)+300};
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
function jwt(payload=claims,header={alg:'RS256',kid:'test'}){const data=encode(header)+'.'+encode(payload);return data+'.'+sign('RSA-SHA256',Buffer.from(data),privateKey).toString('base64url');}
const options={keys,bundleID:claims.aud,challenge:'challenge',now};
test('Apple identity requires signature, issuer, audience, nonce and fresh lifetime',()=>{
  assert.equal(verifyIdentity(jwt(),options).subjectHash,digest('apple:apple-subject'));
  for(const patch of [{iss:'https://evil.test'},{aud:'other.app'},{nonce:'different'},{exp:0},{iat:0},{iat:claims.iat+500},{sub:''}])
    assert.throws(()=>verifyIdentity(jwt({...claims,...patch}),options),{code:'apple_identity_invalid'});
  assert.throws(()=>verifyIdentity(jwt(claims,{alg:'none',kid:'test'}),options),{code:'apple_identity_invalid'});
  const broken=jwt().split('.');broken[1]=encode({...claims,sub:'attacker'});
  assert.throws(()=>verifyIdentity(broken.join('.'),options),{code:'apple_identity_invalid'});
});
test('stored refresh tokens are encrypted and bound to the identity',()=>{
  const key=randomBytes(32),sealed=sealToken('refresh-secret',key,'identity');
  assert.equal(openToken(sealed,key,'identity'),'refresh-secret');assert.ok(!sealed.includes('refresh-secret'));
  assert.throws(()=>openToken(sealed,key,'other-identity'));assert.throws(()=>openToken(sealed,randomBytes(32),'identity'));
});
test('StoreKit verifier refuses missing app identity and unsigned local transactions',async()=>{
  assert.throws(()=>new ApplePurchaseVerifier({env:{}}),{code:'purchases_unavailable'});
  const verifier=new ApplePurchaseVerifier({env:{LYRA_STORE_BUNDLE_ID:'com.test.Lyrica',LYRA_STORE_APP_APPLE_ID:'123',LYRA_STORE_ALLOW_SANDBOX:'true'}});
  await assert.rejects(verifier.transaction(jwt()),{code:'invalid_transaction'});
  await assert.rejects(verifier.notification(jwt()),{code:'invalid_transaction'});
});
