-- Additive, inert foundation. Not registered by the migration runner in this slice.
-- Migration owner only: never run through the runtime/account login.
BEGIN;
CREATE SCHEMA listening_v2;
REVOKE ALL ON SCHEMA listening_v2 FROM PUBLIC;

CREATE DOMAIN listening_v2.environment AS text CHECK (
  VALUE IN ('production','development','test') OR
  VALUE ~ '^preview:[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
);
CREATE DOMAIN listening_v2.safe_uint AS bigint CHECK (VALUE BETWEEN 0 AND 9007199254740991);
CREATE DOMAIN listening_v2.digest AS text CHECK (VALUE ~ '^[0-9a-f]{64}$');
CREATE DOMAIN listening_v2.identifier AS text CHECK (
  octet_length(VALUE) BETWEEN 1 AND 160 AND VALUE !~ '[[:cntrl:]]'
);

-- Safety data has no FK to a user, credential, connection, persona or room.
-- Bindings are versioned server HMACs of verified scopes, never names/OAuth.
CREATE TABLE listening_v2.output_guards (
  environment listening_v2.environment NOT NULL,
  guard_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('appleMusic','spotify')),
  binding_key_version integer NOT NULL CHECK (binding_key_version BETWEEN 1 AND 65535),
  account_binding listening_v2.digest NOT NULL,
  connection_lineage listening_v2.digest NOT NULL,
  output_scope listening_v2.digest NOT NULL,
  scope_kind text NOT NULL CHECK (scope_kind IN ('account_wildcard','captured_output')),
  original_install_scope listening_v2.digest NOT NULL,
  bootstrap_state text NOT NULL DEFAULT 'uninitialized'
    CHECK (bootstrap_state IN ('uninitialized','legacy_quarantined','initialized')),
  bootstrap_epoch listening_v2.safe_uint NOT NULL DEFAULT 0,
  qualification_manifest_hash listening_v2.digest,
  minimum_writer_generation listening_v2.safe_uint NOT NULL DEFAULT 0,
  guard_revision listening_v2.safe_uint NOT NULL DEFAULT 0,
  authority_epoch listening_v2.safe_uint NOT NULL DEFAULT 0,
  lane_state text NOT NULL DEFAULT 'blocked'
    CHECK (lane_state IN ('blocked','idle','reserved','executing','uncertain')),
  send_ordinal listening_v2.safe_uint NOT NULL DEFAULT 0,
  execution_id uuid,
  claim_epoch listening_v2.safe_uint NOT NULL DEFAULT 0,
  claim_nonce_hash listening_v2.digest,
  claim_until_ms listening_v2.safe_uint,
  endpoint_body_hash listening_v2.digest,
  may_have_been_sent boolean NOT NULL DEFAULT false,
  release_evidence_hash listening_v2.digest,
  observed_count integer NOT NULL DEFAULT 0 CHECK (observed_count BETWEEN 0 AND 512),
  reserved_visit_credits integer NOT NULL DEFAULT 0 CHECK (reserved_visit_credits BETWEEN 0 AND 512),
  reserved_semantic_events integer NOT NULL DEFAULT 0 CHECK (reserved_semantic_events BETWEEN 0 AND 20000),
  reserved_receipts integer NOT NULL DEFAULT 0 CHECK (reserved_receipts BETWEEN 0 AND 30000),
  reserved_capsule_bytes integer NOT NULL DEFAULT 0 CHECK (reserved_capsule_bytes BETWEEN 0 AND 131072),
  terminal_reservation_bytes integer NOT NULL DEFAULT 8192 CHECK (terminal_reservation_bytes BETWEEN 8192 AND 14336),
  safety_capsule jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at_ms listening_v2.safe_uint NOT NULL,
  updated_at_ms listening_v2.safe_uint NOT NULL,
  PRIMARY KEY (environment,guard_id),
  UNIQUE (environment,provider,account_binding,connection_lineage,output_scope),
  CHECK (updated_at_ms >= created_at_ms),
  CHECK (jsonb_typeof(safety_capsule)='object' AND octet_length(safety_capsule::text)<=131072),
  CHECK (observed_count+reserved_visit_credits<=512),
  CHECK ((bootstrap_state='initialized' AND bootstrap_epoch>0 AND minimum_writer_generation>0
          AND qualification_manifest_hash IS NOT NULL AND lane_state<>'blocked')
      OR (bootstrap_state<>'initialized' AND lane_state IN ('blocked','uncertain'))),
  CHECK (NOT may_have_been_sent OR (send_ordinal>0 AND execution_id IS NOT NULL
    AND endpoint_body_hash IS NOT NULL AND claim_nonce_hash IS NOT NULL
    AND lane_state IN ('executing','uncertain'))),
  CHECK (lane_state NOT IN ('reserved','executing','uncertain') OR execution_id IS NOT NULL),
  CHECK ((claim_nonce_hash IS NULL)=(claim_until_ms IS NULL))
);
CREATE UNIQUE INDEX output_guards_one_account_lane ON listening_v2.output_guards
  (environment,provider,account_binding) WHERE lane_state IN ('reserved','executing','uncertain');
CREATE INDEX output_guards_install ON listening_v2.output_guards (environment,original_install_scope,guard_id);
CREATE INDEX output_guards_bootstrap ON listening_v2.output_guards (environment,bootstrap_state,provider,account_binding,guard_id);

