BEGIN;
CREATE TABLE app_attest_keys (
  key_id text PRIMARY KEY, user_id text NOT NULL REFERENCES library_users(id),
  audience text NOT NULL, bundle_id text NOT NULL, environment text NOT NULL,
  public_key text NOT NULL, receipt bytea NOT NULL, sign_count bigint NOT NULL DEFAULT 0,
  revoked boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_auth_challenges (
  digest text PRIMARY KEY, user_id text NOT NULL REFERENCES library_users(id),
  credential_digest text NOT NULL REFERENCES library_tokens(digest), key_id text NOT NULL,
  audience text NOT NULL, bundle_id text NOT NULL, purpose text NOT NULL CHECK(purpose IN ('register','session')),
  expires_at timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false
);
CREATE INDEX app_auth_challenge_expiry ON app_auth_challenges(expires_at);
CREATE TABLE app_auth_sessions (
  digest text PRIMARY KEY, key_id text NOT NULL REFERENCES app_attest_keys(key_id),
  credential_digest text NOT NULL REFERENCES library_tokens(digest), audience text NOT NULL,
  expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE INDEX app_auth_session_expiry ON app_auth_sessions(expires_at);
ALTER TABLE library_users ADD COLUMN auth_window timestamptz,
  ADD COLUMN auth_count integer NOT NULL DEFAULT 0,
  ADD COLUMN refresh_window timestamptz,
  ADD COLUMN refresh_count integer NOT NULL DEFAULT 0;
ALTER TABLE library_settings ADD COLUMN emergency_daily_micros bigint NOT NULL DEFAULT 5000000 CHECK(emergency_daily_micros>=0),
  ADD COLUMN emergency_monthly_micros bigint NOT NULL DEFAULT 50000000 CHECK(emergency_monthly_micros>=0);
CREATE OR REPLACE FUNCTION library_admit_spend() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE settings library_settings%ROWTYPE; totals record;
BEGIN
  IF EXISTS(SELECT 1 FROM library_spend_operations WHERE operation_key=NEW.operation_key) THEN RETURN NEW; END IF;
  SELECT * INTO settings FROM library_settings WHERE id=1 FOR UPDATE;
  IF NEW.state<>'reserved' THEN RETURN NEW; END IF;
  IF NOT settings.enabled THEN RAISE EXCEPTION 'generation_disabled' USING ERRCODE='P0001'; END IF;
  SELECT * INTO totals FROM library_spend_totals;
  IF totals.daily+NEW.accounted_micros>settings.emergency_daily_micros OR totals.monthly+NEW.accounted_micros>settings.emergency_monthly_micros
    THEN RAISE EXCEPTION 'emergency_budget_exhausted' USING ERRCODE='P0001'; END IF;
  IF (NEW.kind='generation' AND EXISTS(
    SELECT 1 FROM translation_jobs j JOIN library_users u ON u.id=j.user_id
    WHERE j.id=NEW.generation_job_id AND u.unlimited_generation AND NOT u.disabled
  )) OR (NEW.kind='study_explanation' AND EXISTS(
    SELECT 1 FROM study_explanations e JOIN library_users u ON u.id=e.user_id
    WHERE e.id=NEW.explanation_id AND u.unlimited_generation AND NOT u.disabled
  )) THEN RETURN NEW; END IF;
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
