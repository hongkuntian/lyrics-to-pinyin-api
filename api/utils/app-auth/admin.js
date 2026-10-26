import {revokeSpotifyInTransaction,flushSpotifyCleanup} from '../spotify/revocation.js';
// Operator-only controls. No HTTP handler imports this module.
import {LibraryError,lockAuthWriter} from '../song-library/store.js';
const identifier=value=>typeof value==='string'&&value.trim()&&value.length<=128;
export async function configureEmergencyBudget(db,{dailyMicros,monthlyMicros}) {
  if([dailyMicros,monthlyMicros].some(v=>!Number.isSafeInteger(v)||v<0))throw new LibraryError('invalid_budget',400);
  await db.query('UPDATE library_settings SET emergency_daily_micros=$1,emergency_monthly_micros=$2 WHERE id=1',[dailyMicros,monthlyMicros]);
}
export async function disableUser(database,id,{spotifyCleanupFn=flushSpotifyCleanup}={}) {
  if(!identifier(id))throw new LibraryError('invalid_user',400);
  let spotifyCleanup=[];
  await database.transaction(async db=>{
    // Serialize with paid admissions and claims; current sessions also check this bit.
    await db.query('SELECT id FROM library_settings WHERE id=1 FOR UPDATE');
    await lockAuthWriter(db,{userIDs:[id],allTokens:true,allKeys:true,sessions:true});
    const result=await db.query('UPDATE library_users SET disabled=true WHERE id=$1 RETURNING id',[id]);
    if(!result.rows.length)throw new LibraryError('user_not_found',404);
    await db.query('UPDATE library_tokens SET revoked=true WHERE user_id=$1',[id]);
    await db.query('UPDATE app_attest_keys SET revoked=true WHERE user_id=$1',[id]);
    await revokeSessions(db,id);
    spotifyCleanup=await revokeSpotifyInTransaction(db,{ownerID:id},'ownerDisabled');
  });
  await spotifyCleanupFn(database,spotifyCleanup);
}
export async function revokeSessions(db,id) {
  if(!identifier(id))throw new LibraryError('invalid_user',400);
  // One statement also gives standalone callers a transaction. This terminal
  // session-only writer takes no earlier auth locks, so it cannot close a cycle.
  await db.query(`WITH locked AS MATERIALIZED (
    SELECT s.digest FROM app_auth_sessions s JOIN app_attest_keys k ON s.key_id=k.key_id
    WHERE k.user_id=$1 ORDER BY s.digest COLLATE "C" FOR UPDATE OF s
  ) UPDATE app_auth_sessions s SET revoked=true FROM locked WHERE s.digest=locked.digest`,[id]);
}
export async function revokeKey(database,keyID,{spotifyCleanupFn=flushSpotifyCleanup}={}) {
  if(typeof keyID!=='string'||!/^[A-Za-z0-9+/]{43}=$/.test(keyID))throw new LibraryError('invalid_key',400);
  let spotifyCleanup=[];
  await database.transaction(async db=>{
    const owner=(await db.query('SELECT user_id FROM app_attest_keys WHERE key_id=$1',[keyID])).rows[0];
    if(!owner)throw new LibraryError('app_key_not_registered',404);
    await lockAuthWriter(db,{userIDs:[owner.user_id],keyIDs:[keyID],sessions:true});
    const result=await db.query('UPDATE app_attest_keys SET revoked=true WHERE key_id=$1 RETURNING key_id',[keyID]);
    if(!result.rows.length)throw new LibraryError('app_key_not_registered',404);
    await db.query('UPDATE app_auth_sessions SET revoked=true WHERE key_id=$1',[keyID]);
    spotifyCleanup=await revokeSpotifyInTransaction(db,{keyID},'keyRevoked');
  });
  await spotifyCleanupFn(database,spotifyCleanup);
}