CREATE TABLE listening_v2.privacy_personas (
  environment listening_v2.environment NOT NULL,
  persona_id uuid NOT NULL,
  original_principal_id listening_v2.identifier NOT NULL,
  original_key_id listening_v2.identifier NOT NULL,
  controller_kind text NOT NULL CHECK (controller_kind IN ('guest','apple','erased')),
  controller_principal_id listening_v2.identifier,
  controller_key_id listening_v2.identifier,
  privacy_generation listening_v2.safe_uint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'live' CHECK (status IN ('live','withdrawn','erased')),
  guest_credential_digest listening_v2.digest,
  guest_credential_expires_at_ms listening_v2.safe_uint,
  withdrawn_at_ms listening_v2.safe_uint,
  scrub_due_at_ms listening_v2.safe_uint,
  scrub_cursor text CHECK (octet_length(scrub_cursor)<=96),
  created_at_ms listening_v2.safe_uint NOT NULL,
  updated_at_ms listening_v2.safe_uint NOT NULL,
  PRIMARY KEY (environment,persona_id),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK ((controller_kind='guest' AND controller_principal_id=original_principal_id
    AND controller_key_id=original_key_id AND guest_credential_digest IS NOT NULL
    AND guest_credential_expires_at_ms IS NOT NULL
    AND guest_credential_expires_at_ms>created_at_ms
    AND guest_credential_expires_at_ms::numeric<=created_at_ms::numeric+7776000000) IS TRUE
    OR (controller_kind='apple' AND controller_principal_id IS NOT NULL AND controller_key_id IS NULL
        AND guest_credential_digest IS NULL AND guest_credential_expires_at_ms IS NULL)
    OR (controller_kind='erased' AND status='erased' AND controller_principal_id IS NULL
        AND controller_key_id IS NULL AND guest_credential_digest IS NULL AND guest_credential_expires_at_ms IS NULL)),
  CHECK ((status='live' AND withdrawn_at_ms IS NULL AND scrub_due_at_ms IS NULL AND scrub_cursor IS NULL)
    OR (status<>'live' AND withdrawn_at_ms IS NOT NULL AND scrub_due_at_ms IS NOT NULL
      AND scrub_due_at_ms>=withdrawn_at_ms
      AND scrub_due_at_ms::numeric<=withdrawn_at_ms::numeric+86400000)),
  CHECK (octet_length(jsonb_build_array(environment,persona_id,original_principal_id,original_key_id,
    controller_kind,controller_principal_id,controller_key_id,privacy_generation,status,
    guest_credential_digest,guest_credential_expires_at_ms,withdrawn_at_ms,scrub_due_at_ms,scrub_cursor,
    created_at_ms,updated_at_ms)::text)<=512)
);
-- A fresh explicitly consented incarnation gets a new UUID after withdrawal;
-- it never reopens the old persona or its references.
CREATE UNIQUE INDEX privacy_personas_live_origin ON listening_v2.privacy_personas
  (environment,original_principal_id,original_key_id) WHERE status='live';
CREATE INDEX privacy_personas_controller ON listening_v2.privacy_personas
  (environment,controller_kind,controller_principal_id,persona_id);
CREATE INDEX privacy_personas_dependency ON listening_v2.privacy_personas
  (environment,guest_credential_digest,persona_id) WHERE controller_kind='guest' AND status='live';
CREATE INDEX privacy_personas_expiry ON listening_v2.privacy_personas
  (environment,guest_credential_expires_at_ms,persona_id) WHERE controller_kind='guest' AND status='live';
CREATE INDEX privacy_personas_key ON listening_v2.privacy_personas (environment,original_key_id,status,persona_id);
CREATE INDEX privacy_personas_scrub_due ON listening_v2.privacy_personas
  (environment,scrub_due_at_ms,persona_id) WHERE status<>'live';

