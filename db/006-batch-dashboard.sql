BEGIN;
CREATE VIEW lyra_dashboard.review_queue WITH (security_barrier=true) AS
SELECT q.revision_id,q.state,q.reason,q.first_reported_at,q.last_reported_at,
  r.policy_version,r.model,i.result->>'decision' AS decision,i.result->>'summary' AS summary,
  i.completed_at,b.provider_status,b.updated_at
FROM public.correction_review_queue q
LEFT JOIN public.translation_reviews r ON r.id=q.review_id
LEFT JOIN public.correction_batch_items i ON i.review_id=r.id
LEFT JOIN public.correction_batches b ON b.id=i.batch_id;
CREATE VIEW lyra_dashboard.review_worker WITH (security_barrier=true) AS
SELECT w.last_run_at,w.last_outcome,b.state AS batch_state,b.provider_status,b.error_code,
  b.created_at AS batch_created_at,b.updated_at AS batch_updated_at
FROM public.correction_worker w LEFT JOIN LATERAL (
  SELECT state,provider_status,error_code,created_at,updated_at FROM public.correction_batches ORDER BY created_at DESC LIMIT 1
) b ON true WHERE w.id=1;
REVOKE ALL ON lyra_dashboard.review_queue,lyra_dashboard.review_worker FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_dashboard_reader') THEN
    GRANT SELECT ON lyra_dashboard.review_queue,lyra_dashboard.review_worker TO lyra_dashboard_reader;
  END IF;
END $$;
COMMIT;
