BEGIN;
CREATE TABLE IF NOT EXISTS listening_rooms (
 id uuid PRIMARY KEY,
 environment text NOT NULL,
 owner_id text NOT NULL REFERENCES library_users(id) ON DELETE CASCADE,
 status text NOT NULL CHECK(status IN ('active','ended')),
 invite_hash text NOT NULL UNIQUE,
 code_hash text NOT NULL,
 share_hash text UNIQUE,
 data jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS listening_one_hosted_room ON listening_rooms(owner_id,environment) WHERE status='active';
CREATE UNIQUE INDEX IF NOT EXISTS listening_active_code ON listening_rooms(code_hash,environment) WHERE status='active';
CREATE INDEX IF NOT EXISTS listening_members ON listening_rooms USING gin(data jsonb_path_ops);
CREATE TABLE IF NOT EXISTS listening_commands (
 room_id uuid NOT NULL REFERENCES listening_rooms(id) ON DELETE CASCADE,
 command_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES library_users(id) ON DELETE CASCADE,
 fingerprint text NOT NULL,
 accepted_revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(room_id,command_id)
);
CREATE TABLE IF NOT EXISTS listening_outbox (
 id text PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES listening_rooms(id) ON DELETE CASCADE,
 ordinal integer NOT NULL,
 due_at_ms bigint NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published')),
 receipt text,
 UNIQUE(room_id,ordinal)
);
CREATE INDEX IF NOT EXISTS listening_outbox_pending ON listening_outbox(room_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS listening_rate_windows (
 user_id text NOT NULL REFERENCES library_users(id) ON DELETE CASCADE,
 bucket text NOT NULL,
 window_at timestamptz NOT NULL,
 count integer NOT NULL,
 PRIMARY KEY(user_id,bucket)
);
COMMIT;
