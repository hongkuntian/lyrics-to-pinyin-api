BEGIN;
-- These short locks make the backfill and compatibility triggers one atomic cutover.
SET LOCAL lock_timeout='5s';
LOCK TABLE library_settings,translation_jobs,song_translations,correction_reports IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE library_settings ADD COLUMN IF NOT EXISTS review_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE library_settings ADD COLUMN IF NOT EXISTS review_daily_micros bigint NOT NULL DEFAULT 250000 CHECK(review_daily_micros>=0);
ALTER TABLE library_settings ADD COLUMN IF NOT EXISTS review_monthly_micros bigint NOT NULL DEFAULT 1000000 CHECK(review_monthly_micros>=0);
ALTER TABLE library_settings ADD COLUMN IF NOT EXISTS review_max_daily integer NOT NULL DEFAULT 5 CHECK(review_max_daily BETWEEN 0 AND 100);
ALTER TABLE translation_jobs ADD COLUMN IF NOT EXISTS cost_final boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS translation_revisions (
  id uuid PRIMARY KEY,
  translation_id uuid NOT NULL REFERENCES song_translations(id),
  sequence bigint NOT NULL CHECK(sequence>0),
  base_revision_id uuid,
  source_hash text NOT NULL,recipe text NOT NULL,content jsonb NOT NULL,
  origin text NOT NULL CHECK(origin IN ('generation','correction','rollback')),
  publication_key text NOT NULL UNIQUE,
  request_hash text NOT NULL,
  actor text NOT NULL,reason text NOT NULL,restored_from uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(translation_id,sequence),UNIQUE(id,translation_id),
  FOREIGN KEY(base_revision_id,translation_id) REFERENCES translation_revisions(id,translation_id),
  FOREIGN KEY(restored_from,translation_id) REFERENCES translation_revisions(id,translation_id)
);
CREATE TABLE IF NOT EXISTS translation_heads (
  translation_id uuid PRIMARY KEY REFERENCES song_translations(id),
  revision_id uuid NOT NULL,
  FOREIGN KEY(revision_id,translation_id) REFERENCES translation_revisions(id,translation_id)
);
-- The first revision keeps the existing UUID, so historical reports and installed apps remain valid.
INSERT INTO translation_revisions(id,translation_id,sequence,source_hash,recipe,content,origin,publication_key,request_hash,actor,reason,created_at)
SELECT t.id,t.id,1,d.source_hash,t.recipe,t.content,'generation','generation:'||t.id,'legacy','generation','Initial translation',t.created_at
FROM song_translations t JOIN lyric_documents d ON d.id=t.document_id ON CONFLICT DO NOTHING;
INSERT INTO translation_heads(translation_id,revision_id) SELECT id,id FROM song_translations ON CONFLICT DO NOTHING;
ALTER TABLE correction_reports DROP CONSTRAINT IF EXISTS correction_reports_translation_id_fkey;
ALTER TABLE correction_reports ADD CONSTRAINT correction_reports_translation_id_fkey FOREIGN KEY(translation_id) REFERENCES translation_revisions(id);

CREATE OR REPLACE FUNCTION library_seed_translation_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO translation_revisions(id,translation_id,sequence,source_hash,recipe,content,origin,publication_key,request_hash,actor,reason,created_at)
  SELECT NEW.id,NEW.id,1,d.source_hash,NEW.recipe,NEW.content,'generation','generation:'||NEW.id,'legacy','generation','Initial translation',NEW.created_at
  FROM lyric_documents d WHERE d.id=NEW.document_id;
  INSERT INTO translation_heads(translation_id,revision_id) VALUES(NEW.id,NEW.id);
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER seed_translation_revision AFTER INSERT ON song_translations
FOR EACH ROW EXECUTE FUNCTION library_seed_translation_revision();
CREATE OR REPLACE FUNCTION library_immutable_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'translation_revision_immutable' USING ERRCODE='23514'; END $$;
CREATE OR REPLACE TRIGGER immutable_translation_revision BEFORE UPDATE OR DELETE ON translation_revisions
FOR EACH ROW EXECUTE FUNCTION library_immutable_revision();

