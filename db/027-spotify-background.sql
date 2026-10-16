-- Spotify state is durable, encrypted at the application boundary, and independent
-- of the lifetime of app-auth sessions and queue/function instances.
CREATE TABLE spotify_connections (
 id text PRIMARY KEY,
 owner_id text NOT NULL,
 key_id text NOT NULL,
 credential_digest text NOT NULL,
 enrollment_id text NOT NULL,
 data jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,key_id,enrollment_id)
);
CREATE INDEX spotify_connections_owner ON spotify_connections(owner_id,key_id);
CREATE TABLE spotify_outbox (
 id text PRIMARY KEY,
 connection_id text NOT NULL REFERENCES spotify_connections(id) ON DELETE CASCADE,
 epoch text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('tick','wake','acquire','cleanup','publication','widget')),
 due_at_ms bigint NOT NULL,
 data jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published','cancelled')),
 receipt text,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX spotify_outbox_pending ON spotify_outbox(connection_id,state,due_at_ms);
CREATE TABLE spotify_snapshot_capabilities (
 digest text PRIMARY KEY,
 connection_id text NOT NULL REFERENCES spotify_connections(id) ON DELETE CASCADE,
 session_id text NOT NULL,
 expires_at_ms bigint NOT NULL
);
-- Coordination is at Spotify developer-account bucket scope, not Client ID scope.
CREATE TABLE spotify_provider_circuits (
 id text PRIMARY KEY,
 not_before_ms bigint NOT NULL DEFAULT 0,
 reason text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_runtime_v1') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON spotify_connections,spotify_outbox,spotify_snapshot_capabilities,spotify_provider_circuits TO lyra_runtime_v1;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_account_v1') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON spotify_connections,spotify_outbox,spotify_snapshot_capabilities TO lyra_account_v1;
 END IF;
END $$;
