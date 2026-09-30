BEGIN;
-- Keep curated dashboard contracts aligned with shared containers and attempt ledgers.
CREATE OR REPLACE VIEW lyra_dashboard.songs WITH (security_barrier=true) AS
SELECT d.id,d.source_hash,d.selection_revision,d.created_at,
  d.response->'song'->'title'->>'original' AS title,
  d.response->'song'->'artist'->>'original' AS artist,
  d.response->'song'->>'language' AS language,
  jsonb_array_length(d.structure->'occurrences') AS line_count,
  r.id AS translation_id,r.recipe,r.created_at AS translated_at
FROM public.lyric_documents d
LEFT JOIN public.translation_document_bindings b ON b.document_id=d.id AND b.target='en'
LEFT JOIN public.song_translations t ON t.id=b.translation_id
LEFT JOIN public.translation_heads h ON h.translation_id=t.id
LEFT JOIN public.translation_revisions r ON r.id=h.revision_id
WHERE d.superseded_by IS NULL;

CREATE OR REPLACE VIEW lyra_dashboard.lines WITH (security_barrier=true) AS
SELECT d.id AS document_id,o.ordinality::integer AS position,o.item->>'sourceID' AS source_id,
  coalesce(o.item->>'lyricText',o.item->>'sourceText') AS lyric_text,
  o.item->>'sourceText' AS source_text,
  d.response->'lines'->(o.ordinality::integer-1)->>'romanized' AS pronunciation,
  coalesce(l.item->>'lyricText',l.item->>'text') AS translation,
  r.id AS translation_id
FROM public.lyric_documents d
CROSS JOIN LATERAL jsonb_array_elements(d.structure->'occurrences') WITH ORDINALITY AS o(item,ordinality)
LEFT JOIN public.translation_document_bindings b ON b.document_id=d.id AND b.target='en'
LEFT JOIN public.song_translations t ON t.id=b.translation_id
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
JOIN public.translation_document_bindings b ON b.translation_id=t.id
JOIN public.lyric_documents d ON d.id=b.document_id
CROSS JOIN LATERAL jsonb_array_elements(d.structure->'occurrences') WITH ORDINALITY AS o(item,ordinality)
LEFT JOIN LATERAL jsonb_array_elements(r.content->'lines') AS l(item) ON l.item->>'sourceID'=o.item->>'sourceID'
WHERE d.superseded_by IS NULL;

CREATE OR REPLACE VIEW lyra_dashboard.jobs WITH (security_barrier=true) AS
SELECT j.id,j.document_id,j.target,j.recipe,j.state,j.created_at,j.started_at,j.finished_at,
  j.error_code,j.reserved_micros,totals.accounted_micros,
  (j.state IN ('queued','running') AND coalesce(j.started_at,j.attempt_created_at)<now()-interval '6 minutes') AS stalled,
  CASE WHEN totals.held THEN 'reserved' ELSE 'estimated' END AS cost_kind,
  coalesce(d.response->'song'->'title'->>'original',context.response->'song'->'title'->>'original') AS title,
  coalesce(d.response->'song'->'artist'->>'original',context.response->'song'->'artist'->>'original') AS artist
FROM public.translation_jobs j JOIN public.lyric_documents d ON d.id=j.document_id
CROSS JOIN LATERAL (SELECT coalesce(sum(o.accounted_micros),j.accounted_micros)::bigint AS accounted_micros,
  coalesce(bool_or(o.state IN ('reserved','submitted','unknown')),true) AS held
  FROM public.library_spend_operations o WHERE o.generation_job_id=j.id) totals
LEFT JOIN LATERAL (SELECT next.response FROM public.translation_document_bindings b
  JOIN public.lyric_documents next ON next.id=b.document_id WHERE b.translation_id=j.id AND next.superseded_by IS NULL
  ORDER BY b.created_at,b.document_id LIMIT 1) context ON true;

CREATE OR REPLACE VIEW lyra_dashboard.revisions WITH (security_barrier=true) AS
SELECT r.id,b.document_id,r.sequence::text,r.base_revision_id,r.source_hash,r.recipe,r.origin,r.actor,r.reason,
  r.restored_from,r.created_at,(h.revision_id=r.id) AS current
