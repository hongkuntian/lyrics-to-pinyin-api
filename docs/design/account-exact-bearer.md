# Account exact-bearer authorization

Guest account deletion is ordinary release functionality (Lyrica has no sign-in or sign-out). It retains exact source authentication even though shared Sessions and their optional privacy hooks are removed. Beta accounts are refused with `account_not_deletable`, both before the transaction and against the locked source.

## Required boundary

- `AccountStore` prepares the exact supplied bearer and passes only private writer evidence to its transaction.
- Preserve frozen principal, credential, key, session, environment, audience, bundle and original deadline identities. A newer bearer or replacement session cannot authorize an old request.
- Lock the canonical bounded user/token/key/session union before any lower-resource mutation. Preserve `FOR NO KEY UPDATE` user anchors and explicit row-lock privileges.
- Revalidate the preimage before mutation; verify the exact deliberate postimage afterward. Unexpected changes roll the whole transaction back.
- Sample the final database clock against original source deadlines. Final postimage verification remains the last SQL before commit.
- The backend holds no Spotify grant: the server observer is retired and migration 038 drops its connection tables, so deletion and admin mutations have no Spotify revocation step or postcommit cleanup.

## Retained account data

`api/utils/membership/account-data-privacy.js` owns retained-data compatibility, independently of the deleted feature runtime. `scrubRetainedAccountData` deletes owned historical V1 rooms and their cascades, pseudonymizes the account in other owners rooms and removes its rate windows inside account deletion. Failures roll back deletion.

The unconditional catalog preflight refuses deletion with `account_data_cleanup_required` (503) whenever `listening_v2` exists, including empty or partial schema, or the presence check cannot establish absence. It runs before the deletion transaction and again inside it. This is a truthful fail-closed stopgap, not completed V2 erasure. No output guard or external-object cleanup identifier may be deleted, reset or silently abandoned.

`db/036-account-data-privacy.sql` maintains only the catalog-checked optional V1 `SELECT(user_id)` repair for `lyrica_account_v1`. It runs on normal upgrades and late-role provisioning; historical feature migrations remain unchanged and outside active replay. See [initial release scope](../INITIAL_RELEASE_SCOPE.md).

## Verification

Retain account exact-bearer, deadline, final-SQL-order and rollback tests, the account-lifecycle-without-Spotify regression, both retained-data privilege suites, and the neutral [writer context](writer-auth-context.md) regressions. Cover absent and populated historical schema, insufficient privileges, partial V2 schema, unchanged safety records and truthful refusal. Local fixture proof is not deployed database inventory or external erasure evidence.
