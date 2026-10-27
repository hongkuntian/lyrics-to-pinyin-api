# Public accounts and memberships

Migration `025-memberships.sql` adds account, purchase, allowance, preview, and relay ledgers. Existing users remain `beta`; public enrollment and paid features start disabled. All spending continues to pass the existing provider admission and global budget checks.

## Identity and credentials

`POST /api/account` supports `challenge`, `guest`, `apple`, `signOut`, and `delete`. Anonymous enrollment requires a real Apple App Attest attestation and a server nonce bound to the key, bundle, and purpose. Native Sign in with Apple requires an authenticated App Attest session, a fresh server nonce, Apple JWT verification, and a matching authorization-code exchange. It creates a stable account token for StoreKit. The service requests no name or email.

The account service uses `LYRA_ACCOUNT_DATABASE_URL`, a separate least-privilege login. Generation and relay credentials cannot create identities or issue account credentials. Apple refresh tokens are encrypted with the 32-byte `LYRA_ACCOUNT_ENCRYPTION_KEY` and used for authorization revocation on deletion. Keep this key and the account DB password in private operator storage and Vercel secrets; do not commit them.

Deleting an account requires fresh Apple confirmation, revokes online access, and anonymizes correction details. A minimal pseudonymous purchase and allowance ledger remains to prevent duplicate starters and to process later refunds. Local saved songs are outside this service. Deletion does not cancel an Apple subscription.

## Products and purchase verification

All products belong to one subscription group; Pro is above Plus. Monthly and annual variants of the same tier have equal service levels.

| Product ID | Service | US base price |
| --- | --- | --- |
| `com.hongkuntian.Lyra.plus.monthly` | Plus monthly | $2.99 |
| `com.hongkuntian.Lyra.plus.annual` | Plus annual | $29.99 |
| `com.hongkuntian.Lyra.pro.monthly` | Pro monthly | $4.99 |
| `com.hongkuntian.Lyra.pro.annual` | Pro annual | $49.99 |

Native prices come from StoreKit. `POST /api/membership` accepts actions `status`, `claimStarter`, `transaction` (Apple `signedTransaction`), and `preview` (`activityID`, `recordingID`). The versioned response is defined in `contracts/membership.schema.json`.

The official Apple App Store Server Library verifies certificate chains, signed transactions, bundle ID, environment, and app Apple ID before writing an entitlement. Ownership is bound to the account's StoreKit `appAccountToken`. Old restores cannot replace a newer revocation. `POST /api/store-notifications` verifies V2 notifications and their nested transaction independently; notification IDs deduplicate delivery, including refunds received after account deletion. Configure both production and sandbox notification URLs to this endpoint.

Required verification settings: `LYRA_STORE_BUNDLE_ID`, `LYRA_STORE_APP_APPLE_ID`; set `LYRA_STORE_ALLOW_SANDBOX=true` for Apple-signed sandbox/TestFlight transactions. Unsigned Xcode StoreKit fixtures are never accepted by the deployed verifier. Family sharing and multiseat purchases are unsupported by the account-bound model and must remain disabled. Transactions without this account's `appAccountToken` are rejected; a restore must never silently assign an unbound purchase to the current account.

