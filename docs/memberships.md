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

## Operator setup

Use owner-only JSON configuration files containing the existing migration connection URL. Provisioning creates a separate random credential and encryption key, stores them with mode 0600, and applies migrations transactionally:

```sh
node scripts/membership-admin.mjs provision --database-config-file /private/migration.json --account-config-file /private/account.json
node scripts/membership-admin.mjs status --database-config-file /private/migration.json
node scripts/membership-admin.mjs configure --database-config-file /private/migration.json --set public_access_enabled=true
```

Provisioning refuses to overwrite an existing account role or private output file. Retain the generated private file. Configure `purchases_enabled`, `live_enabled`, `widgets_enabled`, and `carplay_enabled` independently only after their applicable signing, product, and native evidence is available. Native views use those actual capabilities. Do not report a purchase flow as verified from product metadata alone, or background delivery from a foreground-only observation.
