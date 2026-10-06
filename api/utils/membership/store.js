import {randomUUID} from 'node:crypto';
import {LibraryError} from '../song-library/store.js';
import {first,monthlyPeriod,PRODUCTS,STARTER,PRO,PREVIEW} from './policy.js';

async function account(db,userID,{lock=false,includeDisabled=false}={}) {
  const user=await first(db,`SELECT * FROM library_users WHERE id=$1${includeDisabled?'':' AND NOT disabled'}${lock?' FOR UPDATE':''}`,[userID]);
  if(!user)throw new LibraryError('unauthorized',401);
  return user;
}
async function entitlement(db,userID,now) {
  return first(db,`SELECT * FROM membership_subscriptions WHERE user_id=$1 AND NOT revoked
    AND period_start<=$2 AND expires_at>$2 ORDER BY CASE tier WHEN 'pro' THEN 0 ELSE 1 END,expires_at DESC LIMIT 1`,[userID,now]);
}
function grantDescription(sub,kind,now) {
  if(sub?.tier==='pro') {
    const period=monthlyPeriod(sub.period_start,now),end=new Date(Math.min(+period.end,+new Date(sub.expires_at)));
    return {key:`pro:${sub.original_transaction_id}:${period.start.toISOString()}`,limit:PRO[kind],expires:end};
  }
  return {key:'starter-v1',limit:STARTER[kind],expires:null};
}
async function usage(db,grant) {
  if(!grant)return 0;
  return Number((await first(db,"SELECT count(*) AS n FROM membership_usage WHERE grant_id=$1 AND state IN ('reserved','consumed')",[grant.id])).n);
}

// Call inside the existing generation-admission transaction. The caller keeps
// provider budget admission, immutable job identity and cache/coalescing checks.
export async function reserveMemberUsage(db,userID,operationID,kind) {
  if(!Object.hasOwn(PRO,kind))throw new LibraryError('invalid_usage',500);
  const user=await account(db,userID,{lock:true});
  if(user.access_kind==='beta'||user.unlimited_generation)return;
  if(user.access_kind!=='apple')throw new LibraryError('sign_in_required',403);
  const previous=await first(db,'SELECT * FROM membership_usage WHERE operation_id=$1',[operationID]);
  if(previous) {
    if(previous.user_id!==userID||previous.kind!==kind)throw new LibraryError('usage_conflict',409);
    if(previous.state!=='released')return;
  }
  const now=(await first(db,'SELECT now() AS now')).now,sub=await entitlement(db,userID,now);
  const terms=grantDescription(sub,kind,now);
  if(sub?.tier==='pro')await db.query(`INSERT INTO membership_grants(id,user_id,kind,period_key,allowance,expires_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,kind,period_key) DO NOTHING`,[randomUUID(),userID,kind,terms.key,terms.limit,terms.expires]);
  const grant=await first(db,'SELECT * FROM membership_grants WHERE user_id=$1 AND kind=$2 AND period_key=$3 FOR UPDATE',[userID,kind,terms.key]);
  if(!grant)throw new LibraryError('starter_required',403);
  if(await usage(db,grant)>=grant.allowance)throw new LibraryError('membership_allowance_exhausted',429);
  await db.query(`INSERT INTO membership_usage(operation_id,user_id,grant_id,kind,state) VALUES($1,$2,$3,$4,'reserved')
    ON CONFLICT(operation_id) DO UPDATE SET grant_id=$3,state='reserved' WHERE membership_usage.state='released'`,[operationID,userID,grant.id,kind]);
}
export async function settleMemberUsage(db,operationID,success) {
  await db.query("UPDATE membership_usage SET state=$2 WHERE operation_id=$1 AND state='reserved'",[operationID,success?'consumed':'released']);
}