CREATE TABLE listening_v2.rooms (
  environment listening_v2.environment NOT NULL,
  session_id uuid NOT NULL,
  protocol_version smallint NOT NULL DEFAULT 2 CHECK (protocol_version=2),
  host_install_scope listening_v2.digest NOT NULL,
  host_persona_id uuid,
  host_privacy_generation listening_v2.safe_uint,
  privacy_persona_ids uuid[] NOT NULL DEFAULT '{}',
  provider text NOT NULL CHECK (provider IN ('appleMusic','spotify')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  invite_digest listening_v2.digest NOT NULL,
  code_digest listening_v2.digest NOT NULL,
  share_digest listening_v2.digest,
  invite_generation listening_v2.safe_uint NOT NULL DEFAULT 0,
  share_generation listening_v2.safe_uint NOT NULL DEFAULT 0,
  session_revision listening_v2.safe_uint NOT NULL DEFAULT 0,
  queue_revision listening_v2.safe_uint NOT NULL DEFAULT 0,
  settings_revision listening_v2.safe_uint NOT NULL DEFAULT 0,
  transition_revision listening_v2.safe_uint NOT NULL DEFAULT 0,
  state_version listening_v2.safe_uint NOT NULL DEFAULT 0,
  event_seq listening_v2.safe_uint NOT NULL DEFAULT 0 CHECK (event_seq<=30001),
  authority_epoch listening_v2.safe_uint NOT NULL DEFAULT 0,
  observation_sequence listening_v2.safe_uint NOT NULL DEFAULT 0,
  desired_queue_revision listening_v2.safe_uint NOT NULL DEFAULT 0,
  applied_queue_revision listening_v2.safe_uint NOT NULL DEFAULT 0,
  occurrence_count integer NOT NULL DEFAULT 0 CHECK (occurrence_count BETWEEN 0 AND 100),
  observed_visit_count integer NOT NULL DEFAULT 0 CHECK (observed_visit_count BETWEEN 0 AND 512),
  traversal_credits integer NOT NULL DEFAULT 0 CHECK (traversal_credits BETWEEN 0 AND 512),
  inverse_credits integer NOT NULL DEFAULT 0 CHECK (inverse_credits BETWEEN 0 AND 512),
  desired_credits integer NOT NULL DEFAULT 0 CHECK (desired_credits BETWEEN 0 AND 512),
  other_accepted_credits integer NOT NULL DEFAULT 0 CHECK (other_accepted_credits BETWEEN 0 AND 512),
  semantic_event_count integer NOT NULL DEFAULT 0 CHECK (semantic_event_count BETWEEN 0 AND 20000),
  reserved_semantic_events integer NOT NULL DEFAULT 0 CHECK (reserved_semantic_events BETWEEN 0 AND 20000),
  reaction_event_count integer NOT NULL DEFAULT 0 CHECK (reaction_event_count BETWEEN 0 AND 10000),
  receipt_count integer NOT NULL DEFAULT 0 CHECK (receipt_count BETWEEN 0 AND 30000),
  reserved_receipts integer NOT NULL DEFAULT 0 CHECK (reserved_receipts BETWEEN 0 AND 30000),
  execution_count integer NOT NULL DEFAULT 0 CHECK (execution_count BETWEEN 0 AND 1000),
  reserved_executions integer NOT NULL DEFAULT 0 CHECK (reserved_executions BETWEEN 0 AND 1000),
  end_event_reserved boolean NOT NULL DEFAULT true CHECK (end_event_reserved),
  terminal_reservation_bytes integer NOT NULL DEFAULT 8192 CHECK (terminal_reservation_bytes=8192),
  state jsonb NOT NULL DEFAULT '{"occurrences":[],"visits":[]}'::jsonb,
  created_at_ms listening_v2.safe_uint NOT NULL,
  expires_at_ms listening_v2.safe_uint NOT NULL,
  ended_at_ms listening_v2.safe_uint,
  event_delete_after_ms listening_v2.safe_uint,
  receipt_delete_after_ms listening_v2.safe_uint,
  updated_at_ms listening_v2.safe_uint NOT NULL,
  PRIMARY KEY (environment,session_id),
  FOREIGN KEY (environment,host_persona_id) REFERENCES listening_v2.privacy_personas(environment,persona_id) ON DELETE RESTRICT,
  UNIQUE (environment,invite_digest),
  UNIQUE (environment,share_digest),
  CHECK ((host_persona_id IS NULL)=(host_privacy_generation IS NULL)),
  CHECK (cardinality(privacy_persona_ids)<=335 AND array_position(privacy_persona_ids,NULL) IS NULL),
  CHECK (expires_at_ms>created_at_ms AND expires_at_ms::numeric<=created_at_ms::numeric+28800000),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK ((status='active' AND ended_at_ms IS NULL AND event_delete_after_ms IS NULL AND receipt_delete_after_ms IS NULL)
    OR (status='ended' AND ended_at_ms IS NOT NULL AND ended_at_ms>=created_at_ms
      AND event_delete_after_ms::numeric>=ended_at_ms::numeric+86400000
      AND receipt_delete_after_ms::numeric>=ended_at_ms::numeric+2592000000) IS TRUE),
  CHECK ((jsonb_typeof(state)='object' AND jsonb_typeof(state->'occurrences')='array'
    AND jsonb_typeof(state->'visits')='array' AND octet_length(state::text)<=262144
    AND jsonb_array_length(state->'occurrences')=occurrence_count
    AND jsonb_array_length(state->'visits')=observed_visit_count) IS TRUE),
  CHECK (observed_visit_count+traversal_credits+inverse_credits+desired_credits+other_accepted_credits<=512),
  CHECK (semantic_event_count+reserved_semantic_events<=20000),
  CHECK (receipt_count+reserved_receipts<=30000),
  CHECK (execution_count+reserved_executions<=1000),
  CHECK (applied_queue_revision<=desired_queue_revision AND desired_queue_revision<=queue_revision)
);
CREATE UNIQUE INDEX rooms_one_hosted ON listening_v2.rooms (environment,host_install_scope) WHERE status='active';
CREATE UNIQUE INDEX rooms_active_code ON listening_v2.rooms (environment,code_digest) WHERE status='active';
CREATE INDEX rooms_expiry ON listening_v2.rooms (environment,status,expires_at_ms,session_id);
CREATE INDEX rooms_host_privacy ON listening_v2.rooms (environment,host_persona_id,session_id);
-- Built-in array GIN opclasses avoid btree_gin installation. Both predicates
-- must be used: ARRAY[environment::text] @> ARRAY[$env] and persona_ids @> ... .
CREATE INDEX rooms_privacy_refs ON listening_v2.rooms USING gin ((ARRAY[environment::text]),privacy_persona_ids);
CREATE INDEX rooms_event_retention ON listening_v2.rooms (environment,event_delete_after_ms,session_id) WHERE status='ended';
CREATE INDEX rooms_receipt_retention ON listening_v2.rooms (environment,receipt_delete_after_ms,session_id) WHERE status='ended';

CREATE TABLE listening_v2.returning_grants (
  environment listening_v2.environment NOT NULL,
  grant_id uuid NOT NULL,
  host_install_scope listening_v2.digest NOT NULL,
  pair_digest listening_v2.digest NOT NULL,
  hmac_key_version integer NOT NULL CHECK (hmac_key_version BETWEEN 1 AND 65535),
  grant_generation listening_v2.safe_uint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('active','revoked')),
  host_persona_id uuid,
  host_privacy_generation listening_v2.safe_uint,
  guest_persona_id uuid,
  guest_privacy_generation listening_v2.safe_uint,
  approver_persona_id uuid,
  approver_privacy_generation listening_v2.safe_uint,
  approved_session_id uuid,
  created_at_ms listening_v2.safe_uint NOT NULL,
  revoked_at_ms listening_v2.safe_uint,
  updated_at_ms listening_v2.safe_uint NOT NULL,
  PRIMARY KEY (environment,grant_id),
  UNIQUE (environment,host_install_scope,pair_digest),
  FOREIGN KEY (environment,host_persona_id) REFERENCES listening_v2.privacy_personas(environment,persona_id) ON DELETE RESTRICT,
  FOREIGN KEY (environment,guest_persona_id) REFERENCES listening_v2.privacy_personas(environment,persona_id) ON DELETE RESTRICT,
  FOREIGN KEY (environment,approver_persona_id) REFERENCES listening_v2.privacy_personas(environment,persona_id) ON DELETE RESTRICT,
  CHECK ((host_persona_id IS NULL)=(host_privacy_generation IS NULL)),
  CHECK ((guest_persona_id IS NULL)=(guest_privacy_generation IS NULL)),
  CHECK ((approver_persona_id IS NULL)=(approver_privacy_generation IS NULL)),
  CHECK (updated_at_ms>=created_at_ms),
  CHECK ((status='active' AND host_persona_id IS NOT NULL AND guest_persona_id IS NOT NULL AND revoked_at_ms IS NULL)
    OR (status='revoked' AND revoked_at_ms IS NOT NULL)),
  CHECK (octet_length(jsonb_build_array(environment,grant_id,host_install_scope,pair_digest,hmac_key_version,
    grant_generation,status,host_persona_id,host_privacy_generation,guest_persona_id,guest_privacy_generation,
    approver_persona_id,approver_privacy_generation,approved_session_id,created_at_ms,revoked_at_ms,updated_at_ms)::text)<=1024)
);
CREATE INDEX returning_grants_host ON listening_v2.returning_grants (environment,host_install_scope,status,grant_id);
CREATE INDEX returning_grants_host_persona ON listening_v2.returning_grants (environment,host_persona_id,grant_id);
CREATE INDEX returning_grants_guest_persona ON listening_v2.returning_grants (environment,guest_persona_id,grant_id);
CREATE INDEX returning_grants_approver ON listening_v2.returning_grants (environment,approver_persona_id,grant_id);

