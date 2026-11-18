import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,verify,createPublicKey} from 'node:crypto';
import {DeviceCheckError,DeviceCheckService,deviceCheckConfiguration,recentlyUpdated,validDeviceToken} from '../../api/utils/membership/device-check.js';

// Apple's DeviceCheck HTTP is always mocked; no test reaches Apple.
const signing=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const env={LYRICA_APNS_TEAM_ID:'9ESZX68J8U',LYRICA_DEVICECHECK_KEY_ID:'ABCDE12345',
  LYRICA_DEVICECHECK_PRIVATE_KEY:signing.privateKey.export({type:'pkcs8',format:'pem'})};
const token=Buffer.from('device-token-bytes').toString('base64');
const T0=Date.UTC(2026,10,17,12);
function reply(status,text){return {status,text:async()=>text};}
function service({responses=[],now=()=>T0,overrides={},timeoutMs}={}) {
  const calls=[];
  const fetchFn=async(url,options)=>{
    calls.push({url,options,body:JSON.parse(options.body),jwt:options.headers.authorization.slice('Bearer '.length)});
    const next=responses.shift();if(!next)throw new Error('unexpected DeviceCheck call');
    return typeof next==='function'?next(options):next;
  };
  return {calls,device:new DeviceCheckService({env:{...env,...overrides},fetchFn,now,timeoutMs})};
}
const prod='https://api.devicecheck.apple.com',dev='https://api.development.devicecheck.apple.com';

test('unconfigured is a distinct state that never calls Apple',async()=>{
  for(const missing of ['LYRICA_DEVICECHECK_KEY_ID','LYRICA_DEVICECHECK_PRIVATE_KEY','LYRICA_APNS_TEAM_ID']){
    const {device,calls}=service({overrides:{[missing]:undefined}});
    assert.equal(device.configured,false);assert.equal(deviceCheckConfiguration({...env,[missing]:''}),null);
    await assert.rejects(device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),e=>e instanceof DeviceCheckError&&e.reason==='unconfigured');
    assert.equal(calls.length,0);
  }
  assert.equal(service().device.configured,true);
  assert.equal(new DeviceCheckService({env}).timeoutMs,3000);
});

test('ES256 provider JWT uses the APNs team ID, is cached and renewed within 50 minutes',async()=>{
  let time=T0;
  const {device,calls}=service({now:()=>time,responses:Array.from({length:4},()=>reply(200,'Bit State Not Found'))});
  await device.query(token,{bundleID:'com.hongkuntian.Lyrica'});
  const [header,payload,signature]=calls[0].jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header,'base64url')),{alg:'ES256',kid:'ABCDE12345'});
  assert.deepEqual(JSON.parse(Buffer.from(payload,'base64url')),{iss:'9ESZX68J8U',iat:Math.floor(T0/1000)});
  assert.equal(verify('sha256',Buffer.from(header+'.'+payload),{key:createPublicKey(signing.privateKey),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),true);
  time=T0+50*60*1000-1;await device.query(token,{bundleID:'com.hongkuntian.Lyrica'});
  assert.equal(calls[1].jwt,calls[0].jwt);
  time=T0+50*60*1000;await device.query(token,{bundleID:'com.hongkuntian.Lyrica'});
  assert.notEqual(calls[2].jwt,calls[0].jwt);
  assert.equal(JSON.parse(Buffer.from(calls[2].jwt.split('.')[1],'base64url')).iat,Math.floor(time/1000));
});

test('a malformed key is a configured-but-failing state',async()=>{
  const {device,calls}=service({overrides:{LYRICA_DEVICECHECK_PRIVATE_KEY:'not a key'}});
  assert.equal(device.configured,true);
  await assert.rejects(device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),e=>e.reason==='invalid_key');
  assert.equal(calls.length,0);
});

