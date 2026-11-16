BEGIN;
-- Hard prerelease cutover. Historical migrations and their receipts stay exact.
-- Schema/role renames retain object identity, rows, owners and ACLs. Use schema
-- owner/role-administration credentials, never a runtime or dashboard login.
DO $lyrica_namespace$
DECLARE source_name text; target_name text; schema_name text; expected record;
BEGIN
  FOR source_name,target_name IN SELECT * FROM (VALUES
    ('lyra_dashboard','lyrica_dashboard'),
    ('lyra_dashboard_control','lyrica_dashboard_control')
  ) AS names(previous,current) LOOP
    IF pg_catalog.to_regnamespace(source_name) IS NOT NULL AND pg_catalog.to_regnamespace(target_name) IS NOT NULL THEN
      RAISE EXCEPTION 'namespace_target_conflict' USING ERRCODE='23514';
    END IF;
    IF pg_catalog.to_regnamespace(source_name) IS NULL AND pg_catalog.to_regnamespace(target_name) IS NULL THEN
      RAISE EXCEPTION 'namespace_source_missing' USING ERRCODE='23514';
    END IF;
  END LOOP;
  FOR source_name,target_name IN SELECT * FROM (VALUES
    ('lyra_runtime_v1','lyrica_runtime_v1'),
    ('lyra_account_v1','lyrica_account_v1'),
    ('lyra_dashboard_reader','lyrica_dashboard_reader'),
    ('lyra_dashboard_operator','lyrica_dashboard_operator')
  ) AS names(previous,current) LOOP
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=source_name)
       AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=target_name) THEN
      RAISE EXCEPTION 'namespace_target_conflict' USING ERRCODE='23514';
    END IF;
    IF current_user=source_name THEN RAISE EXCEPTION 'namespace_owner_required' USING ERRCODE='42501'; END IF;
  END LOOP;
  -- Never overwrite an independently edited owner-control function. Both the
  -- committed historical bodies and an exact direct reapplication are admitted.
  schema_name := CASE WHEN pg_catalog.to_regnamespace('lyra_dashboard_control') IS NOT NULL
    THEN 'lyra_dashboard_control' ELSE 'lyrica_dashboard_control' END;
  FOR expected IN SELECT * FROM (VALUES
    ('immutable_action','8252d1e2487fc88ba402e8a1492bbfc2','8252d1e2487fc88ba402e8a1492bbfc2'),
    ('advance_version','0c3581f87c139a601bc4e0656e335716','0c3581f87c139a601bc4e0656e335716'),
    ('set_control','4159741ed31ca993491266cfe4a93e65','dfaa8b315de29eb531c3e7c3d0280cef'),
    ('rollback_translation','5c0c4128dcebbe407ce4ada089bd27ad','4eab5c80d101a0e8241186d8b96234c7')
  ) AS bodies(name,previous_md5,current_md5) LOOP
    IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=schema_name AND p.proname=expected.name
          AND pg_catalog.md5(p.prosrc) IN (expected.previous_md5,expected.current_md5)
          AND p.prosecdef=(expected.name IN ('set_control','rollback_translation'))
          AND (p.proconfig=ARRAY['search_path=pg_catalog'] OR expected.name IN ('immutable_action','advance_version')))<>1 THEN
      RAISE EXCEPTION 'namespace_function_drift' USING ERRCODE='23514';
    END IF;
  END LOOP;
  FOR source_name,target_name IN SELECT * FROM (VALUES
    ('lyra_dashboard','lyrica_dashboard'),
    ('lyra_dashboard_control','lyrica_dashboard_control')
  ) AS names(previous,current) LOOP
    IF pg_catalog.to_regnamespace(source_name) IS NOT NULL THEN
      EXECUTE pg_catalog.format('ALTER SCHEMA %I RENAME TO %I',source_name,target_name);
    END IF;
  END LOOP;
  FOR source_name,target_name IN SELECT * FROM (VALUES
    ('lyra_runtime_v1','lyrica_runtime_v1'),
    ('lyra_account_v1','lyrica_account_v1'),
    ('lyra_dashboard_reader','lyrica_dashboard_reader'),
    ('lyra_dashboard_operator','lyrica_dashboard_operator')
  ) AS names(previous,current) LOOP
    IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=source_name) THEN
      EXECUTE pg_catalog.format('ALTER ROLE %I RENAME TO %I',source_name,target_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='lyrica_dashboard_reader') THEN
    ALTER ROLE lyrica_dashboard_reader SET search_path=lyrica_dashboard,pg_catalog;
  END IF;
