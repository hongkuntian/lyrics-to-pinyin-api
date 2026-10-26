-- Unregistered, source-only additive support for the approved lifecycle plan.
-- Apply after immutable 030 using the migration owner, never an app login.
-- No scheduler, GuestLive/auth hook, controller transfer or execution authority.
BEGIN;

-- Fail closed on missing/renamed CHECKs before replacing the two original
-- closed sets. Full definition/index drift still requires Root's catalog
-- review; names alone are not a migration receipt or a schema fingerprint.
DO $$
DECLARE original_checks integer; lifecycle_checks integer;
BEGIN
  SELECT count(*) INTO original_checks FROM pg_constraint
    WHERE conrelid='listening_v2.outbox'::regclass AND contype='c'
      AND conname IN ('outbox_kind_check','outbox_check3');
  SELECT count(*) INTO lifecycle_checks FROM pg_constraint
    WHERE conrelid='listening_v2.outbox'::regclass AND contype='c'
      AND conname IN ('outbox_lifecycle_kind','outbox_lifecycle_references','outbox_privacy_dependency_shape');
  IF NOT ((original_checks=2 AND lifecycle_checks=0) OR (original_checks=0 AND lifecycle_checks=3)) THEN
    RAISE EXCEPTION 'v2_lifecycle_check_catalog_mismatch' USING ERRCODE='23514';
  END IF;
END $$;

-- Public identities are global in this database. Lead with the dependency,
-- then seek every environment in canonical UTF-8 byte order, not only the
-- initiating request's environment. Retired persona history is excluded.
CREATE INDEX IF NOT EXISTS privacy_personas_live_credential ON listening_v2.privacy_personas
  (guest_credential_digest COLLATE "C",environment COLLATE "C",persona_id)
  WHERE controller_kind='guest' AND status='live';
CREATE INDEX IF NOT EXISTS privacy_personas_live_guest_user ON listening_v2.privacy_personas
  (original_principal_id COLLATE "C",environment COLLATE "C",persona_id)
  WHERE controller_kind='guest' AND status='live';
CREATE INDEX IF NOT EXISTS privacy_personas_live_guest_key ON listening_v2.privacy_personas
  (original_key_id COLLATE "C",environment COLLATE "C",persona_id)
  WHERE controller_kind='guest' AND status='live';
CREATE INDEX IF NOT EXISTS privacy_personas_live_apple_controller ON listening_v2.privacy_personas
  (controller_principal_id COLLATE "C",environment COLLATE "C",persona_id)
  WHERE controller_kind='apple' AND status='live';
CREATE INDEX IF NOT EXISTS privacy_personas_live_guest_sweep ON listening_v2.privacy_personas
  (environment COLLATE "C",persona_id) WHERE controller_kind='guest' AND status='live';

-- Enumerate all owner rows, including revoked/expired rows; there is no
-- revoked=false filter in the actual owner-wide invalidation/locking paths.
CREATE INDEX IF NOT EXISTS library_tokens_owner_digest ON public.library_tokens
  (user_id COLLATE "C",digest COLLATE "C");
CREATE INDEX IF NOT EXISTS app_attest_keys_owner_key ON public.app_attest_keys
  (user_id COLLATE "C",key_id COLLATE "C");
CREATE INDEX IF NOT EXISTS app_auth_sessions_key_digest ON public.app_auth_sessions
  (key_id COLLATE "C",digest COLLATE "C");

