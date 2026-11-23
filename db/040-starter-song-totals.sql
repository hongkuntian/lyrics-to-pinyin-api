BEGIN;
-- Starter songs (first-run flow): two running totals per pool song, how often
-- it was shown and how often it was picked. A row holds no account, device,
-- address or per-event time, and nothing acts on the totals yet.
-- Pool: api/data/starter-songs.json. Contract: SONG_LIBRARY.md, "Starter songs".
--
-- Apply this before deploying the backend that uses it: the production build
-- requires this receipt. Every statement is a no-op on a repeat.
CREATE TABLE IF NOT EXISTS public.starter_song_totals (
  song_id text PRIMARY KEY CONSTRAINT starter_song_totals_song_id_check CHECK (char_length(song_id) BETWEEN 1 AND 64),
  shown bigint NOT NULL DEFAULT 0 CONSTRAINT starter_song_totals_shown_check CHECK (shown>=0),
  picked bigint NOT NULL DEFAULT 0 CONSTRAINT starter_song_totals_picked_check CHECK (picked>=0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Starter songs are free to generate up to a per-account daily cap, which counts
-- an account's recent translation jobs and study explanations
-- (docs/memberships.md). Translation jobs already have this index as
-- translation_user_period; this serves the same lookup on explanations, and the
-- existing busy and monthly-attempt checks on that table.
CREATE INDEX IF NOT EXISTS study_explanations_user_period ON public.study_explanations(user_id,created_at);

-- The song-library handler's login adds to the totals with one upsert. It
-- gets no DELETE or TRUNCATE, and the account login gets nothing.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyrica_runtime_v1') THEN
    GRANT SELECT,INSERT,UPDATE ON public.starter_song_totals TO lyrica_runtime_v1;
  END IF;
END $$;
COMMIT;
