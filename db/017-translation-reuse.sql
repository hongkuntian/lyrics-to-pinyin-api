BEGIN;
ALTER TABLE lyric_documents ADD COLUMN translation_identity text;
CREATE INDEX translation_identity_lookup ON lyric_documents(translation_identity) WHERE translation_identity IS NOT NULL;
CREATE TABLE lyric_source_archives (
  document_id text PRIMARY KEY REFERENCES lyric_documents(id),source_hash text NOT NULL,
  response jsonb NOT NULL,structure jsonb NOT NULL,verification text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE translation_document_bindings (
  document_id text NOT NULL REFERENCES lyric_documents(id),target text NOT NULL,
  translation_id uuid NOT NULL REFERENCES song_translations(id),identity text,
  verification text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(document_id,target)
);
INSERT INTO translation_document_bindings(document_id,target,translation_id,verification)
SELECT document_id,target,id,'original' FROM song_translations;
CREATE TABLE translation_generation_keys (
  identity text NOT NULL,target text NOT NULL,job_id uuid NOT NULL REFERENCES translation_jobs(id),
  PRIMARY KEY(identity,target)
);
CREATE TABLE translation_job_aliases (
  id uuid PRIMARY KEY,job_id uuid NOT NULL REFERENCES translation_jobs(id),
  document_id text NOT NULL REFERENCES lyric_documents(id),target text NOT NULL,
  UNIQUE(job_id,document_id)
);
CREATE TABLE translation_reuse_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id text NOT NULL REFERENCES lyric_documents(id),translation_id uuid NOT NULL REFERENCES song_translations(id),
  identity text NOT NULL,verification text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,translation_id)
);
CREATE OR REPLACE FUNCTION library_bind_original_translation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO translation_document_bindings(document_id,target,translation_id,identity,verification)
  SELECT NEW.document_id,NEW.target,NEW.id,d.translation_identity,'original' FROM lyric_documents d WHERE d.id=NEW.document_id
  ON CONFLICT(document_id,target) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER bind_original_translation AFTER INSERT ON song_translations
FOR EACH ROW EXECUTE FUNCTION library_bind_original_translation();
CREATE TRIGGER immutable_lyric_source_archive BEFORE UPDATE OR DELETE ON lyric_source_archives
FOR EACH ROW EXECUTE FUNCTION library_immutable_revision();
CREATE TRIGGER immutable_translation_reuse_event BEFORE UPDATE OR DELETE ON translation_reuse_events
FOR EACH ROW EXECUTE FUNCTION library_immutable_revision();
REVOKE ALL ON lyric_source_archives,translation_document_bindings,translation_generation_keys,translation_job_aliases,translation_reuse_events FROM PUBLIC;
COMMIT;
