BEGIN;
-- Public auth-row lock admission only; independent of unregistered 030/031.
-- No auth writer should update this anchor as part of normal locking.
DO $auth_token_lock_schema$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='library_tokens'
      AND c.relkind='r' AND NOT c.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
  ) THEN
    RAISE EXCEPTION 'auth_token_lock_table_catalog_mismatch' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid='public.library_tokens'::regclass
      AND attname='auth_lock_anchor' AND attnum>0 AND NOT attisdropped
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
      WHERE conrelid='public.library_tokens'::regclass AND conname='library_tokens_auth_lock_anchor_false'
    ) THEN
      RAISE EXCEPTION 'auth_token_lock_anchor_catalog_mismatch' USING ERRCODE='23514';
    END IF;
    ALTER TABLE public.library_tokens ADD COLUMN auth_lock_anchor boolean NOT NULL DEFAULT false
      CONSTRAINT library_tokens_auth_lock_anchor_false CHECK (auth_lock_anchor IS FALSE);
  END IF;
END $auth_token_lock_schema$;

-- The existing role-replay helper selects this entire idempotent block.
-- Catalog refusal is deliberately inside it: replay cannot grant on drift.
-- It contains no DDL or backfill and creates no role when the role is absent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class r
    JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid
    JOIN pg_catalog.pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
    JOIN pg_catalog.pg_constraint c ON c.conrelid=r.oid
    WHERE n.nspname='public' AND r.relname='library_tokens' AND r.relkind='r' AND NOT r.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=r.oid OR i.inhparent=r.oid)
      AND a.attname='auth_lock_anchor' AND a.attnum>0 AND NOT a.attisdropped
      AND a.atttypid='pg_catalog.bool'::regtype AND a.atttypmod=-1 AND a.attndims=0
      AND a.attnotnull AND a.attgenerated='' AND a.attidentity='' AND a.attislocal AND a.attinhcount=0
      AND pg_catalog.pg_get_expr(d.adbin,d.adrelid,false)='false'
      AND c.conname='library_tokens_auth_lock_anchor_false' AND c.contype='c'
      AND c.convalidated AND NOT c.connoinherit AND c.conislocal AND c.coninhcount=0
      AND NOT c.condeferrable AND NOT c.condeferred
      AND c.conkey=ARRAY[a.attnum]::smallint[]
      AND pg_catalog.pg_get_expr(c.conbin,c.conrelid,false)='(auth_lock_anchor IS FALSE)'
  ) THEN
    RAISE EXCEPTION 'auth_token_lock_anchor_catalog_mismatch' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='lyra_runtime_v1') THEN
    GRANT UPDATE(auth_lock_anchor) ON public.library_tokens TO lyra_runtime_v1;
  END IF;
END $$;
COMMIT;
