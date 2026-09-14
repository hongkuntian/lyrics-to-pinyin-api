BEGIN;
CREATE SCHEMA IF NOT EXISTS lyra_dashboard;
REVOKE ALL ON SCHEMA lyra_dashboard FROM PUBLIC;

-- Definer views deliberately expose a smaller surface than the library tables.
-- The runtime login receives SELECT on these views only, never table privileges.
CREATE OR REPLACE VIEW lyra_dashboard.settings WITH (security_barrier=true) AS
SELECT enabled,daily_micros,monthly_micros,user_daily,user_monthly FROM public.library_settings WHERE id=1;

CREATE OR REPLACE VIEW lyra_dashboard.songs WITH (security_barrier=true) AS
SELECT d.id,d.source_hash,d.selection_revision,d.created_at,
  d.response->'song'->'title'->>'original' AS title,
  d.response->'song'->'artist'->>'original' AS artist,
  d.response->'song'->>'language' AS language,
  jsonb_array_length(d.structure->'occurrences') AS line_count,
  t.id AS translation_id,t.recipe,t.created_at AS translated_at
FROM public.lyric_documents d
LEFT JOIN public.song_translations t ON t.document_id=d.id AND t.target='en';

CREATE OR REPLACE VIEW lyra_dashboard.jobs WITH (security_barrier=true) AS
SELECT j.id,j.document_id,j.target,j.recipe,j.state,j.created_at,j.started_at,j.finished_at,
  j.error_code,j.reserved_micros,j.accounted_micros,
  (j.state IN ('queued','running') AND coalesce(j.started_at,j.created_at)<now()-interval '6 minutes') AS stalled,
  CASE WHEN j.state IN ('queued','running','unknown') THEN 'reserved'
    WHEN jsonb_typeof(j.provider_response->'usage'->'input_tokens')='number'
      AND jsonb_typeof(j.provider_response->'usage'->'output_tokens')='number'
      AND (j.provider_response->'usage'->>'input_tokens') ~ '^[0-9]{1,8}$'
      AND (j.provider_response->'usage'->>'output_tokens') ~ '^[0-9]{1,8}$'
    THEN CASE WHEN (j.provider_response->'usage'->>'input_tokens')::bigint<=10000000
      AND (j.provider_response->'usage'->>'output_tokens')::bigint<=10000000
      THEN 'estimated' ELSE 'reserved' END
    ELSE 'reserved' END AS cost_kind,
  d.response->'song'->'title'->>'original' AS title,
  d.response->'song'->'artist'->>'original' AS artist
FROM public.translation_jobs j JOIN public.lyric_documents d ON d.id=j.document_id;

CREATE OR REPLACE VIEW lyra_dashboard.lines WITH (security_barrier=true) AS
SELECT d.id AS document_id,o.ordinality::integer AS position,o.item->>'sourceID' AS source_id,
  coalesce(o.item->>'lyricText',o.item->>'sourceText') AS lyric_text,
  o.item->>'sourceText' AS source_text,
  d.response->'lines'->(o.ordinality::integer-1)->>'romanized' AS pronunciation,
  coalesce(l.item->>'lyricText',l.item->>'text') AS translation,
  t.id AS translation_id
FROM public.lyric_documents d
CROSS JOIN LATERAL jsonb_array_elements(d.structure->'occurrences') WITH ORDINALITY AS o(item,ordinality)
LEFT JOIN public.song_translations t ON t.document_id=d.id AND t.target='en'
LEFT JOIN LATERAL jsonb_array_elements(t.content->'lines') AS l(item)
  ON l.item->>'sourceID'=o.item->>'sourceID';

CREATE OR REPLACE VIEW lyra_dashboard.reports WITH (security_barrier=true) AS
SELECT r.id,r.document_id,r.translation_id,r.source_id,r.category,r.detail,r.status,r.created_at,
  d.response->'song'->'title'->>'original' AS title,
  d.response->'song'->'artist'->>'original' AS artist
FROM public.correction_reports r JOIN public.lyric_documents d ON d.id=r.document_id;
REVOKE ALL ON ALL TABLES IN SCHEMA lyra_dashboard FROM PUBLIC;
COMMIT;