export class MembershipStore {
  constructor(db,{now=()=>new Date()}={}){this.db=db;this.now=now;}
  async snapshot(userID) {
    const user=await account(this.db,userID),now=this.now();
    const settings=await first(this.db,'SELECT * FROM membership_settings WHERE id=1');
    if(!settings)throw new LibraryError('membership_unavailable',503);
    const identity=await first(this.db,'SELECT app_account_token FROM account_identities WHERE user_id=$1 AND deleted_at IS NULL',[userID]);
    const sub=await entitlement(this.db,userID,now),allowances={};
    for(const kind of Object.keys(PRO)) {
      const terms=grantDescription(sub,kind,now);
      const grant=await first(this.db,'SELECT * FROM membership_grants WHERE user_id=$1 AND kind=$2 AND period_key=$3',[userID,kind,terms.key]);
      const used=await usage(this.db,grant),limit=grant?.allowance??(sub?.tier==='pro'?terms.limit:0);
      allowances[kind]={limit,used,remaining:Math.max(0,limit-used),resetsAt:terms.expires?.toISOString()??null};
    }
    const claimed=!!await first(this.db,"SELECT 1 FROM membership_grants WHERE user_id=$1 AND period_key='starter-v1' LIMIT 1",[userID]);
    const preview=await first(this.db,'SELECT * FROM membership_preview_claims WHERE user_id=$1',[userID]);
    return {account:{id:userID,kind:user.access_kind,appAccountToken:identity?.app_account_token??null},
      tier:sub?.tier??'free',expiresAt:sub?new Date(sub.expires_at).toISOString():null,isBeta:user.access_kind==='beta',
      generationUnlimited:user.unlimited_generation===true,allowances,starter:{claimed,eligible:user.access_kind==='apple'&&!claimed},
      preview:{available:user.access_kind==='apple'&&!preview&&settings.live_enabled,expiresAt:preview?new Date(preview.expires_at).toISOString():null},
      capabilities:{purchases:settings.purchases_enabled,liveLyrics:settings.live_enabled,widgets:settings.widgets_enabled,carPlay:settings.carplay_enabled},
      products:Object.entries(PRODUCTS).map(([id,value])=>({id,...value}))};
  }
  async claimStarter(userID) {
    await this.db.transaction(async db=>{
      const settings=await first(db,'SELECT * FROM membership_settings WHERE id=1 FOR UPDATE');
      const user=await account(db,userID,{lock:true});
      if(user.access_kind!=='apple')throw new LibraryError('sign_in_required',403);
      if(await first(db,"SELECT 1 FROM membership_grants WHERE user_id=$1 AND period_key='starter-v1'",[userID]))return;
      const daily=Number((await first(db,"SELECT count(*) AS n FROM membership_grants WHERE period_key='starter-v1' AND kind='translation' AND created_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")).n);
      if(daily>=settings.starter_daily_limit)throw new LibraryError('starter_temporarily_unavailable',503);
      for(const [kind,limit] of Object.entries(STARTER))await db.query(`INSERT INTO membership_grants(id,user_id,kind,period_key,allowance)
        VALUES($1,$2,$3,'starter-v1',$4) ON CONFLICT(user_id,kind,period_key) DO NOTHING`,[randomUUID(),userID,kind,limit]);
    });
    return this.snapshot(userID);
  }
  async recordTransaction(userID,value,{serverNotification=false}={}) {
    await this.db.transaction(async db=>{
      const user=await account(db,userID,{lock:true,includeDisabled:serverNotification});
      if(user.access_kind!=='apple')throw new LibraryError('sign_in_required',403);
      const identity=await first(db,`SELECT app_account_token FROM account_identities WHERE user_id=$1${serverNotification?'':' AND deleted_at IS NULL'}`,[userID]);
      if(identity?.app_account_token!==value.appAccountToken)throw new LibraryError('purchase_account_mismatch',403);
      const previous=await first(db,'SELECT * FROM membership_subscriptions WHERE original_transaction_id=$1 FOR UPDATE',[value.originalID]);
      if(previous&&(previous.user_id!==userID||previous.environment!==value.environment))throw new LibraryError('purchase_account_mismatch',403);
      if(previous&&(new Date(previous.signed_at)>value.signedAt||
        (+new Date(previous.signed_at)===+value.signedAt&&(previous.revoked||!value.revoked))))return;
      await db.query(`INSERT INTO membership_subscriptions(original_transaction_id,user_id,transaction_id,product_id,tier,environment,
        app_account_token,period_start,expires_at,revoked,signed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(original_transaction_id) DO UPDATE SET transaction_id=$3,product_id=$4,tier=$5,environment=$6,
          period_start=$8,expires_at=$9,revoked=$10,signed_at=$11,verified_at=now()`,
        [value.originalID,userID,value.transactionID,value.productID,value.tier,value.environment,value.appAccountToken,value.starts,value.expires,value.revoked,value.signedAt]);
    });
    return serverNotification?null:this.snapshot(userID);
  }
  async applyNotification(id,value) {
    if(await first(this.db,'SELECT 1 FROM membership_notifications WHERE id=$1',[id]))return;
    const owner=await first(this.db,'SELECT user_id FROM account_identities WHERE app_account_token=$1',[value.appAccountToken]);
    if(!owner)throw new LibraryError('purchase_account_not_found',409);
    await this.recordTransaction(owner.user_id,value,{serverNotification:true});
    await this.db.query('INSERT INTO membership_notifications(id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
  }
  async claimPreview(userID,{activityID,recordingID}) {
    if(typeof activityID!=='string'||!/^[A-Za-z0-9-]{1,128}$/.test(activityID)||typeof recordingID!=='string'||!recordingID||recordingID.length>128)
      throw new LibraryError('invalid_request',400);
    await this.db.transaction(async db=>{
      const settings=await first(db,'SELECT * FROM membership_settings WHERE id=1 FOR UPDATE');
      const user=await account(db,userID,{lock:true});
      if(user.access_kind!=='apple')throw new LibraryError('sign_in_required',403);
      if(!settings.live_enabled)throw new LibraryError('live_lyrics_unavailable',503);
      const previous=await first(db,'SELECT * FROM membership_preview_claims WHERE user_id=$1',[userID]);
      if(previous){if(previous.activity_id===activityID&&previous.recording_id===recordingID)return;throw new LibraryError('live_preview_used',403);}
      const daily=Number((await first(db,"SELECT count(*) AS n FROM membership_preview_claims WHERE claimed_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")).n);
      if(daily>=settings.preview_daily_limit)throw new LibraryError('live_preview_temporarily_unavailable',503);
      await db.query(`INSERT INTO membership_preview_claims(user_id,activity_id,recording_id,expires_at)
        VALUES($1,$2,$3,now()+($4*interval '1 second'))`,[userID,activityID,recordingID,PREVIEW.seconds]);
    });
    return this.snapshot(userID);
  }
}

// Each attempted relay request costs infrastructure even when APNs fails or a
// client repeats a sequence. Commit admission before the external push.
export async function admitMemberRelay(database,userID,input) {
  return database.transaction(async db=>{
    const settings=await first(db,'SELECT * FROM membership_settings WHERE id=1 FOR UPDATE');
    const user=await account(db,userID,{lock:true});
    if(user.access_kind==='beta')return;
    if(!settings.live_enabled)throw new LibraryError('live_lyrics_unavailable',503);
    if(user.access_kind!=='apple')throw new LibraryError('sign_in_required',403);
    const now=(await first(db,'SELECT now() AS now')).now,sub=await entitlement(db,userID,now);
    if(!sub) {
      const preview=await first(db,'SELECT * FROM membership_preview_claims WHERE user_id=$1 FOR UPDATE',[userID]);
      if(!preview)throw new LibraryError('plus_required',403);
      if(preview.activity_id!==input.activityID||preview.recording_id!==input.state.recordingID)throw new LibraryError('live_preview_recording_mismatch',403);
      if(new Date(preview.expires_at)<=now||preview.request_count>=PREVIEW.requests)throw new LibraryError('live_preview_ended',403);
    }
    const total=Number((await first(db,"SELECT coalesce(sum(request_count),0) AS n FROM membership_relay_usage WHERE period_start=date_trunc('month',now() AT TIME ZONE 'UTC')::date")).n);
    if(total>=Number(settings.relay_monthly_limit))throw new LibraryError('live_lyrics_budget_exhausted',503);
    await db.query(`INSERT INTO membership_relay_usage(user_id,period_start,request_count)
      VALUES($1,date_trunc('month',now() AT TIME ZONE 'UTC')::date,1)
      ON CONFLICT(user_id,period_start) DO UPDATE SET request_count=membership_relay_usage.request_count+1`,[userID]);
    if(!sub)await db.query('UPDATE membership_preview_claims SET request_count=request_count+1 WHERE user_id=$1',[userID]);
  });
}