CREATE TABLE listening_v2.command_receipts (
  environment listening_v2.environment NOT NULL,
  session_id uuid NOT NULL,
  principal_binding listening_v2.digest NOT NULL,
  key_binding listening_v2.digest NOT NULL,
  command_id uuid NOT NULL,
  binding_key_version integer NOT NULL CHECK (binding_key_version BETWEEN 1 AND 65535),
  -- Nullable for a durable create/restart refusal before a room exists.
  room_id uuid,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{0,63}$'),
  canonical_body_hash listening_v2.digest NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','executing','applied','refused','expired','uncertain','cancelled')),
  actor_persona_id uuid,
  actor_privacy_generation listening_v2.safe_uint,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at_ms listening_v2.safe_uint NOT NULL,
  ticket_expires_at_ms listening_v2.safe_uint,
  delete_after_ms listening_v2.safe_uint NOT NULL,
  PRIMARY KEY (environment,session_id,principal_binding,key_binding,command_id),
  FOREIGN KEY (environment,room_id) REFERENCES listening_v2.rooms(environment,session_id) ON DELETE RESTRICT,
  FOREIGN KEY (environment,actor_persona_id) REFERENCES listening_v2.privacy_personas(environment,persona_id) ON DELETE RESTRICT,
  CHECK (room_id IS NULL OR room_id=session_id),
  CHECK (room_id IS NOT NULL OR action IN ('create','restart','privacy.erase')),
  CHECK ((actor_persona_id IS NULL)=(actor_privacy_generation IS NULL)),
  CHECK (jsonb_typeof(result)='object' AND octet_length(result::text)<=512),
  CHECK (delete_after_ms::numeric>=created_at_ms::numeric+2592000000),
  CHECK ((action IN ('create','restart') AND ticket_expires_at_ms IS NOT NULL
    AND ticket_expires_at_ms<=delete_after_ms
    AND ticket_expires_at_ms::numeric<=created_at_ms::numeric+600000)
    OR (action NOT IN ('create','restart') AND ticket_expires_at_ms IS NULL)),
  CHECK (octet_length(jsonb_build_array(environment,session_id,principal_binding,key_binding,command_id,
    binding_key_version,room_id,action,canonical_body_hash,status,actor_persona_id,actor_privacy_generation,
    result,created_at_ms,ticket_expires_at_ms,delete_after_ms)::text)<=1024)
);
CREATE UNIQUE INDEX command_receipts_creation ON listening_v2.command_receipts
  (environment,principal_binding,key_binding,command_id) WHERE action IN ('create','restart');
