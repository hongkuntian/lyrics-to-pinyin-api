BEGIN;
-- The deployed runtime login predates the relay tables. Grant only the
-- operations used by the relay; do not change schema or account privileges.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_runtime_v1') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON
      public.live_lyrics_push_receipts,public.live_lyrics_push_rate_windows
      TO lyra_runtime_v1;
  END IF;
END $$;
COMMIT;
