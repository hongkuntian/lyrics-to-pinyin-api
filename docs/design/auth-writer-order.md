# Authentication writer lock order

This contract covers actual release consumers: `AppAuthStore`, account writers, auth administration, `SongLibraryStore` and Spotify credential ownership. Their security guarantees are independent of the removed shared Sessions graph.

## Canonical ordering

1. Discover the complete bounded union before locking. Refuse scope overflow rather than truncating it.
2. Lock all user anchors in UTF-8/C order. Readers use `FOR UPDATE`; fixed account mutations use `FOR NO KEY UPDATE`.
3. Lock credential-token rows, then all attestation keys, then globally sorted authentication-session rows.
4. Only then acquire Spotify connections and other lower resources. Recheck the discovered scope instead of expanding earlier categories after lower locks.
5. Revalidate source authority before mutation and the exact intended postimage afterward. Account writers finish with fresh-clock postimage verification as their last SQL before commit.

## Existing writer guarantees

- App Attest challenge issuance, assertion counters, nonce handling, session renewal, quotas, expiry batches and legitimate nullable credential expiry stay intact.
- `disableUser`, `revokeKey` and `revokeSessions` retain their full credential/key/session revocation behavior. Authentication sessions are not the retired shared listening feature.
- `SongLibraryStore.createUser` keeps its precollected owner union, ordered locks and guarded same-owner token reuse. A unique digest owned by another user yields `token_collision`, even after discovery-to-insert races; no user reassignment or expiry extension is permitted.
- Same-owner reuse may un-revoke that owners digest under existing policy, but must not reset owner, creation metadata, disabled/access flags, saved data or finite/nullable expiry. Losing-owner credential changes and newly created losing users roll back.
- Preserve Spotify durable revocation records and the existing transaction/postcommit boundary. Removing optional feature hooks does not remove ordinary Spotify security cleanup.
- Preserve bounded candidate and delete batches, actual SQL error propagation, immediate rollback and client release. A logical row bound is not a bounded physical scan, a nonblocking claim or a fairness guarantee.

## Row-lock privileges and qualification

[032 token-row anchors](auth-token-row-locks.md) grant only the anchor-column UPDATE authority required by explicit PostgreSQL locking. They do not grant identity, owner, timestamp, token INSERT/DELETE or general token UPDATE authority. Retained account-data privileges belong to neutral migration 036, not feature replay.

Hermetic fixtures establish SQL behavior and rollback boundaries, not two-client contention. The [guarded PostgreSQL suites](auth-token-lock-postgres.md) retain real lock-wait barriers, exact source identity, owned database cleanup, restricted-role ACL checks and quiescence assertions. No test may substitute a fabricated successful SQL response for actual writer behavior.

Production pool identity, deployed role inheritance, populated-history query plans and external provider journeys require their own evidence. The removed runtime and its archived output/privacy plans supply none of those approvals.
