BEGIN;
CREATE OR REPLACE VIEW lyra_dashboard.settings WITH (security_barrier=true) AS
SELECT enabled,daily_micros,monthly_micros,user_daily,user_monthly,
  review_enabled,review_daily_micros,review_monthly_micros,review_max_daily FROM public.library_settings WHERE id=1;

CREATE OR REPLACE VIEW lyra_dashboard.songs WITH (security_barrier=true) AS
SELECT d.id,d.source_hash,d.selection_revision,d.created_at,
  d.response->'song'->'title'->>'original' AS title,
  d.response->'song'->'artist'->>'original' AS artist,
  d.response->'song'->>'language' AS language,
  jsonb_array_length(d.structure->'occurrences') AS line_count,
  r.id AS translation_id,r.recipe,r.created_at AS translated_at
FROM public.lyric_documents d
LEFT JOIN public.song_translations t ON t.document_id=d.id AND t.target='en'
LEFT JOIN public.translation_heads h ON h.translation_id=t.id
LEFT JOIN public.translation_revisions r ON r.id=h.revision_id;

CREATE OR REPLACE VIEW lyra_dashboard.lines WITH (security_barrier=true) AS
SELECT d.id AS document_id,o.ordinality::integer AS position,o.item->>'sourceID' AS source_id,
  coalesce(o.item->>'lyricText',o.item->>'sourceText') AS lyric_text,
  o.item->>'sourceText' AS source_text,
  d.response->'lines'->(o.ordinality::integer-1)->>'romanized' AS pronunciation,
  coalesce(l.item->>'lyricText',l.item->>'text') AS translation,
  r.id AS translation_id
FROM public.lyric_documents d
CROSS JOIN LATERAL jsonb_array_elements(d.structure->'occurrences') WITH ORDINALITY AS o(item,ordinality)
LEFT JOIN public.song_translations t ON t.document_id=d.id AND t.target='en'
LEFT JOIN public.translation_heads h ON h.translation_id=t.id
LEFT JOIN public.translation_revisions r ON r.id=h.revision_id
LEFT JOIN LATERAL jsonb_array_elements(r.content->'lines') AS l(item)
  ON l.item->>'sourceID'=o.item->>'sourceID';

CREATE OR REPLACE VIEW lyra_dashboard.revision_lines WITH (security_barrier=true) AS
SELECT d.id AS document_id,o.ordinality::integer AS position,o.item->>'sourceID' AS source_id,
  coalesce(o.item->>'lyricText',o.item->>'sourceText') AS lyric_text,
  o.item->>'sourceText' AS source_text,
  d.response->'lines'->(o.ordinality::integer-1)->>'romanized' AS pronunciation,
  coalesce(l.item->>'lyricText',l.item->>'text') AS translation,r.id AS translation_id
FROM public.translation_revisions r JOIN public.song_translations t ON t.id=r.translation_id
JOIN public.lyric_documents d ON d.id=t.document_id
CROSS JOIN LATERAL jsonb_array_elements(d.structure->'occurrences') WITH ORDINALITY AS o(item,ordinality)
LEFT JOIN LATERAL jsonb_array_elements(r.content->'lines') AS l(item) ON l.item->>'sourceID'=o.item->>'sourceID';

CREATE OR REPLACE VIEW lyra_dashboard.spend WITH (security_barrier=true) AS
SELECT id,kind,state,reserved_micros,accounted_micros,created_at,settled_at,
  CASE WHEN state='settled' THEN 'estimated' ELSE 'reserved' END AS cost_kind
FROM public.library_spend_operations;
CREATE OR REPLACE VIEW lyra_dashboard.budget WITH (security_barrier=true) AS SELECT * FROM public.library_spend_totals;
REVOKE ALL ON ALL TABLES IN SCHEMA lyra_dashboard FROM PUBLIC;
-- Existing reader logins need SELECT on the new curated views, never on their source tables.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_dashboard_reader') THEN
    GRANT SELECT ON lyra_dashboard.spend,lyra_dashboard.budget,lyra_dashboard.revision_lines TO lyra_dashboard_reader;
  END IF;
END $$;
COMMIT;
