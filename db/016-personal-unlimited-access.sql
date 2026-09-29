BEGIN;
-- Only explicit operator grants opt a user out of generation allowances and spend caps.
ALTER TABLE library_users ADD COLUMN unlimited_generation boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION library_admit_spend() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings library_settings%ROWTYPE; totals record;
BEGIN
  -- Existing entries are reconciliations, not new admissions (including ON CONFLICT).
  IF EXISTS(SELECT 1 FROM library_spend_operations WHERE operation_key=NEW.operation_key) THEN RETURN NEW; END IF;
  SELECT * INTO settings FROM library_settings WHERE id=1 FOR UPDATE;
  IF NEW.state<>'reserved' THEN RETURN NEW; END IF;
  IF NOT settings.enabled THEN RAISE EXCEPTION 'generation_disabled' USING ERRCODE='P0001'; END IF;
  -- Resolve the actual account from the durable job, never from caller-supplied flags.
  -- Reviews have independent budgets; personal access applies only to translations and Study.
  IF (NEW.kind='generation' AND EXISTS(
    SELECT 1 FROM translation_jobs j JOIN library_users u ON u.id=j.user_id
    WHERE j.id=NEW.generation_job_id AND u.unlimited_generation AND NOT u.disabled
  )) OR (NEW.kind='study_explanation' AND EXISTS(
    SELECT 1 FROM study_explanations e JOIN library_users u ON u.id=e.user_id
    WHERE e.id=NEW.explanation_id AND u.unlimited_generation AND NOT u.disabled
  )) THEN RETURN NEW; END IF;
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
COMMIT;