END $lyrica_namespace$;

-- PL/pgSQL source is text, unlike relation/view dependencies: replace only the
-- exact reviewed functions after their source preflight. CREATE OR REPLACE keeps
-- existing function OIDs, ownership and execution grants.
CREATE OR REPLACE FUNCTION lyrica_dashboard_control.immutable_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'dashboard_audit_immutable'; END $$;

CREATE OR REPLACE FUNCTION lyrica_dashboard_control.advance_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.control_version := OLD.control_version + 1; RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION lyrica_dashboard_control.set_control(
  p_actor text,p_request_id uuid,p_expected_version bigint,p_control text,p_enabled boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s public.library_settings; prior lyrica_dashboard_control.actions;
  requested jsonb; previous jsonb; result jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM lyrica_dashboard_control.operators WHERE subject=p_actor AND enabled) THEN
    RAISE EXCEPTION 'owner_required';
  END IF;
  IF p_request_id IS NULL OR p_expected_version IS NULL OR p_expected_version<1 OR p_enabled IS NULL
     OR p_control IS NULL OR p_control NOT IN ('paid_work','reviews','publication') THEN
    RAISE EXCEPTION 'invalid_control';
  END IF;
  SELECT * INTO s FROM public.library_settings WHERE id=1 FOR UPDATE;
  requested := jsonb_build_object('version',p_expected_version,'control',p_control,'enabled',p_enabled);
  SELECT * INTO prior FROM lyrica_dashboard_control.actions WHERE id=p_request_id;
  IF FOUND THEN
    IF prior.actor<>p_actor OR prior.kind<>'control' OR prior.request<>requested THEN RAISE EXCEPTION 'action_key_conflict'; END IF;
    RETURN prior.after_state;
  END IF;
  IF s.control_version<>p_expected_version THEN RAISE EXCEPTION 'controls_changed'; END IF;
  previous := jsonb_build_object('version',s.control_version::text,'paid_work',s.enabled,'reviews',s.review_enabled,'publication',s.review_publication_enabled);
  IF (p_control='paid_work' AND s.enabled=p_enabled) OR (p_control='reviews' AND s.review_enabled=p_enabled)
     OR (p_control='publication' AND s.review_publication_enabled=p_enabled) THEN RAISE EXCEPTION 'control_unchanged'; END IF;
  UPDATE public.library_settings SET
    enabled=CASE WHEN p_control='paid_work' THEN p_enabled ELSE enabled END,
    review_enabled=CASE WHEN p_control='reviews' THEN p_enabled ELSE review_enabled END,
    review_publication_enabled=CASE WHEN p_control='publication' THEN p_enabled ELSE review_publication_enabled END
    WHERE id=1 RETURNING * INTO s;
  result := jsonb_build_object('version',s.control_version::text,'paid_work',s.enabled,'reviews',s.review_enabled,'publication',s.review_publication_enabled);
  INSERT INTO lyrica_dashboard_control.actions(id,actor,kind,request,before_state,after_state)
    VALUES(p_request_id,p_actor,'control',requested,previous,result);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION lyrica_dashboard_control.rollback_translation(
  p_actor text,p_request_id uuid,p_document text,p_source_hash text,p_expected uuid,p_restore uuid,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE base public.translation_revisions; restored public.translation_revisions;
  prior lyrica_dashboard_control.actions; requested jsonb; result jsonb; new_id uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM lyrica_dashboard_control.operators WHERE subject=p_actor AND enabled) THEN RAISE EXCEPTION 'owner_required'; END IF;
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
  SELECT * INTO prior FROM lyrica_dashboard_control.actions WHERE id=p_request_id;
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
  INSERT INTO lyrica_dashboard_control.actions(id,actor,kind,document_id,request,before_state,after_state)
    VALUES(p_request_id,p_actor,'rollback',p_document,requested,jsonb_build_object('revision_id',p_expected),result);
  RETURN result;
END $$;

DO $lyrica_function_check$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='lyrica_dashboard_control' AND p.prosrc LIKE '%lyra_dashboard%') THEN
    RAISE EXCEPTION 'namespace_function_drift' USING ERRCODE='23514';
  END IF;
END $lyrica_function_check$;
COMMIT;
