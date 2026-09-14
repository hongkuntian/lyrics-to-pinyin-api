BEGIN;
CREATE OR REPLACE VIEW lyra_dashboard.settings WITH (security_barrier=true) AS
SELECT enabled,daily_micros,monthly_micros,user_daily,user_monthly,
  review_enabled,review_daily_micros,review_monthly_micros,review_max_daily,review_publication_enabled FROM public.library_settings WHERE id=1;
CREATE OR REPLACE VIEW lyra_dashboard.review_queue WITH (security_barrier=true) AS
SELECT q.revision_id,q.state,q.reason,q.first_reported_at,q.last_reported_at,
  r.policy_version,r.model,i.result->>'decision' AS decision,i.result->>'summary' AS summary,
  i.completed_at,b.provider_status,b.updated_at,
  CASE WHEN v.result->>'preferred' IN ('equivalent','uncertain') THEN v.result->>'preferred'
    WHEN v.result->>'preferred'=v.comparison_context->>'candidateSlot' THEN 'correction_preferred'
    WHEN v.result->>'preferred' IN ('A','B') THEN 'current_preferred' END AS comparison,
  v.result->>'summary' AS comparison_summary,o.disposition,o.published_revision_id,o.created_at AS closed_at
FROM public.correction_review_queue q
LEFT JOIN public.translation_reviews r ON r.id=q.review_id
LEFT JOIN public.correction_batch_items i ON i.review_id=r.id AND i.stage='assessment'
LEFT JOIN public.correction_batches b ON b.id=i.batch_id
LEFT JOIN public.correction_batch_items v ON v.review_id=r.id AND v.stage='verification'
LEFT JOIN public.correction_review_outcomes o ON o.review_id=r.id;
CREATE OR REPLACE VIEW lyra_dashboard.review_worker WITH (security_barrier=true) AS
SELECT w.last_run_at,w.last_outcome,b.state AS batch_state,b.provider_status,b.error_code,
  b.created_at AS batch_created_at,b.updated_at AS batch_updated_at,b.stage
FROM public.correction_worker w LEFT JOIN LATERAL (
  SELECT state,provider_status,error_code,created_at,updated_at,stage FROM public.correction_batches ORDER BY created_at DESC,id DESC LIMIT 1
) b ON true WHERE w.id=1;
CREATE VIEW lyra_dashboard.review_changes WITH (security_barrier=true) AS
SELECT i.revision_id,c.ordinality::integer AS position,c.item->>'sourceID' AS source_id,
  c.item->>'sourceQuote' AS source_text,coalesce(l.item->>'lyricText',l.item->>'text') AS before,
  c.item->>'replacement' AS after,c.item->>'reason' AS reason
FROM public.correction_batch_items i JOIN public.translation_revisions r ON r.id=i.revision_id
CROSS JOIN LATERAL jsonb_array_elements(i.result->'changes') WITH ORDINALITY c(item,ordinality)
LEFT JOIN LATERAL jsonb_array_elements(r.content->'lines') l(item) ON l.item->>'sourceID'=c.item->>'sourceID'
WHERE i.stage='assessment' AND i.result->>'decision'='correct';
REVOKE ALL ON lyra_dashboard.review_changes FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_dashboard_reader') THEN
    GRANT SELECT ON lyra_dashboard.review_changes TO lyra_dashboard_reader;
  END IF;
END $$;
COMMIT;
