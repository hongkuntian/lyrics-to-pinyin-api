BEGIN;
CREATE TABLE study_explanations (
 id uuid PRIMARY KEY, cache_key text NOT NULL UNIQUE,
 document_id text NOT NULL REFERENCES lyric_documents(id), revision_id uuid NOT NULL REFERENCES translation_revisions(id),
 source_id text NOT NULL, lower_offset integer NOT NULL, upper_offset integer NOT NULL,
 recipe text NOT NULL, user_id text NOT NULL REFERENCES library_users(id),
 state text NOT NULL CHECK(state IN ('queued','running','ready','failed','unknown')),
 content jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(lower_offset>=0 AND upper_offset>lower_offset AND upper_offset-lower_offset<=80)
);
ALTER TABLE library_spend_operations ADD COLUMN explanation_id uuid UNIQUE REFERENCES study_explanations(id);
ALTER TABLE library_spend_operations DROP CONSTRAINT library_spend_operations_kind_check;
ALTER TABLE library_spend_operations ADD CHECK(kind IN ('generation','review_assessment','review_verification','study_explanation'));
ALTER TABLE library_spend_operations DROP CONSTRAINT library_spend_operations_check;
ALTER TABLE library_spend_operations ADD CHECK(
 (kind='generation' AND generation_job_id IS NOT NULL AND review_id IS NULL AND explanation_id IS NULL) OR
 (kind IN ('review_assessment','review_verification') AND generation_job_id IS NULL AND review_id IS NOT NULL AND explanation_id IS NULL) OR
 (kind='study_explanation' AND generation_job_id IS NULL AND review_id IS NULL AND explanation_id IS NOT NULL));
CREATE OR REPLACE VIEW library_spend_totals AS
SELECT
  coalesce(sum(accounted_micros) FILTER(WHERE state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS daily,
  coalesce(sum(accounted_micros) FILTER(WHERE state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS monthly,
  coalesce(sum(accounted_micros) FILTER(WHERE state IN ('reserved','submitted','unknown')),0) AS held,
  coalesce(sum(accounted_micros) FILTER(WHERE kind IN ('review_assessment','review_verification') AND (state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),0) AS review_daily,
  coalesce(sum(accounted_micros) FILTER(WHERE kind IN ('review_assessment','review_verification') AND (state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),0) AS review_monthly
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
  IF NEW.kind IN ('review_assessment','review_verification') THEN
    IF NOT settings.review_enabled THEN RAISE EXCEPTION 'review_disabled' USING ERRCODE='P0001'; END IF;
    IF totals.review_daily+NEW.accounted_micros>settings.review_daily_micros OR totals.review_monthly+NEW.accounted_micros>settings.review_monthly_micros
      THEN RAISE EXCEPTION 'review_budget_exhausted' USING ERRCODE='P0001'; END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON study_explanations FROM PUBLIC;
COMMIT;
