BEGIN;
CREATE TABLE library_alert_monitor (
  id integer PRIMARY KEY CHECK(id=1),
  initialized_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz, email_configured boolean NOT NULL DEFAULT false,
  worker_error boolean NOT NULL DEFAULT false
);
INSERT INTO library_alert_monitor(id) VALUES(1);
CREATE TABLE library_alert_deliveries (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK(state IN ('sending','accepted','rejected','unknown')),
  payload jsonb NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, provider_id text, error_code text
);
CREATE INDEX library_alert_delivery_time ON library_alert_deliveries(attempted_at);
CREATE TABLE library_alert_incidents (
  id uuid PRIMARY KEY, code text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  delivery_id uuid REFERENCES library_alert_deliveries(id)
);
CREATE UNIQUE INDEX library_alert_one_open ON library_alert_incidents(code) WHERE resolved_at IS NULL;
CREATE INDEX library_alert_history ON library_alert_incidents(first_seen_at DESC);

-- Live conditions are also readable by the dashboard. This detects a missing
-- scheduler even when no scheduled invocation is available to persist an incident.
CREATE VIEW library_alert_conditions AS
WITH status AS (
 SELECT s.*,b.daily,b.monthly,b.review_daily,b.review_monthly,w.last_run_at,w.last_outcome,
   m.initialized_at,m.last_checked_at,m.worker_error
 FROM library_settings s CROSS JOIN library_spend_totals b CROSS JOIN correction_worker w CROSS JOIN library_alert_monitor m
 WHERE s.id=1 AND w.id=1 AND m.id=1
), conditions(code,active) AS (
 SELECT 'global_budget',enabled AND (daily>=daily_micros OR monthly>=monthly_micros OR
   (review_enabled AND last_outcome='budget_exhausted' AND last_run_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) FROM status
 UNION ALL SELECT 'review_budget',enabled AND review_enabled AND (review_daily>=review_daily_micros OR review_monthly>=review_monthly_micros OR
   (last_outcome='review_budget_exhausted' AND last_run_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')) FROM status
 UNION ALL SELECT 'billing_uncertain',EXISTS(SELECT 1 FROM library_spend_operations WHERE state='unknown')
 UNION ALL SELECT 'generation_stalled',EXISTS(SELECT 1 FROM library_spend_operations WHERE kind IN ('generation','study_explanation')
   AND state IN ('reserved','submitted') AND created_at<now()-interval '10 minutes')
 UNION ALL SELECT 'review_batch_stalled',EXISTS(SELECT 1 FROM correction_batches
   WHERE (state IN ('uploading','submitting','submitted') OR (state IN ('prepared','uploaded') AND
     (SELECT enabled AND review_enabled AND (stage='assessment' OR review_publication_enabled) FROM library_settings WHERE id=1)))
   AND created_at<now()-interval '48 hours')
 UNION ALL SELECT 'review_worker_failure',worker_error OR
   (last_outcome IS NOT NULL AND last_outcome NOT IN ('empty','processing','published','assessed','review_completed',
     'review_disabled','review_allowance_exhausted','submission_paused','budget_exhausted','review_budget_exhausted'))
   OR EXISTS(SELECT 1 FROM correction_batches WHERE state NOT IN ('completed','cancelled') AND error_code IS NOT NULL) FROM status
 UNION ALL SELECT 'safety_pause', EXISTS(
   SELECT 1 FROM library_spend_operations o WHERE error_code IN ('provider_configuration_changed','cost_reservation_exceeded')
   AND (NOT enabled OR (NOT review_enabled AND o.kind IN ('review_assessment','review_verification')))
   AND coalesce(o.settled_at,o.submitted_at,o.created_at)>coalesce(
     (SELECT max(resolved_at) FROM library_alert_incidents WHERE code='safety_pause'),'-infinity'::timestamptz)) FROM status
 UNION ALL SELECT 'scheduler_overdue',coalesce(last_checked_at,initialized_at)<now()-interval '36 hours' FROM status
)
SELECT code FROM conditions WHERE active;

CREATE VIEW lyra_dashboard.alert_conditions WITH (security_barrier=true) AS SELECT code FROM public.library_alert_conditions;
CREATE VIEW lyra_dashboard.alert_incidents WITH (security_barrier=true) AS
 SELECT i.id,i.code,i.first_seen_at,i.last_seen_at,i.resolved_at,d.state AS email_state,d.attempted_at
 FROM public.library_alert_incidents i LEFT JOIN public.library_alert_deliveries d ON d.id=i.delivery_id;
CREATE VIEW lyra_dashboard.alert_monitor WITH (security_barrier=true) AS
 SELECT initialized_at,last_checked_at,email_configured,
   (SELECT count(*)::integer FROM public.library_alert_deliveries WHERE attempted_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS daily_attempts,
   (SELECT count(*)::integer FROM public.library_alert_deliveries WHERE attempted_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS monthly_attempts,
   (SELECT state FROM public.library_alert_deliveries ORDER BY attempted_at DESC,id DESC LIMIT 1) AS last_email_state
 FROM public.library_alert_monitor WHERE id=1;
REVOKE ALL ON library_alert_monitor,library_alert_deliveries,library_alert_incidents,library_alert_conditions FROM PUBLIC;
REVOKE ALL ON lyra_dashboard.alert_conditions,lyra_dashboard.alert_incidents,lyra_dashboard.alert_monitor FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_dashboard_reader') THEN
   GRANT SELECT ON lyra_dashboard.alert_conditions,lyra_dashboard.alert_incidents,lyra_dashboard.alert_monitor TO lyra_dashboard_reader;
 END IF;
END $$;
COMMIT;
