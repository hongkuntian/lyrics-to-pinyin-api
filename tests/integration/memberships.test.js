import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {libraryDB,source} from '../helpers/library-db.js';
import {MembershipStore,reserveMemberUsage,settleMemberUsage,admitMemberRelay,admitLibraryTranslation} from '../../api/utils/membership/store.js';
import {mockDeviceCheck,captureLogger,bits,notFound,reply,deviceToken} from '../helpers/device-check.js';

// Contract: Lyrica docs/ANONYMOUS_ACCOUNTS.md, "Membership and purchases" and
// "Live Lyrics relay". reader-a and reader-b are anonymous (guest) accounts.
async function fixture(t,{deviceCheck={configured:false},relayAccess='members'}={}) {
  const {db,store}=await libraryDB();t.after(()=>db.close());
  await db.query("UPDATE library_users SET access_kind='guest' WHERE id IN ('reader-a','reader-b')");
  await db.query('UPDATE membership_settings SET relay_access=$1',[relayAccess]);
  const tokens=Object.fromEntries((await db.query("SELECT id,app_account_token FROM library_users WHERE id IN ('reader-a','reader-b')")).rows.map(r=>[r.id,r.app_account_token]));
  const mock=mockDeviceCheck(deviceCheck),log=captureLogger();
  return {db,store,member:new MembershipStore(store.db,{deviceCheck:mock.device,logger:log.logger}),appToken:tokens['reader-a'],tokens,mock,log};
}
let originals=1000;
const transaction=(token,overrides={})=>({originalID:String(originals++),transactionID:String(originals++),productID:'com.hongkuntian.Lyrica.pro.annual',
  tier:'pro',environment:'Production',appAccountToken:token,starts:new Date(Date.now()-86400000),expires:new Date(Date.now()+300*86400000),
  signedAt:new Date(),revoked:false,...overrides});
const owner=async(db,value)=>(await db.query('SELECT user_id FROM membership_subscriptions WHERE original_transaction_id=$1',[value.originalID])).rows[0]?.user_id;
const mismatch=e=>e.code==='purchase_account_mismatch'&&e.status===403;

test('free accounts cannot generate; a guest without membership needs one, never a sign-in',async t=>{
  const {db,member}=await fixture(t);
  const snapshot=await member.snapshot('reader-a');
  assert.equal(snapshot.allowances.translation.remaining,0);assert.equal(snapshot.allowances.study.remaining,0);
  assert.equal(snapshot.starter,undefined);assert.equal(snapshot.tier,'free');
  assert.deepEqual(snapshot.libraryTranslations,{unlimited:false,limit:3,used:0,remaining:3,nextAvailableAt:null});
  assert.equal(member.claimStarter,undefined);
  for(const kind of ['translation','study'])
    await assert.rejects(db.transaction(tx=>reserveMemberUsage(tx,'reader-b',randomUUID(),kind)),e=>e.code==='membership_required'&&e.status===403);
  await db.query("UPDATE library_users SET access_kind='beta' WHERE id='reader-b'");
  await db.transaction(tx=>reserveMemberUsage(tx,'reader-b',randomUUID(),'study'));
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM membership_grants')).rows[0].n),0);
});

test('every account has its own appAccountToken in the snapshot',async t=>{
  const {member,tokens}=await fixture(t);
  const a=await member.snapshot('reader-a'),b=await member.snapshot('reader-b');
  assert.equal(a.account.appAccountToken,tokens['reader-a']);assert.equal(b.account.appAccountToken,tokens['reader-b']);
  assert.notEqual(a.account.appAccountToken,b.account.appAccountToken);
  assert.deepEqual([a.account.kind,b.account.kind],['guest','guest']);
});

