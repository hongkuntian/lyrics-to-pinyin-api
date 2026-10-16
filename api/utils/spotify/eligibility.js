import {LibraryError} from '../song-library/store.js';
import {PREVIEW} from '../membership/policy.js';
// Observation admission is read-only. The existing relay admission increments
// budget/preview usage immediately before an actual APNs publication.
export async function checkSpotifyEligibility(db,userID,input){
 const first=async(sql,args)=>(await db.query(sql,args)).rows[0];
 const row=await first('SELECT u.access_kind,u.disabled,s.live_enabled,s.relay_monthly_limit FROM library_users u CROSS JOIN membership_settings s WHERE u.id=$1 AND s.id=1',[userID]);
 if(!row||row.disabled)throw new LibraryError('unauthorized',401);if(row.access_kind==='beta')return;
 if(!row.live_enabled)throw new LibraryError('live_lyrics_unavailable',503);if(row.access_kind!=='apple')throw new LibraryError('sign_in_required',403);
 const sub=await first('SELECT 1 FROM membership_subscriptions WHERE user_id=$1 AND NOT revoked AND period_start<=now() AND expires_at>now() LIMIT 1',[userID]);
 if(!sub){const preview=await first('SELECT *,expires_at>now() AS valid FROM membership_preview_claims WHERE user_id=$1',[userID]);
  if(!preview)throw new LibraryError('plus_required',403);
  if(preview.activity_id!==input.activityID||preview.recording_id!==input.state.recordingID)throw new LibraryError('live_preview_recording_mismatch',403);
  if(!preview.valid||preview.request_count>=PREVIEW.requests)throw new LibraryError('live_preview_ended',403);
 }
 const total=await first("SELECT coalesce(sum(request_count),0) AS count FROM membership_relay_usage WHERE period_start=date_trunc('month',now() AT TIME ZONE 'UTC')::date");
 if(Number(total.count)>=Number(row.relay_monthly_limit))throw new LibraryError('live_lyrics_budget_exhausted',503);
}