test('the Debug bundle asks the development host first and every other bundle production first',async()=>{
  const {device,calls}=service({responses:[reply(200,JSON.stringify({bit0:true,bit1:false,last_update_time:'2026-11'})),
    reply(200,'Failed to find bit state'),reply(200,''),reply(200,'')]});
  assert.deepEqual(await device.query(token,{bundleID:'com.hongkuntian.Lyrica.Debug'}),{bit0:true,bit1:false,lastUpdateTime:'2026-11'});
  assert.deepEqual(await device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),{bit0:false,bit1:false,lastUpdateTime:null});
  await device.setBit(token,{bundleID:'com.hongkuntian.Lyrica',bit:0});
  await device.setBit(token,{bundleID:'com.hongkuntian.Lyrica.Debug',bit:1});
  assert.deepEqual(calls.map(c=>c.url),[dev+'/v1/query_two_bits',prod+'/v1/query_two_bits',prod+'/v1/update_two_bits',dev+'/v1/update_two_bits']);
  for(const call of calls){
    assert.equal(call.options.method,'POST');assert.equal(call.options.headers['content-type'],'application/json');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.body.device_token,token);assert.equal(call.body.timestamp,T0);
    assert.match(call.body.transaction_id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  assert.deepEqual(Object.keys(calls[0].body).sort(),['device_token','timestamp','transaction_id']);
  // Updates set exactly one bit; Apple leaves the other unchanged.
  assert.equal(calls[2].body.bit0,true);assert.equal('bit1' in calls[2].body,false);
  assert.equal(calls[3].body.bit1,true);assert.equal('bit0' in calls[3].body,false);
  await assert.rejects(device.setBit(token,{bundleID:'com.hongkuntian.Lyrica',bit:2}),e=>e.reason==='invalid_bit');
});

test("both wordings of Apple's no-state answer mean both bits are false",async()=>{
  for(const text of ['Failed to find bit state','Bit State Not Found','failed to find bit state\n','Bit State Not Found.']){
    const {device}=service({responses:[reply(200,text)]});
    assert.deepEqual(await device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),{bit0:false,bit1:false,lastUpdateTime:null},text);
  }
  const {device}=service({responses:[reply(200,'Failed to find bit state for this device and something else')]});
  await assert.rejects(device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),e=>e.reason==='malformed_response');
});

test('a 400 with any text retries exactly once on the other host; nothing else retries',async()=>{
  const bad=()=>reply(400,'anything at all');
  let f=service({responses:[bad(),reply(200,JSON.stringify({bit0:false,bit1:true,last_update_time:'2026-10'}))]});
  assert.deepEqual(await f.device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),{bit0:false,bit1:true,lastUpdateTime:'2026-10'});
  assert.deepEqual(f.calls.map(c=>c.url),[prod+'/v1/query_two_bits',dev+'/v1/query_two_bits']);
  assert.notEqual(f.calls[0].body.transaction_id,f.calls[1].body.transaction_id);
  f=service({responses:[bad(),bad()]});
  await assert.rejects(f.device.setBit(token,{bundleID:'com.hongkuntian.Lyrica.Debug',bit:0}),e=>e.kind==='rejected'&&e.reason==='status_400');
  assert.deepEqual(f.calls.map(c=>c.url),[dev+'/v1/update_two_bits',prod+'/v1/update_two_bits']);
  for(const status of [401,403,404,413,429,500,503]){
    f=service({responses:[reply(status,'Missing or incorrectly formatted device token payload')]});
    await assert.rejects(f.device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),e=>e.reason==='status_'+status);
    assert.equal(f.calls.length,1,String(status));
  }
});

// Classified by status code only; response text never changes the class.
for(const [label,statuses,kind] of [
  ['token rejected: any 4xx except 401, 403 and 429',[400,404,410,413,422,499],'rejected'],
  ['our key or configuration refused: 401 and 403',[401,403],'credentials'],
  ['outage: 429, 5xx and unexpected statuses',[429,500,502,503,504,302,204],'unavailable']])
test('answer class '+label,async()=>{
  for(const status of statuses)for(const text of ['','Missing or incorrectly formatted device token payload','Unable to verify authorization token']){
    for(const operation of ['query','setBit']){
      const f=service({responses:[reply(status,text),reply(status,text)]});
      const call=operation==='query'?f.device.query(token,{bundleID:'com.hongkuntian.Lyrica'}):f.device.setBit(token,{bundleID:'com.hongkuntian.Lyrica',bit:0});
      await assert.rejects(call,e=>e instanceof DeviceCheckError&&e.kind===kind&&e.reason==='status_'+status,`${operation} ${status} ${text}`);
    }
  }
});

test('a refused key drops the cached JWT so the next call signs a fresh one',async()=>{
  let time=T0;
  const {device,calls}=service({now:()=>time,responses:[reply(401),reply(200,'Failed to find bit state')]});
  await assert.rejects(device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),e=>e.kind==='credentials');
  time+=1000;await device.query(token,{bundleID:'com.hongkuntian.Lyrica'});
  assert.notEqual(calls[1].jwt,calls[0].jwt);
});

