BEGIN;
CREATE TABLE IF NOT EXISTS library_settings (
  id integer PRIMARY KEY CHECK (id=1), enabled boolean NOT NULL DEFAULT false,
  daily_micros bigint NOT NULL DEFAULT 0 CHECK (daily_micros>=0),
  monthly_micros bigint NOT NULL DEFAULT 0 CHECK (monthly_micros>=0),
  user_daily integer NOT NULL DEFAULT 10 CHECK (user_daily>=0),
  user_monthly integer NOT NULL DEFAULT 50 CHECK (user_monthly>=0)
);
INSERT INTO library_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS library_users (
  id text PRIMARY KEY, disabled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS library_tokens (
  digest text PRIMARY KEY, user_id text NOT NULL REFERENCES library_users(id),
  revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lyric_documents (
  id text PRIMARY KEY, recording_key text NOT NULL, source_hash text NOT NULL,
  selection_revision text NOT NULL, response jsonb NOT NULL, structure jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lyric_requests (
  request_key text NOT NULL, selection_revision text NOT NULL,
  document_id text NOT NULL REFERENCES lyric_documents(id),
  PRIMARY KEY(request_key,selection_revision)
);
CREATE TABLE IF NOT EXISTS lyric_lookups (
  request_key text NOT NULL, selection_revision text NOT NULL, owner uuid NOT NULL,
  expires_at timestamptz NOT NULL, PRIMARY KEY(request_key,selection_revision)
);
CREATE TABLE IF NOT EXISTS translation_jobs (
  id uuid PRIMARY KEY, document_id text NOT NULL REFERENCES lyric_documents(id),
  target text NOT NULL, recipe text NOT NULL, user_id text NOT NULL REFERENCES library_users(id),
  state text NOT NULL CHECK(state IN ('queued','running','ready','failed','unknown')),
  reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),
  accounted_micros bigint NOT NULL CHECK(accounted_micros>=0),
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  error_code text, provider_response jsonb, UNIQUE(document_id,target)
);
CREATE INDEX IF NOT EXISTS translation_spend_period ON translation_jobs(created_at);
CREATE INDEX IF NOT EXISTS translation_user_period ON translation_jobs(user_id,created_at);
CREATE TABLE IF NOT EXISTS song_translations (
  id uuid PRIMARY KEY REFERENCES translation_jobs(id),
  document_id text NOT NULL REFERENCES lyric_documents(id), target text NOT NULL,
  recipe text NOT NULL, content jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,target)
);
CREATE TABLE IF NOT EXISTS correction_reports (
  id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES library_users(id),
  document_id text NOT NULL REFERENCES lyric_documents(id), translation_id uuid REFERENCES song_translations(id),
  source_id text NOT NULL, category text NOT NULL CHECK(category IN ('lyrics','translation','pronunciation','timing')),
  detail text NOT NULL, fingerprint text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  assessment jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS library_rate_windows (
  user_id text NOT NULL REFERENCES library_users(id), window_start timestamptz NOT NULL,
  count integer NOT NULL, PRIMARY KEY(user_id,window_start)
);
COMMIT;
