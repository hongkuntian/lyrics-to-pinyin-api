// Shared across per-request relay instances, scoped to their warm database pool.
// Cold pools may also sweep; row locks let independent sweeps skip busy state.
const lastAttempts=new WeakMap();
export async function cleanupExpiredPushState(db,{now=Date.now}={}) {
  const time=now(),previous=lastAttempts.get(db);
  if(previous!==undefined&&time>=previous&&time-previous<60_000)return {state:'skipped'};
  lastAttempts.set(db,time); // Throttle overlapping calls and failed attempts too.
  try {
    return await db.transaction(async tx=>{
      await tx.query("SET LOCAL lock_timeout='100ms'");
      await tx.query("SET LOCAL statement_timeout='500ms'");
      const {rows}=await tx.query(`WITH expired_receipts AS MATERIALIZED (
        SELECT activity_id FROM live_lyrics_push_receipts WHERE expires_at<now()
        ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED
      ), removed_receipts AS (
        DELETE FROM live_lyrics_push_receipts r USING expired_receipts e
        WHERE r.activity_id=e.activity_id AND r.expires_at<now() RETURNING 1
      ), expired_windows AS MATERIALIZED (
        SELECT user_id,window_start FROM live_lyrics_push_rate_windows
        WHERE window_start<now()-interval '1 day'
        ORDER BY window_start LIMIT 1000 FOR UPDATE SKIP LOCKED
      ), removed_windows AS (
        DELETE FROM live_lyrics_push_rate_windows w USING expired_windows e
        WHERE w.user_id=e.user_id AND w.window_start=e.window_start RETURNING 1
      ) SELECT (SELECT count(*)::int FROM removed_receipts) AS receipts,
        (SELECT count(*)::int FROM removed_windows) AS "rateWindows"`);
      return {state:'completed',...rows[0]};
    });
  } catch {
    // Housekeeping has no authority to fail a delivered push or expose SQL errors.
    return {state:'failed'};
  }
}
