# Public accounts and memberships

Migration `025-memberships.sql` adds account, purchase, allowance, preview, and relay ledgers. Existing users remain `beta`; public enrollment and paid features start disabled. All spending continues to pass the existing provider admission and global budget checks.

## Identity and credentials

`POST /api/account` supports `challenge`, `guest`, `apple`, `signOut`, and `delete`. Anonymous enrollment requires a real Apple App Attest attestation and a server nonce bound to the key, bundle, and purpose. Native Sign in with Apple requires an authenticated App Attest session, a fresh server nonce, Apple JWT verification, and a matching authorization-code exchange. It creates a stable account token for StoreKit. The service requests no name or email.

The account service uses `LYRA_ACCOUNT_DATABASE_URL`, a separate least-privilege login. Generation and relay credentials cannot create identities or issue account credentials. Apple refresh tokens are encrypted with the 32-byte `LYRA_ACCOUNT_ENCRYPTION_KEY` and used for authorization revocation on deletion. Keep this key and the account DB password in private operator storage and Vercel secrets; do not commit them.

Deleting an account requires fresh Apple confirmation, revokes online access, and anonymizes correction details. A minimal pseudonymous purchase and allowance ledger remains so opened free translations stay consistent and later refunds can be processed. Local saved songs are outside this service. Deletion does not cancel an Apple subscription.

## Products and purchase verification

There is one membership tier (decided 7 Nov 2026). Its two products share the "Lyrica Membership" subscription group and give equal service. The `pro` product identifiers and internal tier value are durable App Store data; the user-facing name is Membership. The former Plus products were deleted from App Store Connect before any submission.

| Product ID | Service | US base price |
| --- | --- | --- |
| `com.hongkuntian.Lyra.pro.monthly` | Membership monthly | $4.99 |
| `com.hongkuntian.Lyra.pro.annual` | Membership annual | $39.99 |

Other storefronts use Apple's converted prices, except manual prices at roughly 40–55% of the local Apple Music individual plan in Japan, South Korea, Taiwan, Malaysia, Thailand, Indonesia, Vietnam, the Philippines, India, Brazil, Mexico, Türkiye and mainland China. Apple never re-converts subscription prices, so review them about every six months. Native prices come from StoreKit. `POST /api/membership` accepts actions `status`, `transaction` (Apple `signedTransaction`), and `preview` (`activityID`, `recordingID`). The versioned response is defined in `contracts/membership.schema.json`.

The official Apple App Store Server Library verifies certificate chains, signed transactions, bundle ID, environment, and app Apple ID before writing an entitlement. Ownership is bound to the account's StoreKit `appAccountToken`. Old restores cannot replace a newer revocation. `POST /api/store-notifications` verifies V2 notifications and their nested transaction independently; notification IDs deduplicate delivery, including refunds received after account deletion. Configure both production and sandbox notification URLs to this endpoint.

Required verification settings: `LYRA_STORE_BUNDLE_ID`, `LYRA_STORE_APP_APPLE_ID`; set `LYRA_STORE_ALLOW_SANDBOX=true` for Apple-signed sandbox/TestFlight transactions. Unsigned Xcode StoreKit fixtures are never accepted by the deployed verifier. Family sharing and multiseat purchases are unsupported by the account-bound model and must remain disabled. Transactions without this account's `appAccountToken` are rejected; a restore must never silently assign an unbound purchase to the current account.

