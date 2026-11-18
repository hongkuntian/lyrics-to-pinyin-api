# Public accounts and memberships

Migration `025-memberships.sql` adds account, purchase, allowance, preview, and relay ledgers. Existing users remain `beta`; public enrollment and paid features start disabled. All spending continues to pass the existing provider admission and global budget checks.

## Accounts and credentials

Lyrica has no sign-in (decided 17 November 2026; contract: the Lyrica app repo's
`docs/ANONYMOUS_ACCOUNTS.md`). Every installation uses an anonymous `guest`
account it creates itself; access-code accounts stay `beta`. Sign in with Apple,
sign-out and the `apple` account kind are removed; migration 039 reset the one
existing Apple account (see [the 039 procedure](ANONYMOUS_ACCOUNTS_MIGRATION.md)).

`POST /api/account` supports:

- `challenge` (`purpose:"guest"`, `bundleID`, `keyID`) and `guest` (`bundleID`,
  `keyID`, `challenge`, `attestation`, `credential`, optional `deviceToken`).
  Anonymous enrollment requires a real Apple App Attest attestation and a server
  nonce bound to the key, bundle and purpose. The `lyrica_g_…` credential is
  generated on the phone (kept in iCloud Keychain) and saved before enrollment.
  A retry with the same key and credential only acknowledges.
- `delete` (`{action:"delete"}`, session bearer). It deletes the **guest**
  account behind the exact session: retained data is scrubbed, the user is
  disabled, every credential, key and session is revoked, and push receipts,
  selected-source links and correction-report details are removed. Beta accounts
  get `403 account_not_deletable`. A minimal pseudonymous purchase and allowance
  ledger remains so opened free translations stay consistent and later refunds
  can be processed. Deletion does not cancel an Apple subscription; it can be
  restored onto the next account.

Every account has its own `library_users.app_account_token` (UUID), which links
App Store purchases to it. A second device with the same synced credential
registers its own App Attest key through `/api/app-auth` `register`. Issuing a
session slides a guest credential's expiry to 365 days from now (written only
when fewer than 300 days remain), so a credential in use never expires.

The account service uses `LYRICA_ACCOUNT_DATABASE_URL`, a separate
least-privilege login. Generation and relay credentials cannot create accounts or
issue account credentials. Keep the account DB password in private operator
storage and Vercel secrets; do not commit it.

### DeviceCheck

Apple DeviceCheck stops a reinstall from creating a fresh free allowance on the
same device. Bit 0 means "a Lyrica account was created on this device recently";
bit 1 means "this device has used the Live Lyrics preview".
`api/utils/membership/device-check.js` signs an ES256 provider JWT (`kid`,
`iss`, `iat`, cached at most 50 minutes) with `LYRICA_DEVICECHECK_KEY_ID`,
`LYRICA_DEVICECHECK_PRIVATE_KEY` and the APNs team ID `LYRICA_APNS_TEAM_ID`. The
Debug bundle asks `api.development.devicecheck.apple.com` first, every other
bundle `api.devicecheck.apple.com` first; a `400` for the device token retries
once on the other host; each call has a 3 s timeout. Apple's answers are
classified by status code only: any other 4xx except 401, 403 and 429 rejects
the device token (treated as no token); 401 or 403 means our key or
configuration is wrong (fail open, logged at error level); 429, 5xx, timeouts
and network errors fail open. Apple's "no state" answer
(`200 Failed to find bit state`, documented as `Bit State Not Found`) means both
bits are false. One client per process caches the JWT. Without the key DeviceCheck is *unconfigured*, a
state distinct from *failing*. Device tokens and JWTs are never logged.

On creating a **new** guest account (not a retry acknowledgement, not `register`),
outside the database transaction:

1. With a `deviceToken`, query the two bits.
2. Hold the new account's free allowance for 7 days
   (`free_allowance_held_until`) when bit 0 is set and `last_update_time` is the
   current or previous UTC month, or when DeviceCheck is configured but the
   request has no `deviceToken`. A token Apple rejects counts as no token, so a
   made-up token cannot skip the hold.