test('reservations enforce each allowance; repeat operations and failed work never double debit',async t=>{
  const {db,member,appToken}=await fixture(t);await member.recordTransaction('reader-a',transaction(appToken));
  const a=randomUUID(),b=randomUUID(),c=randomUUID();
  const reserve=id=>db.transaction(tx=>reserveMemberUsage(tx,'reader-a',id,'translation'));
  await Promise.all([reserve(a),reserve(a),reserve(b)]);
  await db.query("UPDATE membership_grants SET allowance=2 WHERE kind='translation'");
  await assert.rejects(reserve(c),e=>e.code==='membership_allowance_exhausted');
  await settleMemberUsage(db,a,false);await settleMemberUsage(db,a,false);
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,1);
  await reserve(c);await settleMemberUsage(db,c,true);await settleMemberUsage(db,c,false);
  assert.equal((await member.snapshot('reader-a')).allowances.translation.used,2);
  await db.transaction(tx=>reserveMemberUsage(tx,'reader-a',randomUUID(),'study'));
  assert.equal((await member.snapshot('reader-a')).allowances.study.remaining,79);
});

test('free accounts open three new library translations per rolling week and keep opened songs',async t=>{
  const {db,member,appToken}=await fixture(t);
  const admit=(user,doc,unlock=false)=>admitLibraryTranslation(db,user,doc,{unlock});
  assert.equal(await admit('reader-a','doc-1'),'locked');
  assert.equal((await member.snapshot('reader-a')).libraryTranslations.remaining,3);
  await Promise.all([admit('reader-a','doc-1',true),admit('reader-a','doc-1',true)]);
  assert.equal(await admit('reader-a','doc-1'),'open');
  assert.equal(await admit('reader-a','doc-2',true),'open');assert.equal(await admit('reader-a','doc-3',true),'open');
  let snapshot=(await member.snapshot('reader-a')).libraryTranslations;
  assert.equal(snapshot.used,3);assert.equal(snapshot.remaining,0);assert.ok(new Date(snapshot.nextAvailableAt)>new Date());
  await assert.rejects(admit('reader-a','doc-4',true),e=>e.code==='library_translation_limit'&&e.status===403);
  assert.equal(await admit('reader-a','doc-4'),'locked');
  assert.equal(await admit('reader-a','doc-2',true),'open');
  await db.query("UPDATE membership_usage SET created_at=now()-interval '8 days' WHERE operation_id=(SELECT operation_id FROM membership_usage ORDER BY created_at LIMIT 1)");
  snapshot=(await member.snapshot('reader-a')).libraryTranslations;
  assert.equal(snapshot.remaining,1);assert.equal(snapshot.nextAvailableAt,null);
  assert.equal(await admit('reader-a','doc-1'),'open');
  assert.equal(await admit('reader-a','doc-4',true),'open');
  assert.equal(await admit('reader-b','doc-1'),'locked');assert.equal(await admit('reader-b','doc-1',true),'open');
  await member.recordTransaction('reader-a',transaction(appToken));
  assert.equal(await admit('reader-a','doc-9'),'open');
  assert.equal((await member.snapshot('reader-a')).libraryTranslations.unlimited,true);
  await db.query("UPDATE library_users SET access_kind='beta' WHERE id='reader-b'");
  assert.equal(await admit('reader-b','doc-8'),'open');
});

test('a held free allowance reports nothing remaining until the hold ends; membership still opens songs',async t=>{
  const {db,member,appToken}=await fixture(t);
  const end=(await db.query("UPDATE library_users SET free_allowance_held_until=now()+interval '7 days' WHERE id='reader-a' RETURNING free_allowance_held_until AS at")).rows[0].at;
  assert.deepEqual((await member.snapshot('reader-a')).libraryTranslations,{unlimited:false,limit:3,used:0,remaining:0,nextAvailableAt:new Date(end).toISOString()});
  await assert.rejects(admitLibraryTranslation(db,'reader-a','doc-1',{unlock:true}),e=>e.code==='library_translation_limit');
  await member.recordTransaction('reader-a',transaction(appToken));
  assert.equal(await admitLibraryTranslation(db,'reader-a','doc-1'),'open');
});

