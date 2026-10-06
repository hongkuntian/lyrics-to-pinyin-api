BEGIN;
ALTER TABLE library_users ADD COLUMN access_kind text NOT NULL DEFAULT 'beta' CHECK(access_kind IN ('beta','guest','apple'));
ALTER TABLE library_tokens ADD COLUMN expires_at timestamptz;
CREATE TABLE membership_settings (
  id integer PRIMARY KEY CHECK(id=1), public_access_enabled boolean NOT NULL DEFAULT false,
  purchases_enabled boolean NOT NULL DEFAULT false, live_enabled boolean NOT NULL DEFAULT false,
  widgets_enabled boolean NOT NULL DEFAULT false, carplay_enabled boolean NOT NULL DEFAULT false,
  starter_daily_limit integer NOT NULL DEFAULT 100 CHECK(starter_daily_limit>=0),
  preview_daily_limit integer NOT NULL DEFAULT 100 CHECK(preview_daily_limit>=0),
  relay_monthly_limit bigint NOT NULL DEFAULT 1000000 CHECK(relay_monthly_limit>=0)
);
INSERT INTO membership_settings(id) VALUES(1);
CREATE TABLE account_identities (
  subject_hash text PRIMARY KEY, user_id text NOT NULL UNIQUE REFERENCES library_users(id),
  app_account_token uuid NOT NULL UNIQUE, apple_client_id text, refresh_token_encrypted text,
  deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE account_nonces (
  digest text PRIMARY KEY, purpose text NOT NULL CHECK(purpose IN ('guest','apple','delete')),
  bundle_id text NOT NULL, key_id text, user_id text REFERENCES library_users(id),
  expires_at timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false
);
CREATE INDEX account_nonce_expiry ON account_nonces(expires_at);
CREATE TABLE account_rate_windows (
  scope text NOT NULL, window_start timestamptz NOT NULL, count integer NOT NULL,
  PRIMARY KEY(scope,window_start)
);
CREATE TABLE membership_subscriptions (
  original_transaction_id text PRIMARY KEY, user_id text NOT NULL REFERENCES library_users(id),
  transaction_id text NOT NULL, product_id text NOT NULL, tier text NOT NULL CHECK(tier IN ('plus','pro')),
  environment text NOT NULL CHECK(environment IN ('Sandbox','Production')),
  app_account_token uuid NOT NULL, period_start timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false, signed_at timestamptz NOT NULL, verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX membership_active_user ON membership_subscriptions(user_id,expires_at);
CREATE TABLE membership_notifications (
  id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE membership_grants (
  id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES library_users(id),
  kind text NOT NULL CHECK(kind IN ('translation','study')), period_key text NOT NULL,
  allowance integer NOT NULL CHECK(allowance>=0), expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,kind,period_key)
);
CREATE TABLE membership_usage (
  operation_id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES library_users(id),
  grant_id uuid NOT NULL REFERENCES membership_grants(id), kind text NOT NULL CHECK(kind IN ('translation','study')),
  state text NOT NULL CHECK(state IN ('reserved','consumed','released')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX membership_usage_grant ON membership_usage(grant_id,state);
CREATE TABLE membership_preview_claims (
  user_id text PRIMARY KEY REFERENCES library_users(id), activity_id text NOT NULL,
  recording_id text NOT NULL, request_count integer NOT NULL DEFAULT 0,
  claimed_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE TABLE membership_relay_usage (
  user_id text NOT NULL REFERENCES library_users(id), period_start date NOT NULL,
  request_count bigint NOT NULL DEFAULT 0, PRIMARY KEY(user_id,period_start)
);
-- Public identity writes use a separate login, never the generation/relay login.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_runtime_v1') THEN
    GRANT SELECT ON public.library_users,public.account_identities,public.membership_settings TO lyra_runtime_v1;
    GRANT UPDATE(auth_count) ON public.library_users TO lyra_runtime_v1;
    GRANT UPDATE(id) ON public.membership_settings TO lyra_runtime_v1;
    GRANT SELECT,INSERT,UPDATE ON public.membership_subscriptions,public.membership_notifications,
      public.membership_grants,public.membership_usage,public.membership_preview_claims,public.membership_relay_usage TO lyra_runtime_v1;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyra_account_v1') THEN
    GRANT USAGE ON SCHEMA public TO lyra_account_v1;
    GRANT SELECT,INSERT,UPDATE,DELETE ON public.account_identities,public.account_nonces,public.account_rate_windows,
      public.library_tokens,public.app_attest_keys,public.app_auth_sessions TO lyra_account_v1;
    GRANT SELECT ON public.membership_settings,public.library_users TO lyra_account_v1;
    GRANT UPDATE(id) ON public.membership_settings TO lyra_account_v1;
    GRANT INSERT(id,access_kind),UPDATE(disabled,auth_count,auth_window,refresh_count,refresh_window) ON public.library_users TO lyra_account_v1;
    GRANT DELETE ON public.live_lyrics_push_receipts TO lyra_account_v1;
    GRANT SELECT(user_id) ON public.live_lyrics_push_receipts TO lyra_account_v1;
    GRANT SELECT(user_id),UPDATE(detail,assessment) ON public.correction_reports TO lyra_account_v1;
  END IF;
END $$;
COMMIT;