CREATE INDEX command_receipts_retention ON listening_v2.command_receipts (environment,delete_after_ms,session_id,principal_binding,key_binding,command_id);
CREATE INDEX command_receipts_actor ON listening_v2.command_receipts (environment,actor_persona_id,session_id,principal_binding,key_binding,command_id);
CREATE INDEX command_receipts_room ON listening_v2.command_receipts (environment,room_id,principal_binding,key_binding,command_id);

-- One physical relation, separate semantic/reaction cursors and budgets.
CREATE TABLE listening_v2.semantic_events (
  environment listening_v2.environment NOT NULL,
  session_id uuid NOT NULL,
  event_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq BETWEEN 1 AND 30001),
  lane text NOT NULL CHECK (lane IN ('semantic','reaction','end')),
  lane_seq integer NOT NULL,
  state_version listening_v2.safe_uint NOT NULL,
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_.]{0,63}$'),
  actor_persona_id uuid,
  actor_privacy_generation listening_v2.safe_uint,
  occurrence_id uuid,
  visit_id uuid,
  command_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_at_ms listening_v2.safe_uint NOT NULL,
  delete_after_ms listening_v2.safe_uint NOT NULL,
  PRIMARY KEY (environment,session_id,seq),
  UNIQUE (environment,event_id),
  UNIQUE (environment,session_id,lane,lane_seq),
  FOREIGN KEY (environment,session_id) REFERENCES listening_v2.rooms(environment,session_id) ON DELETE RESTRICT,
  FOREIGN KEY (environment,actor_persona_id) REFERENCES listening_v2.privacy_personas(environment,persona_id) ON DELETE RESTRICT,
  CHECK ((actor_persona_id IS NULL)=(actor_privacy_generation IS NULL)),
  CHECK ((lane='semantic' AND lane_seq BETWEEN 1 AND 20000)
    OR (lane='reaction' AND lane_seq BETWEEN 1 AND 10000)
    OR (lane='end' AND lane_seq=1 AND type='session.ended')),
  CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=512),
  CHECK (delete_after_ms::numeric>=server_at_ms::numeric+86400000)
);
CREATE INDEX semantic_events_cursor ON listening_v2.semantic_events (environment,session_id,lane,seq);
CREATE INDEX semantic_events_retention ON listening_v2.semantic_events (environment,delete_after_ms,session_id,seq);
CREATE INDEX semantic_events_actor ON listening_v2.semantic_events (environment,actor_persona_id,session_id,seq);

CREATE TABLE listening_v2.private_profile_assets (
  environment listening_v2.environment NOT NULL,
  asset_id uuid NOT NULL,
  persona_id uuid NOT NULL,
  privacy_generation listening_v2.safe_uint NOT NULL,
  asset_generation listening_v2.safe_uint NOT NULL,
  install_scope listening_v2.digest NOT NULL,
  state text NOT NULL CHECK (state IN ('staged','current','revoked','deleted')),
  object_key uuid,
  content_hash listening_v2.digest NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg','image/png','image/webp')),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 262144),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 256),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 256),
  created_at_ms listening_v2.safe_uint NOT NULL,
  stage_expires_at_ms listening_v2.safe_uint NOT NULL,
  withdrawn_at_ms listening_v2.safe_uint,
  delete_due_at_ms listening_v2.safe_uint,
  backup_delete_due_at_ms listening_v2.safe_uint,
  deleted_at_ms listening_v2.safe_uint,
  PRIMARY KEY (environment,asset_id),
  UNIQUE (environment,object_key),
  FOREIGN KEY (environment,persona_id) REFERENCES listening_v2.privacy_personas(environment,persona_id) ON DELETE RESTRICT,
  CHECK (stage_expires_at_ms>created_at_ms AND stage_expires_at_ms::numeric<=created_at_ms::numeric+3600000),
  CHECK ((state IN ('staged','current') AND object_key IS NOT NULL AND withdrawn_at_ms IS NULL
      AND delete_due_at_ms IS NULL AND backup_delete_due_at_ms IS NULL AND deleted_at_ms IS NULL)
    OR (state IN ('revoked','deleted') AND withdrawn_at_ms IS NOT NULL
      AND delete_due_at_ms>=withdrawn_at_ms AND delete_due_at_ms::numeric<=withdrawn_at_ms::numeric+86400000
      AND backup_delete_due_at_ms>=withdrawn_at_ms AND backup_delete_due_at_ms::numeric<=withdrawn_at_ms::numeric+2592000000
      AND ((state='revoked' AND object_key IS NOT NULL AND deleted_at_ms IS NULL)
        OR (state='deleted' AND object_key IS NULL AND deleted_at_ms IS NOT NULL))) IS TRUE)
);
CREATE UNIQUE INDEX private_profile_assets_current ON listening_v2.private_profile_assets (environment,install_scope) WHERE state='current';
CREATE UNIQUE INDEX private_profile_assets_staged ON listening_v2.private_profile_assets (environment,install_scope) WHERE state='staged';
CREATE INDEX private_profile_assets_generation ON listening_v2.private_profile_assets (environment,persona_id,privacy_generation,asset_generation,asset_id);
CREATE INDEX private_profile_assets_staging_due ON listening_v2.private_profile_assets (environment,stage_expires_at_ms,asset_id) WHERE state='staged';
CREATE INDEX private_profile_assets_delete_due ON listening_v2.private_profile_assets (environment,delete_due_at_ms,asset_id) WHERE state='revoked';
CREATE INDEX private_profile_assets_backup_due ON listening_v2.private_profile_assets (environment,backup_delete_due_at_ms,asset_id) WHERE state IN ('revoked','deleted');

