import {verifyAttestation,verifyAssertion} from 'node-app-attest';
import cbor from 'cbor';
import {X509Certificate} from 'node:crypto';

// The pinned verifier checks Apple's root, nonce, key ID, RP ID and credential ID.
// Add strict framing, certificate validity/constraints and exact environment checks.
function decode(bytes) {
  const values=cbor.decodeAllSync(bytes,{max_depth:16,preventDuplicateKeys:true});
  if(values.length!==1 || !values[0] || typeof values[0]!=='object')throw new Error('invalid_object');
  return values[0];
}
export function attest({attestation,challenge,keyId,bundleID,prefix,environment,now=Date.now()}) {
  const obj=decode(attestation),auth=obj.authData;
  if(!Buffer.isBuffer(auth)||auth.length<87||(auth[32]&0x40)===0||auth.readUInt16BE(53)!==32)throw new Error('invalid_authenticator');
  if(!Array.isArray(obj.attStmt?.x5c)||obj.attStmt.x5c.length!==2)throw new Error('invalid_chain');
  const [leaf,issuer]=obj.attStmt.x5c.map(value=>new X509Certificate(value));
  if(leaf.ca||!issuer.ca||!leaf.checkIssued(issuer)||!leaf.verify(issuer.publicKey))throw new Error('invalid_chain');
  for(const certificate of [leaf,issuer])if(now<Date.parse(certificate.validFrom)||now>Date.parse(certificate.validTo))throw new Error('expired_certificate');
  const result=verifyAttestation({attestation,challenge,keyId,bundleIdentifier:bundleID,teamIdentifier:prefix,
    allowDevelopmentEnvironment:environment==='development'});
  if(result.environment!==environment)throw new Error('wrong_environment');
  return result;
}
export function assertion({assertion:bytes,challenge,publicKey,bundleID,prefix,signCount}) {
  const obj=decode(bytes),auth=obj.authenticatorData;
  if(!Buffer.isBuffer(obj.signature)||obj.signature.length>80||!Buffer.isBuffer(auth)||auth.length<37||auth.length>4096)
    throw new Error('invalid_assertion');
  const result=verifyAssertion({assertion:bytes,payload:challenge,publicKey,bundleIdentifier:bundleID,teamIdentifier:prefix,signCount});
  if(!Number.isSafeInteger(result.signCount)||result.signCount<=signCount)throw new Error('invalid_counter');
  return result.signCount;
}
