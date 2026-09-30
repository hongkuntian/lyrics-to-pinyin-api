BEGIN;
ALTER TABLE lyric_documents ADD COLUMN canonical_recording_id text;
ALTER TABLE lyric_documents ADD COLUMN text_revision text;
ALTER TABLE lyric_documents ADD COLUMN timing_revision text;
ALTER TABLE lyric_documents ADD COLUMN reading_revision text;
CREATE INDEX lyric_canonical_recording ON lyric_documents(canonical_recording_id,selection_revision);
CREATE TABLE catalog_recording_bindings (
  catalog_id text NOT NULL,storefront text NOT NULL,canonical_recording_id text NOT NULL,
  evidence jsonb NOT NULL,checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(catalog_id,storefront)
);
CREATE TABLE recording_lyric_heads (
  canonical_recording_id text NOT NULL,selection_revision text NOT NULL,
  document_id text NOT NULL REFERENCES lyric_documents(id),checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(canonical_recording_id,selection_revision)
);
REVOKE ALL ON catalog_recording_bindings,recording_lyric_heads FROM PUBLIC;
COMMIT;
