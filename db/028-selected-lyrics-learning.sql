ALTER TABLE lyric_documents ADD COLUMN IF NOT EXISTS selected_source jsonb;
CREATE TABLE IF NOT EXISTS selected_source_access (
  user_id text NOT NULL REFERENCES library_users(id),
  document_id text NOT NULL REFERENCES lyric_documents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,document_id)
);
CREATE INDEX IF NOT EXISTS selected_source_access_document ON selected_source_access(document_id);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_runtime_v1') THEN
  GRANT SELECT,INSERT,DELETE ON selected_source_access TO lyra_runtime_v1;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_account_v1') THEN
  GRANT DELETE ON selected_source_access TO lyra_account_v1;
  GRANT SELECT(user_id) ON selected_source_access TO lyra_account_v1;
 END IF;
END $$;