test('malformed answers, a malformed key and a locally invalid token are classified',async()=>{
  for(const text of ['{"bit0":"yes"}','<html>']){
    const f=service({responses:[reply(200,text)]});
    await assert.rejects(f.device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),e=>e.kind==='unavailable'&&e.reason==='malformed_response');
  }
  const broken=service({overrides:{LYRICA_DEVICECHECK_PRIVATE_KEY:'not a key'}});
  await assert.rejects(broken.device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),e=>e.kind==='credentials'&&e.reason==='invalid_key');
  const local=service();
  await assert.rejects(local.device.query('not base64!',{bundleID:'com.hongkuntian.Lyrica'}),e=>e.kind==='rejected'&&e.reason==='invalid_token');
  assert.equal(local.calls.length+broken.calls.length,0);
});

test('each call is bounded by its own timeout and network failures are failures, not unconfigured',async()=>{
  const hang=options=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason)));
  let f=service({timeoutMs:20,responses:[hang]});
  await assert.rejects(f.device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),e=>e instanceof DeviceCheckError&&e.reason==='timeout'&&e.kind==='unavailable');
  assert.equal(f.calls.length,1);
  f=service({responses:[()=>{throw new TypeError('fetch failed');}]});
  await assert.rejects(f.device.query(token,{bundleID:'com.hongkuntian.Lyrica'}),e=>e.reason==='network'&&e.kind==='unavailable');
});

test('device tokens and JWTs never appear in an error',async()=>{
  const {device,calls}=service({responses:[reply(400,'Missing or incorrectly formatted device token payload '+token),reply(400,'bad device token')]});
  const error=await device.query(token,{bundleID:'com.hongkuntian.Lyrica'}).catch(e=>e);
  const exposed=JSON.stringify({message:error.message,reason:error.reason,stack:error.stack,...error});
  for(const secret of [token,calls[0].jwt])assert.equal(exposed.includes(secret),false);
  assert.equal(error.message,'devicecheck_unavailable');
  await assert.rejects(device.query('not base64!',{bundleID:'com.hongkuntian.Lyrica'}),e=>e.reason==='invalid_token');
  assert.equal(validDeviceToken('A'.repeat(4096)),true);assert.equal(validDeviceToken('A'.repeat(4100)),false);
  assert.equal(validDeviceToken(''),false);assert.equal(validDeviceToken(42),false);
});

test('recent bit 0 means the current or previous UTC month',()=>{
  const now=Date.UTC(2026,10,1,0,0,0);
  assert.equal(recentlyUpdated('2026-11',now),true);
  assert.equal(recentlyUpdated('2026-10',now),true);
  assert.equal(recentlyUpdated('2026-09',now),false);
  assert.equal(recentlyUpdated('2026-12',now),false);
  assert.equal(recentlyUpdated('2025-11',now),false);
  // January's previous month is last year's December; the boundary is UTC.
  assert.equal(recentlyUpdated('2025-12',Date.UTC(2026,0,1,0,0,0)),true);
  assert.equal(recentlyUpdated('2025-11',Date.UTC(2026,0,31,23,59,59)),false);
  assert.equal(recentlyUpdated('2026-10',Date.UTC(2026,10,30,23,59,59,999)),true);
  assert.equal(recentlyUpdated('2026-10',Date.UTC(2026,11,1)),false);
  for(const malformed of [null,undefined,'2026-1','2026/11',''])assert.equal(recentlyUpdated(malformed,now),false);
});

test('the private key is accepted as real multi-line PEM or with escaped newlines, as for APNs',async()=>{
  const pem=env.LYRICA_DEVICECHECK_PRIVATE_KEY;
  assert.ok(pem.includes('\n-----END PRIVATE KEY-----'));
  for(const privateKey of [pem,pem.trim().replace(/\n/g,'\\n')]){
    const {device,calls}=service({overrides:{LYRICA_DEVICECHECK_PRIVATE_KEY:privateKey},responses:[reply(200,'Bit State Not Found')]});
    await device.query(token,{bundleID:'com.hongkuntian.Lyrica'});
    const [header,payload,signature]=calls[0].jwt.split('.');
    assert.equal(verify('sha256',Buffer.from(header+'.'+payload),{key:createPublicKey(signing.privateKey),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),true);
  }
});
