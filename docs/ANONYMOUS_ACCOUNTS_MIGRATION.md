# Anonymous accounts: migration 039 and deploy procedure

Migration `db/039-anonymous-accounts.sql` moves the backend to anonymous
accounts with no sign-in. The contract is the Lyrica app repo's
`docs/ANONYMOUS_ACCOUNTS.md`, section "Reset and removal".

## What 039 does

- Adds `library_users.app_account_token` (UUID, unique, a distinct value
  generated for every existing and future row) and
  `library_users.free_allowance_held_until` (DeviceCheck hold; null for every
  existing row).
- Adds `membership_settings.relay_access` (`members` or `everyone`, default
  `members`) and sets it to `everyone` when the column is created.
- Makes `membership_subscriptions.app_account_token` nullable (offer codes)
  and indexes `membership_grants(period_key, kind)` for the paid-usage count
  shared by every account that held a subscription.
- Refuses with `apple_account_live_subscription` (SQLSTATE 23514), changing
  nothing, if the `apple` account owns any Production or unexpired
  subscription. Production has only two expired Sandbox ones.
- Resets every `apple` account (production: exactly one): the user is
  disabled; its credentials are revoked; its App Attest keys are revoked with
  key material cleared; its sessions are deleted; its subscriptions (the two
  expired Sandbox ones), preview claim and relay usage are deleted. The user
  row, its allowance ledger (`membership_grants`/`membership_usage`) and
  correction reports stay.
- Drops `account_identities` (one row) and deletes `apple`/`delete` nonces;
  `account_nonces.purpose` now allows only `guest`.
- Adds `public.slide_guest_credential_expiry(text)`, a `SECURITY DEFINER`
  function the runtime login uses to slide a guest credential to 365 days
  when a session is issued. The runtime login gets `EXECUTE` on it and still
  has no `UPDATE` on `library_tokens.expires_at`.
- Grants `lyrica_account_v1` `INSERT(free_allowance_held_until)` on
  `library_users`.

Existing guest and beta accounts are left alone. Every statement is safe to
rerun: a direct repeat changes nothing (including an operator's later
`relay_access` value). The runner applies 039 and its receipt in one
transaction under the migration advisory lock; the default `RESTRICT` refuses
and rolls everything back if an unexpected object depends on
`account_identities`.

## Order

Migration, then the backend, then the app. The production build requires the
039 receipt, so the new backend cannot be promoted before the migration. The
new app needs the new backend because the backend rejects unknown fields
(`deviceToken`, `restore`).

Between the migration and the backend deploy the previous backend fails closed
(503) on Sign in with Apple, `POST /api/membership` (its snapshot reads
`account_identities`) and App Store notifications (Apple retries them).
Enrollment, sessions, lyrics and the relay keep working. Deploy the backend
straight after the migration.

## Operator commands

Run from this repository with the owner-only private configuration; nothing
below prints a secret.

1. Inventory, read-only. With the owner connection (for example
   `psql "$(node -p "require(process.argv[1]).LYRICA_LIBRARY_DATABASE_URL" ~/.config/lyrica/credentials/backend-admin/migration.json)"`):

   ```sql
   SELECT access_kind, disabled, count(*) FROM library_users GROUP BY 1,2 ORDER BY 1,2;
   SELECT u.access_kind, s.environment, count(*) FROM membership_subscriptions s
     JOIN library_users u ON u.id = s.user_id GROUP BY 1,2;
   SELECT u.access_kind, s.environment, s.expires_at < now() AS expired, count(*)
     FROM membership_subscriptions s JOIN library_users u ON u.id = s.user_id GROUP BY 1,2,3;
   SELECT count(*) AS identities FROM account_identities;
   SELECT u.access_kind, count(*) AS preview_claims FROM membership_preview_claims p
     JOIN library_users u ON u.id = p.user_id GROUP BY 1;
   SELECT name FROM library_schema_migrations ORDER BY name DESC LIMIT 2;
   ```

   Expected on 17 November 2026:

   | access_kind | disabled | count |
   | --- | --- | --- |
   | apple | f | 1 |
   | beta | f | 1 |
   | beta | t | 6 |
   | guest | f | 14 |

   2 `Sandbox` subscriptions, both expired and both on the `apple` user;
   1 identity; 1 preview claim, on the `apple` user (only Apple accounts could
   claim one); latest receipt `038-retire-spotify-observer.sql`. Stop and
   investigate any other shape.

