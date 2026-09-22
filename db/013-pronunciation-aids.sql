BEGIN;
-- Derived annotations never rewrite lyric, translation or learning identity.
CREATE TABLE pronunciation_aids (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES lyric_documents(id),
  source_hash text NOT NULL,
  profile_id text NOT NULL,
  profile_version text NOT NULL,
  engine_version text NOT NULL,
  annotation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pronunciation_aids_document ON pronunciation_aids(document_id,profile_id);
COMMIT;
