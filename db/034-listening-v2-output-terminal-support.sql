BEGIN;
-- Source-only/unregistered slice A+B. Migration owner only. SQL NOT EXECUTED
-- by this author. No enrollment, output store, semantic End or Release here.
ALTER TABLE public.app_attest_keys
  ADD COLUMN sessions_install_binding_version smallint
    CONSTRAINT app_attest_keys_sessions_binding_version CHECK (sessions_install_binding_version=1),
  ADD COLUMN sessions_authority_generation listening_v2.safe_uint NOT NULL DEFAULT 0;

CREATE FUNCTION listening_v2.protect_install_metadata() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.sessions_install_binding_version=1 THEN
      RAISE EXCEPTION 'v2_install_anchor_retained' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.sessions_install_binding_version=1 AND NOT (
      octet_length(NEW.key_id)=44 AND NEW.key_id COLLATE "C" ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'
      AND octet_length(NEW.bundle_id) BETWEEN 1 AND 128 AND NEW.bundle_id COLLATE "C" !~ '[^A-Za-z0-9.-]'
      AND octet_length(NEW.audience) BETWEEN 1 AND 64 AND NEW.audience COLLATE "C" !~ '[^A-Za-z0-9_-]'
      AND NEW.environment IN ('production','development')
    ) THEN
      RAISE EXCEPTION 'v2_install_metadata_shape' USING ERRCODE='23514';
    END IF;
    -- Syntactic metadata only; a future actual verified producer sets v1.
    RETURN NEW;
  END IF;
  IF (NEW.key_id,NEW.bundle_id,NEW.audience,NEW.environment)
      IS DISTINCT FROM (OLD.key_id,OLD.bundle_id,OLD.audience,OLD.environment)
    OR NEW.sessions_install_binding_version IS DISTINCT FROM OLD.sessions_install_binding_version
    OR NEW.sessions_authority_generation<OLD.sessions_authority_generation
  THEN
    -- Includes NULL->1: no reviewed assertion/capture upgrade exists yet.
    RAISE EXCEPTION 'v2_install_binding_or_generation_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION listening_v2.protect_install_metadata() FROM PUBLIC;
CREATE TRIGGER app_attest_keys_sessions_metadata_protect
  BEFORE INSERT OR UPDATE OR DELETE ON public.app_attest_keys
  FOR EACH ROW EXECUTE FUNCTION listening_v2.protect_install_metadata();
-- LT01: no qualified enrollment or generation-CAS consumer exists yet. Keep
-- this exact privilege-only block replayable without any DDL/data or callback.
DO $sessions_install_metadata_privileges$
DECLARE
  key_table oid; role_oid oid; metadata_count integer; expected_count integer;
  role_name text; column_name text; action text; allowed_columns text[];