3. After the account commits, set bit 0 (which refreshes `last_update_time`).
4. Unconfigured, unreachable or failing DeviceCheck creates the account without a
   hold and logs `devicecheck_unavailable` (with a reason, never the token).

While held, `libraryTranslations.remaining` is 0 and `nextAvailableAt` is the
hold's end.

## Products and purchase verification

There is one membership tier (decided 7 Nov 2026). Its two products share the "Lyrica Membership" subscription group and give equal service. The `pro` product identifiers and internal tier value are durable App Store data; the user-facing name is Membership. The former Plus products were deleted from App Store Connect before any submission.

| Product ID | Service | US base price |
| --- | --- | --- |
| `com.hongkuntian.Lyrica.pro.monthly` | Membership monthly | $4.99 |
| `com.hongkuntian.Lyrica.pro.annual` | Membership annual | $39.99 |

Other storefronts use Apple's converted prices, except manual prices at roughly 40–55% of the local Apple Music individual plan in Japan, South Korea, Taiwan, Malaysia, Thailand, Indonesia, Vietnam, the Philippines, India, Brazil, Mexico, Türkiye and mainland China. Apple never re-converts subscription prices, so review them about every six months. Native prices come from StoreKit. `POST /api/membership` accepts actions `status`, `transaction` (Apple `signedTransaction`, optional `restore:"true"`), and `preview` (`activityID`, `recordingID`, optional `deviceToken`). The versioned response is defined in `contracts/membership.schema.json`: `account.kind` is `guest` or `beta`, `account.appAccountToken` is always the account's UUID, and `liveLyricsIncluded` is true when the relay admits the account without a preview right now (Live Lyrics enabled and the account is beta or unlimited, has an active membership, or `relay_access` is `everyone`). `preview.available` is true for a non-beta account without a preview claim when Live Lyrics is enabled and `liveLyricsIncluded` is false.

The official Apple App Store Server Library verifies certificate chains, signed transactions, bundle ID, environment, and app Apple ID before writing an entitlement. Ownership follows `original_transaction_id`:

- Not yet recorded: it is recorded for this account when its `appAccountToken` is this account's, is absent (offer codes), belongs to no current (enabled) account, or `restore` is set. Otherwise `403 purchase_account_mismatch`.
- Recorded for another account: it moves to this account only with `restore`; otherwise `purchase_account_mismatch`. A different environment is always a mismatch.

The app's automatic sync sends `currentEntitlements` without `restore`; the Restore purchases button runs `AppStore.sync()` and sends them with `restore`. A paid period's allowance belongs to the subscription, so moving it never refills the allowance. Old signed data cannot replace a newer state (including a revocation), though Restore still moves ownership. `POST /api/store-notifications` verifies V2 notifications and their nested transaction independently and finds the owner by `original_transaction_id` first, then by `library_users.app_account_token`; a notification never moves a purchase, and one with no owner is answered `409 purchase_account_not_found` so Apple retries. Notification IDs deduplicate delivery, including refunds received after account deletion. Configure both production and sandbox notification URLs to this endpoint.

Required verification settings: `LYRICA_STORE_BUNDLE_ID`, `LYRICA_STORE_APP_APPLE_ID`; set `LYRICA_STORE_ALLOW_SANDBOX=true` for Apple-signed sandbox/TestFlight transactions. Unsigned Xcode StoreKit fixtures are never accepted by the deployed verifier. Family sharing and multiseat purchases are unsupported by the account-bound model and must remain disabled. Purchases pass `.appAccountToken(snapshot.account.appAccountToken)`.

