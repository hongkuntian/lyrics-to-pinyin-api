# Exact-bearer account writer consumer

This component connects the actual V1 account HTTP handler and `AccountStore` to
the frozen named `createWriterAuthContext` factory. It is a source-only candidate
against backend `b88a1486fe0b5bc013ea7012695360aecbf61758`, prepared for redesign
Root. It requires Root's companion writer-auth implementation; that export does
not exist at the base pin. There is no fallback to tuple-only authorization.
This component is not the complete Sessions lifecycle checkpoint and must not
be published independently as lifecycle protection.

The approved composition authority is the retained R2 plan, SHA-256
`f745e92b644ba09ccf121406fc459d99cdb4ca0d2345907a4816dee9e349841d`.
R5 remains SHA-256
`7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`.
The implementation uses the later frozen writer API supplied by Root, rather
than inventing callbacks for the plan's proposed interfaces.

## HTTP and private authentication

The handler retains its exact extracted `lyra_s_` bearer privately after the
existing `AppAuthStore.authenticate` and rate-limit calls. For `apple`, `delete`
and `signOut`, it calls `accounts.prepareWriterAuthentication(exactBearer)` once
and supplies the resulting opaque handle as an additional internal argument.
There are no public fields for the bearer, digest or handle. Request validation,
challenge/guest policy, response fields and `authError` handling stay V1.

`AccountStore` privately constructs the writer with an actual
`AppAuthStore(this.db,{policy:this.policy})`. Its pure auth environment is
`production` when the App Attest policy is production and `development`
otherwise. Construction performs no SQL and does not consult Sessions
configuration or activate a V2 namespace.

The returned empty frozen handle is branded by a store-private `WeakMap`.
Missing, fabricated, JSON-reconstructed and other-store handles fail with
`LibraryError('app_access_revoked',403)` before Apple IO. The incoming user ID,
key and bundle must match the prepared evidence. The store captures a frozen
source tuple before awaiting anything and checks its credential digest against
the actual locked writer scope. A raw writer authentication object is not an
AccountStore-owned handle. Writer evidence itself remains opaque and is never
serialized or reconstructed.

## Transaction composition

Sign-in and deletion preserve their membership-settings, nonce and verified
Apple identity anchors. Fresh target user/identity INSERTs remain private to the
transaction and uniqueness failures propagate to rollback. Apple verification,
deletion's subject comparison and external Apple revoke ordering remain the
account store's responsibility. Apple revoke happens before the local delete
transaction as in V1; a local rollback cannot undo that external effect.

For sign-in, C2 is random and server minted. The store computes SHA-256(C2) and
captures the exact closed JSON string
`{kind:'signIn',targetPrincipalID,targetCredentialDigest}` once after resolving
the verified identity and before discovery. Sign-out and delete use immutable
raw strings containing only their respective `kind`.

The bound writer operation proves C2 absent before discovery and revalidation.
Its digest is not a required existing-token anchor. After the sole auth lock
pass and intentional source move/closure, the store inserts C2, then verifies
the complete intended postimage. INSERT is not an UPSERT: a unique collision
rolls back the entire transaction. The raw intent was captured before these
awaits; an existing or replacement credential cannot stand in for C2.

Each account mutation calls `discover` once and `lock` once on the caller's
transaction client. These calls replace the old `lockAuthWriter` invocation for
the three mutations. There is no second auth-lock pass. Guest methods and their
existing `lockAuthWriter` paths remain unchanged.

Required scopes are derived by the store. Sign-in names its source and target
users, source credential and moved key. Sign-out retains every source-owner key
needed by its owner-plus-credential Spotify selector. Delete collects every
owned token and key. Collection uses C ordering and a 65th-row refusal sentinel;
no list greater than 64 is submitted or silently truncated. After the writer
holds its user anchors, read-only completeness checks refuse a newly appeared
owner token/key rather than appending locks. The writer owns user
`NO KEY UPDATE` locks, ordered token locks, all required key locks, and the
globally sorted full session union including the exact submitted source.

The store compares the returned scope to the captured original tuple, then
calls `scope.revalidate({tx})` before intentional existing-account mutation.
Existing Spotify cleanup selectors, source credential closure, moved-key
semantics, session deletion, learning/data operations, account identity fields
and postcommit cleanup remain. Target reactivation preserves V1 behavior here;
Root must compose its no-resurrection fence before any such reactivation.

After the deliberate move/revocation/deletion, the store calls
`scope.verifyPostimage({tx})` once as its last transaction IO and returns
directly to the database wrapper's COMMIT. It does not run unchanged-source
revalidation. Final auth SQL must verify the actual intended postimage and the
captured exact source session and credential deadlines with a fresh database
clock. No later read, write, privacy hook or queue call may be inserted between
that final check and COMMIT. Postcommit Spotify flushing remains outside the
transaction. The final sample cannot guarantee time will not cross a deadline
during COMMIT itself.