BEGIN
  key_table=pg_catalog.to_regclass('public.app_attest_keys');
  IF key_table IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class WHERE oid=key_table AND relkind='r'
      AND NOT relispartition AND NOT relrowsecurity AND NOT relforcerowsecurity
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=key_table OR inhparent=key_table)
  ) THEN RAISE EXCEPTION 'v2_install_privilege_catalog_mismatch' USING ERRCODE='23514'; END IF;
  SELECT count(*) INTO metadata_count FROM pg_catalog.pg_attribute
    WHERE attrelid=key_table AND attnum>0 AND NOT attisdropped
      AND attname IN ('sessions_install_binding_version','sessions_authority_generation');
  IF metadata_count NOT IN (0,2) THEN
    RAISE EXCEPTION 'v2_install_privilege_catalog_mismatch' USING ERRCODE='23514';
  END IF;
  expected_count=10+metadata_count;
  IF (SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid=key_table AND attnum>0)<>expected_count
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=key_table AND a.attnum>0 AND (
        a.attisdropped OR a.atttypmod<>-1 OR a.attndims<>0 OR a.attgenerated<>'' OR a.attidentity<>''
        OR NOT a.attislocal OR a.attinhcount<>0 OR a.attcollation<>t.typcollation
        OR (CASE a.attname
          WHEN 'key_id' THEN a.atttypid='pg_catalog.text'::regtype AND a.attnotnull AND d.oid IS NULL
          WHEN 'user_id' THEN a.atttypid='pg_catalog.text'::regtype AND a.attnotnull AND d.oid IS NULL
          WHEN 'audience' THEN a.atttypid='pg_catalog.text'::regtype AND a.attnotnull AND d.oid IS NULL
          WHEN 'bundle_id' THEN a.atttypid='pg_catalog.text'::regtype AND a.attnotnull AND d.oid IS NULL
          WHEN 'environment' THEN a.atttypid='pg_catalog.text'::regtype AND a.attnotnull AND d.oid IS NULL
          WHEN 'public_key' THEN a.atttypid='pg_catalog.text'::regtype AND a.attnotnull AND d.oid IS NULL
          WHEN 'receipt' THEN a.atttypid='pg_catalog.bytea'::regtype AND a.attnotnull AND d.oid IS NULL
          WHEN 'sign_count' THEN a.atttypid='pg_catalog.int8'::regtype AND a.attnotnull AND d.oid IS NOT NULL
            AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(d.adbin,d.adrelid,false),'[()[:space:]'']|::bigint','','g')='0'
          WHEN 'revoked' THEN a.atttypid='pg_catalog.bool'::regtype AND a.attnotnull AND d.oid IS NOT NULL
            AND pg_catalog.pg_get_expr(d.adbin,d.adrelid,false)='false'
          WHEN 'created_at' THEN a.atttypid='pg_catalog.timestamptz'::regtype AND a.attnotnull AND d.oid IS NOT NULL
            AND pg_catalog.pg_get_expr(d.adbin,d.adrelid,false)='now()'
          WHEN 'sessions_install_binding_version' THEN a.atttypid='pg_catalog.int2'::regtype AND NOT a.attnotnull AND d.oid IS NULL
          WHEN 'sessions_authority_generation' THEN a.atttypid=pg_catalog.to_regtype('listening_v2.safe_uint') AND a.attnotnull AND d.oid IS NOT NULL
            AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(d.adbin,d.adrelid,false),'[()[:space:]'']|::bigint|::listening_v2[.]safe_uint','','g')='0'
          ELSE false END) IS NOT TRUE
      )
    ) THEN RAISE EXCEPTION 'v2_install_privilege_catalog_mismatch' USING ERRCODE='23514'; END IF;
  IF metadata_count=0 THEN
    -- Construction-off V1 databases need no V2 schema. Partial 034 never looks
    -- absent merely because both fields were dropped from a drifted catalog.
    IF pg_catalog.to_regprocedure('listening_v2.protect_install_metadata()') IS NOT NULL
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=key_table AND tgname='app_attest_keys_sessions_metadata_protect')
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=key_table AND conname='app_attest_keys_sessions_binding_version')
    THEN RAISE EXCEPTION 'v2_install_privilege_catalog_mismatch' USING ERRCODE='23514'; END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_constraint c ON c.contypid=t.oid
    WHERE t.oid=pg_catalog.to_regtype('listening_v2.safe_uint') AND t.typtype='d' AND t.typbasetype='pg_catalog.int8'::regtype
      AND t.typtypmod=-1 AND NOT t.typnotnull AND t.typdefaultbin IS NULL
      AND c.conname='safe_uint_check' AND c.contype='c' AND c.convalidated
      AND (SELECT count(*) FROM pg_catalog.pg_constraint WHERE contypid=t.oid)=1
      AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(c.conbin,0,false),'[()[:space:]'']|::bigint','','g')='VALUE>=0ANDVALUE<=9007199254740991'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid
    WHERE c.conrelid=key_table AND c.conname='app_attest_keys_sessions_binding_version' AND c.contype='c'
      AND c.convalidated AND NOT c.connoinherit AND c.conislocal AND c.coninhcount=0 AND NOT c.condeferrable AND NOT c.condeferred
      AND a.attname='sessions_install_binding_version' AND c.conkey=ARRAY[a.attnum]::smallint[]
      AND pg_catalog.regexp_replace(pg_catalog.pg_get_expr(c.conbin,c.conrelid,false),'[()[:space:]]','','g')='sessions_install_binding_version=1'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger g JOIN pg_catalog.pg_proc p ON p.oid=g.tgfoid
    WHERE g.tgrelid=key_table AND g.tgname='app_attest_keys_sessions_metadata_protect'
      AND g.tgtype=31 AND g.tgenabled='O' AND NOT g.tgisinternal AND g.tgparentid=0
      AND g.tgnargs=0 AND g.tgattr=''::int2vector AND g.tgqual IS NULL AND g.tgconstraint=0
      AND p.oid=pg_catalog.to_regprocedure('listening_v2.protect_install_metadata()')
      AND NOT p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']::text[]
  ) THEN RAISE EXCEPTION 'v2_install_privilege_catalog_mismatch' USING ERRCODE='23514'; END IF;
  FOREACH role_name IN ARRAY ARRAY['lyra_runtime_v1','lyra_account_v1'] LOOP
    SELECT oid INTO role_oid FROM pg_catalog.pg_roles WHERE rolname=role_name;
    IF NOT FOUND THEN CONTINUE; END IF;
    -- Owners may revoke their ordinary ACL privileges and later regrant them.
    -- Reject ownership authority itself, not only the post-REVOKE ACL result.
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_class c ON c.oid=key_table
      WHERE r.oid=role_oid AND (r.rolsuper OR c.relowner=r.oid OR pg_catalog.pg_has_role(r.oid,c.relowner,'MEMBER')))
    THEN RAISE EXCEPTION 'v2_install_metadata_residual_privilege' USING ERRCODE='23514'; END IF;
    FOREACH action IN ARRAY ARRAY['INSERT','UPDATE'] LOOP
      -- Snapshot effective rights before narrowing this action. Never infer
      -- runtime rights from the smaller 030-only fixture or fabricate new ones.
      SELECT array_agg(a.attname::text ORDER BY a.attnum) INTO allowed_columns
      FROM pg_catalog.pg_attribute a WHERE a.attrelid=key_table AND a.attnum>0
        AND a.attname IN ('key_id','user_id','audience','bundle_id','environment','public_key','receipt','sign_count','revoked','created_at')
        AND pg_catalog.has_column_privilege(role_oid,key_table,a.attnum,action);
      EXECUTE pg_catalog.format('REVOKE %s ON TABLE public.app_attest_keys FROM %I',action,role_name);
      EXECUTE pg_catalog.format('REVOKE %s (sessions_install_binding_version,sessions_authority_generation) ON TABLE public.app_attest_keys FROM %I',action,role_name);
      FOREACH column_name IN ARRAY COALESCE(allowed_columns,ARRAY[]::text[]) LOOP
        EXECUTE pg_catalog.format('GRANT %s (%I) ON TABLE public.app_attest_keys TO %I',action,column_name,role_name);
      END LOOP;
      -- PUBLIC/inheritance/owner/superuser rights cannot be subtracted with a
      -- column REVOKE. Refuse/roll back, never alter an unknown third-party role.
      IF pg_catalog.has_column_privilege(role_oid,key_table,'sessions_install_binding_version',action)
        OR pg_catalog.has_column_privilege(role_oid,key_table,'sessions_authority_generation',action)
      THEN RAISE EXCEPTION 'v2_install_metadata_residual_privilege' USING ERRCODE='23514'; END IF;
    END LOOP;
  END LOOP;