CREATE TABLE listening_v2.outbox (
  environment listening_v2.environment NOT NULL,
  job_id uuid NOT NULL,
  job_key listening_v2.identifier NOT NULL,
  kind text NOT NULL CHECK (kind IN ('wake','execution','room_expiry','privacy_scrub','asset_delete')),
  room_id uuid,
  guard_id uuid,
  persona_id uuid,
  asset_id uuid,
  privacy_generation listening_v2.safe_uint,
  guard_revision listening_v2.safe_uint,
  send_ordinal listening_v2.safe_uint,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','published','dead','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 10),
  claim_epoch listening_v2.safe_uint NOT NULL DEFAULT 0,
  claim_nonce_hash listening_v2.digest,
  claim_until_ms listening_v2.safe_uint,
  payload jsonb NOT NULL,
  created_at_ms listening_v2.safe_uint NOT NULL,
  due_at_ms listening_v2.safe_uint NOT NULL,
  retry_until_ms listening_v2.safe_uint NOT NULL,
  completed_at_ms listening_v2.safe_uint,
  delete_after_ms listening_v2.safe_uint,
  PRIMARY KEY (environment,job_id),
  UNIQUE (environment,job_key),
  FOREIGN KEY (environment,room_id) REFERENCES listening_v2.rooms(environment,session_id) ON DELETE RESTRICT,
  FOREIGN KEY (environment,guard_id) REFERENCES listening_v2.output_guards(environment,guard_id) ON DELETE RESTRICT,
  FOREIGN KEY (environment,persona_id) REFERENCES listening_v2.privacy_personas(environment,persona_id) ON DELETE RESTRICT,
  FOREIGN KEY (environment,asset_id) REFERENCES listening_v2.private_profile_assets(environment,asset_id) ON DELETE RESTRICT,
  CHECK (due_at_ms>=created_at_ms AND retry_until_ms>=due_at_ms
    AND retry_until_ms::numeric<=created_at_ms::numeric+86400000),
  CHECK ((state='claimed' AND claim_nonce_hash IS NOT NULL AND claim_until_ms IS NOT NULL
    AND claim_until_ms<=retry_until_ms AND claim_epoch>0 AND attempt_count>0)
    OR (state<>'claimed' AND claim_nonce_hash IS NULL AND claim_until_ms IS NULL)),
  CHECK ((state IN ('published','cancelled','dead') AND completed_at_ms IS NOT NULL
    AND delete_after_ms::numeric>=completed_at_ms::numeric+86400000) IS TRUE
    OR (state IN ('pending','claimed') AND completed_at_ms IS NULL AND delete_after_ms IS NULL)),
  CHECK ((kind IN ('wake','room_expiry') AND room_id IS NOT NULL AND guard_id IS NULL AND persona_id IS NULL AND asset_id IS NULL
      AND guard_revision IS NULL AND send_ordinal IS NULL AND privacy_generation IS NULL)
    OR (kind='execution' AND room_id IS NOT NULL AND guard_id IS NOT NULL AND guard_revision IS NOT NULL
      AND send_ordinal IS NOT NULL AND persona_id IS NULL AND asset_id IS NULL AND privacy_generation IS NULL)
    OR (kind='privacy_scrub' AND persona_id IS NOT NULL AND privacy_generation IS NOT NULL
      AND room_id IS NULL AND guard_id IS NULL AND asset_id IS NULL AND guard_revision IS NULL AND send_ordinal IS NULL)
    OR (kind='asset_delete' AND asset_id IS NOT NULL AND persona_id IS NOT NULL AND privacy_generation IS NOT NULL
      AND room_id IS NULL AND guard_id IS NULL AND guard_revision IS NULL AND send_ordinal IS NULL)),
  CHECK ((jsonb_typeof(payload)='object' AND octet_length(payload::text)<=4096
    AND payload->>'environment'=environment AND payload->'version'='2'::jsonb) IS TRUE)
);
CREATE INDEX outbox_due ON listening_v2.outbox (environment,due_at_ms,job_id) WHERE state='pending';
CREATE INDEX outbox_claim_deadline ON listening_v2.outbox (environment,claim_until_ms,job_id) WHERE state='claimed';
CREATE INDEX outbox_retention ON listening_v2.outbox (environment,delete_after_ms,job_id) WHERE delete_after_ms IS NOT NULL;
CREATE INDEX outbox_room ON listening_v2.outbox (environment,room_id,job_id);
CREATE INDEX outbox_guard ON listening_v2.outbox (environment,guard_id,job_id);
CREATE INDEX outbox_persona ON listening_v2.outbox (environment,persona_id,job_id);
CREATE INDEX outbox_asset ON listening_v2.outbox (environment,asset_id,job_id);

