BEGIN;
ALTER TABLE lyric_documents ADD COLUMN IF NOT EXISTS superseded_by text REFERENCES lyric_documents(id);
ALTER TABLE lyric_requests ADD COLUMN IF NOT EXISTS checked_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS lyric_document_extras (
  document_id text PRIMARY KEY REFERENCES lyric_documents(id),
  song_details jsonb,
  provider_translation jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
