BEGIN;
-- Privilege-only V1 account deletion correction. No V2 schema or activation.
-- Replay this exact body together with the other membership privilege bodies.
DO $listening_account_delete_privileges$
DECLARE
  previous_search_path pg_catalog.text;
  target_name pg_catalog.text; relation_oid pg_catalog.oid; relation_count pg_catalog.int4;
  expected_columns pg_catalog.int4; expected_keys pg_catalog.int2[]; expected_foreign_keys pg_catalog.int4;
BEGIN
  -- Resolve operators, casts and catalog expressions in pg_catalog even when
  -- the caller explicitly places hostile schemas before it. Restore on success;
  -- statement/transaction rollback restores the prior setting on any refusal.
  previous_search_path=pg_catalog.current_setting('search_path');
  PERFORM pg_catalog.set_config('search_path','pg_catalog',true);
  SELECT pg_catalog.count(*) INTO relation_count FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN
      ('listening_rooms','listening_commands','listening_outbox','listening_rate_windows');
  -- Older account-only fixtures legitimately omit the entire optional 029
  -- family. One missing/replaced relation in a present family is not absence.
  IF relation_count=0 THEN
    -- Do not RETURN from an embedded replay: 034 must still withhold metadata.
    NULL;
  ELSE
  IF relation_count<>4 THEN
    RAISE EXCEPTION 'listening_account_delete_catalog_mismatch' USING ERRCODE='23514';
  END IF;
  FOREACH target_name IN ARRAY ARRAY['listening_rooms','listening_commands','listening_outbox','listening_rate_windows'] LOOP
    relation_oid=pg_catalog.to_regclass(pg_catalog.format('public.%I',target_name));
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=relation_oid AND c.relkind='r'
        AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
    ) THEN RAISE EXCEPTION 'listening_account_delete_catalog_mismatch' USING ERRCODE='23514'; END IF;
    expected_columns=CASE target_name WHEN 'listening_rooms' THEN 9 WHEN 'listening_commands' THEN 6
      WHEN 'listening_outbox' THEN 6 ELSE 4 END;
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute WHERE attrelid=relation_oid AND attnum>0)<>expected_columns
      OR EXISTS (
        WITH expected(expected_relation,column_name,type_name,not_null,default_expression) AS (VALUES
          ('listening_rooms','id','uuid',true,NULL::text),
          ('listening_rooms','environment','text',true,NULL),
          ('listening_rooms','owner_id','text',true,NULL),
          ('listening_rooms','status','text',true,NULL),
          ('listening_rooms','invite_hash','text',true,NULL),
          ('listening_rooms','code_hash','text',true,NULL),
          ('listening_rooms','share_hash','text',false,NULL),
          ('listening_rooms','data','jsonb',true,NULL),
          ('listening_rooms','updated_at','timestamptz',true,'now()'),
          ('listening_commands','room_id','uuid',true,NULL),
          ('listening_commands','command_id','uuid',true,NULL),
          ('listening_commands','actor_id','text',true,NULL),
          ('listening_commands','fingerprint','text',true,NULL),
          ('listening_commands','accepted_revision','int4',true,NULL),
          ('listening_commands','created_at','timestamptz',true,'now()'),
          ('listening_outbox','id','text',true,NULL),
          ('listening_outbox','room_id','uuid',true,NULL),
          ('listening_outbox','ordinal','int4',true,NULL),
          ('listening_outbox','due_at_ms','int8',true,NULL),
          ('listening_outbox','state','text',true,'''pending''::text'),
          ('listening_outbox','receipt','text',false,NULL),
          ('listening_rate_windows','user_id','text',true,NULL),
          ('listening_rate_windows','bucket','text',true,NULL),
          ('listening_rate_windows','window_at','timestamptz',true,NULL),
          ('listening_rate_windows','count','int4',true,NULL)
        )
        SELECT 1 FROM pg_catalog.pg_attribute a
          LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
          LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          LEFT JOIN expected e ON e.expected_relation=target_name AND e.column_name=a.attname
        WHERE a.attrelid=relation_oid AND a.attnum>0 AND (
          a.attisdropped OR e.column_name IS NULL OR a.atttypid<>pg_catalog.to_regtype('pg_catalog.'||e.type_name)
          OR a.atttypmod<>-1 OR a.attndims<>0 OR a.attnotnull<>e.not_null
          OR a.attgenerated<>'' OR a.attidentity<>'' OR NOT a.attislocal OR a.attinhcount<>0
          OR a.attcollation<>t.typcollation
          OR pg_catalog.pg_get_expr(d.adbin,d.adrelid,false) IS DISTINCT FROM e.default_expression
        )
      ) THEN RAISE EXCEPTION 'listening_account_delete_catalog_mismatch' USING ERRCODE='23514'; END IF;
    expected_keys=CASE target_name WHEN 'listening_commands' THEN ARRAY[1,2]::smallint[]
      WHEN 'listening_rate_windows' THEN ARRAY[1,2]::smallint[] ELSE ARRAY[1]::smallint[] END;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=relation_oid
      AND c.conname=target_name||'_pkey' AND c.contype='p' AND c.conkey=expected_keys
      AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND c.conislocal AND c.coninhcount=0)
    THEN RAISE EXCEPTION 'listening_account_delete_catalog_mismatch' USING ERRCODE='23514'; END IF;
    expected_foreign_keys=CASE target_name WHEN 'listening_commands' THEN 2 ELSE 1 END;
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_constraint WHERE conrelid=relation_oid AND contype='f')<>expected_foreign_keys
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=relation_oid AND c.contype='f' AND (
          NOT c.convalidated OR c.condeferrable OR c.condeferred OR NOT c.conislocal OR c.coninhcount<>0
          OR c.confdeltype<>'c' OR c.confupdtype<>'a' OR c.confmatchtype<>'s'
          OR NOT (
            (c.conname=target_name||'_owner_id_fkey' AND target_name='listening_rooms'
              AND c.conkey=ARRAY[3]::smallint[] AND c.confrelid=pg_catalog.to_regclass('public.library_users') AND c.confkey=ARRAY[1]::smallint[])
            OR (c.conname=target_name||'_actor_id_fkey' AND target_name='listening_commands'
              AND c.conkey=ARRAY[3]::smallint[] AND c.confrelid=pg_catalog.to_regclass('public.library_users') AND c.confkey=ARRAY[1]::smallint[])
            OR (c.conname=target_name||'_room_id_fkey' AND target_name IN ('listening_commands','listening_outbox')
              AND c.conkey=CASE target_name WHEN 'listening_commands' THEN ARRAY[1]::smallint[] ELSE ARRAY[2]::smallint[] END
              AND c.confrelid=pg_catalog.to_regclass('public.listening_rooms') AND c.confkey=ARRAY[1]::smallint[])
            OR (c.conname=target_name||'_user_id_fkey' AND target_name='listening_rate_windows'
              AND c.conkey=ARRAY[1]::smallint[] AND c.confrelid=pg_catalog.to_regclass('public.library_users') AND c.confkey=ARRAY[1]::smallint[])
          )
        )
      ) THEN RAISE EXCEPTION 'listening_account_delete_catalog_mismatch' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='lyra_account_v1') THEN
    -- The DELETE predicate reads only user_id. Never grant table SELECT,
    -- other columns, grant option, runtime/PUBLIC rights or historical 027/029.
    GRANT SELECT (user_id) ON TABLE public.listening_rate_windows TO lyra_account_v1;
  END IF;
  END IF;
  PERFORM pg_catalog.set_config('search_path',previous_search_path,true);
END $listening_account_delete_privileges$;
COMMIT;