test('verified purchases keep their newest state; old restore data cannot reverse revocation',async t=>{
  const {db,member,appToken}=await fixture(t),value=transaction(appToken);
  let snapshot=await member.recordTransaction('reader-a',value);
  assert.equal(snapshot.tier,'pro');assert.equal(snapshot.allowances.translation.remaining,20);assert.equal(snapshot.allowances.study.remaining,80);
  const a=randomUUID();await db.transaction(tx=>reserveMemberUsage(tx,'reader-a',a,'translation'));
  snapshot=await member.snapshot('reader-a');assert.equal(snapshot.allowances.translation.remaining,19);
  assert.ok(new Date(snapshot.allowances.translation.resetsAt)<value.expires);
  await member.recordTransaction('reader-a',{...value,revoked:true,signedAt:new Date(+value.signedAt+1000)});
  await member.recordTransaction('reader-a',value);
  await member.recordTransaction('reader-a',value,{restore:true});
  assert.equal((await member.snapshot('reader-a')).tier,'free');
  await assert.rejects(db.transaction(tx=>reserveMemberUsage(tx,'reader-a',randomUUID(),'study')),e=>e.code==='membership_required');
});

test('a first purchase is recorded when its token is this account, absent, or no current account; never another current account without Restore',async t=>{
  const {db,member,tokens}=await fixture(t);
  const own=transaction(tokens['reader-a']);await member.recordTransaction('reader-a',own);
  assert.equal(await owner(db,own),'reader-a');
  const offerCode=transaction(null);await member.recordTransaction('reader-a',offerCode);
  assert.equal(await owner(db,offerCode),'reader-a');
  assert.equal((await db.query('SELECT app_account_token FROM membership_subscriptions WHERE original_transaction_id=$1',[offerCode.originalID])).rows[0].app_account_token,null);
  const unknown=transaction(randomUUID());await member.recordTransaction('reader-b',unknown);
  assert.equal(await owner(db,unknown),'reader-b');
  // A deleted (disabled) account is not a current account.
  await db.query("INSERT INTO library_users(id,access_kind,disabled) VALUES('deleted-guest','guest',true)");
  const deletedToken=(await db.query("SELECT app_account_token FROM library_users WHERE id='deleted-guest'")).rows[0].app_account_token;
  const orphan=transaction(deletedToken);await member.recordTransaction('reader-b',orphan);
  assert.equal(await owner(db,orphan),'reader-b');
  // Another current account's purchase needs Restore on this device.
  const others=transaction(tokens['reader-b']);
  await assert.rejects(member.recordTransaction('reader-a',others),mismatch);
  assert.equal(await owner(db,others),undefined);
  await member.recordTransaction('reader-a',others,{restore:true});
  assert.equal(await owner(db,others),'reader-a');
});

test('a purchase recorded for another account moves only with Restore and keeps its spent allowance',async t=>{
  const {db,member,tokens}=await fixture(t),value=transaction(tokens['reader-a']);
  await member.recordTransaction('reader-a',value);
  for(let n=0;n<5;n++)await db.transaction(tx=>reserveMemberUsage(tx,'reader-a',randomUUID(),'translation'));
  // The automatic entitlement sync on another account never moves it.
  await assert.rejects(member.recordTransaction('reader-b',value),mismatch);
  await assert.rejects(member.recordTransaction('reader-b',{...value,signedAt:new Date(+value.signedAt+1000)}),mismatch);
  assert.equal(await owner(db,value),'reader-a');
  const moved=await member.recordTransaction('reader-b',value,{restore:true});
  assert.equal(await owner(db,value),'reader-b');assert.equal(moved.tier,'pro');
  // The period's allowance belongs to the subscription: moving never refills it.
  assert.equal(moved.allowances.translation.remaining,15);
  await db.transaction(tx=>reserveMemberUsage(tx,'reader-b',randomUUID(),'translation'));
  assert.equal((await member.snapshot('reader-b')).allowances.translation.remaining,14);
  assert.equal((await member.snapshot('reader-a')).tier,'free');
  await assert.rejects(db.transaction(tx=>reserveMemberUsage(tx,'reader-a',randomUUID(),'translation')),e=>e.code==='membership_required');
  // And back again with Restore, still sharing the same period allowance.
  assert.equal((await member.recordTransaction('reader-a',value,{restore:true})).allowances.translation.remaining,14);
});