CREATE TABLE IF NOT EXISTS translation_reviews (
  id uuid PRIMARY KEY,revision_id uuid NOT NULL UNIQUE REFERENCES translation_revisions(id),
  policy_version text NOT NULL,model text NOT NULL CHECK(model='gpt-5.6-luna'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS library_spend_operations (
  id uuid PRIMARY KEY,operation_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK(kind IN ('generation','review_assessment','review_verification')),
  generation_job_id uuid UNIQUE REFERENCES translation_jobs(id),
  review_id uuid REFERENCES translation_reviews(id),
  state text NOT NULL CHECK(state IN ('reserved','submitted','unknown','settled','released')),
  reserved_micros bigint NOT NULL CHECK(reserved_micros BETWEEN 0 AND 9007199254740991),
  accounted_micros bigint NOT NULL CHECK(accounted_micros BETWEEN 0 AND 9007199254740991),
  provider_id text,error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),submitted_at timestamptz,settled_at timestamptz,
  UNIQUE(review_id,kind),
  CHECK((kind='generation' AND generation_job_id IS NOT NULL AND review_id IS NULL)
     OR (kind<>'generation' AND generation_job_id IS NULL AND review_id IS NOT NULL)),
  CHECK((state='settled' AND settled_at IS NOT NULL) OR (state<>'settled' AND settled_at IS NULL)),
  CHECK(state<>'released' OR accounted_micros=0)
);
CREATE INDEX IF NOT EXISTS library_spend_settled ON library_spend_operations(settled_at) WHERE state='settled';
CREATE INDEX IF NOT EXISTS library_spend_held ON library_spend_operations(state) WHERE state IN ('reserved','submitted','unknown');

-- Compatibility: old workers continue writing translation_jobs during a rolling deployment.
-- Keep their ledger entries synchronized in the same transaction, rather than dual-writing in JS.
CREATE OR REPLACE FUNCTION library_has_final_usage(response jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN
    jsonb_typeof(response->'usage'->'input_tokens')='number' AND
    jsonb_typeof(response->'usage'->'output_tokens')='number' AND
    (response->'usage'->>'input_tokens') ~ '^[0-9]{1,8}$' AND
    (response->'usage'->>'output_tokens') ~ '^[0-9]{1,8}$'
  THEN (response->'usage'->>'input_tokens')::bigint<=10000000 AND
    (response->'usage'->>'output_tokens')::bigint<=10000000 ELSE false END
$$;
CREATE OR REPLACE FUNCTION library_sync_generation_spend() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final boolean; operation_state text;
BEGIN
  final := NEW.state IN ('ready','failed') AND (NEW.cost_final OR library_has_final_usage(NEW.provider_response));
  operation_state := CASE WHEN NEW.state='queued' THEN 'reserved' WHEN NEW.state='running' THEN 'submitted'
    WHEN coalesce(final,false) THEN 'settled' ELSE 'unknown' END;
  INSERT INTO library_spend_operations(id,operation_key,kind,generation_job_id,state,reserved_micros,accounted_micros,
    provider_id,error_code,created_at,submitted_at,settled_at)
  VALUES(NEW.id,'generation:'||NEW.id,'generation',NEW.id,operation_state,NEW.reserved_micros,NEW.accounted_micros,
    NEW.provider_response->>'id',NEW.error_code,NEW.created_at,NEW.started_at,
    CASE WHEN operation_state='settled' THEN coalesce(NEW.finished_at,NEW.created_at) END)
  ON CONFLICT(generation_job_id) DO UPDATE SET state=EXCLUDED.state,accounted_micros=EXCLUDED.accounted_micros,
    provider_id=EXCLUDED.provider_id,error_code=EXCLUDED.error_code,submitted_at=EXCLUDED.submitted_at,settled_at=EXCLUDED.settled_at;
  RETURN NEW;
END $$;
-- Backfill before installing the admission trigger. Known historical charges retain their time;
-- unresolved requests remain held regardless of age.
INSERT INTO library_spend_operations(id,operation_key,kind,generation_job_id,state,reserved_micros,accounted_micros,
  provider_id,error_code,created_at,submitted_at,settled_at)
SELECT id,'generation:'||id,'generation',id,
  CASE WHEN state='queued' THEN 'reserved' WHEN state='running' THEN 'submitted' WHEN final THEN 'settled' ELSE 'unknown' END,
  reserved_micros,accounted_micros,provider_response->>'id',error_code,created_at,started_at,
  CASE WHEN final THEN coalesce(finished_at,created_at) END
FROM (SELECT j.*,state IN ('ready','failed') AND (cost_final OR library_has_final_usage(provider_response)) AS final FROM translation_jobs j) source
ON CONFLICT DO NOTHING;
CREATE OR REPLACE TRIGGER sync_generation_spend AFTER INSERT OR UPDATE ON translation_jobs
FOR EACH ROW EXECUTE FUNCTION library_sync_generation_spend();

CREATE OR REPLACE VIEW library_spend_totals AS
SELECT
  coalesce(sum(accounted_micros) FILTER(WHERE state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS daily,
  coalesce(sum(accounted_micros) FILTER(WHERE state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS monthly,
  coalesce(sum(accounted_micros) FILTER(WHERE state IN ('reserved','submitted','unknown')),0) AS held,
  coalesce(sum(accounted_micros) FILTER(WHERE kind<>'generation' AND (state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),0) AS review_daily,
  coalesce(sum(accounted_micros) FILTER(WHERE kind<>'generation' AND (state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),0) AS review_monthly
FROM library_spend_operations;

CREATE OR REPLACE FUNCTION library_admit_spend() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings library_settings%ROWTYPE; totals record;
BEGIN
  -- Existing entries are reconciliations, not new admissions (including ON CONFLICT).
  IF EXISTS(SELECT 1 FROM library_spend_operations WHERE operation_key=NEW.operation_key) THEN RETURN NEW; END IF;
  SELECT * INTO settings FROM library_settings WHERE id=1 FOR UPDATE;
  IF NEW.state<>'reserved' THEN RETURN NEW; END IF;
  IF NOT settings.enabled THEN RAISE EXCEPTION 'generation_disabled' USING ERRCODE='P0001'; END IF;
  SELECT * INTO totals FROM library_spend_totals;
  IF totals.daily+NEW.accounted_micros>settings.daily_micros OR totals.monthly+NEW.accounted_micros>settings.monthly_micros
    THEN RAISE EXCEPTION 'budget_exhausted' USING ERRCODE='P0001'; END IF;
  IF NEW.kind<>'generation' THEN
    IF NOT settings.review_enabled THEN RAISE EXCEPTION 'review_disabled' USING ERRCODE='P0001'; END IF;
    IF totals.review_daily+NEW.accounted_micros>settings.review_daily_micros OR totals.review_monthly+NEW.accounted_micros>settings.review_monthly_micros
      THEN RAISE EXCEPTION 'review_budget_exhausted' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER admit_library_spend BEFORE INSERT ON library_spend_operations
FOR EACH ROW EXECUTE FUNCTION library_admit_spend();

CREATE TABLE IF NOT EXISTS library_spend_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES library_spend_operations(id),state text NOT NULL,
  accounted_micros bigint NOT NULL,provider_id text,error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION library_audit_spend() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' OR (OLD.state,OLD.accounted_micros,OLD.provider_id,OLD.error_code) IS DISTINCT FROM
    (NEW.state,NEW.accounted_micros,NEW.provider_id,NEW.error_code) THEN
    INSERT INTO library_spend_events(operation_id,state,accounted_micros,provider_id,error_code)
    VALUES(NEW.id,NEW.state,NEW.accounted_micros,NEW.provider_id,NEW.error_code);
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER audit_library_spend AFTER INSERT OR UPDATE ON library_spend_operations
FOR EACH ROW EXECUTE FUNCTION library_audit_spend();
CREATE OR REPLACE TRIGGER immutable_library_spend_event BEFORE UPDATE OR DELETE ON library_spend_events
FOR EACH ROW EXECUTE FUNCTION library_immutable_revision();
INSERT INTO library_spend_events(operation_id,state,accounted_micros,provider_id,error_code)
SELECT o.id,o.state,o.accounted_micros,o.provider_id,o.error_code FROM library_spend_operations o
WHERE NOT EXISTS(SELECT 1 FROM library_spend_events e WHERE e.operation_id=o.id);
REVOKE ALL ON translation_revisions,translation_heads,translation_reviews,library_spend_operations,library_spend_totals,library_spend_events FROM PUBLIC;
COMMIT;
