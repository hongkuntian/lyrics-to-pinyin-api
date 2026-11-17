BEGIN;
-- Retires the server-side Spotify observer created by 027-spotify-background.sql.
-- Lyrica observes Spotify only through the native App Remote SDK; the backend
-- keeps no Spotify grant, polling schedule or activity publication state.
-- Dropping these tables destroys the encrypted refresh/access credentials,
-- enrollment records, queued polls/cleanups and widget capabilities they held,
-- together with their indexes, constraints and role grants.
--
-- Apply this before deploying the code that removes the observer: the
-- production build requires every registered migration's receipt, and the
-- earlier code treats these tables as absent schema (account flows skip
-- Spotify; its queue consumers fail on their first read, before any Spotify
-- request), so the drop also stops server polling immediately.
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