test('Restore moves ownership but stale signed data never overwrites newer state, and environments never mix',async t=>{
  const {db,member,tokens}=await fixture(t),value=transaction(tokens['reader-a']);
  await member.recordTransaction('reader-a',{...value,revoked:true,signedAt:new Date(+value.signedAt+5000)});
  await member.recordTransaction('reader-b',value,{restore:true});
  assert.equal(await owner(db,value),'reader-b');
  assert.equal((await db.query('SELECT revoked FROM membership_subscriptions WHERE original_transaction_id=$1',[value.originalID])).rows[0].revoked,true);
  await assert.rejects(member.recordTransaction('reader-a',{...value,environment:'Sandbox'},{restore:true}),mismatch);
  assert.equal(await owner(db,value),'reader-b');
});

test('notifications find the owner by original transaction first, then by appAccountToken, and never move a purchase',async t=>{
  const {db,member,tokens}=await fixture(t);
  // Not yet recorded: the token's account receives it.
  const first=transaction(tokens['reader-b']);
  await member.applyNotification('n-1',first);
  assert.equal(await owner(db,first),'reader-b');
  // Restored onto reader-a: later notifications follow the recorded owner,
  // even though the purchase still carries reader-b's token.
  await member.recordTransaction('reader-a',first,{restore:true});
  const renewal={...first,transactionID:'renewal',signedAt:new Date(+first.signedAt+1000)};
  await member.applyNotification('n-2',renewal);
  assert.equal(await owner(db,first),'reader-a');
  assert.equal((await db.query('SELECT transaction_id FROM membership_subscriptions WHERE original_transaction_id=$1',[first.originalID])).rows[0].transaction_id,'renewal');
  // No recorded owner and no account with the token (or no token): Apple retries later.
  for(const [id,value] of [['n-3',transaction(randomUUID())],['n-4',transaction(null)]]) {
    await assert.rejects(member.applyNotification(id,value),e=>e.code==='purchase_account_not_found'&&e.status===409);
    assert.equal(await owner(db,value),undefined);
  }
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM membership_notifications')).rows[0].n),2);
});

test('signed refund notifications remain effective while an account is deleted',async t=>{
  const {db,member,appToken}=await fixture(t),value=transaction(appToken);
  await member.recordTransaction('reader-a',value);
  await db.query("UPDATE library_users SET disabled=true WHERE id='reader-a'");
  const refund={...value,revoked:true,signedAt:new Date(+value.signedAt+1000)};
  await member.applyNotification('refund',refund);await member.applyNotification('refund',refund);
  assert.equal((await db.query("SELECT revoked FROM membership_subscriptions WHERE user_id='reader-a'")).rows[0].revoked,true);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM membership_notifications')).rows[0].n),1);
  // A deleted account's unrecorded purchase still finds it by token.
  const late=transaction(appToken);await member.applyNotification('late',late);
  assert.equal(await owner(db,late),'reader-a');
  await db.query("UPDATE library_users SET disabled=false WHERE id='reader-a'");
  await member.recordTransaction('reader-a',value);
  assert.equal((await member.snapshot('reader-a')).tier,'pro');
});