FROM public.translation_revisions r JOIN public.song_translations t ON t.id=r.translation_id
JOIN public.translation_heads h ON h.translation_id=t.id
JOIN public.translation_document_bindings b ON b.translation_id=t.id
JOIN public.lyric_documents d ON d.id=b.document_id WHERE t.target='en' AND d.superseded_by IS NULL;
CREATE OR REPLACE FUNCTION lyra_dashboard_control.rollback_translation(
  p_actor text,p_request_id uuid,p_document text,p_source_hash text,p_expected uuid,p_restore uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE base public.translation_revisions; restored public.translation_revisions;
  prior lyra_dashboard_control.actions; requested jsonb; result jsonb; new_id uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM lyra_dashboard_control.operators WHERE subject=p_actor AND enabled) THEN RAISE EXCEPTION 'owner_required'; END IF;
  IF p_request_id IS NULL OR p_expected IS NULL OR p_restore IS NULL OR p_reason IS NULL
    OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 OR p_document IS NULL OR p_source_hash IS NULL THEN
    RAISE EXCEPTION 'invalid_rollback';
  END IF;
  -- All publishers lock this stable container. A worker and owner cannot move the same head together.
  PERFORM t.id FROM public.song_translations t JOIN public.translation_revisions r ON r.translation_id=t.id
    JOIN public.translation_document_bindings binding ON binding.translation_id=t.id
    WHERE r.id=p_expected AND binding.document_id=p_document AND t.target='en' FOR UPDATE OF t;
  IF NOT FOUND THEN RAISE EXCEPTION 'translation_not_found'; END IF;
  requested := jsonb_build_object('document',p_document,'source',p_source_hash,'expected',p_expected,'restore',p_restore,'reason',p_reason);
  SELECT * INTO prior FROM lyra_dashboard_control.actions WHERE id=p_request_id;
  IF FOUND THEN
    IF prior.actor<>p_actor OR prior.kind<>'rollback' OR prior.request<>requested THEN RAISE EXCEPTION 'action_key_conflict'; END IF;
    RETURN prior.after_state;
  END IF;
  SELECT * INTO base FROM public.translation_revisions WHERE id=p_expected;
  IF NOT EXISTS(SELECT 1 FROM public.translation_heads WHERE translation_id=base.translation_id AND revision_id=p_expected) THEN
    RAISE EXCEPTION 'translation_revision_superseded';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.lyric_documents WHERE id=p_document AND source_hash=p_source_hash AND superseded_by IS NULL)
    OR NOT EXISTS(SELECT 1 FROM public.song_translations t JOIN public.lyric_documents d ON d.id=t.document_id
      WHERE t.id=base.translation_id AND d.source_hash=base.source_hash) THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  SELECT * INTO restored FROM public.translation_revisions WHERE id=p_restore AND translation_id=base.translation_id AND source_hash=base.source_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_restore_revision'; END IF;
  IF restored.content=base.content THEN RAISE EXCEPTION 'translation_unchanged'; END IF;
  new_id := gen_random_uuid();
  INSERT INTO public.translation_revisions(id,translation_id,sequence,base_revision_id,source_hash,recipe,content,origin,publication_key,request_hash,actor,reason,restored_from)
    VALUES(new_id,base.translation_id,base.sequence+1,p_expected,base.source_hash,restored.recipe,restored.content,'rollback',
      'dashboard:'||p_request_id,md5(requested::text),p_actor,p_reason,p_restore);
  UPDATE public.translation_heads SET revision_id=new_id WHERE translation_id=base.translation_id AND revision_id=p_expected;
  IF NOT FOUND THEN RAISE EXCEPTION 'translation_revision_superseded'; END IF;
  result := jsonb_build_object('revision_id',new_id,'sequence',base.sequence+1,'restored_from',p_restore);
  INSERT INTO lyra_dashboard_control.actions(id,actor,kind,document_id,request,before_state,after_state)
    VALUES(p_request_id,p_actor,'rollback',p_document,requested,jsonb_build_object('revision_id',p_expected),result);
  RETURN result;
END $$;
COMMIT;
