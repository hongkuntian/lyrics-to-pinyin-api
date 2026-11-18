import {randomUUID,createHash} from 'node:crypto';
import {LibraryError} from '../song-library/store.js';
import {first,monthlyPeriod,PRODUCTS,FREE,PRO,PREVIEW} from './policy.js';
import {DeviceCheckError,defaultDeviceCheck,rejectedDeviceToken,validDeviceToken} from './device-check.js';

async function account(db,userID,{lock=false,includeDisabled=false}={}) {
  const user=await first(db,`SELECT * FROM library_users WHERE id=$1${includeDisabled?'':' AND NOT disabled'}${lock?' FOR UPDATE':''}`,[userID]);
  if(!user)throw new LibraryError('unauthorized',401);
  return user;
}
async function entitlement(db,userID,now) {
  return first(db,`SELECT * FROM membership_subscriptions WHERE user_id=$1 AND NOT revoked AND tier='pro'
    AND period_start<=$2 AND expires_at>$2 ORDER BY expires_at DESC LIMIT 1`,[userID,now]);
}
function grantDescription(sub,kind,now) {
  if(!sub)return null;
  const period=monthlyPeriod(sub.period_start,now),end=new Date(Math.min(+period.end,+new Date(sub.expires_at)));
  return {key:`pro:${sub.original_transaction_id}:${period.start.toISOString()}`,limit:PRO[kind],expires:end};
}
const LIBRARY_GRANT='library-free-v1';
// One durable, idempotent ledger row per account and song document.
function unlockOperation(userID,documentID) {
  const hex=createHash('sha256').update(`library-translation:${userID}:${documentID}`).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-8${hex.slice(13,16)}-${(8|parseInt(hex[16],16)&3).toString(16)}${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
// A new account created on a device that recently created one (DeviceCheck)
// has its free allowance held: nothing remains until the hold ends.
async function libraryWindow(db,user,now) {
  const since=new Date(+new Date(now)-FREE.windowDays*86400000);
  const rows=(await db.query(`SELECT u.created_at FROM membership_usage u JOIN membership_grants g ON g.id=u.grant_id
    WHERE g.user_id=$1 AND g.period_key=$2 AND u.state='consumed' AND u.created_at>$3 ORDER BY u.created_at`,[user.id,LIBRARY_GRANT,since])).rows;
  const limit=FREE.libraryTranslationsPerWeek,used=rows.length;
  const held=user.free_allowance_held_until!=null&&new Date(user.free_allowance_held_until)>new Date(now);
  if(held)return {unlimited:false,limit,used:Math.min(used,limit),remaining:0,nextAvailableAt:new Date(user.free_allowance_held_until).toISOString()};
  const nextAvailableAt=used>=limit&&rows.length?new Date(+new Date(rows[used-limit].created_at)+FREE.windowDays*86400000).toISOString():null;
  return {unlimited:false,limit,used:Math.min(used,limit),remaining:Math.max(0,limit-used),nextAvailableAt};
}
// A paid period's allowance belongs to the subscription, not the account:
// usage counts every account that held it, so Restore never refills it.
async function usage(db,kind,periodKey) {
  return Number((await first(db,`SELECT count(*) AS n FROM membership_usage u JOIN membership_grants g ON g.id=u.grant_id
    WHERE g.kind=$1 AND g.period_key=$2 AND u.state IN ('reserved','consumed')`,[kind,periodKey])).n);
}

// Call inside the existing generation-admission transaction. The caller keeps
// provider budget admission, immutable job identity and cache/coalescing checks.
export async function reserveMemberUsage(db,userID,operationID,kind) {
  if(!Object.hasOwn(PRO,kind))throw new LibraryError('invalid_usage',500);
  const user=await account(db,userID,{lock:true});
  if(user.access_kind==='beta'||user.unlimited_generation)return;
  const previous=await first(db,'SELECT * FROM membership_usage WHERE operation_id=$1',[operationID]);
  if(previous) {
    if(previous.user_id!==userID||previous.kind!==kind)throw new LibraryError('usage_conflict',409);
    if(previous.state!=='released')return;
  }
  const now=(await first(db,'SELECT now() AS now')).now,sub=await entitlement(db,userID,now);
  const terms=grantDescription(sub,kind,now);
  if(!terms)throw new LibraryError('membership_required',403);
  await db.query(`INSERT INTO membership_grants(id,user_id,kind,period_key,allowance,expires_at)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,kind,period_key) DO NOTHING`,[randomUUID(),userID,kind,terms.key,terms.limit,terms.expires]);
  const grant=await first(db,'SELECT * FROM membership_grants WHERE user_id=$1 AND kind=$2 AND period_key=$3 FOR UPDATE',[userID,kind,terms.key]);
  if(!grant)throw new LibraryError('membership_required',403);
  if(await usage(db,kind,terms.key)>=grant.allowance)throw new LibraryError('membership_allowance_exhausted',429);
  await db.query(`INSERT INTO membership_usage(operation_id,user_id,grant_id,kind,state) VALUES($1,$2,$3,$4,'reserved')
    ON CONFLICT(operation_id) DO UPDATE SET grant_id=$3,state='reserved' WHERE membership_usage.state='released'`,[operationID,userID,grant.id,kind]);
}
export async function settleMemberUsage(db,operationID,success) {
  await db.query("UPDATE membership_usage SET state=$2 WHERE operation_id=$1 AND state='reserved'",[operationID,success?'consumed':'released']);
}

// Gates delivery of an existing shared translation. Members, beta and unlimited
// accounts always read. A free account reads songs it already opened; opening a
// new song needs an explicit unlock and uses one of its weekly library reads.
export async function admitLibraryTranslation(database,userID,documentID,{unlock=false}={}) {
  return database.transaction(async db=>{
    const user=await account(db,userID,{lock:true});
    if(user.access_kind==='beta'||user.unlimited_generation)return 'open';
    const now=(await first(db,'SELECT now() AS now')).now;
    if(await entitlement(db,userID,now))return 'open';
    const operation=unlockOperation(userID,documentID);
    if(await first(db,"SELECT 1 FROM membership_usage WHERE operation_id=$1 AND state='consumed'",[operation]))return 'open';
    if(!unlock)return 'locked';
    if((await libraryWindow(db,user,now)).remaining<=0)throw new LibraryError('library_translation_limit',403);
    await db.query(`INSERT INTO membership_grants(id,user_id,kind,period_key,allowance) VALUES($1,$2,'translation',$3,$4)
      ON CONFLICT(user_id,kind,period_key) DO NOTHING`,[randomUUID(),userID,LIBRARY_GRANT,FREE.libraryTranslationsPerWeek]);
    const grant=await first(db,"SELECT id FROM membership_grants WHERE user_id=$1 AND kind='translation' AND period_key=$2",[userID,LIBRARY_GRANT]);
    await db.query(`INSERT INTO membership_usage(operation_id,user_id,grant_id,kind,state) VALUES($1,$2,$3,'translation','consumed')
      ON CONFLICT(operation_id) DO NOTHING`,[operation,userID,grant.id]);
    return 'open';
  });
}

// A preview is only for an account whose Live Lyrics is not already included
// (snapshot liveLyricsIncluded): beta, unlimited, a member, or relay_access
// 'everyone' get 400 invalid_request, as the app never offers it to them.
async function previewNeeded(db,user,settings) {
  if(user.access_kind==='beta')throw new LibraryError('invalid_request',400);
  if(!settings?.live_enabled)throw new LibraryError('live_lyrics_unavailable',503);
  if(user.unlimited_generation===true||settings.relay_access==='everyone'||
    await entitlement(db,user.id,(await first(db,'SELECT now() AS now')).now))throw new LibraryError('invalid_request',400);
}

export class MembershipStore {
  constructor(db,{now=()=>new Date(),deviceCheck=defaultDeviceCheck(),logger=console}={}) {
    this.db=db;this.now=now;this.deviceCheck=deviceCheck;this.logger=logger;
  }
  async snapshot(userID) {
    const user=await account(this.db,userID),now=this.now();
    const settings=await first(this.db,'SELECT * FROM membership_settings WHERE id=1');
    if(!settings)throw new LibraryError('membership_unavailable',503);
    const sub=await entitlement(this.db,userID,now),allowances={};
    for(const kind of Object.keys(PRO)) {
      const terms=grantDescription(sub,kind,now);
      const grant=terms&&await first(this.db,'SELECT * FROM membership_grants WHERE user_id=$1 AND kind=$2 AND period_key=$3',[userID,kind,terms.key]);
      const used=terms?await usage(this.db,kind,terms.key):0,limit=grant?.allowance??terms?.limit??0;
      allowances[kind]={limit,used,remaining:Math.max(0,limit-used),resetsAt:terms?.expires.toISOString()??null};
    }
    const beta=user.access_kind==='beta',unlimited=user.unlimited_generation===true;
    const unlimitedReading=beta||unlimited||!!sub;
    const libraryTranslations=unlimitedReading?{unlimited:true,limit:null,used:0,remaining:null,nextAvailableAt:null}:await libraryWindow(this.db,user,now);
    const preview=await first(this.db,'SELECT * FROM membership_preview_claims WHERE user_id=$1',[userID]);
    // The relay admits this account right now without a preview.
    const liveLyricsIncluded=settings.live_enabled===true&&(beta||unlimited||!!sub||settings.relay_access==='everyone');
    return {account:{id:userID,kind:user.access_kind,appAccountToken:user.app_account_token},
      tier:sub?.tier??'free',expiresAt:sub?new Date(sub.expires_at).toISOString():null,isBeta:beta,
      generationUnlimited:unlimited,allowances,libraryTranslations,liveLyricsIncluded,
      preview:{available:!beta&&!preview&&settings.live_enabled===true&&!liveLyricsIncluded,expiresAt:preview?new Date(preview.expires_at).toISOString():null},
      capabilities:{purchases:settings.purchases_enabled,liveLyrics:settings.live_enabled,widgets:settings.widgets_enabled,carPlay:settings.carplay_enabled},
      products:Object.entries(PRODUCTS).map(([id,value])=>({id,...value}))};
  }
  // Ownership follows original_transaction_id. A first record goes to this
  // account when the purchase's appAccountToken is this account's, absent
  // (offer codes) or no current account's, or on Restore. A purchase recorded
  // for another account moves here only on Restore.
  async recordTransaction(userID,value,{restore=false,serverNotification=false}={}) {
    await this.db.transaction(async db=>{
      const user=await account(db,userID,{lock:true,includeDisabled:serverNotification});
      const previous=await first(db,'SELECT * FROM membership_subscriptions WHERE original_transaction_id=$1 FOR UPDATE',[value.originalID]);
      if(previous&&previous.environment!==value.environment)throw new LibraryError('purchase_account_mismatch',403);
      if(previous&&previous.user_id!==userID) {
        if(serverNotification||!restore)throw new LibraryError('purchase_account_mismatch',403);
        await db.query('UPDATE membership_subscriptions SET user_id=$2,verified_at=now() WHERE original_transaction_id=$1',[value.originalID,userID]);
      } else if(!previous&&!serverNotification&&!restore&&value.appAccountToken!=null&&value.appAccountToken!==user.app_account_token&&
        await first(db,'SELECT 1 FROM library_users WHERE app_account_token=$1 AND NOT disabled',[value.appAccountToken]))
        throw new LibraryError('purchase_account_mismatch',403);
      if(previous&&(new Date(previous.signed_at)>value.signedAt||
        (+new Date(previous.signed_at)===+value.signedAt&&(previous.revoked||!value.revoked))))return;
      // A concurrent first record can win the insert race: Restore still takes
      // ownership, and any other caller learns it lost instead of silently
      // receiving a snapshot without the purchase.
      const recorded=await first(db,`INSERT INTO membership_subscriptions(original_transaction_id,user_id,transaction_id,product_id,tier,environment,
        app_account_token,period_start,expires_at,revoked,signed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT(original_transaction_id) DO UPDATE SET
          user_id=CASE WHEN $12::boolean THEN EXCLUDED.user_id ELSE membership_subscriptions.user_id END,
          transaction_id=$3,product_id=$4,tier=$5,environment=$6,
          period_start=$8,expires_at=$9,revoked=$10,signed_at=$11,verified_at=now()
        RETURNING user_id`,
        [value.originalID,userID,value.transactionID,value.productID,value.tier,value.environment,value.appAccountToken,value.starts,value.expires,value.revoked,value.signedAt,
          restore&&!serverNotification]);
      if(recorded.user_id!==userID)throw new LibraryError('purchase_account_mismatch',403);
    });
    return serverNotification?null:this.snapshot(userID);
  }
  // Server notifications never move a purchase: the recorded owner wins, then
  // the account whose appAccountToken the purchase carries.
  async applyNotification(id,value) {
    if(await first(this.db,'SELECT 1 FROM membership_notifications WHERE id=$1',[id]))return;
    const owner=await first(this.db,'SELECT user_id FROM membership_subscriptions WHERE original_transaction_id=$1',[value.originalID])??
      (value.appAccountToken==null?null:await first(this.db,'SELECT id AS user_id FROM library_users WHERE app_account_token=$1',[value.appAccountToken]));
    if(!owner)throw new LibraryError('purchase_account_not_found',409);
    await this.recordTransaction(owner.user_id,value,{serverNotification:true});
    await this.db.query('INSERT INTO membership_notifications(id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
  }
  #deviceCheckUnavailable(error) {
    // Never the device token, JWT or Apple's response body. A refused key is
    // our configuration, so it is logged at error level.
    const event={event:'devicecheck_unavailable',stage:'preview',
      reason:error===null?'unconfigured':error instanceof DeviceCheckError?error.reason:'error'};
    if(error instanceof DeviceCheckError&&error.kind==='credentials')this.logger.error?.(event);else this.logger.warn?.(event);
  }
  // One Live Lyrics preview per non-beta account and, with DeviceCheck, per
  // device (bit 1). A missing token, or one Apple rejects on both hosts, is
  // refused. Unconfigured or failing DeviceCheck allows the claim.
  async claimPreview(userID,{activityID,recordingID,deviceToken},{bundleID}={}) {
    if(typeof activityID!=='string'||!/^[A-Za-z0-9-]{1,128}$/.test(activityID)||typeof recordingID!=='string'||!recordingID||recordingID.length>128||
      (deviceToken!==undefined&&!validDeviceToken(deviceToken)))
      throw new LibraryError('invalid_request',400);
    // A retry or repeat claim is answered without asking Apple.
    const claimed=await first(this.db,'SELECT activity_id,recording_id FROM membership_preview_claims WHERE user_id=$1',[userID]);
    if(claimed){if(claimed.activity_id===activityID&&claimed.recording_id===recordingID)return this.snapshot(userID);throw new LibraryError('live_preview_used',403);}
    // Refuse before asking Apple when the preview would change nothing.
    await previewNeeded(this.db,await account(this.db,userID),await first(this.db,'SELECT * FROM membership_settings WHERE id=1'));
    let mark=false;
    if(!this.deviceCheck.configured)this.#deviceCheckUnavailable(null);
    else if(deviceToken===undefined)throw new LibraryError('live_preview_used',403);
    else {
      let bits=null;
      try{bits=await this.deviceCheck.query(deviceToken,{bundleID});}
      catch(error){if(rejectedDeviceToken(error))throw new LibraryError('live_preview_used',403);this.#deviceCheckUnavailable(error);}
      if(bits?.bit1)throw new LibraryError('live_preview_used',403);
      mark=bits!==null;
    }
    await this.db.transaction(async db=>{
      const settings=await first(db,'SELECT * FROM membership_settings WHERE id=1 FOR UPDATE');
      await previewNeeded(db,await account(db,userID,{lock:true}),settings);
      const previous=await first(db,'SELECT * FROM membership_preview_claims WHERE user_id=$1',[userID]);
      if(previous){if(previous.activity_id===activityID&&previous.recording_id===recordingID)return;throw new LibraryError('live_preview_used',403);}
      const daily=Number((await first(db,"SELECT count(*) AS n FROM membership_preview_claims WHERE claimed_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'")).n);
      if(daily>=settings.preview_daily_limit)throw new LibraryError('live_preview_temporarily_unavailable',503);
      await db.query(`INSERT INTO membership_preview_claims(user_id,activity_id,recording_id,expires_at)
        VALUES($1,$2,$3,now()+($4*interval '1 second'))`,[userID,activityID,recordingID,PREVIEW.seconds]);
    });
    // Mark the device only once the claim exists.
    if(mark)try{await this.deviceCheck.setBit(deviceToken,{bundleID,bit:1});}catch(error){this.#deviceCheckUnavailable(error);}
    return this.snapshot(userID);
  }
}

// Each attempted relay request costs infrastructure even when APNs fails or a
// client repeats a sequence. Commit admission before the external push.
export async function admitMemberRelay(database,userID,input) {
  return database.transaction(async db=>{
    const settings=await first(db,'SELECT * FROM membership_settings WHERE id=1 FOR UPDATE');
    const user=await account(db,userID,{lock:true});
    if(user.access_kind==='beta'||user.unlimited_generation===true)return;
    if(!settings.live_enabled)throw new LibraryError('live_lyrics_unavailable',503);
    // relay_access 'everyone' (prerelease) admits without membership or
    // preview; the global budget and usage ledger still apply.
    const now=(await first(db,'SELECT now() AS now')).now;
    const included=settings.relay_access==='everyone'||!!await entitlement(db,userID,now);
    if(!included) {
      const preview=await first(db,'SELECT * FROM membership_preview_claims WHERE user_id=$1 FOR UPDATE',[userID]);
      if(!preview)throw new LibraryError('membership_required',403);
      if(preview.activity_id!==input.activityID||preview.recording_id!==input.state.recordingID)throw new LibraryError('live_preview_recording_mismatch',403);
      if(new Date(preview.expires_at)<=now||preview.request_count>=PREVIEW.requests)throw new LibraryError('live_preview_ended',403);
    }
    const total=Number((await first(db,"SELECT coalesce(sum(request_count),0) AS n FROM membership_relay_usage WHERE period_start=date_trunc('month',now() AT TIME ZONE 'UTC')::date")).n);
    if(total>=Number(settings.relay_monthly_limit))throw new LibraryError('live_lyrics_budget_exhausted',503);
    await db.query(`INSERT INTO membership_relay_usage(user_id,period_start,request_count)
      VALUES($1,date_trunc('month',now() AT TIME ZONE 'UTC')::date,1)
      ON CONFLICT(user_id,period_start) DO UPDATE SET request_count=membership_relay_usage.request_count+1`,[userID]);
    if(!included)await db.query('UPDATE membership_preview_claims SET request_count=request_count+1 WHERE user_id=$1',[userID]);
  });
}