test('liveLyricsIncluded and preview.available follow live_enabled, account kind, membership and relay_access',async t=>{
  const {db,member,appToken}=await fixture(t);
  const state=async user=>{const s=await member.snapshot(user);return [s.liveLyricsIncluded,s.preview.available];};
  assert.deepEqual(await state('reader-a'),[false,false],'Live Lyrics disabled');
  await db.query('UPDATE membership_settings SET live_enabled=true');
  assert.deepEqual(await state('reader-a'),[false,true],'members mode, free guest');
  await db.query("UPDATE membership_settings SET relay_access='everyone'");
  assert.deepEqual(await state('reader-a'),[true,false],'everyone');
  await db.query("UPDATE membership_settings SET relay_access='members'");
  await member.recordTransaction('reader-a',transaction(appToken));
  assert.deepEqual(await state('reader-a'),[true,false],'member');
  await db.query("UPDATE library_users SET unlimited_generation=true WHERE id='reader-b'");
  assert.deepEqual(await state('reader-b'),[true,false],'unlimited');
  await db.query("UPDATE library_users SET unlimited_generation=false,access_kind='beta' WHERE id='reader-b'");
  assert.deepEqual(await state('reader-b'),[true,false],'beta');
  await db.query("UPDATE library_users SET access_kind='guest' WHERE id='reader-b'");
  await db.query("INSERT INTO membership_preview_claims(user_id,activity_id,recording_id,expires_at) VALUES('reader-b','a','r',now()+interval '10 minutes')");
  assert.deepEqual(await state('reader-b'),[false,false],'preview already claimed');
});

test('one live preview binds a recording and activity, expires and caps attempted requests',async t=>{
  const {db,member}=await fixture(t),input={activityID:'activity-a',state:{recordingID:'catalog-a'}};
  await db.query('UPDATE membership_settings SET live_enabled=true');
  const first=await member.claimPreview('reader-a',{activityID:'activity-a',recordingID:'catalog-a'});
  const retry=await member.claimPreview('reader-a',{activityID:'activity-a',recordingID:'catalog-a'});
  assert.equal(first.preview.expiresAt,retry.preview.expiresAt);
  await assert.rejects(member.claimPreview('reader-a',{activityID:'activity-b',recordingID:'catalog-a'}),e=>e.code==='live_preview_used');
  await assert.rejects(admitMemberRelay(db,'reader-a',{...input,state:{recordingID:'other'}}),e=>e.code==='live_preview_recording_mismatch');
  await db.query("UPDATE membership_preview_claims SET request_count=199 WHERE user_id='reader-a'");
  await admitMemberRelay(db,'reader-a',input);
  await assert.rejects(admitMemberRelay(db,'reader-a',input),e=>e.code==='live_preview_ended');
  await db.query("UPDATE membership_preview_claims SET request_count=0,expires_at=now()-interval '1 second'");
  await assert.rejects(admitMemberRelay(db,'reader-a',input),e=>e.code==='live_preview_ended');
  // Beta accounts never need or claim the preview.
  await db.query("UPDATE library_users SET access_kind='beta' WHERE id='reader-b'");
  await assert.rejects(member.claimPreview('reader-b',{activityID:'activity-c',recordingID:'catalog-a'}),e=>e.code==='invalid_request');
});

const claim={activityID:'activity-a',recordingID:'catalog-a'};
const claims=async db=>Number((await db.query('SELECT count(*) AS n FROM membership_preview_claims')).rows[0].n);
test('with DeviceCheck configured, a preview needs a token and an unused bit 1, then sets bit 1 after the claim',async t=>{
  const f=await fixture(t,{deviceCheck:{respond:({path})=>path==='/v1/query_two_bits'?notFound():reply(200)}});
  await f.db.query('UPDATE membership_settings SET live_enabled=true');
  await assert.rejects(f.member.claimPreview('reader-a',claim),e=>e.code==='live_preview_used'&&e.status===403);
  assert.equal(f.mock.calls.length,0);assert.equal(await claims(f.db),0);
  const snapshot=await f.member.claimPreview('reader-a',{...claim,deviceToken},{bundleID:'com.hongkuntian.Lyrica.Debug'});
  assert.ok(snapshot.preview.expiresAt);
  assert.deepEqual(f.mock.calls.map(c=>[c.host,c.path]),[['api.development.devicecheck.apple.com','/v1/query_two_bits'],
    ['api.development.devicecheck.apple.com','/v1/update_two_bits']]);
  assert.equal(f.mock.calls[1].body.bit1,true);assert.equal('bit0' in f.mock.calls[1].body,false);
  // A retry is idempotent and asks Apple nothing; another activity is refused.
  await f.member.claimPreview('reader-a',{...claim,deviceToken});
  await assert.rejects(f.member.claimPreview('reader-a',{...claim,activityID:'activity-b',deviceToken}),e=>e.code==='live_preview_used');
  assert.equal(f.mock.calls.length,2);
});

