BEGIN;
CREATE TABLE correction_review_queue (
  revision_id uuid PRIMARY KEY REFERENCES translation_revisions(id),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','reserved','submitted','assessed','blocked','superseded')),
  review_id uuid UNIQUE REFERENCES translation_reviews(id),
  reason text,
  first_reported_at timestamptz NOT NULL DEFAULT now(),
  last_reported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX correction_queue_pending ON correction_review_queue(first_reported_at) WHERE state='pending';
CREATE INDEX correction_reports_translation_review ON correction_reports(translation_id,created_at,id) WHERE category='translation';
CREATE FUNCTION library_queue_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.category='translation' AND NEW.translation_id IS NOT NULL THEN
    INSERT INTO correction_review_queue(revision_id,first_reported_at,last_reported_at)
    VALUES(NEW.translation_id,NEW.created_at,NEW.created_at)
    ON CONFLICT(revision_id) DO UPDATE SET last_reported_at=greatest(correction_review_queue.last_reported_at,EXCLUDED.last_reported_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER library_queue_report AFTER INSERT ON correction_reports FOR EACH ROW EXECUTE FUNCTION library_queue_report();
INSERT INTO correction_review_queue(revision_id,first_reported_at,last_reported_at)
SELECT translation_id,min(created_at),max(created_at) FROM correction_reports
WHERE category='translation' AND translation_id IS NOT NULL AND status='pending' GROUP BY translation_id;

CREATE TABLE correction_worker (
  id integer PRIMARY KEY CHECK(id=1),
  owner uuid, lease_until timestamptz,
  last_run_at timestamptz, last_outcome text
);
INSERT INTO correction_worker(id) VALUES(1);
CREATE TABLE correction_batches (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK(state IN ('prepared','uploading','uploaded','submitting','submitted','completed','cancelled')),
  input_file_id text, provider_batch_id text UNIQUE,
  request_hash text NOT NULL,
  provider_status text, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- One uncertain or unfinished batch blocks new admission. A lease alone cannot prevent
-- duplicate paid work after an interrupted network request.
CREATE UNIQUE INDEX correction_one_active_batch ON correction_batches((true)) WHERE state NOT IN ('completed','cancelled');
CREATE TABLE correction_batch_items (
  operation_id uuid PRIMARY KEY REFERENCES library_spend_operations(id),
  batch_id uuid NOT NULL REFERENCES correction_batches(id),
  review_id uuid UNIQUE NOT NULL REFERENCES translation_reviews(id),
  revision_id uuid UNIQUE NOT NULL REFERENCES translation_revisions(id),
  request_body jsonb NOT NULL, report_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','done','unknown','cancelled')),
  result jsonb, result_hash text, usage jsonb, provider_response_id text, error_code text, completed_at timestamptz
);
CREATE INDEX correction_batch_items_batch ON correction_batch_items(batch_id);
REVOKE ALL ON correction_review_queue,correction_worker,correction_batches,correction_batch_items FROM PUBLIC;
COMMIT;
