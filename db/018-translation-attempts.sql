BEGIN;
SET LOCAL lock_timeout='5s';
LOCK TABLE translation_jobs,library_spend_operations IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE translation_jobs ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK(attempt>0);
ALTER TABLE translation_jobs ADD COLUMN attempt_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE translation_jobs ADD COLUMN attempt_created_at timestamptz NOT NULL DEFAULT now();
UPDATE translation_jobs SET attempt_id=id,attempt_created_at=created_at;
ALTER TABLE library_spend_operations DROP CONSTRAINT library_spend_operations_generation_job_id_key;
ALTER TABLE library_spend_operations ADD COLUMN generation_attempt integer;
UPDATE library_spend_operations SET generation_attempt=1 WHERE generation_job_id IS NOT NULL;
ALTER TABLE library_spend_operations ADD CONSTRAINT generation_attempt_unique UNIQUE(generation_job_id,generation_attempt);
ALTER TABLE library_spend_operations ADD CONSTRAINT generation_attempt_required CHECK((generation_job_id IS NULL AND generation_attempt IS NULL) OR (generation_job_id IS NOT NULL AND generation_attempt IS NOT NULL AND generation_attempt>0));
CREATE TABLE translation_attempt_history (
  job_id uuid NOT NULL REFERENCES translation_jobs(id),attempt integer NOT NULL,
  operation_id uuid NOT NULL REFERENCES library_spend_operations(id),recipe text NOT NULL,generation_request jsonb,
  state text NOT NULL,reserved_micros bigint NOT NULL,accounted_micros bigint NOT NULL,cost_final boolean NOT NULL,
  error_code text,provider_response jsonb,created_at timestamptz NOT NULL,started_at timestamptz,finished_at timestamptz,
  PRIMARY KEY(job_id,attempt)
);
CREATE TABLE translation_retry_requests (
  request_key text PRIMARY KEY,request_hash text NOT NULL,job_id uuid NOT NULL REFERENCES translation_jobs(id),
  attempt integer NOT NULL,actor text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,attempt)
);
CREATE OR REPLACE FUNCTION library_sync_generation_spend() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final boolean; operation_state text; operation_id uuid;
BEGIN
  final := NEW.state IN ('ready','failed') AND (NEW.cost_final OR library_has_final_usage(NEW.provider_response));
  operation_state := CASE WHEN NEW.state='queued' THEN 'reserved' WHEN NEW.state='running' THEN 'submitted'
    WHEN coalesce(final,false) THEN 'settled' ELSE 'unknown' END;
  operation_id := CASE WHEN NEW.attempt=1 THEN NEW.id ELSE NEW.attempt_id END;
  INSERT INTO library_spend_operations(id,operation_key,kind,generation_job_id,generation_attempt,state,reserved_micros,accounted_micros,
    provider_id,error_code,created_at,submitted_at,settled_at)
  VALUES(operation_id,CASE WHEN NEW.attempt=1 THEN 'generation:'||NEW.id ELSE 'generation:'||NEW.id||':attempt:'||NEW.attempt END,
    'generation',NEW.id,NEW.attempt,operation_state,NEW.reserved_micros,NEW.accounted_micros,
    NEW.provider_response->>'id',NEW.error_code,CASE WHEN NEW.attempt=1 THEN NEW.created_at ELSE NEW.attempt_created_at END,NEW.started_at,
    CASE WHEN operation_state='settled' THEN coalesce(NEW.finished_at,NEW.attempt_created_at) END)
  ON CONFLICT(generation_job_id,generation_attempt) DO UPDATE SET state=EXCLUDED.state,accounted_micros=EXCLUDED.accounted_micros,
    provider_id=EXCLUDED.provider_id,error_code=EXCLUDED.error_code,submitted_at=EXCLUDED.submitted_at,settled_at=EXCLUDED.settled_at;
  IF NEW.state IN ('ready','failed','unknown') THEN
    INSERT INTO translation_attempt_history(job_id,attempt,operation_id,recipe,generation_request,state,reserved_micros,accounted_micros,
      cost_final,error_code,provider_response,created_at,started_at,finished_at)
    VALUES(NEW.id,NEW.attempt,operation_id,NEW.recipe,NEW.generation_request,NEW.state,NEW.reserved_micros,NEW.accounted_micros,
      coalesce(final,false),NEW.error_code,NEW.provider_response,NEW.attempt_created_at,NEW.started_at,NEW.finished_at)
    ON CONFLICT(job_id,attempt) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
INSERT INTO translation_attempt_history(job_id,attempt,operation_id,recipe,generation_request,state,reserved_micros,accounted_micros,
  cost_final,error_code,provider_response,created_at,started_at,finished_at)
SELECT id,1,id,recipe,generation_request,state,reserved_micros,accounted_micros,
  coalesce(cost_final OR library_has_final_usage(provider_response),false),error_code,provider_response,created_at,started_at,finished_at
FROM translation_jobs WHERE state IN ('ready','failed','unknown');
CREATE TRIGGER immutable_translation_attempt BEFORE UPDATE OR DELETE ON translation_attempt_history
FOR EACH ROW EXECUTE FUNCTION library_immutable_revision();
CREATE TRIGGER immutable_translation_retry BEFORE UPDATE OR DELETE ON translation_retry_requests
FOR EACH ROW EXECUTE FUNCTION library_immutable_revision();
REVOKE ALL ON translation_attempt_history,translation_retry_requests FROM PUBLIC;
COMMIT;