2. Apply:

   ```sh
   node scripts/song-library-admin.js migrate --database-config-file ~/.config/lyrica/credentials/backend-admin/migration.json
   ```

3. Verify:

   ```sql
   SELECT name FROM library_schema_migrations WHERE name = '039-anonymous-accounts.sql';
   SELECT access_kind, disabled, count(*) FROM library_users GROUP BY 1,2 ORDER BY 1,2;  -- apple t 1, beta f 1, beta t 6, guest f 14
   SELECT count(*) FROM membership_subscriptions;                                          -- 0
   SELECT count(*) FROM membership_preview_claims;                                         -- 0
   SELECT to_regclass('public.account_identities');                                        -- null
   SELECT count(*) = count(DISTINCT app_account_token) FROM library_users;                 -- true
   SELECT relay_access FROM membership_settings;                                           -- everyone
   SELECT count(*) FROM library_tokens t JOIN library_users u ON u.id = t.user_id
     WHERE u.access_kind = 'apple' AND NOT t.revoked;                                      -- 0
   ```

4. Deploy the backend (production environment variables below), then ship the
   app.

The App Attest key of the reset Apple account is revoked for good; a device
that reused it must enroll with a new key, which the updated app does.

## Environment variables

Required in production (Sensitive, production-only) for the backend deploy.
Both were added on 17 November 2026 and Apple accepts the key on both hosts:

| Variable | Value |
| --- | --- |
| `LYRICA_DEVICECHECK_KEY_ID` | 10-character key ID of the Apple Developer key with DeviceCheck enabled |
| `LYRICA_DEVICECHECK_PRIVATE_KEY` | That key's `.p8` PEM text, multi-line; escaped `\n` newlines also work (parsed as for APNs) |

The team ID is the existing `LYRICA_APNS_TEAM_ID`; no new variable. Without the two variables
DeviceCheck is unconfigured: enrollment never holds, the preview is not
limited per device, and each attempt logs `devicecheck_unavailable` with
reason `unconfigured`.

Delete after the backend deploy (nothing reads them any more):

- `LYRICA_SIGN_IN_APPLE_KEY_ID`
- `LYRICA_SIGN_IN_APPLE_PRIVATE_KEY`
- `LYRICA_ACCOUNT_ENCRYPTION_KEY` (it only sealed Sign in with Apple refresh
  tokens)

`LYRICA_APP_ID_PREFIX` and `LYRICA_APP_BUNDLE_IDS` stay; App Attest uses them.

## Launch checklist

Before App Store release:

```sh
node scripts/membership-admin.mjs configure --database-config-file ~/.config/lyrica/credentials/backend-admin/migration.json --set relay_access=members
```

Also confirm the DeviceCheck key is configured in production and the preview
daily limit (`preview_daily_limit`).

## Recovery: roll forward only

There is no down migration. Before the backend deploy, a failed 039 rolls back
completely and changes nothing. After it, the dropped identity and the reset
Apple account are not restorable; the contract accepts that (backwards
compatibility is not kept, and its only purchases were expired Sandbox ones).

Once 039 is applied, do not use a Vercel instant rollback (or any redeploy) to
a backend from before this change: that code reads `account_identities`, so
its membership status, App Store notifications and Sign in with Apple paths
fail (503) until a current backend is deployed again. Fix a problem in the new
backend by deploying a fix forward.