-- These triggers protect immutable identities/monotone fences only. They do
-- not implement Release, GuestLive, semantic reducers or cross-row accounting.
CREATE FUNCTION listening_v2.protect_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'v2_guard_retained' USING ERRCODE='23514'; END IF;
  IF (NEW.environment,NEW.guard_id,NEW.provider,NEW.binding_key_version,NEW.account_binding,
      NEW.connection_lineage,NEW.output_scope,NEW.scope_kind,NEW.original_install_scope,NEW.created_at_ms)
    IS DISTINCT FROM (OLD.environment,OLD.guard_id,OLD.provider,OLD.binding_key_version,OLD.account_binding,
      OLD.connection_lineage,OLD.output_scope,OLD.scope_kind,OLD.original_install_scope,OLD.created_at_ms)
    OR NEW.guard_revision<OLD.guard_revision OR NEW.authority_epoch<OLD.authority_epoch
    OR NEW.bootstrap_epoch<OLD.bootstrap_epoch OR NEW.minimum_writer_generation<OLD.minimum_writer_generation
    OR NEW.send_ordinal<OLD.send_ordinal OR NEW.claim_epoch<OLD.claim_epoch
  THEN RAISE EXCEPTION 'v2_guard_fence_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER output_guards_protect BEFORE UPDATE OR DELETE ON listening_v2.output_guards
  FOR EACH ROW EXECUTE FUNCTION listening_v2.protect_guard();

CREATE FUNCTION listening_v2.protect_persona() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.environment,NEW.persona_id,NEW.original_principal_id,NEW.original_key_id,NEW.created_at_ms)
    IS DISTINCT FROM (OLD.environment,OLD.persona_id,OLD.original_principal_id,OLD.original_key_id,OLD.created_at_ms)
    OR NEW.privacy_generation<OLD.privacy_generation
    OR (OLD.status<>'live' AND NEW.status='live')
  THEN RAISE EXCEPTION 'v2_persona_origin_or_withdrawal_immutable' USING ERRCODE='23514'; END IF;
  IF (NEW.controller_kind,NEW.controller_principal_id,NEW.controller_key_id,NEW.guest_credential_digest,
      NEW.guest_credential_expires_at_ms,NEW.status)
    IS DISTINCT FROM (OLD.controller_kind,OLD.controller_principal_id,OLD.controller_key_id,OLD.guest_credential_digest,
      OLD.guest_credential_expires_at_ms,OLD.status) AND NEW.privacy_generation<=OLD.privacy_generation
  THEN RAISE EXCEPTION 'v2_persona_generation_required' USING ERRCODE='23514'; END IF;
  IF (OLD.controller_kind='apple' AND NEW.controller_kind<>'erased' AND
      (NEW.controller_kind,NEW.controller_principal_id) IS DISTINCT FROM (OLD.controller_kind,OLD.controller_principal_id))
    OR (OLD.controller_kind='erased' AND NEW.controller_kind<>'erased')
    OR (OLD.status<>'live' AND NEW.controller_kind='apple' AND OLD.controller_kind<>'apple')
  THEN RAISE EXCEPTION 'v2_persona_controller_transfer_forbidden' USING ERRCODE='23514'; END IF;
  IF OLD.controller_kind='guest' AND NEW.controller_kind='guest' AND
    (NEW.guest_credential_digest,NEW.guest_credential_expires_at_ms)
    IS DISTINCT FROM (OLD.guest_credential_digest,OLD.guest_credential_expires_at_ms)
  THEN RAISE EXCEPTION 'v2_guest_dependency_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER privacy_personas_protect BEFORE UPDATE ON listening_v2.privacy_personas
  FOR EACH ROW EXECUTE FUNCTION listening_v2.protect_persona();

CREATE FUNCTION listening_v2.protect_room() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.environment,NEW.session_id,NEW.protocol_version,NEW.host_install_scope,NEW.provider,NEW.created_at_ms,NEW.expires_at_ms)
    IS DISTINCT FROM (OLD.environment,OLD.session_id,OLD.protocol_version,OLD.host_install_scope,OLD.provider,OLD.created_at_ms,OLD.expires_at_ms)
    OR (OLD.status='ended' AND NEW.status<>'ended')
    OR NEW.session_revision<OLD.session_revision OR NEW.queue_revision<OLD.queue_revision
    OR NEW.settings_revision<OLD.settings_revision OR NEW.transition_revision<OLD.transition_revision
    OR NEW.state_version<OLD.state_version OR NEW.event_seq<OLD.event_seq OR NEW.authority_epoch<OLD.authority_epoch
    OR NEW.observation_sequence<OLD.observation_sequence OR NEW.desired_queue_revision<OLD.desired_queue_revision
    OR NEW.applied_queue_revision<OLD.applied_queue_revision OR NEW.occurrence_count<OLD.occurrence_count
    OR NEW.observed_visit_count<OLD.observed_visit_count OR NEW.semantic_event_count<OLD.semantic_event_count
    OR NEW.reaction_event_count<OLD.reaction_event_count OR NEW.receipt_count<OLD.receipt_count
    OR NEW.execution_count<OLD.execution_count
  THEN RAISE EXCEPTION 'v2_room_identity_or_revision_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rooms_protect BEFORE UPDATE ON listening_v2.rooms
  FOR EACH ROW EXECUTE FUNCTION listening_v2.protect_room();