-- These are 030's generated names: outbox_kind_check and outbox_check3
-- (kind-reference CHECK). Retain all other 030 constraints, FKs and caps.
-- Named replacements make reapplication of these exact bytes additive.
ALTER TABLE listening_v2.outbox DROP CONSTRAINT IF EXISTS outbox_kind_check;
ALTER TABLE listening_v2.outbox DROP CONSTRAINT IF EXISTS outbox_check3;
ALTER TABLE listening_v2.outbox DROP CONSTRAINT IF EXISTS outbox_lifecycle_kind;
ALTER TABLE listening_v2.outbox DROP CONSTRAINT IF EXISTS outbox_lifecycle_references;
ALTER TABLE listening_v2.outbox DROP CONSTRAINT IF EXISTS outbox_privacy_dependency_shape;
ALTER TABLE listening_v2.outbox ADD CONSTRAINT outbox_lifecycle_kind CHECK (
  kind IN ('wake','execution','guard_cleanup','room_expiry','privacy_scrub','asset_delete','privacy_dependency')
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
);
ALTER TABLE listening_v2.outbox ADD CONSTRAINT outbox_privacy_dependency_shape CHECK (
  kind<>'privacy_dependency' OR (CASE WHEN jsonb_typeof(payload)='object' THEN
    job_key='privacy-dependency:'||job_id::text
    AND state IN ('pending','claimed','published','dead')
    AND payload ?& ARRAY['version','environment','selector','cursor','invalidatedAtMS']
    AND payload-ARRAY['version','environment','selector','cursor','invalidatedAtMS']='{}'::jsonb
    AND payload->'version'='2'::jsonb
    AND jsonb_typeof(payload->'environment')='string' AND payload->>'environment'=environment
    AND octet_length(payload::text)<=512
    -- Reserve a complete worst-size global keyset cursor before enqueue. A
    -- later environment boundary cannot strand a hint at the byte ceiling.
    AND octet_length(jsonb_set(payload,'{cursor}',jsonb_build_array(
      repeat('x',128),'ffffffff-ffff-ffff-ffff-ffffffffffff'))::text)<=512
    AND CASE WHEN jsonb_typeof(payload->'selector')='object' THEN
      CASE WHEN payload->'selector'->>'kind'='indexed-sweep' THEN
        payload->'selector'='{"kind":"indexed-sweep"}'::jsonb AND payload->'invalidatedAtMS'='null'::jsonb
      ELSE
        payload->'selector' ?& ARRAY['kind','value']
        AND (payload->'selector')-ARRAY['kind','value']='{}'::jsonb
        AND jsonb_typeof(payload->'selector'->'value')='string'
        AND CASE payload->'selector'->>'kind'
          WHEN 'credential' THEN payload->'selector'->>'value' ~ '^[0-9a-f]{64}$'
          WHEN 'guest-key' THEN payload->'selector'->>'value' ~ '^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$'
          WHEN 'guest-user' THEN octet_length(payload->'selector'->>'value') BETWEEN 1 AND 160
            AND payload->'selector'->>'value' !~ '[[:space:][:cntrl:]]'
          WHEN 'apple-controller' THEN octet_length(payload->'selector'->>'value') BETWEEN 1 AND 160
            AND payload->'selector'->>'value' !~ '[[:space:][:cntrl:]]'
          ELSE false END
        AND CASE WHEN jsonb_typeof(payload->'invalidatedAtMS')='number'
          AND payload->>'invalidatedAtMS' ~ '^(0|[1-9][0-9]{0,15})$' THEN
            (payload->>'invalidatedAtMS')::numeric<=9007199254740991
            AND (payload->>'invalidatedAtMS')::numeric<=created_at_ms::numeric
          ELSE false END
      END ELSE false END
    AND CASE WHEN payload->'cursor'='null'::jsonb THEN true
      WHEN jsonb_typeof(payload->'cursor')='array' THEN
        jsonb_array_length(payload->'cursor')=2
        AND jsonb_typeof(payload->'cursor'->0)='string' AND jsonb_typeof(payload->'cursor'->1)='string'
        AND ((payload->'cursor'->>0) IN ('production','development','test')
          OR (payload->'cursor'->>0) ~ '^preview:[A-Za-z0-9][A-Za-z0-9._-]{0,119}$')
        AND (payload->'cursor'->>1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ELSE false END
    ELSE false END) IS TRUE
);

-- Exact selector JSONB equality is collision-free, includes its closed kind,
-- and ignores object key order. job_key identifies a row, not this identity.
-- A dead job retains the unique slot/deadline until durable handoff/repair.
-- Published means ALL remaining work was durably handed off or proved done;
-- merely sending a queue wakeup never permits this transition.
CREATE UNIQUE INDEX IF NOT EXISTS outbox_privacy_dependency_pending ON listening_v2.outbox
  (environment,(payload->'selector')) WHERE kind='privacy_dependency' AND state<>'published';

-- No grants, functions, roles, identity/provenance columns or new relations.
-- Timestamp-min merge, identity immutability, retention, cursor/claim CAS and
-- publish-after-handoff are REQUIRED service transactions; DDL is not them.
COMMIT;