for(const [status,calls] of [[400,2],[413,1]])
test('a device token Apple rejects ('+status+') is refused like a missing one',async t=>{
  const f=await fixture(t,{deviceCheck:{respond:()=>reply(status,'any text')}});
  await f.db.query('UPDATE membership_settings SET live_enabled=true');
  await assert.rejects(f.member.claimPreview('reader-a',{...claim,deviceToken:'AAAA'}),e=>e.code==='live_preview_used');
  assert.equal(await claims(f.db),0);assert.equal(f.mock.calls.length,calls);
  assert.equal(f.mock.calls.some(c=>c.path==='/v1/update_two_bits'),false);
});

test('a device whose bit 1 is set cannot claim another account preview',async t=>{
  const f=await fixture(t,{deviceCheck:{respond:()=>bits(true,true,'2026-01')}});
  await f.db.query('UPDATE membership_settings SET live_enabled=true');
  await assert.rejects(f.member.claimPreview('reader-a',{...claim,deviceToken}),e=>e.code==='live_preview_used');
  assert.equal(await claims(f.db),0);assert.deepEqual(f.mock.calls.map(c=>c.path),['/v1/query_two_bits']);
});

test('unconfigured or failing DeviceCheck allows the preview claim and is logged without the token',async t=>{
  for(const [deviceCheck,reason,level] of [[{configured:false},'unconfigured','warn'],[{respond:()=>reply(500)},'status_500','warn'],
    [{respond:()=>reply(429)},'status_429','warn'],[{respond:()=>reply(401)},'status_401','error'],[{respond:()=>reply(403)},'status_403','error']]){
    const f=await fixture(t,{deviceCheck});
    await f.db.query('UPDATE membership_settings SET live_enabled=true');
    assert.ok((await f.member.claimPreview('reader-a',{...claim,deviceToken})).preview.expiresAt);
    if(deviceCheck.configured===false)assert.ok((await f.member.claimPreview('reader-b',claim)).preview.expiresAt,'no token is fine when unconfigured');
    assert.equal(f.mock.calls.some(c=>c.path==='/v1/update_two_bits'),false);
    assert.ok(f.log.events.some(e=>e.level===level&&e.value.event==='devicecheck_unavailable'&&e.value.stage==='preview'&&e.value.reason===reason),reason);
    assert.equal(JSON.stringify(f.log.events).includes(deviceToken),false);
  }
});

test('a refused preview claim never sets bit 1',async t=>{
  const f=await fixture(t,{deviceCheck:{}});
  await f.db.query('UPDATE membership_settings SET live_enabled=true,preview_daily_limit=0');
  await assert.rejects(f.member.claimPreview('reader-a',{...claim,deviceToken}),e=>e.code==='live_preview_temporarily_unavailable');
  assert.deepEqual(f.mock.calls.map(c=>c.path),['/v1/query_two_bits']);
  await f.db.query('UPDATE membership_settings SET live_enabled=false,preview_daily_limit=100');
  await assert.rejects(f.member.claimPreview('reader-a',{...claim,deviceToken}),e=>e.code==='live_lyrics_unavailable');
  assert.equal(f.mock.calls.length,1);
});

