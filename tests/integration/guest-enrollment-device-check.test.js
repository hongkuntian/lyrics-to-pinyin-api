import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {libraryDB} from '../helpers/library-db.js';
import {AccountStore} from '../../api/utils/membership/accounts.js';
import {MembershipStore,admitLibraryTranslation} from '../../api/utils/membership/store.js';
import {createAccountHandler} from '../../api/account.js';
import {createMockRes} from '../helpers/mock-http.js';
import {mockDeviceCheck,captureLogger,bits,notFound,reply,deviceToken} from '../helpers/device-check.js';

// Contract: Lyrica docs/ANONYMOUS_ACCOUNTS.md, "Enrollment and DeviceCheck".
const policy={audience:'test',environment:'production',prefix:'9ESZX68J8U',bundles:['com.hongkuntian.Lyrica','com.hongkuntian.Lyrica.Debug']};
const bundleID=policy.bundles[0];
const NOW=Date.UTC(2026,10,17,12); // November 2026 (UTC)

async function fixture(t,{configured=true,respond,timeoutMs}={}) {
  const f=await libraryDB();t.after(()=>f.db.close());
  await f.db.query('UPDATE membership_settings SET public_access_enabled=true');
  const events=[],mock=mockDeviceCheck({configured,now:()=>NOW,timeoutMs,respond:(call,options)=>{
    events.push('apple:'+call.path);return (respond??(()=>notFound()))(call,options);
  }});
  const log=captureLogger(),raw=f.store.db;
  // Records transaction boundaries next to Apple calls; never alters SQL.
  const db={query:(...args)=>raw.query(...args),transaction:fn=>{
    events.push('BEGIN');
    return raw.transaction(fn).then(value=>{events.push('COMMIT');return value;},error=>{events.push('ROLLBACK');throw error;});
  }};
  const accounts=new AccountStore(db,{policy,deviceCheck:mock.device,logger:log.logger,now:()=>NOW,
    attestFn:()=>({publicKey:'proof',receipt:Buffer.from('receipt')})});
  return {...f,accounts,mock,log,events,members:new MembershipStore(raw,{now:()=>new Date()})};
}
let seed=1;
async function enroll(f,{token,bundle=bundleID}={}) {
  const keyID=Buffer.alloc(32,seed).toString('base64'),address='10.0.0.'+seed++;
  const nonce=await f.accounts.challenge({purpose:'guest',bundleID:bundle,keyID},address);
  const body={bundleID:bundle,keyID,...nonce,credential:'lyrica_g_'+randomBytes(32).toString('base64url'),attestation:'cHJvb2Y=',
    ...(token===undefined?{}:{deviceToken:token})};
  assert.deepEqual(await f.accounts.guest(body),{registered:true});
  const user=(await f.db.query(`SELECT u.*,(u.free_allowance_held_until-u.created_at)=interval '7 days' AS seven_days
    FROM library_users u JOIN app_attest_keys k ON k.user_id=u.id WHERE k.key_id=$1`,[keyID])).rows[0];
  return {body,user};
}
const warnings=f=>f.log.events.filter(e=>e.level==='warn').map(e=>e.value);
const noTokenLogged=f=>assert.equal(JSON.stringify(f.log.events).includes(deviceToken),false,'device token must never be logged');

test('a new device without a recent bit 0 enrolls unheld, then bit 0 is set after the commit',async t=>{
  const f=await fixture(t),{user}=await enroll(f,{token:deviceToken});
  assert.equal(user.access_kind,'guest');assert.equal(user.free_allowance_held_until,null);
  // Query before the transaction; mark only after the account exists.
  assert.deepEqual(f.events,['apple:/v1/query_two_bits','BEGIN','COMMIT','apple:/v1/update_two_bits']);
  assert.deepEqual(f.mock.calls.map(c=>c.host),['api.devicecheck.apple.com','api.devicecheck.apple.com']);
  assert.equal(f.mock.calls[1].body.bit0,true);assert.equal('bit1' in f.mock.calls[1].body,false);
  assert.equal((await f.members.snapshot(user.id)).libraryTranslations.remaining,3);
  assert.deepEqual(warnings(f),[]);noTokenLogged(f);
});

