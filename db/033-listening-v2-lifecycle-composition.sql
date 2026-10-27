BEGIN;
-- Disabled foundation on exact 030/031/032. Intentionally unregistered.
-- Migration owner only. No activation, role creation or late-role replay.
-- Existing columns cause a refusal, not blind reconciliation/reapplication.
ALTER TABLE public.library_users
  ADD COLUMN sessions_privacy_epoch listening_v2.safe_uint NOT NULL DEFAULT 0;
ALTER TABLE listening_v2.privacy_personas
  ADD COLUMN controller_privacy_epoch listening_v2.safe_uint NOT NULL DEFAULT 0,
  ADD COLUMN private_transfer_from_generation listening_v2.safe_uint;

-- Keep every original 030 CHECK, index, FK and protection trigger. These
-- immediately validated additions refuse incompatible/oversized old rows;
-- no identity/epoch/bridge is invented and no retained data is truncated.
ALTER TABLE listening_v2.privacy_personas
  ADD CONSTRAINT privacy_personas_guest_epoch CHECK (
    controller_kind<>'guest' OR controller_privacy_epoch=0
  ),
  ADD CONSTRAINT privacy_personas_transfer_bridge CHECK (
    private_transfer_from_generation IS NULL OR (
      controller_kind IN ('apple','erased')
      AND private_transfer_from_generation<privacy_generation
    ) IS TRUE
  ),
  ADD CONSTRAINT privacy_personas_composition_bytes CHECK (
    octet_length(jsonb_build_array(environment,persona_id,original_principal_id,original_key_id,
      controller_kind,controller_principal_id,controller_key_id,privacy_generation,status,
      guest_credential_digest,guest_credential_expires_at_ms,withdrawn_at_ms,scrub_due_at_ms,scrub_cursor,
      created_at_ms,updated_at_ms,controller_privacy_epoch,private_transfer_from_generation)::text)<=512
  );

CREATE FUNCTION listening_v2.protect_persona_composition() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.private_transfer_from_generation IS NOT NULL THEN
      RAISE EXCEPTION 'v2_persona_initial_transfer_bridge_forbidden' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.controller_kind='guest' AND NEW.controller_kind='apple' THEN
    -- Shape only: the actual service holds source/target user anchors and
    -- checks GuestLive, the exact source, consent and target controller epoch.
    -- Neither SQL status='live' nor a supplied capture authenticates anyone.
    IF OLD.status<>'live' OR NEW.status<>'live'
      OR OLD.private_transfer_from_generation IS NOT NULL
      OR NEW.private_transfer_from_generation IS DISTINCT FROM OLD.privacy_generation
      OR OLD.privacy_generation::numeric>=9007199254740991
      OR NEW.privacy_generation::numeric<>OLD.privacy_generation::numeric+1
    THEN
      RAISE EXCEPTION 'v2_persona_exact_live_transfer_required' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.private_transfer_from_generation IS DISTINCT FROM OLD.private_transfer_from_generation
    OR NEW.controller_privacy_epoch IS DISTINCT FROM OLD.controller_privacy_epoch
  THEN
    RAISE EXCEPTION 'v2_persona_transfer_capture_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION listening_v2.protect_persona_composition() FROM PUBLIC;
CREATE TRIGGER privacy_personas_composition_protect
  BEFORE INSERT OR UPDATE ON listening_v2.privacy_personas
  FOR EACH ROW EXECUTE FUNCTION listening_v2.protect_persona_composition();

CREATE FUNCTION listening_v2.protect_user_privacy_epoch() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.sessions_privacy_epoch IS NULL OR NEW.sessions_privacy_epoch<OLD.sessions_privacy_epoch THEN
    RAISE EXCEPTION 'v2_user_privacy_epoch_monotone' USING ERRCODE='23514';
  END IF;
  -- safe_uint + NOT NULL enforce the upper/lower bounds without wrap.
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION listening_v2.protect_user_privacy_epoch() FROM PUBLIC;
CREATE TRIGGER library_users_sessions_privacy_epoch_protect
  BEFORE UPDATE OF sessions_privacy_epoch ON public.library_users
  FOR EACH ROW EXECUTE FUNCTION listening_v2.protect_user_privacy_epoch();

-- Exact additive column grants only. Invoker triggers require no new caller
-- EXECUTE grants. Original auth privileges and 032's false-only anchor stay.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='lyra_runtime_v1') THEN
    GRANT UPDATE(sessions_privacy_epoch) ON public.library_users TO lyra_runtime_v1;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='lyra_account_v1') THEN
    GRANT UPDATE(sessions_privacy_epoch) ON public.library_users TO lyra_account_v1;
    GRANT UPDATE(controller_privacy_epoch,private_transfer_from_generation)
      ON listening_v2.privacy_personas TO lyra_account_v1;
  END IF;
END $$;
COMMIT;