test('paid relay access follows expiry and the project budget while preserving beta compatibility',async t=>{
  const {db,member,appToken}=await fixture(t),value=transaction(appToken),input={activityID:'a',state:{recordingID:'r'}};
  await db.query('UPDATE membership_settings SET live_enabled=true,relay_monthly_limit=1');
  await member.recordTransaction('reader-a',{...value,productID:'com.hongkuntian.Lyrica.pro.monthly'});
  await admitMemberRelay(db,'reader-a',input);
  await assert.rejects(admitMemberRelay(db,'reader-a',input),e=>e.code==='live_lyrics_budget_exhausted');
  await db.query("UPDATE library_users SET access_kind='beta' WHERE id='reader-b'");
  await admitMemberRelay(db,'reader-b',input);
  await db.query("UPDATE membership_subscriptions SET expires_at=now()-interval '1 second'");
  await db.query('UPDATE membership_settings SET relay_monthly_limit=100');
  await assert.rejects(admitMemberRelay(db,'reader-a',input),e=>e.code==='membership_required');
});

test("relay_access 'everyone' admits any guest while counting the budget and usage; 'members' does not",async t=>{
  const {db}=await fixture(t,{relayAccess:'everyone'}),input={activityID:'a',state:{recordingID:'r'}};
  const usage=async user=>Number((await db.query('SELECT coalesce(sum(request_count),0) AS n FROM membership_relay_usage WHERE user_id=$1',[user])).rows[0].n);
  await assert.rejects(admitMemberRelay(db,'reader-a',input),e=>e.code==='live_lyrics_unavailable');
  await db.query('UPDATE membership_settings SET live_enabled=true,relay_monthly_limit=2');
  await admitMemberRelay(db,'reader-a',input);await admitMemberRelay(db,'reader-b',input);
  assert.deepEqual([await usage('reader-a'),await usage('reader-b')],[1,1]);
  await assert.rejects(admitMemberRelay(db,'reader-a',input),e=>e.code==='live_lyrics_budget_exhausted');
  // A claimed preview is not consumed while everyone is admitted.
  await db.query('UPDATE membership_settings SET relay_monthly_limit=100');
  await db.query("INSERT INTO membership_preview_claims(user_id,activity_id,recording_id,expires_at) VALUES('reader-a','a','r',now()+interval '10 minutes')");
  await admitMemberRelay(db,'reader-a',input);
  assert.equal((await db.query("SELECT request_count FROM membership_preview_claims WHERE user_id='reader-a'")).rows[0].request_count,0);
  // Switching to members needs no build: the same guest now needs membership or its preview.
  await db.query("UPDATE membership_settings SET relay_access='members'");
  await assert.rejects(admitMemberRelay(db,'reader-b',input),e=>e.code==='membership_required');
  await admitMemberRelay(db,'reader-a',input);
  assert.equal((await db.query("SELECT request_count FROM membership_preview_claims WHERE user_id='reader-a'")).rows[0].request_count,1);
});

test('beta and unlimited accounts are admitted before the live_enabled check and outside the budget',async t=>{
  const {db}=await fixture(t),input={activityID:'a',state:{recordingID:'r'}};
  await db.query("UPDATE library_users SET access_kind='beta' WHERE id='reader-a'");
  await db.query("UPDATE library_users SET unlimited_generation=true WHERE id='reader-b'");
  await db.query('UPDATE membership_settings SET live_enabled=false,relay_monthly_limit=0');
  await admitMemberRelay(db,'reader-a',input);await admitMemberRelay(db,'reader-b',input);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM membership_relay_usage')).rows[0].n),0);
});

test('translation admission uses membership credits only for genuinely new work',async t=>{
  const {member,store,appToken}=await fixture(t);await store.saveDocument(source);
  const args={userID:'reader-a',documentID:source.id,target:'en',recipe:'test',reservedMicros:10};
  await assert.rejects(store.reserve({...args,allowGeneration:true}),e=>e.code==='membership_required');
  await member.recordTransaction('reader-a',transaction(appToken));
  await assert.rejects(store.reserve(args),e=>e.code==='generation_required');
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,20);
  const work=await store.reserve({...args,allowGeneration:true});assert.equal(work.kind,'created');
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,19);
  assert.equal((await store.reserve(args)).kind,'pending');
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,19);
  await store.claim(work.job.id);await store.fail(work.job.id,'provider_error',0);
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,20);
});