Disable Streamlined Purchasing before offering purchases outside the app. App Store Connect requires a **latest approved binary** with the required StoreKit purchase-intent support before it allows that setting to be turned off. An implementation or development build alone does not satisfy Apple's prerequisite. Until approval, leave promoted purchases, win-back offers, and contingent pricing unconfigured; the app completes purchases after Lyrica sign-in with the account token. See [Apple's Streamlined Purchasing requirements](https://developer.apple.com/help/app-store-connect/manage-subscriptions/manage-streamlined-purchasing).

Sign-in settings: `LYRA_APP_ID_PREFIX`, `LYRA_APP_BUNDLE_IDS`, `LYRA_SIGN_IN_APPLE_KEY_ID`, `LYRA_SIGN_IN_APPLE_PRIVATE_KEY`, and `LYRA_ACCOUNT_ENCRYPTION_KEY`. The signing key must be scoped to the app's primary Sign in with Apple identifier and any deliberately grouped development identifier.

## Usage policy

The explicit one-time starter grants 2 new song translations and 10 Study explanations. Pro grants 20 translations and 80 explanations per monthly anniversary, including annual subscriptions. Unused allowance does not roll over. Cached/coalesced content is free, retries share an operation ID, and failed operations release their allowance reservation. Existing readable content remains available on downgrade or expiry.

Public reads never authorize new provider work. Translation `allowGeneration=true` and Study `allowGeneration:true` mark explicit generation; Study `readOnly:true` returns saved content or `missing`. Opening or revisiting a reader and changing accounts must not silently spend allowance. Concurrent admission locks the account and existing budget rows before reserving.

Live Lyrics needs active Plus/Pro or a claimed preview. A preview is once per Apple account, bound to one activity and recording, and ends at 10 minutes or 200 admitted relay requests. Defaults cap new starters and previews at 100/day each. The operational relay ceiling is 1,000,000 requests/month across public users; failures still count admitted infrastructure work. These are bounded operational safeguards, not advertised paid-user minute quotas. Beta access preserves its existing policy.

The relay derives its APNs topic from the session's App Attest bundle identity. Both `com.hongkuntian.Lyra` and the existing `com.hongkuntian.musicromanization` development bundle use their own Live Activity topic; request bodies cannot override it. The APNs environment still follows the signed app's provisioning environment.

## Operator setup

Use owner-only JSON configuration files containing the existing migration connection URL. Provisioning creates a separate random credential and encryption key, stores them with mode 0600, and applies migrations transactionally:

```sh
node scripts/membership-admin.mjs provision --database-config-file /private/migration.json --account-config-file /private/account.json
node scripts/membership-admin.mjs status --database-config-file /private/migration.json
node scripts/membership-admin.mjs configure --database-config-file /private/migration.json --set public_access_enabled=true
```

Provisioning refuses to overwrite an existing account role or private output file. Retain the generated private file. Configure `purchases_enabled`, `live_enabled`, `widgets_enabled`, and `carplay_enabled` independently only after their applicable signing, product, and native evidence is available. Native views use those actual capabilities. Do not report a purchase flow as verified from product metadata alone, or background delivery from a foreground-only observation.

## V1 listening account-deletion privilege prerequisite

`035-listening-account-delete-privileges.sql` is a privilege-only correction registered immediately after032. It conditionally grants exactly `SELECT(user_id)` on `public.listening_rate_windows` to the existing `lyra_account_v1` role. The actual account scrub already deletes rate windows with `WHERE user_id=$1`;029 supplied DELETE without that predicate-column read right. The measured roles-before-migrations local fixture reached42501 and rolled back. No deployed defect, principal or effective ACL is established by that fixture.

The supported historical footprint has the actual025/027/028/029 account grants and032 installed, with the account role present when those conditional grants ran.035 checks the four optional V1 listening relations' ordinary-table, nonpartitioned/noninherited, RLS-free catalog; exact columns/types/nullability/defaults; primary keys; and named cascade foreign keys. All four absent together is the compatible older account-only fixture path; it continues to034 during replay. The035 body temporarily fixes SQL name/operator resolution to `pg_catalog`, restores the caller's search path on success, and relies on statement/transaction rollback on refusal. It changes no persistent runtime configuration. A partially present family, wrong relation kind, dropped/extra/changed column, primary-key or foreign-key drift refuses with23514.035 performs no role creation, DDL, data rewrite, table SELECT, other-column visibility, GRANT OPTION, runtime/PUBLIC grant or V2 activation. The new read permission exposes that column across existing rows; these are backend service roles, not per-user SQL authorization.

The migration runner retains old names/order/checksums and receipts and adds035 only.030/031/033/034 remain unregistered. Its existing transaction contains the new grant and035 receipt, so failure before the receipt must roll both back. Direct privilege application invents no receipt. `replayMembershipRoleGrants` executes unchanged025/028/032 bodies, the exact035 body, and the unchanged tagged034 metadata-withholding body in the same single outer DO, with034 last. Standalone-client autocommit and an existing caller transaction must both be atomic; no intermediate broad key grant may become externally visible. Replay performs no migration DDL/data and changes no receipts.

**Late-role limit:** actual provisioning after historical027/029 receipts still omits those two privilege bodies from replay.035 does not repair that separate source-writer gap or establish complete late-role deletion. A late-role test with explicitly independently established027/029 grants is a different footprint. Never silently add those fixture grants, inheritance or replay expansion to call the genuine late-after-all-receipts writer positive.

Before deployment, Root must qualify the exact combined source, checksummed migration receipt, actual deployed database/schema and account/library principals, effective direct/PUBLIC/inherited permissions, ownership/role flags, and populated actual-method PostgreSQL deletion/rollback. The account and library roles must address the same authority for same-transaction SQL claims.034's existing metadata INSERT/UPDATE withholding and owner/superuser/owner-membership/PUBLIC/inheritance refusals remain unchanged. SQL rollback restores local rows; Apple revoke is external IO performed before the transaction and cannot be rolled back by SQL. No provider terminality or subscription cancellation follows.

The new integration/manual-PostgreSQL matrix and exact existing-fixture adaptations are **authored and unexecuted** in the source-only handoff. Only JavaScript syntax checks are authorized there; no red/green, PostgreSQL, hermetic, canonical, deployed-role, enrollment, native or public-feature-parity qualification is claimed. Root supplies an explicitly approved clean commit to the manual harnesses; their changed-input pin refreshes resolve named blobs from that exact Git object, retaining literal historical pins for all other inputs. The old032 and sealed LT01 fixtures select their original migration prefixes so their assertions remain historical controls. New tests independently use the complete registered migrator for the corrected restricted path. Root owns application, actual red/green, independent review, full checks, publication, deployment and cleanup. Public V2 stays off and live retained-profile capacity stays0.