Disable Streamlined Purchasing before offering purchases outside the app. App Store Connect requires a **latest approved binary** with the required StoreKit purchase-intent support before it allows that setting to be turned off. An implementation or development build alone does not satisfy Apple's prerequisite. Until approval, leave promoted purchases, win-back offers, and contingent pricing unconfigured; the app completes purchases after Lyrica sign-in with the account token. See [Apple's Streamlined Purchasing requirements](https://developer.apple.com/help/app-store-connect/manage-subscriptions/manage-streamlined-purchasing).

Sign-in settings: `LYRA_APP_ID_PREFIX`, `LYRA_APP_BUNDLE_IDS`, `LYRA_SIGN_IN_APPLE_KEY_ID`, `LYRA_SIGN_IN_APPLE_PRIVATE_KEY`, and `LYRA_ACCOUNT_ENCRYPTION_KEY`. The signing key must be scoped to the app's primary Sign in with Apple identifier and any deliberately grouped development identifier.

## Usage policy

Lyrics and pronunciation are free and unlimited. New generation requires membership (`membership_required`), which grants 20 translations and 80 explanations per monthly anniversary, including annual subscriptions. There is no starter.

Free accounts, guest or Apple, can read **3 existing shared-library translations per rolling 7 days** (`FREE.libraryTranslationsPerWeek` in `api/utils/membership/policy.js`; change it there, no app update needed). Members, beta and unlimited accounts read every library translation. For a free account, `translate`/`current`/`status` return `{state:'locked',target,documentID,sourceHash}` without content until the song is opened. The app opens it only after an explicit tap by sending `current` with `unlock:true`, which records one idempotent `membership_usage` row per account and document (grant `library-free-v1`). A song stays readable after it is opened; past the limit, unlock returns `403 library_translation_limit`. Draft lines are streamed only to accounts that can read the song. The status snapshot reports `libraryTranslations {unlimited,limit,used,remaining,nextAvailableAt}`. Unused allowance does not roll over. Cached/coalesced generation is free, retries share an operation ID, and failed operations release their allowance reservation. Existing readable content remains available on downgrade or expiry.

Public reads never authorize new provider work. Translation `allowGeneration=true` and Study `allowGeneration:true` mark explicit generation; Study `readOnly:true` returns saved content or `missing`. Opening or revisiting a reader and changing accounts must not silently spend allowance. Concurrent admission locks the account and existing budget rows before reserving.

Live Lyrics needs an active membership or a claimed preview (otherwise `membership_required`). A preview is once per Apple account, bound to one activity and recording, and ends at 10 minutes or 200 admitted relay requests. Defaults cap new previews at 100/day. The operational relay ceiling is 1,000,000 requests/month across public users; failures still count admitted infrastructure work. These are bounded operational safeguards, not advertised paid-user minute quotas. Beta access preserves its existing policy.

The relay derives its APNs topic from the session's App Attest bundle identity. Both `com.hongkuntian.Lyra` and the existing `com.hongkuntian.musicromanization` development bundle use their own Live Activity topic; request bodies cannot override it. The APNs environment still follows the signed app's provisioning environment.

## Operator setup

Use owner-only JSON configuration files containing the existing migration connection URL. Provisioning creates a separate random credential and encryption key, stores them with mode 0600, and applies migrations transactionally:

```sh
node scripts/membership-admin.mjs provision --database-config-file /private/migration.json --account-config-file /private/account.json
node scripts/membership-admin.mjs status --database-config-file /private/migration.json
node scripts/membership-admin.mjs configure --database-config-file /private/migration.json --set public_access_enabled=true
```

Provisioning refuses to overwrite an existing account role or private output file. Retain the generated private file. Configure `purchases_enabled`, `live_enabled`, `widgets_enabled`, and `carplay_enabled` independently only after their applicable signing, product, and native evidence is available. Native views use those actual capabilities. Do not report a purchase flow as verified from product metadata alone, or background delivery from a foreground-only observation.

## Retained account-data privacy prerequisite

Shared listening is retired. Historical SQL 029/030/031/033/034/035 remains unchanged but outside active registration and replay. The active manifest is 001–028, 032 and neutral `036-account-data-privacy.sql`. Existing historical receipts are preserved; no schema is dropped or data wiped.

036 preserves the exact catalog-checked optional V1 repair previously defined in035: conditionally grant only `SELECT(user_id)` on `public.listening_rate_windows` to an existing `lyra_account_v1`. Account deletion already needs that predicate-column read right to execute its DELETE. All four optional V1 relations absent is valid; partial presence, wrong catalogs or drift refuse with23514. The repair creates no role/schema, performs no data rewrite and grants no broader table/column visibility, GRANT OPTION or runtime/PUBLIC permission. Its statement-local catalog lookup guard restores search_path on success and rolls back on failure.

The actual migration transaction includes the grant and036 receipt atomically. Late-role provisioning replays the unchanged025/028/032 privilege bodies and036 in one atomic DO; it never replays034. This narrow repair does not supply missing historical027/029 account grants or prove complete late-role deletion. Tests must distinguish historical roles-before-migrations from independently established late-role prerequisites; never widen fixture grants to conceal that difference.

`membership/account-data-privacy.js` retains transactional owner-room deletion, foreign-room member pseudonymization and rate-window cleanup for existing V1 data. It also unconditionally checks for a retained `listening_v2` namespace before external Apple revocation and again during the transaction. Any present namespace, including an empty or partial one, refuses deletion with `account_data_cleanup_required` (503). This is a truthful safety stopgap, not completed V2 erasure. No retired admission/protocol/lifecycle hook is imported or activated. Retained output guards and external cleanup identifiers must not be deleted, reset, released or silently abandoned.

The restricted-role integration/manual PostgreSQL suites explicitly construct historical schema fixtures without activating retired migrations. Exact checksummed receipt, actual deployed database/principals, direct/PUBLIC/inherited ACLs, populated actual-method deletion/rollback and same-authority pool identity are separate evidence requirements. SQL rollback cannot undo external Apple revoke; no subscription cancellation or provider terminality follows. See [qualification](design/auth-token-lock-postgres.md) and [initial release scope](INITIAL_RELEASE_SCOPE.md). Candidate test results and read-only inventory are recorded by the executing task, not inferred from this contract.
