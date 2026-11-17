BEGIN;
-- Retires the server-side Spotify observer created by 027-spotify-background.sql.
-- Lyrica observes Spotify only through the native App Remote SDK; the backend
-- keeps no Spotify grant, polling schedule or activity publication state.
-- Dropping these tables destroys the encrypted refresh/access credentials,
-- enrollment records, queued polls/cleanups and widget capabilities they held,
-- together with their indexes, constraints and role grants.
--
-- Deploy the code that no longer reads these tables before applying this.
-- IF EXISTS keeps a repeat or a never-provisioned installation a no-op. The
-- default RESTRICT refuses (and rolls back) if anything else depends on them;
-- no other object is dropped. Spotify recording identity and lyric documents
-- (026-spotify-recordings.sql), accounts, memberships, the Live Lyrics relay
-- and listening data are untouched. 027 and its receipt stay as history.
DROP TABLE IF EXISTS public.spotify_outbox;
DROP TABLE IF EXISTS public.spotify_snapshot_capabilities;
DROP TABLE IF EXISTS public.spotify_provider_circuits;
DROP TABLE IF EXISTS public.spotify_connections;
COMMIT;
