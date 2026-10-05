BEGIN;
CREATE INDEX live_lyrics_push_rate_windows_expiry ON live_lyrics_push_rate_windows(window_start);
COMMIT;