test('the Debug bundle consults the development host first',async t=>{
  const f=await fixture(t);await enroll(f,{token:deviceToken,bundle:'com.hongkuntian.Lyrica.Debug'});
  assert.deepEqual(f.mock.calls.map(c=>c.host),['api.development.devicecheck.apple.com','api.development.devicecheck.apple.com']);
});

for(const [label,lastUpdateTime,held] of [['current UTC month','2026-11',true],['previous UTC month','2026-10',true],
  ['two months earlier','2026-09',false],['the same month last year','2025-11',false]])
test('bit 0 updated in the '+label+(held?' holds':' does not hold')+' the new free allowance',async t=>{
  const f=await fixture(t,{respond:({path})=>path==='/v1/query_two_bits'?bits(true,false,lastUpdateTime):reply(200)});
  const {user}=await enroll(f,{token:deviceToken});
  if(held) {
    assert.equal(user.seven_days,true);
    const library=(await f.members.snapshot(user.id)).libraryTranslations;
    assert.deepEqual(library,{unlimited:false,limit:3,used:0,remaining:0,nextAvailableAt:new Date(user.free_allowance_held_until).toISOString()});
    await assert.rejects(admitLibraryTranslation(f.store.db,user.id,'song',{unlock:true}),{code:'library_translation_limit',status:403});
    assert.equal(await admitLibraryTranslation(f.store.db,user.id,'song'),'locked');
    // The hold ends on its own; the ordinary weekly allowance then applies.
    await f.db.query("UPDATE library_users SET free_allowance_held_until=now()-interval '1 second' WHERE id=$1",[user.id]);
    assert.equal((await f.members.snapshot(user.id)).libraryTranslations.remaining,3);
    assert.equal(await admitLibraryTranslation(f.store.db,user.id,'song',{unlock:true}),'open');
  } else assert.equal(user.free_allowance_held_until,null);
  // Either way bit 0 is refreshed, which also refreshes last_update_time.
  assert.deepEqual(f.mock.calls.map(c=>c.path),['/v1/query_two_bits','/v1/update_two_bits']);
});

test('a recent update of bit 1 alone never holds enrollment',async t=>{
  const f=await fixture(t,{respond:({path})=>path==='/v1/query_two_bits'?bits(false,true,'2026-11'):reply(200)});
  assert.equal((await enroll(f,{token:deviceToken})).user.free_allowance_held_until,null);
});

test('configured DeviceCheck with no device token holds without calling Apple',async t=>{
  const f=await fixture(t),{user}=await enroll(f);
  assert.equal(user.seven_days,true);assert.equal(f.mock.calls.length,0);
  assert.equal((await f.members.snapshot(user.id)).libraryTranslations.remaining,0);
});

for(const token of [undefined,deviceToken])
test('unconfigured DeviceCheck never holds and never calls Apple '+(token?'with':'without')+' a token',async t=>{
  const f=await fixture(t,{configured:false}),{user}=await enroll(f,{token});
  assert.equal(user.free_allowance_held_until,null);assert.equal(f.mock.calls.length,0);
  assert.deepEqual(warnings(f),[{event:'devicecheck_unavailable',stage:'enrollment',reason:'unconfigured'}]);
  assert.deepEqual(f.events,['BEGIN','COMMIT']);noTokenLogged(f);
});

const errors=f=>f.log.events.filter(e=>e.level==='error').map(e=>e.value);
for(const [label,respond,reason,timeoutMs] of [
  ['server error',()=>reply(500),'status_500'],
  ['rate limited',()=>reply(429),'status_429'],
  ['network',()=>{throw new TypeError('fetch failed');},'network'],
  ['timeout',(_,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason))),'timeout',20],
  ['malformed answer',()=>reply(200,'{"bit0":1}'),'malformed_response']])
test('failing DeviceCheck ('+label+') enrolls without a hold or mark and logs devicecheck_unavailable',async t=>{
  const f=await fixture(t,{respond,timeoutMs}),{user}=await enroll(f,{token:deviceToken});
  assert.equal(user.free_allowance_held_until,null);
  assert.equal(f.mock.calls.some(c=>c.path==='/v1/update_two_bits'),false);
  assert.deepEqual(warnings(f),[{event:'devicecheck_unavailable',stage:'enrollment',reason}]);
  assert.deepEqual(errors(f),[]);noTokenLogged(f);
});

