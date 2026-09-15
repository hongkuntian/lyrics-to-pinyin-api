BEGIN;
CREATE SCHEMA lyra_dashboard_control;
REVOKE ALL ON SCHEMA lyra_dashboard_control FROM PUBLIC;
CREATE TABLE lyra_dashboard_control.operators (
  subject text PRIMARY KEY CHECK(length(subject) BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE lyra_dashboard_control.actions (
  id uuid PRIMARY KEY,
  actor text NOT NULL REFERENCES lyra_dashboard_control.operators(subject),
  kind text NOT NULL CHECK(kind IN ('control','rollback')),
  document_id text REFERENCES public.lyric_documents(id),
  request jsonb NOT NULL, before_state jsonb NOT NULL, after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION lyra_dashboard_control.immutable_action() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'dashboard_audit_immutable'; END $$;
CREATE TRIGGER immutable_action BEFORE UPDATE OR DELETE ON lyra_dashboard_control.actions
FOR EACH ROW EXECUTE FUNCTION lyra_dashboard_control.immutable_action();

ALTER TABLE public.library_settings ADD COLUMN control_version bigint NOT NULL DEFAULT 1;
CREATE FUNCTION lyra_dashboard_control.advance_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.control_version := OLD.control_version + 1; RETURN NEW; END $$;
CREATE TRIGGER advance_control_version BEFORE UPDATE ON public.library_settings
FOR EACH ROW EXECUTE FUNCTION lyra_dashboard_control.advance_version();

CREATE FUNCTION lyra_dashboard_control.set_control(
  p_actor text,p_request_id uuid,p_expected_version bigint,p_control text,p_enabled boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE s public.library_settings; prior lyra_dashboard_control.actions;
  requested jsonb; previous jsonb; result jsonb;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM lyra_dashboard_control.operators WHERE subject=p_actor AND enabled) THEN
    RAISE EXCEPTION 'owner_required';
  END IF;
  IF p_request_id IS NULL OR p_expected_version IS NULL OR p_expected_version<1 OR p_enabled IS NULL
     OR p_control IS NULL OR p_control NOT IN ('paid_work','reviews','publication') THEN
    RAISE EXCEPTION 'invalid_control';
  END IF;
  SELECT * INTO s FROM public.library_settings WHERE id=1 FOR UPDATE;
  requested := jsonb_build_object('version',p_expected_version,'control',p_control,'enabled',p_enabled);
  SELECT * INTO prior FROM lyra_dashboard_control.actions WHERE id=p_request_id;
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
  INSERT INTO lyra_dashboard_control.actions(id,actor,kind,request,before_state,after_state)
    VALUES(p_request_id,p_actor,'control',requested,previous,result);
  RETURN result;
END $$;

CREATE FUNCTION lyra_dashboard_control.rollback_translation(
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
    WHERE r.id=p_expected AND t.document_id=p_document AND t.target='en' FOR UPDATE OF t;
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
  IF base.source_hash<>p_source_hash OR NOT EXISTS(SELECT 1 FROM public.lyric_documents WHERE id=p_document AND source_hash=p_source_hash) THEN
    RAISE EXCEPTION 'source_changed';
  END IF;
  SELECT * INTO restored FROM public.translation_revisions WHERE id=p_restore AND translation_id=base.translation_id AND source_hash=p_source_hash;
  IF NOT FOUND THEN RAISE EXCEPTION 'invalid_restore_revision'; END IF;
  IF restored.content=base.content THEN RAISE EXCEPTION 'translation_unchanged'; END IF;
  new_id := gen_random_uuid();
  INSERT INTO public.translation_revisions(id,translation_id,sequence,base_revision_id,source_hash,recipe,content,origin,publication_key,request_hash,actor,reason,restored_from)
    VALUES(new_id,base.translation_id,base.sequence+1,p_expected,p_source_hash,restored.recipe,restored.content,'rollback',
      'dashboard:'||p_request_id,md5(requested::text),p_actor,p_reason,p_restore);
  UPDATE public.translation_heads SET revision_id=new_id WHERE translation_id=base.translation_id AND revision_id=p_expected;
  IF NOT FOUND THEN RAISE EXCEPTION 'translation_revision_superseded'; END IF;
  result := jsonb_build_object('revision_id',new_id,'sequence',base.sequence+1,'restored_from',p_restore);
  INSERT INTO lyra_dashboard_control.actions(id,actor,kind,document_id,request,before_state,after_state)
    VALUES(p_request_id,p_actor,'rollback',p_document,requested,jsonb_build_object('revision_id',p_expected),result);
  RETURN result;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA lyra_dashboard_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA lyra_dashboard_control FROM PUBLIC;

CREATE OR REPLACE VIEW lyra_dashboard.settings WITH (security_barrier=true) AS
SELECT enabled,daily_micros,monthly_micros,user_daily,user_monthly,
  review_enabled,review_daily_micros,review_monthly_micros,review_max_daily,review_publication_enabled,control_version::text
FROM public.library_settings WHERE id=1;
CREATE VIEW lyra_dashboard.revisions WITH (security_barrier=true) AS
SELECT r.id,t.document_id,r.sequence::text,r.base_revision_id,r.source_hash,r.recipe,r.origin,r.actor,r.reason,
  r.restored_from,r.created_at,(h.revision_id=r.id) AS current
FROM public.translation_revisions r JOIN public.song_translations t ON t.id=r.translation_id
JOIN public.translation_heads h ON h.translation_id=t.id WHERE t.target='en';
CREATE VIEW lyra_dashboard.control_actions WITH (security_barrier=true) AS
SELECT id,actor,kind,document_id,before_state,after_state,created_at FROM lyra_dashboard_control.actions;
REVOKE ALL ON lyra_dashboard.revisions,lyra_dashboard.control_actions FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_dashboard_reader') THEN
    GRANT SELECT ON lyra_dashboard.revisions,lyra_dashboard.control_actions TO lyra_dashboard_reader;
  END IF;
END $$;
COMMIT;
