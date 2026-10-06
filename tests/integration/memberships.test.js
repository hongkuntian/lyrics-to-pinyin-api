import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {libraryDB,source} from '../helpers/library-db.js';
import {MembershipStore,reserveMemberUsage,settleMemberUsage,admitMemberRelay} from '../../api/utils/membership/store.js';

async function fixture(t) {
  const {db,store}=await libraryDB();t.after(()=>db.close());
  await db.query("UPDATE library_users SET access_kind='apple' WHERE id='reader-a'");
  const appToken=randomUUID();
  await db.query("INSERT INTO account_identities(subject_hash,user_id,app_account_token) VALUES('subject-a','reader-a',$1)",[appToken]);
  return {db,store,member:new MembershipStore(store.db),appToken};
}
test('starter is explicit, account scoped, idempotent and has an acquisition ceiling',async t=>{
  const {db,member}=await fixture(t);
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,0);
  await assert.rejects(member.claimStarter('reader-b'),e=>e.code==='sign_in_required');
  await Promise.all([member.claimStarter('reader-a'),member.claimStarter('reader-a')]);
  const snapshot=await member.snapshot('reader-a');
  assert.equal(snapshot.allowances.translation.remaining,2);assert.equal(snapshot.allowances.study.remaining,10);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM membership_grants')).rows[0].n),2);
  await db.query('UPDATE membership_settings SET starter_daily_limit=0');
  assert.equal((await member.claimStarter('reader-a')).starter.claimed,true);
  await db.query("UPDATE library_users SET access_kind='apple' WHERE id='reader-b'");
  await assert.rejects(member.claimStarter('reader-b'),e=>e.code==='starter_temporarily_unavailable');
});
test('reservations enforce each allowance; repeat operations and failed work never double debit',async t=>{
  const {db,member}=await fixture(t);await member.claimStarter('reader-a');
  const a=randomUUID(),b=randomUUID(),c=randomUUID();
  const reserve=id=>db.transaction(tx=>reserveMemberUsage(tx,'reader-a',id,'translation'));
  await Promise.all([reserve(a),reserve(a),reserve(b)]);
  await assert.rejects(reserve(c),e=>e.code==='membership_allowance_exhausted');
  await settleMemberUsage(db,a,false);await settleMemberUsage(db,a,false);
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,1);
  await reserve(c);await settleMemberUsage(db,c,true);await settleMemberUsage(db,c,false);
  assert.equal((await member.snapshot('reader-a')).allowances.translation.used,2);
  await db.transaction(tx=>reserveMemberUsage(tx,'reader-a',randomUUID(),'study'));
  assert.equal((await member.snapshot('reader-a')).allowances.study.remaining,9);
});
const transaction=token=>({originalID:'1000',transactionID:'1001',productID:'com.hongkuntian.Lyra.pro.annual',
  tier:'pro',environment:'Production',appAccountToken:token,starts:new Date(Date.now()-86400000),expires:new Date(Date.now()+300*86400000),signedAt:new Date(),revoked:false});
test('verified purchases bind one account; old restore data cannot reverse revocation',async t=>{
  const {db,member,appToken}=await fixture(t),value=transaction(appToken);
  let snapshot=await member.recordTransaction('reader-a',value);
  assert.equal(snapshot.tier,'pro');assert.equal(snapshot.allowances.translation.remaining,20);assert.equal(snapshot.allowances.study.remaining,80);
  const a=randomUUID();await db.transaction(tx=>reserveMemberUsage(tx,'reader-a',a,'translation'));
  snapshot=await member.snapshot('reader-a');assert.equal(snapshot.allowances.translation.remaining,19);
  assert.ok(new Date(snapshot.allowances.translation.resetsAt)<value.expires);
  await assert.rejects(member.recordTransaction('reader-a',{...value,appAccountToken:randomUUID()}),e=>e.code==='purchase_account_mismatch');
  await member.recordTransaction('reader-a',{...value,revoked:true,signedAt:new Date(+value.signedAt+1000)});
  await member.recordTransaction('reader-a',value);
  assert.equal((await member.snapshot('reader-a')).tier,'free');
  await assert.rejects(db.transaction(tx=>reserveMemberUsage(tx,'reader-a',randomUUID(),'study')),e=>e.code==='starter_required');
});
test('signed refund notifications remain effective while an account is deleted',async t=>{
  const {db,member,appToken}=await fixture(t),value=transaction(appToken);
  await member.recordTransaction('reader-a',value);
  await db.query("UPDATE library_users SET disabled=true WHERE id='reader-a'");
  await db.query("UPDATE account_identities SET deleted_at=now() WHERE user_id='reader-a'");
  const refund={...value,revoked:true,signedAt:new Date(+value.signedAt+1000)};
  await member.applyNotification('refund',refund);await member.applyNotification('refund',refund);
  assert.equal((await db.query("SELECT revoked FROM membership_subscriptions WHERE user_id='reader-a'")).rows[0].revoked,true);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM membership_notifications')).rows[0].n),1);
  await db.query("UPDATE library_users SET disabled=false WHERE id='reader-a'");
  await db.query("UPDATE account_identities SET deleted_at=NULL WHERE user_id='reader-a'");
  await member.recordTransaction('reader-a',value);
  assert.equal((await member.snapshot('reader-a')).tier,'free');
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
});
test('paid relay access follows expiry and the project budget while preserving beta compatibility',async t=>{
  const {db,member,appToken}=await fixture(t),value=transaction(appToken),input={activityID:'a',state:{recordingID:'r'}};
  await db.query('UPDATE membership_settings SET live_enabled=true,relay_monthly_limit=1');
  await member.recordTransaction('reader-a',{...value,tier:'plus',productID:'com.hongkuntian.Lyra.plus.monthly'});
  await admitMemberRelay(db,'reader-a',input);
  await assert.rejects(admitMemberRelay(db,'reader-a',input),e=>e.code==='live_lyrics_budget_exhausted');
  await admitMemberRelay(db,'reader-b',input);
  await db.query("UPDATE membership_subscriptions SET expires_at=now()-interval '1 second'");
  await assert.rejects(admitMemberRelay(db,'reader-a',input),e=>e.code==='plus_required');
});
test('translation admission uses membership credits only for genuinely new work',async t=>{
  const {db,member,store}=await fixture(t);await member.claimStarter('reader-a');await store.saveDocument(source);
  const args={userID:'reader-a',documentID:source.id,target:'en',recipe:'test',reservedMicros:10};
  await assert.rejects(store.reserve(args),e=>e.code==='generation_required');
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,2);
  const work=await store.reserve({...args,allowGeneration:true});assert.equal(work.kind,'created');
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,1);
  assert.equal((await store.reserve(args)).kind,'pending');
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,1);
  await store.claim(work.job.id);await store.fail(work.job.id,'provider_error',0);
  assert.equal((await member.snapshot('reader-a')).allowances.translation.remaining,2);
});
