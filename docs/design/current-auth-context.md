# Current authentication context

This maintained security contract covers ordinary application authentication. Shared Sessions are outside the [initial release scope](../INITIAL_RELEASE_SCOPE.md); their archived design is not an activation prerequisite for this helper.

## Authority and exact bearer

- `api/utils/app-auth/auth-context.js` prepares evidence from the exact supplied bearer, never a replacement session for the same key or user.
- Evidence is frozen, private WeakMap-backed state. Caller-created objects, spreads, serialized copies, stale transaction handles and cross-client reuse confer no authority.
- The frozen policy includes environment, audience, bundle and attestation requirements. Principal, key, credential digest and exact authentication-session digest retain their original identities.
- Nullable credential expiry stays valid where allowed. Finite credential and session deadlines are captured without rounding away database precision or extending the original authority.

## Transaction and lock contract

- Use the actual caller transaction and client. Reject autocommit, transaction reuse and changed transaction identity.
- Collect the bounded union of users, tokens, keys and sessions before lower resources. A 65th scope row is a refusal, not truncation; retain the 64-row limit.
- Sort opaque text identifiers in UTF-8 byte order, matching PostgreSQL C ordering. Never normalize principal identifiers.
- Readers lock users with `FOR UPDATE`; fixed account writers use `FOR NO KEY UPDATE` for their separately defined mutation protocol.
- Canonical category order is users, credential tokens, all attestation keys, globally sorted exact authentication sessions, then Spotify connections and lower resources. Never acquire a newly discovered earlier-category scope after lower locks.
- Revalidate scope identities and current authorization after locking. Revocation, moved ownership, missing rows, mismatched audience or policy, or changed discovery scopes must refuse the operation.
- Sample a fresh database wall clock at the final authorization boundary. Transaction-start `now()` is not fresh deadline evidence. Check the original captured deadlines even if a row was extended meanwhile.

## Error and evidence boundaries

`api/utils/app-auth/errors.js` defines `AuthContextError` and bounded transactional signals. HTTP translation must not expose SQL, bearer strings, key material, connection strings or internal database errors.

Focused hermetic coverage is in `tests/integration/auth-context.test.js` and `tests/unit/auth-transaction-error.test.js`. Real contention and least-privilege behavior require the separately guarded [PostgreSQL qualification](auth-token-lock-postgres.md). Embedded SQL, fixture success and authored manual tests are not production or concurrent PostgreSQL proof.

The helper provides authentication authority only. It creates no room protocol, output permits, external-object erasure or provider-side cleanup guarantees.
