# Writer authentication context

The fixed writer factory in `api/utils/app-auth/auth-context.js` supplies the mutation-specific account boundary. It is distinct from [reader authentication](current-auth-context.md) and contains no shared Sessions lifecycle activation.

## Closed mutation plans

- Admit only immutable `signIn`, `signOut` and `delete` operations with their exact allowed fields. Parse the original raw JSON and reject duplicate keys, extra fields, unknown operations or malformed identifiers.
- Bind preparation privately to the exact original bearer and frozen policy. Do not infer authority from a user/key lookup or an authentication renewal.
- Private plans and handles are opaque, transaction-bound and single-use. Reject forged, copied, stale, reused or different-client values.
- Bound every discovered scope and union at 64 rows; fail on overflow. Keep UTF-8/C sorting and globally ordered authentication-session locks.

## Preimage, mutation and postimage

- Discover the complete user/token/key/session scope before mutation. Fixed account writers acquire users with `FOR NO KEY UPDATE`, then tokens, all keys and sorted sessions before Spotify or lower resources.
- Revalidate the preimage after locks and before any intended mutation. A newly discovered earlier lock, scope change or source-authorization loss is a conflict or unauthorized result, not a retry with a widened scope.
- Sign-in proves the new target token absent and uses `INSERT`, not a token-owner-reassigning UPSERT. Preserve unrelated fields and the target account access constraints.
- Verify the deliberate mutation against its exact expected postimage, including revoked source authority and the intended target identities. Do not apply ordinary source liveness rules that would reject the intended revocation itself.
- Verify the original source bearer deadlines using a fresh database clock. Later row extensions do not extend the captured deadline.
- Account postimage verification is the last SQL before `COMMIT`. No query, external call or mutable callback follows it inside the transaction.
- On error, roll back every application mutation. A successful provider callback or partial SQL write is not a committed account operation.

## Consumers and proof

`api/utils/membership/accounts.js` retains safe error translation and the exact-bearer [account contract](account-exact-bearer.md). Ordinary auth/admin/library and Spotify operations follow the [writer lock-order contract](auth-writer-order.md); `revokeSessions` means authentication-session revocation.

`tests/integration/writer-auth-context.test.js` covers private plans, source deadlines, preimages, intended postimages and final SQL ordering. `tests/postgres/auth-writers.test.js` exercises actual writers through guarded real PostgreSQL clients. Neither filename nor authored assertions imply that a particular candidate passed; retain commit-specific executed evidence separately.
