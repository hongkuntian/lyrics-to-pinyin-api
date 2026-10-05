import {createHash} from 'node:crypto';
import {LibraryError} from '../song-library/store.js';
import {cleanupExpiredPushState} from './maintenance.js';

const fail=()=>{throw new LibraryError('invalid_request',400);};
const limits={recordingID:128,title:256,artist:256,lineID:96,original:800,pronunciation:500,translation:400,nextOriginal:256};
const other=['rubyReadings','pronunciationAbove','centered','artwork','progress','part','parts','phase','playing','observedAt','sequence'];
const phases=['waiting','loading','lyrics','untimed','instrumental','unavailable','ended'];
export function validatePush(body,now=Date.now()) {
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['activityID','token','environment','reason','state'].includes(k)))fail();
  if(typeof body.activityID!=='string'||!/^[A-Za-z0-9-]{1,128}$/.test(body.activityID)||
    typeof body.token!=='string'||!/^[a-f0-9]{64,512}$/.test(body.token)||body.token.length%2||
    !['development','production'].includes(body.environment)||!['content','progress','heartbeat'].includes(body.reason))fail();
  const state=body.state;
  if(!state||typeof state!=='object'||Array.isArray(state)||Object.keys(state).some(k=>!Object.hasOwn(limits,k)&&!other.includes(k)))fail();
  for(const [key,bytes] of Object.entries(limits))if(typeof state[key]!=='string'||Buffer.byteLength(JSON.stringify(state[key]))>bytes)fail();
  if(!Array.isArray(state.rubyReadings)||state.rubyReadings.length>800||state.rubyReadings.some(r=>typeof r!=='string'||Buffer.byteLength(r)>128)||
    ['pronunciationAbove','centered','playing'].some(k=>typeof state[k]!=='boolean')||!phases.includes(state.phase)||
    !Number.isFinite(state.progress)||state.progress<0||state.progress>=1||
    !Number.isInteger(state.parts)||state.parts<1||state.parts>1000||!Number.isInteger(state.part)||state.part<0||state.part>=state.parts||
    !Number.isSafeInteger(state.sequence)||state.sequence<1||state.sequence>2147483647||!Number.isFinite(state.observedAt))fail();
  if(state.artwork!=null&&(typeof state.artwork!=='string'||state.artwork.length>1200||Buffer.from(state.artwork,'base64').toString('base64')!==state.artwork))fail();
  // Swift's default Codable date uses seconds since 2001, as ActivityKit expects.
  const observed=state.observedAt+978307200;
  if(observed>now/1000+2)fail();
  if(now/1000-observed>=8)throw new LibraryError('push_observation_expired',409);
  if(Buffer.byteLength(JSON.stringify(state))>3500)fail();
  return {...body,observed,tokenDigest:createHash('sha256').update(body.token).digest('hex')};
}

export class LiveLyricsPushRelay {
  constructor(db,{send,now=Date.now,logger=console}={}){this.db=db;this.send=send;this.now=now;this.logger=logger;}
  async update(userID,input) {
    // Failed delivery attempts also consume the independent push quota.
    const count=(await this.db.query(`INSERT INTO live_lyrics_push_rate_windows(user_id,window_start,count)
      VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(user_id,window_start)
      DO UPDATE SET count=live_lyrics_push_rate_windows.count+1 RETURNING count`,[userID])).rows[0].count;
    if(count>120)throw new LibraryError('push_rate_limited',429);
    const result=await this.db.transaction(async db=>{
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query(`INSERT INTO live_lyrics_push_receipts(activity_id,user_id,token_digest,expires_at)
        VALUES($1,$2,$3,now()+interval '30 minutes') ON CONFLICT(activity_id) DO UPDATE
        SET user_id=EXCLUDED.user_id,token_digest=EXCLUDED.token_digest,sequence=0,push_timestamp=0,expires_at=EXCLUDED.expires_at
        WHERE live_lyrics_push_receipts.expires_at<now()`,[input.activityID,userID,input.tokenDigest]);
      const previous=(await db.query('SELECT * FROM live_lyrics_push_receipts WHERE activity_id=$1 FOR UPDATE',[input.activityID])).rows[0];
      if(previous.user_id!==userID)throw new LibraryError('push_session_conflict',403);
      if(input.state.sequence<=previous.sequence)return {state:'accepted',sequence:previous.sequence,timestamp:Number(previous.push_timestamp)};
      // Integer APNs timestamps must increase. Coalesce quick consecutive changes
      // in the app instead of inventing future timestamps or replaying old lyrics.
      const timestamp=Math.floor(this.now()/1000);
      if(timestamp<=Number(previous.push_timestamp))throw new LibraryError('push_rate_limited',429);
      if(this.now()/1000-input.observed>=8)throw new LibraryError('push_observation_expired',409);
      const payload={aps:{timestamp,event:'update','content-state':input.state,'stale-date':Math.floor(input.observed+8)}};
      if(Buffer.byteLength(JSON.stringify(payload))>4096)throw new LibraryError('invalid_request',400);
      await this.send({environment:input.environment,token:input.token,payload,priority:input.reason==='heartbeat'?5:10});
      await db.query(`UPDATE live_lyrics_push_receipts SET sequence=$2,push_timestamp=$3,token_digest=$4,expires_at=now()+interval '30 minutes' WHERE activity_id=$1`,
        [input.activityID,input.state.sequence,timestamp,input.tokenDigest]);
      return {state:'accepted',sequence:input.state.sequence,timestamp};
    });
    // Send and commit fresh state before bounded, best-effort housekeeping.
    const cleanup=await cleanupExpiredPushState(this.db,{now:this.now});
    if(cleanup.state==='failed')this.logger.warn({event:'live_lyrics_cleanup_failed'});
    return result;
  }
}
