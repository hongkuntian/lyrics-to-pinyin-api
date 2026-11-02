# Account exact-bearer authorization

Account sign-in, sign-out and deletion are ordinary release functionality. They retain exact source authentication even though shared Sessions and their optional privacy hooks are removed.

## Required boundary

- `AccountStore` prepares the exact supplied bearer before provider work and passes only private writer evidence to its transaction.
- Preserve frozen principal, credential, key, session, environment, audience, bundle and original deadline identities. A newer bearer or replacement session cannot authorize an old request.
- Lock the canonical bounded user/token/key/session union before Spotify or lower-resource mutation. Preserve `FOR NO KEY UPDATE` user anchors and explicit row-lock privileges.
- Revalidate the preimage before mutation; verify the exact deliberate postimage afterward. Unexpected changes roll the whole transaction back.
- Sign-in inserts an absent target digest. Foreign ownership is never overwritten. Same-owner reuse elsewhere retains its own nullable/finite expiry and unrelated data.
- Sample the final database clock against original source deadlines. Final postimage verification remains the last SQL before commit.
- Preserve durable Spotify revocation and postcommit cleanup on sign-out, deletion and applicable admin mutations. The removal does not authorize dropping connection-security obligations.

## Retained account data

`api/utils/membership/account-data-privacy.js` owns retained-data compatibility, independently of the deleted feature runtime. `scrubRetainedAccountData` deletes owned historical V1 rooms and their cascades, pseudonymizes the account in other owners rooms and removes its rate windows inside account deletion. Failures roll back deletion.

The unconditional catalog preflight refuses deletion with `account_data_cleanup_required` (503) whenever `listening_v2` exists, including empty or partial schema, or the presence check cannot establish absence. It runs before external Apple revocation and again inside the scrub transaction. This is a truthful fail-closed stopgap, not completed V2 erasure. No output guard or external-object cleanup identifier may be deleted, reset or silently abandoned.

`db/036-account-data-privacy.sql` maintains only the catalog-checked optional V1 `SELECT(user_id)` repair for `lyra_account_v1`. It runs on normal upgrades and late-role provisioning; historical feature migrations remain unchanged and outside active replay. See [initial release scope](../INITIAL_RELEASE_SCOPE.md).

## Verification

Retain account exact-bearer, deadline, final-SQL-order and rollback tests, Spotify owner-revocation tests, both retained-data privilege suites, and the neutral [writer context](writer-auth-context.md) regressions. Cover absent and populated historical schema, insufficient privileges, partial V2 schema, unchanged safety records and truthful refusal. Local fixture proof is not deployed database inventory or external erasure evidence.