CREATE FUNCTION listening_v2.protect_asset() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF (NEW.environment,NEW.asset_id,NEW.persona_id,NEW.asset_generation,NEW.install_scope,NEW.content_hash,
      NEW.content_type,NEW.byte_count,NEW.width,NEW.height,NEW.created_at_ms,NEW.stage_expires_at_ms)
    IS DISTINCT FROM (OLD.environment,OLD.asset_id,OLD.persona_id,OLD.asset_generation,OLD.install_scope,OLD.content_hash,
      OLD.content_type,OLD.byte_count,OLD.width,OLD.height,OLD.created_at_ms,OLD.stage_expires_at_ms)
    OR NEW.privacy_generation<OLD.privacy_generation
    OR (OLD.state IN ('revoked','deleted') AND NEW.state IN ('staged','current'))
    OR (OLD.state='deleted' AND NEW.state<>'deleted')
    OR (NEW.object_key IS DISTINCT FROM OLD.object_key AND NOT (NEW.state='deleted' AND NEW.object_key IS NULL))
    OR (OLD.withdrawn_at_ms IS NOT NULL AND
      (NEW.withdrawn_at_ms,NEW.delete_due_at_ms,NEW.backup_delete_due_at_ms)
      IS DISTINCT FROM (OLD.withdrawn_at_ms,OLD.delete_due_at_ms,OLD.backup_delete_due_at_ms))
  THEN RAISE EXCEPTION 'v2_asset_identity_or_withdrawal_immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER private_profile_assets_protect BEFORE UPDATE ON listening_v2.private_profile_assets
  FOR EACH ROW EXECUTE FUNCTION listening_v2.protect_asset();

REVOKE ALL ON ALL TABLES IN SCHEMA listening_v2 FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA listening_v2 FROM PUBLIC;
REVOKE ALL ON DOMAIN listening_v2.environment,listening_v2.safe_uint,listening_v2.digest,listening_v2.identifier FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_runtime_v1') THEN
    GRANT USAGE ON SCHEMA listening_v2 TO lyra_runtime_v1;
    GRANT SELECT,INSERT,UPDATE ON listening_v2.output_guards,
      listening_v2.rooms,listening_v2.returning_grants,listening_v2.command_receipts,
      listening_v2.semantic_events,listening_v2.outbox,listening_v2.private_profile_assets TO lyra_runtime_v1;
    GRANT SELECT,INSERT ON listening_v2.privacy_personas TO lyra_runtime_v1;
    GRANT UPDATE(privacy_generation,status,withdrawn_at_ms,scrub_due_at_ms,scrub_cursor,updated_at_ms)
      ON listening_v2.privacy_personas TO lyra_runtime_v1;
    -- Retention/compaction excludes guards. Persona FKs require explicit scrub first.
    GRANT DELETE ON listening_v2.privacy_personas,listening_v2.rooms,listening_v2.returning_grants,
      listening_v2.command_receipts,listening_v2.semantic_events,listening_v2.outbox,
      listening_v2.private_profile_assets TO lyra_runtime_v1;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_account_v1') THEN
    GRANT USAGE ON SCHEMA listening_v2 TO lyra_account_v1;
    GRANT SELECT ON ALL TABLES IN SCHEMA listening_v2 TO lyra_account_v1;
    GRANT UPDATE(guard_revision,authority_epoch,lane_state,updated_at_ms) ON listening_v2.output_guards TO lyra_account_v1;
    GRANT UPDATE(controller_kind,controller_principal_id,controller_key_id,privacy_generation,status,
      guest_credential_digest,guest_credential_expires_at_ms,withdrawn_at_ms,scrub_due_at_ms,scrub_cursor,updated_at_ms)
      ON listening_v2.privacy_personas TO lyra_account_v1;
    GRANT UPDATE(host_persona_id,host_privacy_generation,privacy_persona_ids,status,state,ended_at_ms,
      event_delete_after_ms,receipt_delete_after_ms,session_revision,transition_revision,state_version,authority_epoch,updated_at_ms)
      ON listening_v2.rooms TO lyra_account_v1;
    GRANT UPDATE(status,grant_generation,host_persona_id,host_privacy_generation,guest_persona_id,
      guest_privacy_generation,approver_persona_id,approver_privacy_generation,revoked_at_ms,updated_at_ms)
      ON listening_v2.returning_grants TO lyra_account_v1;
    GRANT UPDATE(actor_persona_id,actor_privacy_generation,result) ON listening_v2.command_receipts TO lyra_account_v1;
    GRANT UPDATE(actor_persona_id,actor_privacy_generation,payload) ON listening_v2.semantic_events TO lyra_account_v1;
    GRANT UPDATE(privacy_generation,state,withdrawn_at_ms,delete_due_at_ms,backup_delete_due_at_ms) ON listening_v2.private_profile_assets TO lyra_account_v1;
    -- Only cleanup jobs: other kinds require room/guard columns not granted here.
    GRANT INSERT(environment,job_id,job_key,kind,persona_id,asset_id,privacy_generation,payload,
      created_at_ms,due_at_ms,retry_until_ms) ON listening_v2.outbox TO lyra_account_v1;
  END IF;
END $$;
COMMIT;