Disable Streamlined Purchasing before offering purchases outside the app. App Store Connect requires a **latest approved binary** with the required StoreKit purchase-intent support before it allows that setting to be turned off. An implementation or development build alone does not satisfy Apple's prerequisite. Until approval, leave promoted purchases, win-back offers, and contingent pricing unconfigured; the app completes purchases with the account token. See [Apple's Streamlined Purchasing requirements](https://developer.apple.com/help/app-store-connect/manage-subscriptions/manage-streamlined-purchasing).

Account settings: `LYRICA_APP_ID_PREFIX`, `LYRICA_APP_BUNDLE_IDS` (App Attest), `LYRICA_DEVICECHECK_KEY_ID` and `LYRICA_DEVICECHECK_PRIVATE_KEY` (DeviceCheck, with `LYRICA_APNS_TEAM_ID`). `LYRICA_SIGN_IN_APPLE_KEY_ID`, `LYRICA_SIGN_IN_APPLE_PRIVATE_KEY` and `LYRICA_ACCOUNT_ENCRYPTION_KEY` are no longer read; delete them after the anonymous-accounts deploy.

## Usage policy

Lyrics and pronunciation are free and unlimited. New generation requires membership (`membership_required`), which grants 20 translations and 80 explanations per monthly anniversary, including annual subscriptions. There is no starter.

Free (guest) accounts can read **3 existing shared-library translations per rolling 7 days** (`FREE.libraryTranslationsPerWeek` in `api/utils/membership/policy.js`; change it there, no app update needed). Members, beta and unlimited accounts read every library translation. For a free account, `translate`/`current`/`status` return `{state:'locked',target,documentID,sourceHash}` without content until the song is opened. The app opens it only after an explicit tap by sending `current` with `unlock:true`, which records one idempotent `membership_usage` row per account and document (grant `library-free-v1`). A song stays readable after it is opened; past the limit, unlock returns `403 library_translation_limit`. Draft lines are streamed only to accounts that can read the song. The status snapshot reports `libraryTranslations {unlimited,limit,used,remaining,nextAvailableAt}`. Unused allowance does not roll over. Cached/coalesced generation is free, retries share an operation ID, and failed operations release their allowance reservation. Existing readable content remains available on downgrade or expiry.

Public reads never authorize new provider work. Translation `allowGeneration=true` and Study `allowGeneration:true` mark explicit generation; Study `readOnly:true` returns saved content or `missing`. Opening or revisiting a reader and changing accounts must not silently spend allowance. Concurrent admission locks the account and existing budget rows before reserving.

Live Lyrics relay admission (`admitMemberRelay`): beta or unlimited accounts are admitted; otherwise Live Lyrics must be enabled (`live_lyrics_unavailable`); then `membership_settings.relay_access = 'everyone'` admits any account (prerelease), and `members` needs an active membership or a claimed preview (otherwise `membership_required`). Changing `relay_access` needs no new build: `node scripts/membership-admin.mjs configure ... --set relay_access=members` (the launch setting). Every admission except beta/unlimited counts toward the global monthly budget and the usage ledger. A preview is once per non-beta account and, with DeviceCheck configured, once per device: a claim without a `deviceToken`, with a token Apple rejects, or from a device whose bit 1 is set, is `live_preview_used`; otherwise the claim is recorded and bit 1 is set afterwards. Unconfigured or failing DeviceCheck allows the claim. An account whose Live Lyrics is already included (beta, unlimited, a member, or `relay_access = 'everyone'`) gets `400 invalid_request` without a DeviceCheck call. A preview is bound to one activity and recording, and ends at 10 minutes or 200 admitted relay requests. Defaults cap new previews at 100/day. The operational relay ceiling is 1,000,000 requests/month across public users; failures still count admitted infrastructure work. These are bounded operational safeguards, not advertised paid-user minute quotas. Beta access preserves its existing policy. `sign_in_required`, `purchase_account_unbound` and the `apple_*` error codes no longer exist.

The relay derives its APNs topic from the session's App Attest bundle identity. Both `com.hongkuntian.Lyrica` and the existing `com.hongkuntian.Lyrica.Debug` development bundle use their own Live Activity topic; request bodies cannot override it. The APNs environment still follows the signed app's provisioning environment.

## Accepted prerelease risks

Recorded 17 November 2026; revisit before App Store release.

- **Restore with stale or leaked signed data.** An explicit Restore moves a
  purchase's ownership whatever the JWS `signedDate`: a leaked signed
  transaction lets another account take the subscription until the owner taps
  Restore again. Requiring a newer `signedDate` could refuse legitimate
  restores, because the signed date of the transaction StoreKit hands back
  after `AppStore.sync()` is not something the server can rely on. Stale data
  still never overwrites newer subscription state.
- **Parallel enrollments sharing one real device token.** Two new accounts
  enrolled at the same time from one device both query DeviceCheck before
  either sets bit 0, so neither is held.
- **One `last_update_time` for both bits.** Setting bit 1 (a preview claim)
  refreshes it, so a device that claimed a preview recently can have a
  re-enrollment held although its bit 0 is older.

## Operator setup

Use owner-only JSON configuration files containing the existing migration connection URL. Provisioning creates a separate random account-login credential, stores it with mode 0600, and applies migrations transactionally:

```sh
node scripts/membership-admin.mjs provision --database-config-file /private/migration.json --account-config-file /private/account.json
node scripts/membership-admin.mjs status --database-config-file /private/migration.json
node scripts/membership-admin.mjs configure --database-config-file /private/migration.json --set public_access_enabled=true
node scripts/membership-admin.mjs configure --database-config-file /private/migration.json --set relay_access=members
```

Provisioning refuses to overwrite an existing account role or private output file. Retain the generated private file (it holds only `LYRICA_ACCOUNT_DATABASE_URL`). Configure `purchases_enabled`, `live_enabled`, `widgets_enabled`, and `carplay_enabled` independently only after their applicable signing, product, and native evidence is available. Native views use those actual capabilities. Do not report a purchase flow as verified from product metadata alone, or background delivery from a foreground-only observation.

## Retained account-data privacy prerequisite

Shared listening is retired. Historical SQL 029/030/031/033/034/035 remains unchanged but outside active registration and replay. The active manifest is 001–028, 032 and neutral `036-account-data-privacy.sql`. Existing historical receipts are preserved; no schema is dropped or data wiped.

036 preserves the exact catalog-checked optional V1 repair previously defined in035: conditionally grant only `SELECT(user_id)` on `public.listening_rate_windows` to an existing `lyrica_account_v1`. Account deletion already needs that predicate-column read right to execute its DELETE. All four optional V1 relations absent is valid; partial presence, wrong catalogs or drift refuse with23514. The repair creates no role/schema, performs no data rewrite and grants no broader table/column visibility, GRANT OPTION or runtime/PUBLIC permission. Its statement-local catalog lookup guard restores search_path on success and rolls back on failure.

The actual migration transaction includes the grant and036 receipt atomically. Late-role provisioning replays the unchanged025/028/032 privilege bodies and036 in one atomic DO; it never replays034. This narrow repair does not supply missing historical027/029 account grants or prove complete late-role deletion. Tests must distinguish historical roles-before-migrations from independently established late-role prerequisites; never widen fixture grants to conceal that difference.

`membership/account-data-privacy.js` retains transactional owner-room deletion, foreign-room member pseudonymization and rate-window cleanup for existing V1 data. It also unconditionally checks for a retained `listening_v2` namespace before the deletion transaction and again during it. Any present namespace, including an empty or partial one, refuses deletion with `account_data_cleanup_required` (503). This is a truthful safety stopgap, not completed V2 erasure. No retired admission/protocol/lifecycle hook is imported or activated. Retained output guards and external cleanup identifiers must not be deleted, reset, released or silently abandoned.

The restricted-role integration/manual PostgreSQL suites explicitly construct historical schema fixtures without activating retired migrations. Exact checksummed receipt, actual deployed database/principals, direct/PUBLIC/inherited ACLs, populated actual-method deletion/rollback and same-authority pool identity are separate evidence requirements. No subscription cancellation or provider terminality follows deletion. See [qualification](design/auth-token-lock-postgres.md) and [initial release scope](INITIAL_RELEASE_SCOPE.md). Candidate test results and read-only inventory are recorded by the executing task, not inferred from this contract.