Writer `SessionV2Error` authorization/conflict/expiry refusals map to the existing
account `app_access_revoked`/403 response. Internal writer configuration/intent
failures map to `app_auth_unavailable`/503. Existing Apple, nonce, rate-limit and
initial HTTP authentication errors retain their existing mappings. Neither
mapping includes evidence, bearer or digest.

## Tests and evidence boundary

The complete existing `tests/integration/accounts.test.js` postimage is sealed
before behavior postimages. Existing regressions are preserved; direct callers
prepare actual sessions instead of bypassing exact-bearer authorization. The
suite imports the final actual writer factory by name, uses actual stores and
AppAuth migrations/SQL, and substitutes only external Apple/App Attest
cryptography. Query instrumentation observes real statements or introduces
actual SQL faults; it does not return successful replacement SQL/auth results.

New cases cover exact source replacement, revocation, deletion and expiry during
Apple IO while a sibling session remains live; a still-live exact source;
sign-out with a replacement bearer; missing/fabricated/foreign handles; rollback
after delete writes; final exact-session and credential deadline crossings for
all three mutations; C2/target postimage mismatch; a fresh-token uniqueness
failure; retained starter/user data; V1 HTTP shapes and error privacy; actual
writer lock ordering and final-IO placement; and execution against a schema
without V2 relations or new lifecycle columns.

Only `node --check` is authorized for the JavaScript postimages in this handoff.
No test, candidate import, database, package installation, network/provider,
private configuration, native execution or publication was performed. Syntax
acceptance is not red/green evidence. Root owns actual execution and any
qualification beyond source inspection.

## Root composition obligations

1. Assemble the exact frozen writer implementation with this consumer, run
   test-first red/green using actual methods, and independently inspect all
   final postimages. Qualify the real restricted-role PostgreSQL lock order,
   races, authoritative clock and rollback. Query traces in a local test do not
   establish real multi-client blocking or deployed role privileges.
2. Complete A+B together: privacy/lifecycle representation, all actual auth
   lifecycle writers, real authorization/read paths, first-retention admission,
   all-selector no-resurrection fences and durable bounded withdrawal/scrub.
   A single account consumer or one hooked writer cannot provide that boundary.
3. Split real Spotify revocation into trusted prep and persistence at its
   existing entrypoints. Acquire the combined connection/guard/persona/grant/
   room scopes before lower writes. Insert privacy lifecycle work and its final
   verification before this consumer's final auth `verifyPostimage`; never
   append a lifecycle hook after the existing combined Spotify writer.
4. Preserve narrow live guest transfer, shared-C sibling closure, cross-namespace
   negative responsibility, A-to-A history, A-to-B isolation, controller-wide
   erase, target reactivation's no-resurrection and exact durable hint timestamps
   in the full candidate. None is claimed fixed by this component.
5. Keep schema registration, retained V2 data, public routes and capabilities
   disabled. Demonstrate the complete schema-absent V1 path before deployment.
   Later activate only after all compatible writers/readers are deployed,
   required schema/roles/configuration qualify, old instances drain, and trusted
   scheduling/deletion budgets qualify. Root owns provider/deployment proof,
   publication, delivery, cleanup and any preview.

## Unowned pinned callers Root must adapt

The immutable b88 caller search identifies these additional fixture updates for
Root's combined candidate, outside this four-file ownership:

- `tests/integration/spotify-owner-hooks.test.js:20-22`: direct signOut, signIn
  and delete calls omit authentication; delete fabricates the Apple user tuple.
- `tests/integration/selected-source-storage.test.js:221-223`: partial policy,
  fabricated key/user and direct delete. The new pure constructor requires the
  actual auth policy; the test must issue a real session and preserve its
  selected-content assertions.
- `tests/integration/spotify-root-recovery.test.js:123-125`: direct signOut
  without a handle; its fixture must supply the actual auth schema/session.
- `tests/postgres/auth-token-lock-roles.test.js:471,478`: signOut calls need a
  handle prepared on that same AccountStore instance.
- `tests/postgres/listening-v2-auth-writers.test.js:213,223-225` and subsequent
  account writer call sites: preserve actual bearer/connection/store ownership,
  prepare once before Apple IO and retain the original lock/race assertions.

These are static compatibility observations, not observed test failures. No
additional path was modified or proposed here. Root owns these adaptations as
part of full composition; do not keep the old tuple-only behavior to pass them.