END $sessions_install_metadata_privileges$;


CREATE FUNCTION listening_v2.terminal_payload_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE s jsonb; r jsonb; c jsonb; n jsonb; e text; future jsonb; future_selector jsonb;
  nums jsonb[]; envs text[];
BEGIN
  IF p IS NULL OR jsonb_typeof(p) IS DISTINCT FROM 'object'
    OR NOT (p ?& ARRAY['version','environment','selector','invalidatedAtMS','phase','cursor'])
    OR p-ARRAY['version','environment','selector','invalidatedAtMS','phase','cursor','repair']<>'{}'::jsonb
    OR p->>'version' IS DISTINCT FROM '2' OR jsonb_typeof(p->'version') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p->'environment') IS DISTINCT FROM 'string'
    OR p->>'phase' NOT IN ('rooms','complete') OR jsonb_typeof(p->'phase') IS DISTINCT FROM 'string'
  THEN RETURN false; END IF;
  s=p->'selector';c=p->'cursor';
  IF jsonb_typeof(s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  nums=ARRAY[p->'invalidatedAtMS'];envs=ARRAY[p->>'environment'];
  CASE s->>'kind'
  WHEN 'credential' THEN
    IF NOT (s ?& ARRAY['kind','value']) OR s-ARRAY['kind','value']<>'{}'::jsonb
      OR jsonb_typeof(s->'value') IS DISTINCT FROM 'string'
      OR octet_length(s->>'value')<>64 OR (s->>'value') COLLATE "C" !~ '^[0-9a-f]{64}$'
    THEN RETURN false; END IF;
  WHEN 'installation' THEN
    IF NOT (s ?& ARRAY['kind','value','bindingVersion','throughGeneration'])
      OR s-ARRAY['kind','value','bindingVersion','throughGeneration']<>'{}'::jsonb
      OR jsonb_typeof(s->'value') IS DISTINCT FROM 'string'
      OR octet_length(s->>'value')<>64 OR (s->>'value') COLLATE "C" !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(s->'bindingVersion') IS DISTINCT FROM 'number' OR s->>'bindingVersion' IS DISTINCT FROM '1'
    THEN RETURN false; END IF;
    nums=array_append(nums,s->'throughGeneration');
  WHEN 'private-transfer' THEN
    IF NOT (s ?& ARRAY['kind','targetEnvironment','personaID','fromGeneration','toGeneration'])
      OR s-ARRAY['kind','targetEnvironment','personaID','fromGeneration','toGeneration']<>'{}'::jsonb
      OR jsonb_typeof(s->'targetEnvironment') IS DISTINCT FROM 'string'
      OR jsonb_typeof(s->'personaID') IS DISTINCT FROM 'string' OR octet_length(s->>'personaID')<>36
      OR (s->>'personaID') COLLATE "C" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN RETURN false; END IF;
    nums=array_cat(nums,ARRAY[s->'fromGeneration',s->'toGeneration']);
    envs=array_append(envs,s->>'targetEnvironment');
  ELSE RETURN false;
  END CASE;
  IF c<>'null'::jsonb THEN
    IF jsonb_typeof(c) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(c)<>2 OR jsonb_typeof(c->0) IS DISTINCT FROM 'string'
      OR jsonb_typeof(c->1) IS DISTINCT FROM 'string' OR octet_length(c->>1)<>36
      OR (c->>1) COLLATE "C" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN RETURN false; END IF;
    envs=array_append(envs,c->>0);
  END IF;
  IF p->>'phase'='complete' AND c<>'null'::jsonb THEN RETURN false; END IF;
  IF p ? 'repair' THEN
    r=p->'repair';
    IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
    IF NOT (r ?& ARRAY['rootJobID','predecessorJobID','originalCreatedAtMS','originalRetryUntilMS','repairOrdinal'])
      OR r-ARRAY['rootJobID','predecessorJobID','originalCreatedAtMS','originalRetryUntilMS','repairOrdinal']<>'{}'::jsonb
    THEN RETURN false; END IF;
    FOREACH e IN ARRAY ARRAY['rootJobID','predecessorJobID'] LOOP
      IF jsonb_typeof(r->e) IS DISTINCT FROM 'string' OR octet_length(r->>e)<>36
        OR (r->>e) COLLATE "C" !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN RETURN false; END IF;
    END LOOP;
    nums=array_cat(nums,ARRAY[r->'originalCreatedAtMS',r->'originalRetryUntilMS',r->'repairOrdinal']);
  END IF;
  FOREACH n IN ARRAY nums LOOP
    IF jsonb_typeof(n) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
    IF n::text COLLATE "C" !~ '^(0|[1-9][0-9]{0,15})$' THEN RETURN false; END IF;
    IF n::text::numeric>9007199254740991 THEN RETURN false; END IF;
  END LOOP;
  FOREACH e IN ARRAY envs LOOP
    IF e IS NULL OR octet_length(e)>128 OR e COLLATE "C" ~ '[^A-Za-z0-9._:-]'
      OR NOT (e IN ('production','development','test') OR e COLLATE "C" ~ '^preview:[A-Za-z0-9][A-Za-z0-9._-]{0,119}$')
    THEN RETURN false; END IF;
  END LOOP;
  IF s->>'kind'='private-transfer' AND
    (s->>'toGeneration')::numeric<>(s->>'fromGeneration')::numeric+1 THEN RETURN false; END IF;
  IF r IS NOT NULL AND ((r->>'repairOrdinal')::numeric<1
    OR (r->>'originalRetryUntilMS')::numeric<(r->>'originalCreatedAtMS')::numeric
    OR (r->>'originalRetryUntilMS')::numeric-(r->>'originalCreatedAtMS')::numeric>86400000
    OR (p->>'invalidatedAtMS')::numeric>(r->>'originalCreatedAtMS')::numeric) THEN RETURN false; END IF;

  future_selector=s;
  IF s->>'kind'='installation' THEN
    future_selector=jsonb_set(s,'{throughGeneration}','9007199254740991'::jsonb);
  ELSIF s->>'kind'='private-transfer' THEN
    future_selector=jsonb_set(jsonb_set(s,'{fromGeneration}','9007199254740990'::jsonb),
      '{toGeneration}','9007199254740991'::jsonb);
  END IF;
  future=p||jsonb_build_object('selector',future_selector,'invalidatedAtMS',9007199254740991::bigint,
    'phase','rooms','cursor',jsonb_build_array(repeat('x',128),'ffffffff-ffff-ffff-ffff-ffffffffffff'),
    'repair',jsonb_build_object('rootJobID','ffffffff-ffff-ffff-ffff-ffffffffffff',
      'predecessorJobID','ffffffff-ffff-ffff-ffff-ffffffffffff','originalCreatedAtMS',9007199254740991::bigint,
      'originalRetryUntilMS',9007199254740991::bigint,'repairOrdinal',9007199254740991::bigint));
  RETURN octet_length(p::text)<=4096 AND octet_length(future::text)<=4096;
END $$;
REVOKE ALL ON FUNCTION listening_v2.terminal_payload_valid(jsonb) FROM PUBLIC;
-- Needed for CHECK evaluation only. No auth-key column or new writer grant.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='lyra_runtime_v1') THEN
    GRANT EXECUTE ON FUNCTION listening_v2.terminal_payload_valid(jsonb) TO lyra_runtime_v1;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='lyra_account_v1') THEN
    GRANT EXECUTE ON FUNCTION listening_v2.terminal_payload_valid(jsonb) TO lyra_account_v1;
  END IF;
