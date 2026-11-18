BEGIN;
-- Anonymous accounts (no sign-in). Contract: Lyrica docs/ANONYMOUS_ACCOUNTS.md,
-- "Reset and removal". Operator procedure: docs/ANONYMOUS_ACCOUNTS_MIGRATION.md.
--
-- Apply this before deploying the backend that uses it: the production build
-- requires this receipt. Until that deploy, the previous backend's Sign in with
-- Apple, membership status and store-notification paths fail closed (503)
-- because account_identities is gone; Apple retries notifications.
--
-- Every statement is a no-op on a repeat, so a direct rerun changes nothing.

-- Every account owns its StoreKit appAccountToken. The volatile default gives
-- each existing row its own UUID during the rewrite.
ALTER TABLE public.library_users ADD COLUMN IF NOT EXISTS app_account_token uuid
  NOT NULL DEFAULT gen_random_uuid() CONSTRAINT library_users_app_account_token_key UNIQUE;
-- DeviceCheck hold on a new account's free library allowance.
ALTER TABLE public.library_users ADD COLUMN IF NOT EXISTS free_allowance_held_until timestamptz;
-- Offer-code transactions carry no appAccountToken.
ALTER TABLE public.membership_subscriptions ALTER COLUMN app_account_token DROP NOT NULL;
-- A paid period's allowance is counted across every account that held the
-- subscription (Restore moves it), by grant period and kind.
CREATE INDEX IF NOT EXISTS membership_grants_period_kind ON public.membership_grants(period_key,kind);

-- Live Lyrics relay admission: 'members' by default, 'everyone' in prerelease.
-- Set only when the column is created, so a rerun keeps the operator's value.
DO $relay_access$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid='public.membership_settings'::regclass AND attname='relay_access' AND attnum>0 AND NOT attisdropped
  ) THEN
    ALTER TABLE public.membership_settings ADD COLUMN relay_access text NOT NULL DEFAULT 'members'
      CONSTRAINT membership_settings_relay_access_check CHECK (relay_access IN ('members','everyone'));
    UPDATE public.membership_settings SET relay_access='everyone' WHERE id=1;
  END IF;
END $relay_access$;

-- The reset deletes the Apple account's subscriptions. Production has only
-- two expired Sandbox ones; refuse (rolling everything back) rather than
-- delete a Production or still-active purchase.
DO $apple_subscriptions$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.membership_subscriptions s JOIN public.library_users u ON u.id=s.user_id
    WHERE u.access_kind='apple' AND (s.environment<>'Sandbox' OR s.expires_at>now())
  ) THEN
    RAISE EXCEPTION 'apple_account_live_subscription' USING ERRCODE='23514';
  END IF;
END $apple_subscriptions$;

-- Reset every Sign in with Apple account (production: exactly one). The row
-- stays as a disabled 'apple' account so retained ledgers keep their owner.
-- Credentials and keys are revoked (key material cleared as on deletion),
-- sessions deleted, and its subscriptions, preview claim and relay usage
-- deleted. Each statement only touches rows not yet in the reset state.
UPDATE public.library_users SET disabled=true WHERE access_kind='apple' AND NOT disabled;
UPDATE public.library_tokens SET revoked=true
  WHERE NOT revoked AND user_id IN (SELECT id FROM public.library_users WHERE access_kind='apple');
UPDATE public.app_attest_keys SET revoked=true,receipt=''::bytea,public_key=''
  WHERE (NOT revoked OR public_key<>'' OR receipt<>''::bytea)
    AND user_id IN (SELECT id FROM public.library_users WHERE access_kind='apple');
DELETE FROM public.app_auth_sessions
  WHERE key_id IN (SELECT k.key_id FROM public.app_attest_keys k JOIN public.library_users u ON u.id=k.user_id WHERE u.access_kind='apple')
     OR credential_digest IN (SELECT t.digest FROM public.library_tokens t JOIN public.library_users u ON u.id=t.user_id WHERE u.access_kind='apple');
DELETE FROM public.membership_subscriptions WHERE user_id IN (SELECT id FROM public.library_users WHERE access_kind='apple');
DELETE FROM public.membership_preview_claims WHERE user_id IN (SELECT id FROM public.library_users WHERE access_kind='apple');
DELETE FROM public.membership_relay_usage WHERE user_id IN (SELECT id FROM public.library_users WHERE access_kind='apple');

-- Sign in with Apple identity and its nonce purposes are removed. The default
-- RESTRICT refuses (and rolls back) if anything else depends on the table.
DROP TABLE IF EXISTS public.account_identities;
DELETE FROM public.account_nonces WHERE purpose<>'guest';
ALTER TABLE public.account_nonces DROP CONSTRAINT IF EXISTS account_nonces_purpose_check;
ALTER TABLE public.account_nonces ADD CONSTRAINT account_nonces_purpose_check CHECK (purpose='guest');

-- Issuing an App Attest session slides a guest credential to 365 days. The
-- runtime login keeps no direct UPDATE on library_tokens; this bounded
-- function is its only way to change an expiry. It never extends a revoked,
-- expired, unbounded or non-guest credential, and writes only when fewer
-- than 300 days remain. The caller already holds the token row lock.
CREATE OR REPLACE FUNCTION public.slide_guest_credential_expiry(p_digest text) RETURNS timestamptz
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $slide$
  UPDATE public.library_tokens t SET expires_at=pg_catalog.clock_timestamp()+interval '365 days'
  WHERE t.digest=p_digest AND NOT t.revoked AND t.expires_at IS NOT NULL
    AND t.expires_at>pg_catalog.clock_timestamp()
    AND t.expires_at<pg_catalog.clock_timestamp()+interval '300 days'
    AND EXISTS (SELECT 1 FROM public.library_users u WHERE u.id=t.user_id AND u.access_kind='guest' AND NOT u.disabled)
  RETURNING t.expires_at
$slide$;
REVOKE ALL ON FUNCTION public.slide_guest_credential_expiry(text) FROM PUBLIC;

-- The membership role replay helper selects this entire idempotent block.
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyrica_account_v1') THEN
    GRANT INSERT(free_allowance_held_until) ON public.library_users TO lyrica_account_v1;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='lyrica_runtime_v1') THEN
    GRANT EXECUTE ON FUNCTION public.slide_guest_credential_expiry(text) TO lyrica_runtime_v1;
  END IF;
END $$;
COMMIT;