// Models a concurrent first record committing between this transaction's
// ownership read and its insert, without changing any SQL under test.
function racingDatabase(raw,competitor){
  let armed=true;
  const wrap=tx=>({query:async(sql,args)=>{
    if(armed&&/^\s*(?:const recorded=)?INSERT INTO membership_subscriptions/.test(sql.trim())){armed=false;await competitor(tx);}
    return tx.query(sql,args);
  }});
  return {query:(...args)=>raw.query(...args),transaction:fn=>raw.transaction(tx=>fn(wrap(tx)))};
}
test('a Restore that loses the first-record race still takes ownership; any other caller is told it lost',async t=>{
  const {db,store,tokens}=await fixture(t),value=transaction(null);let raced=false;
  const competitor=tx=>(raced=true,tx).query(`INSERT INTO membership_subscriptions(original_transaction_id,user_id,transaction_id,product_id,tier,environment,
    app_account_token,period_start,expires_at,signed_at) VALUES($1,'reader-a',$1,'com.hongkuntian.Lyrica.pro.annual','pro','Production',NULL,now(),now()+interval '30 days',now())`,[value.originalID]);
  const restoring=new MembershipStore(racingDatabase(store.db,competitor),{deviceCheck:{configured:false},logger:{}});
  assert.equal((await restoring.recordTransaction('reader-b',value,{restore:true})).tier,'pro');
  assert.equal(raced,true);assert.equal(await owner(db,value),'reader-b');
  // Without Restore the loser gets purchase_account_mismatch and nothing changes.
  const other=transaction(null),before=(await db.query('SELECT count(*)::int AS n FROM membership_subscriptions')).rows[0].n;
  const syncing=new MembershipStore(racingDatabase(store.db,tx=>tx.query(`INSERT INTO membership_subscriptions(original_transaction_id,user_id,transaction_id,product_id,tier,environment,
    app_account_token,period_start,expires_at,signed_at) VALUES($1,'reader-a',$1,'com.hongkuntian.Lyrica.pro.annual','pro','Production',$2,now(),now()+interval '30 days',now())`,
    [other.originalID,tokens['reader-a']])),{deviceCheck:{configured:false},logger:{}});
  await assert.rejects(syncing.recordTransaction('reader-b',other),mismatch);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM membership_subscriptions')).rows[0].n,before,'the losing transaction rolled back, competitor included');
});

test('a preview is refused before DeviceCheck when Live Lyrics is already included',async t=>{
  const f=await fixture(t,{deviceCheck:{}}),{db,member,appToken}=f;
  const refuse=async(user,code)=>{
    await assert.rejects(member.claimPreview(user,{...claim,deviceToken}),e=>e.code===code);
    assert.equal(f.mock.calls.length,0);assert.equal(await claims(db),0);
  };
  await refuse('reader-a','live_lyrics_unavailable');
  await db.query('UPDATE membership_settings SET live_enabled=true');
  await member.recordTransaction('reader-a',transaction(appToken));
  await refuse('reader-a','invalid_request');                      // member
  await db.query("UPDATE library_users SET unlimited_generation=true WHERE id='reader-b'");
  await refuse('reader-b','invalid_request');                      // unlimited
  await db.query("UPDATE library_users SET unlimited_generation=false WHERE id='reader-b'");
  await db.query("UPDATE membership_settings SET relay_access='everyone'");
  await refuse('reader-b','invalid_request');                      // everyone
  await db.query("UPDATE membership_settings SET relay_access='members'");
  assert.ok((await member.claimPreview('reader-b',{...claim,deviceToken})).preview.expiresAt);
});
