BEGIN;
-- Private publishing credentials only. Public runtime has read-only access.
CREATE SEQUENCE IF NOT EXISTS public.prepared_publication_generation;
CREATE TABLE IF NOT EXISTS public.prepared_editions (
 edition_id text PRIMARY KEY CHECK(edition_id ~ '^[a-f0-9]{64}$'),
 generation bigint NOT NULL UNIQUE DEFAULT nextval('public.prepared_publication_generation'),
 state text NOT NULL CHECK(state IN ('published','withdrawn')),
 bundle jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Retain tombstones forever: withdrawal cannot turn a former starter into a paid song.
CREATE TABLE IF NOT EXISTS public.prepared_edition_variants (
 variant_key text NOT NULL,
 edition_id text NOT NULL REFERENCES public.prepared_editions(edition_id),
 PRIMARY KEY(variant_key,edition_id)
);
-- Offline generation reserves the whole approved ceiling in the existing budget.
CREATE TABLE IF NOT EXISTS public.prepared_generation_runs (
 plan_id text PRIMARY KEY CHECK(plan_id ~ '^[a-f0-9]{64}$'),
 ceiling_micros bigint NOT NULL CHECK(ceiling_micros BETWEEN 0 AND 9007199254740991),
 accounted_micros bigint NOT NULL CHECK(accounted_micros BETWEEN 0 AND 9007199254740991),
 state text NOT NULL CHECK(state IN ('reserved','unknown','settled')),
 settled_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.prepared_generation_attempts (
 plan_id text NOT NULL REFERENCES public.prepared_generation_runs(plan_id),task_id text NOT NULL,attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),
 state text NOT NULL CHECK(state IN ('submitted','ready','unknown')),
 accounted_micros bigint NOT NULL CHECK(accounted_micros>=0),content jsonb,
 PRIMARY KEY(plan_id,task_id,attempt)
);
CREATE OR REPLACE VIEW public.library_spend_totals AS
SELECT
 coalesce(sum(accounted_micros) FILTER(WHERE state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS daily,
 coalesce(sum(accounted_micros) FILTER(WHERE state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS monthly,
 coalesce(sum(accounted_micros) FILTER(WHERE state IN ('reserved','submitted','unknown')),0) AS held,
 coalesce(sum(accounted_micros) FILTER(WHERE kind IN ('review_assessment','review_verification') AND (state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),0) AS review_daily,
 coalesce(sum(accounted_micros) FILTER(WHERE kind IN ('review_assessment','review_verification') AND (state IN ('reserved','submitted','unknown') OR settled_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')),0) AS review_monthly
FROM (
 SELECT accounted_micros,state,settled_at,kind FROM public.library_spend_operations
 UNION ALL
 SELECT accounted_micros,state,settled_at,'prepared_generation' FROM public.prepared_generation_runs
) operations;
REVOKE ALL ON public.prepared_generation_runs,public.prepared_generation_attempts FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyrica_runtime_v1')
  AND to_regclass('public.prepared_editions') IS NOT NULL AND to_regclass('public.prepared_edition_variants') IS NOT NULL THEN
  GRANT SELECT ON public.prepared_editions,public.prepared_edition_variants TO lyrica_runtime_v1;
  REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON public.prepared_editions,public.prepared_edition_variants FROM lyrica_runtime_v1;
 END IF;
END $$;
COMMIT;
