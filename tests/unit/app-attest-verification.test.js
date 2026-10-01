import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import cbor from 'cbor';
import {attest,assertion} from '../../api/utils/app-auth/verification.js';
const fixture=JSON.parse(await readFile(new URL('../../node_modules/node-app-attest/test/fixtures/attestation-production.json',import.meta.url)));
const input={attestation:Buffer.from(fixture.attestation,'base64'),challenge:Buffer.from(fixture.challenge,'base64'),keyId:fixture.keyId,
 bundleID:'io.uebelacker.AppAttestExample',prefix:'V8H6LQ9448',environment:'production',now:Date.parse('2024-02-08T00:00:00Z')};
test('real Apple certificate fixture verifies and rejects modified nonce, key, app, environment and expired certificate',()=>{
 assert.ok(attest(input).publicKey.includes('PUBLIC KEY'));
 for(const patch of [{challenge:'wrong'},{keyId:Buffer.alloc(32).toString('base64')},{bundleID:'evil'},
  {environment:'development'},{now:Date.now()}])assert.throws(()=>attest({...input,...patch}));
 const obj=cbor.decodeFirstSync(input.attestation);obj.authData[33]=1;
 assert.throws(()=>attest({...input,attestation:cbor.encode(obj)}));
});
const bytes=Buffer.from('omlzaWduYXR1cmVYRzBFAiBB8BGAwkmFCg1M5J0mOYEun0SUN1/lse79/7ypG9WiMQIhAIHvqj7eg59B1PMFX1CN4GMGlsgfFtdL30pHCf7G/dNRcWF1dGhlbnRpY2F0b3JEYXRhWCXKPdw7T3iujcFZbHVrHX0mDSMrNms5PzEbrFbQPRA6rEAAAAAB','base64');
const proof={assertion:bytes,challenge:'{"subject":"Lorem ipsum","message":"Lorem ipsum dolor sit amet, consectetur adipiscing elit."}',
 publicKey:'-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEg69t2YzgcPTLUx8Zgu+rbcikeaEL\n8Ppb+HG0QTIulz8YUB9tgv1pDRruWk87nZC3our56pzIWaqXEbaWyamdzA==\n-----END PUBLIC KEY-----\n',
 bundleID:input.bundleID,prefix:input.prefix,signCount:0};
test('real signed assertion verifies and rejects replay, payload, app and CBOR framing tampering',()=>{
 assert.equal(assertion(proof),1);
 for(const patch of [{signCount:1},{challenge:'wrong'},{bundleID:'evil'},
  {assertion:Buffer.concat([bytes,cbor.encode({})])},{assertion:Buffer.alloc(8)}])assert.throws(()=>assertion({...proof,...patch}));
});
