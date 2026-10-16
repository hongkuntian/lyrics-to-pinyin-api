BEGIN;
-- Spotify source/model capsules are immutable document data. Match evidence and
-- the exact app-reported recording belong to each request fingerprint instead.
ALTER TABLE lyric_documents ADD COLUMN source_capsule jsonb;
ALTER TABLE lyric_documents ADD COLUMN model_context jsonb;
ALTER TABLE lyric_requests ADD COLUMN request_recording jsonb;
ALTER TABLE lyric_requests ADD COLUMN request_evidence jsonb;
COMMIT;