END $$;

-- Replace only 031's two kind/reference closed sets. Every old alternative
-- below is preserved verbatim; privacy dependency shape/index are untouched.
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_constraint
      WHERE conrelid='listening_v2.outbox'::regclass AND contype='c'
      AND conname IN ('outbox_lifecycle_kind','outbox_lifecycle_references','outbox_privacy_dependency_shape'))<>3
  THEN RAISE EXCEPTION 'v2_terminal_check_catalog_mismatch' USING ERRCODE='23514'; END IF;
END $$;
ALTER TABLE listening_v2.outbox DROP CONSTRAINT outbox_lifecycle_kind;
ALTER TABLE listening_v2.outbox DROP CONSTRAINT outbox_lifecycle_references;
ALTER TABLE listening_v2.outbox ADD CONSTRAINT outbox_lifecycle_kind CHECK (
  kind IN ('wake','execution','guard_cleanup','room_expiry','privacy_scrub','asset_delete','privacy_dependency','authority_terminal')
);
ALTER TABLE listening_v2.outbox ADD CONSTRAINT outbox_lifecycle_references CHECK (
  (kind IN ('wake','room_expiry') AND room_id IS NOT NULL AND guard_id IS NULL AND persona_id IS NULL AND asset_id IS NULL
    AND guard_revision IS NULL AND send_ordinal IS NULL AND privacy_generation IS NULL)
  OR (kind='execution' AND room_id IS NOT NULL AND guard_id IS NOT NULL AND guard_revision IS NOT NULL
    AND send_ordinal IS NOT NULL AND persona_id IS NULL AND asset_id IS NULL AND privacy_generation IS NULL)
  OR (kind='guard_cleanup' AND room_id IS NULL AND guard_id IS NOT NULL AND guard_revision IS NOT NULL
    AND send_ordinal IS NOT NULL AND persona_id IS NULL AND asset_id IS NULL AND privacy_generation IS NULL)
  OR (kind='privacy_scrub' AND persona_id IS NOT NULL AND privacy_generation IS NOT NULL
    AND room_id IS NULL AND guard_id IS NULL AND asset_id IS NULL AND guard_revision IS NULL AND send_ordinal IS NULL)
  OR (kind='asset_delete' AND asset_id IS NOT NULL AND persona_id IS NOT NULL AND privacy_generation IS NOT NULL
    AND room_id IS NULL AND guard_id IS NULL AND guard_revision IS NULL AND send_ordinal IS NULL)
  OR (kind='privacy_dependency' AND room_id IS NULL AND guard_id IS NULL AND persona_id IS NULL AND asset_id IS NULL
    AND privacy_generation IS NULL AND guard_revision IS NULL AND send_ordinal IS NULL)
  OR (kind='authority_terminal' AND room_id IS NULL AND guard_id IS NULL AND persona_id IS NULL AND asset_id IS NULL
    AND privacy_generation IS NULL AND guard_revision IS NULL AND send_ordinal IS NULL)
);

