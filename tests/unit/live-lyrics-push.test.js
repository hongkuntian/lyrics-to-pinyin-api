import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {providerToken,sendAPNs,createAPNsSender} from '../../api/utils/live-lyrics/apns.js';
import {validatePush} from '../../api/utils/live-lyrics/relay.js';
import {pushBody,pushTime} from '../helpers/live-lyrics.js';

test('APNs JWT uses P-256 ES256, a Unix issue time and the intended team',()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const token=providerToken({teamID:'9ESZX68J8U',keyID:'TESTKEY123',privateKey:privateKey.export({type:'pkcs8',format:'pem'}).replaceAll('\n','\\n')},pushTime);
  const [header,payload,signature]=token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url')),{alg:'ES256',kid:'TESTKEY123'});
  assert.deepEqual(JSON.parse(Buffer.from(payload,'base64url')),{iss:'9ESZX68J8U',iat:pushTime/1000});
  assert.equal(Buffer.from(signature,'base64url').length,64);
  assert.equal(verify('sha256',Buffer.from(`${header}.${payload}`),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),true);
});
test('push validation preserves default Swift Codable dates and rejects stale or malformed state',()=>{
  const valid=pushBody();assert.equal(validatePush(valid,pushTime).observed,pushTime/1000);
  for(const mutate of [b=>b.extra=true,b=>b.token='no',b=>b.environment='unknown',b=>b.state.extra=true,
    b=>b.state.progress=1,b=>b.state.playing='true',b=>b.state.part=1,b=>b.state.sequence=0,
    b=>b.state.original='字'.repeat(300),b=>b.state.observedAt='2026-10-03',b=>b.state.observedAt+=3]) {
    const b=structuredClone(valid);mutate(b);assert.throws(()=>validatePush(b,pushTime),{code:'invalid_request'});
  }
  assert.throws(()=>validatePush(valid,pushTime+8000),{code:'push_observation_expired'});
});
test('HTTP/2 delivery chooses the correct environment, topic, priority and zero expiry',async()=>{
  for(const environment of ['development','production']) for(const bundleID of ['com.hongkuntian.musicromanization','com.hongkuntian.Lyra']) {
    let host,headers,body,closed=false;
    const stream=new EventEmitter();stream.setEncoding=()=>{};stream.close=()=>{};
    stream.end=value=>{body=JSON.parse(value);queueMicrotask(()=>{stream.emit('response',{':status':200});stream.emit('end');});};
    const session=new EventEmitter();session.request=value=>{headers=value;return stream;};session.close=()=>{closed=true;};session.destroy=()=>{};
    const input={bundleID,environment,token:'ab'.repeat(32),jwt:'fixture-jwt',priority:5,payload:{aps:{event:'update'}}};
    assert.deepEqual(await sendAPNs(input,value=>{host=value;return session;}),{status:200,reason:undefined});
    assert.equal(host,environment==='development'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com');
    assert.equal(headers['apns-topic'],bundleID+'.push-type.liveactivity');
    assert.equal(headers['apns-push-type'],'liveactivity');assert.equal(headers['apns-priority'],'5');assert.equal(headers['apns-expiration'],'0');
    assert.deepEqual(body,input.payload);assert.equal(closed,true);
  }
  for(const bundleID of [undefined,'com.unrelated.app','com.hongkuntian.Lyra\r\ninjected']) {
    assert.throws(()=>sendAPNs({bundleID},()=>{throw Error('unexpected transport');}),{code:'app_access_revoked'});
  }
});
test('APNs errors are bounded and invalid activity tokens are distinguished from credentials',async()=>{
  const {privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const env={LYRA_APNS_TEAM_ID:'9ESZX68J8U',LYRA_APNS_KEY_ID:'TESTKEY123',LYRA_APNS_PRIVATE_KEY:privateKey.export({type:'pkcs8',format:'pem'})};
  for(const [result,code] of [[{status:410,reason:'Unregistered'},'push_token_invalid'],[{status:403},'push_credentials_rejected'],[{status:429},'push_rate_limited'],[{status:500},'push_unavailable']]) {
    const send=createAPNsSender({env,send:async()=>result});await assert.rejects(()=>send({}),{code});
  }
  const send=createAPNsSender({env:{},send:async()=>{throw Error('should not send');}});
  await assert.rejects(()=>send({}),{code:'push_not_configured'});
});