for(const status of [401,403])
test('a refused DeviceCheck key ('+status+') enrolls without a hold and logs at error level',async t=>{
  const f=await fixture(t,{respond:()=>reply(status,'Unable to verify authorization token')}),{user}=await enroll(f,{token:deviceToken});
  assert.equal(user.free_allowance_held_until,null);
  assert.deepEqual(f.mock.calls.map(c=>c.path),['/v1/query_two_bits']);
  assert.deepEqual(errors(f),[{event:'devicecheck_unavailable',stage:'enrollment',reason:'status_'+status}]);
  assert.deepEqual(warnings(f),[]);noTokenLogged(f);
});

for(const [status,text,calls] of [[400,'Missing or incorrectly formatted device token payload',2],[400,'',2],[413,'Payload Too Large',1],[404,'',1]])
test('a device token Apple rejects ('+status+(text?' '+text:'')+') counts as no token and holds',async t=>{
  const f=await fixture(t,{respond:()=>reply(status,text)});
  const {user}=await enroll(f,{token:Buffer.from('made-up').toString('base64')});
  assert.equal(user.seven_days,true);
  assert.deepEqual(f.mock.calls.map(c=>c.host),['api.devicecheck.apple.com','api.development.devicecheck.apple.com'].slice(0,calls));
  assert.equal(f.mock.calls.some(c=>c.path==='/v1/update_two_bits'),false);
  assert.deepEqual(warnings(f),[]);assert.deepEqual(errors(f),[]);
});

test('a failed mark after commit keeps the account and is only logged',async t=>{
  const f=await fixture(t,{respond:({path})=>path==='/v1/query_two_bits'?notFound():reply(503)}),{user}=await enroll(f,{token:deviceToken});
  assert.equal(user.disabled,false);assert.equal(user.free_allowance_held_until,null);
  assert.deepEqual(warnings(f),[{event:'devicecheck_unavailable',stage:'enrollment_mark',reason:'status_503'}]);
});

test('a retry ACK or a refused enrollment never marks the device',async t=>{
  const f=await fixture(t),{body}=await enroll(f,{token:deviceToken});
  f.mock.calls.length=0;f.events.length=0;
  assert.deepEqual(await f.accounts.guest(body),{registered:true});
  assert.equal(f.mock.calls.length,0,'a retry is not a new account');
  assert.deepEqual(f.events,['BEGIN','COMMIT']);f.events.length=0;
  // A key that already belongs to another account is refused inside the transaction.
  const nonce=await f.accounts.challenge({purpose:'guest',bundleID,keyID:body.keyID},'10.9.9.9');
  await assert.rejects(f.accounts.guest({...body,...nonce,credential:'lyrica_g_'+randomBytes(32).toString('base64url')}),{code:'app_access_revoked'});
  assert.deepEqual(f.events,['apple:/v1/query_two_bits','BEGIN','ROLLBACK']);
  assert.equal(f.mock.calls.some(c=>c.path==='/v1/update_two_bits'),false);
});

test('account HTTP accepts an optional base64 deviceToken of at most 4096 characters',async t=>{
  const f=await fixture(t),handler=createAccountHandler({store:f.accounts});
  const keyID=Buffer.alloc(32,200).toString('base64');
  const call=async body=>{const res=createMockRes();await handler({method:'POST',headers:{},body,socket:{remoteAddress:'10.1.1.1'}},res);return res;};
  const challenge=await call({action:'challenge',purpose:'guest',bundleID,keyID});
  assert.equal(challenge.statusCode,200);
  const body={action:'guest',bundleID,keyID,challenge:challenge.body.challenge,credential:'lyrica_g_'+randomBytes(32).toString('base64url'),attestation:'cHJvb2Y='};
  for(const invalid of ['not base64!','A'.repeat(4100),'',42,null])
    assert.equal((await call({...body,deviceToken:invalid})).statusCode,400);
  assert.equal(f.mock.calls.length,0);
  const accepted=await call({...body,deviceToken});
  assert.equal(accepted.statusCode,200);assert.deepEqual(accepted.body,{version:1,registered:true});
  assert.equal(f.mock.calls[0].body.device_token,deviceToken);
});