ALTER TABLE listening_v2.outbox ADD CONSTRAINT outbox_authority_terminal_shape CHECK (
  kind<>'authority_terminal' OR (
    listening_v2.terminal_payload_valid(payload)
    AND job_key='authority-terminal:'||job_id::text
    AND state IN ('pending','claimed','published','dead')
    AND (payload->>'invalidatedAtMS')::numeric<=created_at_ms::numeric
    AND (NOT (payload ? 'repair') OR (payload->'repair'->>'originalCreatedAtMS')::numeric<=created_at_ms::numeric)
    AND (completed_at_ms IS NULL OR completed_at_ms>=created_at_ms)
  ) IS TRUE
);
-- Deliberately excludes invalidatedAtMS: a new timestamp cannot bypass the
-- same unfinished credential era or exact installation/transfer cutoff.
CREATE UNIQUE INDEX outbox_authority_terminal_unfinished ON listening_v2.outbox
  (environment,(payload->'selector')) WHERE kind='authority_terminal' AND state<>'published';

CREATE FUNCTION listening_v2.protect_terminal_job() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE at_ms numeric; live boolean; progress boolean;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.kind='authority_terminal' THEN
      RAISE EXCEPTION 'v2_terminal_retained_until_compactor' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND (OLD.kind='authority_terminal')<>(NEW.kind='authority_terminal') THEN
    RAISE EXCEPTION 'v2_terminal_kind_immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.kind<>'authority_terminal' THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'pending' OR NEW.attempt_count<>0 OR NEW.claim_epoch<>0
      OR NEW.payload->>'phase' IS DISTINCT FROM 'rooms'
      OR (NOT (NEW.payload ? 'repair') AND NEW.payload->'cursor' IS DISTINCT FROM 'null'::jsonb)
    THEN RAISE EXCEPTION 'v2_terminal_initial_shape' USING ERRCODE='23514'; END IF;
    IF NEW.payload ? 'repair' THEN
      -- Existing table UPDATE privilege distinguishes runtime from the
      -- INSERT-only account role. It is NOT trusted repair/source proof.
      IF NOT pg_catalog.has_table_privilege(current_user,'listening_v2.outbox','UPDATE') THEN
        RAISE EXCEPTION 'v2_terminal_repair_runtime_only' USING ERRCODE='42501';
      END IF;
      IF NEW.payload->'repair'->>'rootJobID'=NEW.job_id::text
        OR NEW.payload->'repair'->>'predecessorJobID'=NEW.job_id::text THEN
        RAISE EXCEPTION 'v2_terminal_repair_self_lineage' USING ERRCODE='23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF to_jsonb(NEW)=to_jsonb(OLD) THEN RETURN NEW; END IF;
  IF OLD.state='dead' AND NEW.state='published' THEN
    -- Exact predecessor handoff, NOT reopening/claiming/refunding it.
    -- Successor insertion/provenance/finite authorization is a future store.
    IF to_jsonb(NEW)-'state' IS DISTINCT FROM to_jsonb(OLD)-'state' THEN
      RAISE EXCEPTION 'v2_terminal_handoff_preserves_debt' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.state IN ('published','dead') THEN
    RAISE EXCEPTION 'v2_terminal_no_reopen' USING ERRCODE='23514';
  END IF;
  IF (to_jsonb(NEW)-ARRAY['state','attempt_count','claim_epoch','claim_nonce_hash','claim_until_ms','payload',
      'due_at_ms','completed_at_ms','delete_after_ms']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','attempt_count','claim_epoch','claim_nonce_hash','claim_until_ms','payload',
      'due_at_ms','completed_at_ms','delete_after_ms'])
    OR (NEW.payload-ARRAY['phase','cursor']) IS DISTINCT FROM (OLD.payload-ARRAY['phase','cursor'])
    OR NEW.due_at_ms<OLD.due_at_ms
    OR (NEW.state<>'pending' AND NEW.due_at_ms<>OLD.due_at_ms)
  THEN RAISE EXCEPTION 'v2_terminal_source_or_chronology_immutable' USING ERRCODE='23514'; END IF;
  at_ms=extract(epoch FROM clock_timestamp())*1000;
  IF NEW.completed_at_ms IS NOT NULL AND NEW.completed_at_ms::numeric>at_ms THEN
    RAISE EXCEPTION 'v2_terminal_future_completion' USING ERRCODE='23514';
  END IF;
  IF NEW.state='claimed' THEN
    IF NEW.payload IS DISTINCT FROM OLD.payload OR OLD.attempt_count>=10
      OR NEW.attempt_count<>OLD.attempt_count+1 OR NEW.claim_epoch::numeric<>OLD.claim_epoch::numeric+1
      OR NEW.claim_nonce_hash IS NULL OR NEW.claim_nonce_hash IS NOT DISTINCT FROM OLD.claim_nonce_hash
      OR NEW.claim_until_ms IS NULL OR NEW.claim_until_ms::numeric<=at_ms
      OR at_ms>=OLD.retry_until_ms::numeric OR at_ms<OLD.due_at_ms::numeric
      OR (OLD.state='claimed' AND at_ms<OLD.claim_until_ms::numeric)
    THEN RAISE EXCEPTION 'v2_terminal_fresh_claim_required' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.claim_epoch<>OLD.claim_epoch THEN
    RAISE EXCEPTION 'v2_terminal_epoch_immutable_outside_claim' USING ERRCODE='23514';
  END IF;
  IF OLD.state='pending' THEN
    IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.attempt_count<>OLD.attempt_count
      OR NOT (NEW.state='pending' OR (NEW.state='dead' AND
        (OLD.attempt_count>=10 OR at_ms>=OLD.retry_until_ms::numeric)))
    THEN RAISE EXCEPTION 'v2_terminal_pending_transition' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  live=at_ms<OLD.claim_until_ms::numeric AND at_ms<OLD.retry_until_ms::numeric;
  IF NEW.state='pending' AND NEW.attempt_count=OLD.attempt_count THEN
    IF NEW.payload IS DISTINCT FROM OLD.payload OR NEW.attempt_count>=10 OR at_ms>=OLD.retry_until_ms::numeric THEN
      RAISE EXCEPTION 'v2_terminal_failed_claim_preserves_debit' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.state='dead' AND NEW.attempt_count=OLD.attempt_count AND NEW.payload=OLD.payload
    AND (OLD.attempt_count>=10 OR at_ms>=OLD.retry_until_ms::numeric) THEN RETURN NEW; END IF;
  progress=false;
  IF OLD.payload->>'phase'='rooms' AND NEW.payload->>'phase'='rooms'
    AND NEW.payload->'cursor'<>'null'::jsonb THEN
    progress=OLD.payload->'cursor'='null'::jsonb OR
      ROW((NEW.payload->'cursor'->>0) COLLATE "C",(NEW.payload->'cursor'->>1) COLLATE "C")>
      ROW((OLD.payload->'cursor'->>0) COLLATE "C",(OLD.payload->'cursor'->>1) COLLATE "C");
  END IF;
  IF live AND NEW.attempt_count=OLD.attempt_count-1 AND (
    (NEW.state='pending' AND progress) OR
    (NEW.state='published' AND OLD.payload->>'phase'='rooms'
      AND NEW.payload->>'phase'='complete' AND NEW.payload->'cursor'='null'::jsonb)
  ) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'v2_terminal_progress_or_exact_failure_required' USING ERRCODE='23514';
END $$;
REVOKE ALL ON FUNCTION listening_v2.protect_terminal_job() FROM PUBLIC;
CREATE TRIGGER outbox_terminal_protect BEFORE INSERT OR UPDATE OR DELETE ON listening_v2.outbox
  FOR EACH ROW EXECUTE FUNCTION listening_v2.protect_terminal_job();

-- No table/column grant expansion, registration, ninth relation, cap increase,
-- cross-row lock, SECURITY DEFINER, public callback or actual store processor.
COMMIT;
