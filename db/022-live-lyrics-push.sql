BEGIN;
CREATE TABLE live_lyrics_push_receipts (
  activity_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES library_users(id),
  token_digest text NOT NULL,
  sequence integer NOT NULL DEFAULT 0,
  push_timestamp bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL
);
CREATE INDEX live_lyrics_push_receipts_expiry ON live_lyrics_push_receipts(expires_at);
CREATE TABLE live_lyrics_push_rate_windows (
  user_id text NOT NULL REFERENCES library_users(id),
  window_start timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY(user_id,window_start)
);
COMMIT;
