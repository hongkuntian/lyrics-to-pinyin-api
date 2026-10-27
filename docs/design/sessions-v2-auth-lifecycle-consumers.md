# Sessions V2 actual auth lifecycle consumers — source candidate R1

This is an unapplied source candidate for redesign Root, on backend
`b88a1486fe0b5bc013ea7012695360aecbf61758`. It changes actual AccountStore,
AppAuthStore construction, operator admin and SongLibraryStore.createUser paths.
It is **not whole-lifecycle completion**. Root explicitly retains the unsupported
room/output transitions described below. Public V2 retention, routes, capabilities,
migration registration, configuration wiring and scheduling remain off. No
maintained files, index, commit, qualification checkout or runtime were changed.

Authority: full R5 architecture SHA256
`7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`,
full approved composition plan R2
`f745e92b644ba09ccf121406fc459d99cdb4ca0d2345907a4816dee9e349841d`, and
Root lifecycle foundation interface R1. The approved design gates were supplied
by Root; this worker assigns no score or independent approval.

## Exact component bases and required assembly

There are exactly eleven proposed paths. AccountStore and accounts tests use
completed AccountR3 preimages, not the older b88 tuple-only writer:

- accounts source `ce09a8fa6fabe9b8957edfdc11903f3689f136087e05b45fc1b1901de7d1e992`;
- accounts test `674363ead0001d8e60e808f08323ba275729a0a5f3e2108acb81deedc3ede904`;
- owner-hooks test uses completed caller fixture3
  `e7dd64bd268fbe7d18c93e20703c7438b102f9f7833b577a3489205768e8518e`.

Root's account HTTP is already composed and is not proposed here. Other existing
owned paths use b88 preimages. Both complete-component-base and b88 patches are
provided; apply one matching base, never both. Neither patch bundles or replaces
unowned foundations. Root must assemble these completed sources separately:

| Component | Required SHA256 |
| --- | --- |
| Auth context, completed retry-boundary R1 | `a9b166dab7739a8ff952663b10a93fe773365a305363d896d626d306d2fa9bfe` |
| Internal errors, completed retry-boundary R1 | `dac70423b7f56295f3b6d1fed410a87edda06432dbf8fd892ed84e98170d049c` |
| Negative engine, completed retry-boundary R1 | `9a595114623ef5b07c93ec01bc20115876ef716d6af17d3977101e78d98c6c83` |
| 033 composition DDL | `71b57b21ae4555d3d76da9b9936342238926fa8059117e68aa41a40a7e628678` |
| Privacy codec | `f4ab488efed5e80ea03ade63d715b80bb42886c20e1502ed0c52612bd7f19879` |
| Spotify prepare/persist revocation R2 | `a27ce0ea1774d6b40fabf68b16c58d75485361840893b01bb28abc8c4bb119e4` |

The latest auth/negative sources supersede their initially supplied
`e1e40b8b…` / `d0b8cf2f…` versions only at the sanitized transaction-error boundary
and failed-plan retirement; their SQL, API and lock order remain unchanged per
Root's handoff. Their internal retry signal is not a new public error contract.

## Server-only construction and actual operations

`AccountStore`, `AppAuthStore`, and `SongLibraryStore` accept optional trusted
constructor option `sessionsPrivacy:{coordinatorEnvironment}`. `disableUser` and
`revokeKey` accept the same closed option in their actual operator options.
Undefined means absent; null, booleans, proxies, accessors, extra keys, callbacks,
clock overrides and invalid namespaces refuse with bounded
`sessions_privacy_unavailable` 503. Construction performs no SQL.

Absent construction takes no V2 query or new-field query in actual methods. It
preserves the live V1 mode while 030/031/033 are absent. Source intent is not a
schema-absence execution receipt. Explicit configuration requires the composed
schema and roles; missing tables are not caught as successful off-mode operation.
No request payload, URL, environment selector or public factory turns it on.

The new `createAuthPrivacyWriters(db, configuration)` captures actual negative
engine and codec instances. It returns null when absent, otherwise frozen trusted
infrastructure with these closed entry-specific methods:

| Method | Actual caller and operation |
| --- | --- |
| `prepareSignIn(tx, writerScope, verifiedTargetID)` | Actual AccountStore, after its sole writer-auth pass and Spotify connection preparation; bounded whole G/K transfer discovery, actual target reserve, negative preimage plans |
| `prepareSignOut(tx, writerScope)` | Actual AccountStore exact-C closure; private Apple history is unchanged |
| `prepareDelete(tx, writerScope)` | Actual AccountStore exact owned sources and actual guest/Apple controller class |
| `prepareDisableUser(tx, ownerID)` | Actual operator, preheld complete bounded owner auth anchors |
| `prepareRevokeKey(tx, keyID, ownerID)` | Actual operator, rereads actual key/owner and closes only that owned key |
| `prepareRotation(tx, ownerID, newDigest)` | Actual createUser, refuses incoming digest resurrection before opening it and captures old credential closures |
| `applyBeforeAuth(tx, handle)` | Executes exact persona transfer CAS before source auth changes |
| `persistAfterAuth(tx, handle)` | Executes genuine negative-engine postimage checks and limited hint INSERTs, after Spotify persistence |
| `verifyPostimage(tx, handle)` | Actual complete transfer tuples, target epoch/enabled state, durable hints and unsupported-transition checks before final account auth SQL |

These are not request dispatch methods or positive authorization permits. The
actual AccountStore owns exact bearer preparation, Apple verification and the
sole actual writer-auth context. Operators retain their real trusted authority.
The helper snapshots scope fields rather than accepting an auth callback or
success boolean. Handles are closure-owned WeakMap keys bound to factory, exact
client/query identity, xid and phase. No caller receives editable plan contents.
Final privacy verification consumes its handle before awaiting, including failed
verification. A failed operation requires outer rollback, not savepoint reuse.

AppAuth's challenge/register/session remain the actual challenge, attestation,
assertion-counter and SQL methods. They do not reopen a revoked key or disabled
user. Existing-key ACK does not extend C, and same-live-C 15-minute session
replacement does not change personas, hints or broker authority. The standalone
session-only revoke method remains lifecycle-neutral. Its existing session-lock
statement is unchanged. The AppAuth option validates the closed construction;
it adds no speculative V2 action to these neutral operations.

## Transaction order and exact source

AccountR3's pre-Apple exact-S preparation, complete discovery and one actual
writer-auth category pass are preserved. `#lockWriter` has no appended earlier
locks. Existing settings/nonce/account-identity anchors remain earlier. Order is:

1. Actual sorted users NO KEY UPDATE, tokens, all required keys, all selected S.
2. Completed Spotify preparation: actual sorted connection locks, no outbox yet.
3. Actual negative source preparations and complete transfer preflight; sorted
   environment/persona locks where a supported transfer is possible. Unsupported
   guard/room/grant transitions refuse before intentional source mutation.
4. Exact persona CAS and real auth source/key/token/session mutations.
5. Completed Spotify persistence/capability/outbox writes, then negative producer
   postimage/hint persistence, then final privacy postimage verification.
6. AccountR3 `verifyPostimage`: exact intended auth postimage and captured exact
   S/C/C2 deadlines with fresh PostgreSQL timestamptz clock as the LAST SQL.
   The transaction callback returns directly to COMMIT; cleanup flush is later.

There is no source `scope.revalidate` after intentional key move/revocation.
Source preimage revalidation remains before mutation. No connection-locking
SELECT or second auth lock pass follows lower locks. disableUser now directly
updates its already-prelocked sessions instead of calling another session-lock
SELECT after connection preparation. Standalone revokeSessions is unchanged.

Configured operator/rotation auth unions use `authScopeLimit:64`, an internal
fixed numerical bound, not an authorization permit. Existing category collection
returns at most 65 candidates to detect overflow and refuses the whole operation.
No required row is trimmed. Off mode retains the existing uncapped policy.
Target-row limits are not physical scan/latency/IO guarantees; actual plans and
contention remain Root's measurements.

The completed negative engine samples DB time after actual source anchors and
before deliberate closure, then validates real negative postimages. Finite
retained expiry supplies its own earlier time. No caller clock or sweep-time
revocation timestamp is substituted. Hints remain global, coalesced, INSERT-only
for account role, with the engine's exact conflict verification. Actual expiry
already denies canonical reads independently of a job.

## Supported narrow transfer and no resurrection

Actual live G/K1 sign-in discovers all status-live guest G/K1 records across all
environments, with 101 detecting overflow of the 100 supported set. The entire
operation refuses on overflow, malformed tuple, dependency/deadline drift,
non-live source, source class drift, changed discovery or insufficient reserve;
no prefix transfers. Source C must be finite/current and its conservatively
floored retained millisecond deadline must match exactly, preserving the existing
privacy representation. Exact sub-ms S/C final deadlines stay in auth-context's
PostgreSQL timestamptz check. Retention-to-expiry must be <=90 days.

Each actual target tuple is reserved through `decodePersonaTuple` with
`reserveFuture:true` BEFORE any source change. It becomes Apple-controlled by
verified A, generation g+1, bridge exactly old g, captured current A epoch and
null guest dependencies. There is no fabricated legacy bridge or second
transfer. C closes only after this real CAS; G/K2 remains guest and canonical C
revocation denies it immediately with the processor stopped. The authored
sibling SQL assertion is not an actual all-audience service execution receipt.

A->B transfers no A history. A->A preserves existing Apple persona/bridge bytes.
Both replace auth, so supported old-install effects must be fenced separately;
this candidate refuses their unsupported room/output transitions. No account
sign-in or change moves a live room.

A disabled target cannot reopen while any global status-live Apple-controlled
persona remains, including effectively dead rows awaiting permanent materialization.
Incoming createUser digest reuse likewise refuses while any global status-live
bound guest persona remains, even if expired/revoked. This conservative deferral
performs no unbounded persona UPDATE and invents no invalidation time. Once all
old personas are permanently withdrawn, AUTH-only reactivation can proceed while
cleanup hints are unfinished. It never revives a withdrawn UUID. Actual first
retention must still refuse matching pending/claimed/dead responsibility until
publication; that operation is Root-owned, not replaced by an unused permit here.

Transfers check unfinished exact credential, guest-key, guest-user and target
apple-controller selectors in ALL namespaces, including successors. Old unrelated
digests do not block a candidate merely by owner association. Current source
anchors serialize these checks against the completed processor's final publication.

Delete/disable select actual access_kind to prepare guest-user or Apple-controller
closure, plus actual unrevoked owned credentials/keys. Disabling A canonically
withdraws all A-controlled old G/K without claiming auth rights over K now owned
by B. Key revoke closes the actual current owner key and guest-key dependency;
Apple private history is not withdrawn merely for key loss. Repeated already-closed
sources do not invent another preimage event. Historical lost timestamps/anchors
remain negative-engine repair debt, not reconstructed time.

The conflict-time foreign-owner createUser UPSERT predicate is byte-preserved.
The new candidate changes only its auth helper/constructor/createUser area; all
later SongLibrary behavior and configure method are byte-identical to b88.

## Precise Root objections and safe actual-entry refusals

Root confirmed there is **no completed install-binding or terminal-handoff
contract** and explicitly directed this worker to keep these refusals. No broader
file allowlist, new table, guessed binding or fake terminal job is proposed.

- **PW-01, guard/install resolution:** neither actual auth key nor Spotify
  connection can be mapped to `output_guards.original_install_scope` by a retained
  closed contract. This candidate conservatively refuses a configured closing
  writer if ANY guard exists. This is a deliberate availability restriction,
  including unrelated guards whose independence cannot be proven, not scoped
  output-fence completion. No guard is locked, initialized, released, deleted,
  credited or mutated; every retained guard byte survives. Root needs one closed
  actual-install resolution/pre-send fence contract under the existing auth locks.
- **PW-02, actual room closure:** account has limited room fence/redaction and
  cleanup INSERT privileges, but no semantic-event/counter execution or closed
  trusted End/handoff producer. This candidate refuses if any active V2 room
  exists, and for affected historical rooms needing consent/attribution work.
  Empty rooms also refuse rather than claim an End from a status-only UPDATE.
  Nonempty/unknown room shapes are never recursively scrubbed or interpreted as
  recording/visit mappings. Root needs an in-transaction bounded terminal fence
  and a durable handoff to runtime's independent End reserve, with exact postimage
  and claimed responsibility semantics. It must not forge user receipts or call
  guest removal on a host. No greater account execution grant is requested.
- **PW-03, controlled grant generations:** affected active returning grants also
  refuse until Root's closed physical-install/generation transition is available.
  The worker does not revoke an unrelated newly approved generation or silently
  assert remembered-pair continuity from a privacy bridge.

Root's clarified product rules are fixed: hosting belongs to the installation
that created the room for its entire lifetime; it is never transferred mid-session.
If that host install cannot be resolved, the room can only end by host End, timeout
or server expiry, while guests keep their recap. P47 Start again creates a NEW
room hosted by whoever starts it. It is not a live-room handoff. These rules
supply no missing SQL/processor/install representation by themselves.

These refusals occur in ACTUAL configured entrypoints, before intentional source
mutation. Existing external Apple verification/revocation ordering remains the
AccountR3 behavior; external IO cannot be rolled back by PostgreSQL. Failure
rolls back auth/persona/hint/Spotify database changes. No runtime success or
whole A+B publication is claimed from this source candidate.

## Retry signal boundary and Root correction

Root supplied the completed transaction-retry-boundary component, then corrected
an earlier HTTP-500 inference against actual b88 `app-auth/http.js:5-9`: unknown
errors ALREADY become fixed status503/code app_auth_unavailable, and only the
fixed app_auth_unavailable message is logged. The completed retry unit postimage
directly tests that existing authError boundary. Public503 is not an open blocker.

No extra AccountStore writerAuthorization mapper remains. Its AccountR3 behavior
is preserved exactly, including propagating unknown internal errors to the
existing HTTP boundary. No extra import/classification of transactionRetrySignal
was added here. The latest foundation sources remain required assembly pins.

The privacy helper's original generic catch remains independently necessary:
actual admin/createUser callers also run outside HTTP authError. It preserves
intentional LibraryError refusals and converts any other internal exception,
including the negative engine's sanitized signal, to fixed
sessions_privacy_unavailable 503. It exposes no SQL/detail/cause or raw signal and
performs no retry. AppAuth and Spotify retain their existing error boundaries.
The receipt gateway alone owns its existing bounded attempts. No account,
Apple IO, operator, provider retry loop, timeout, delay or backoff was added.

## Tests-first artifacts, evidence and remaining qualification

Five complete test postimages were sealed in `tests-first/seal.json` before
writing behavior. Final tests match that initial seal byte-for-byte. Six late
expectations for the subsequently retracted extra-mapper requirement were never
executed and are explicitly retired outside the final postimages/patches. Their
seal/history remains labeled for inspection; it is not a final test contract. No
original baseline or initial worker assertion/skip/timeout was weakened or removed.

Authored cases use actual AccountStore/AppAuth challenge/register/session/
authenticate, admin, createUser, Spotify and negative processor methods, and
actual 030/031/032/033 DDL. Only external cryptography and queue flush are fixtures;
SQL observation/faults forward real statements and do not fabricate positive
responses. Retained persona fixture INSERTs are preimages, not first-retention,
auth or successful transfer evidence. A role case exercises actual account
transfer/hints under exact migration grants and asserts forbidden event/guard
execution. Existing AccountR3 source/final deadline, C2, HTTP and source-metadata
regressions are preserved in full.

Coverage includes multi-environment whole live transfer and overflow/drift,
shared C/K2 denial, A->A/A->B history, unfinished selectors in pending/claimed/dead
states, deleted target/no resurrection, same-owner token reuse after actual
permanent withdrawal, actual source closure entrypoints, unsupported room/guard
refusals, source-S replacement during Apple IO, final SQL ordering, rollback
after transfer/hints/C2, schema-absent off mode and no callback permit. The
completed dependency's retry tests remain separately Root-owned. Authored worker
cases are expectations, **not executed results**.

No candidate import, test, PGlite/PG/DB, npm, network, native/resource or config
operation occurred. `node --check` is syntax only; the artifact receipt enumerates
exact files and exit status. Static checks also verify initial sealed-test equality,
complete patch scopes, base/final hashes and
unrelated SongLibrary byte identity. They establish no SQL validity, import
compatibility, behavioral pass, red/green, role execution, concurrency or latency.

Root must run a discriminating consumer red control with the completed helper
available but consumer hooks absent; a missing-module import error alone is not
behavioral red proof. Then execute the assembled final candidate, affected
regressions, actual restricted PostgreSQL roles/clocks/lock ordering/races and
fault rollback, full required gates and independent source review. Actual
first-retention/global publication races, real private audience readers/erase,
epoch rollback, active-room terminalization, grant generations, shared output
pre-send and backup completion remain Root components. This worker does not fake
those APIs to author passing composition tests. Public/live admission and all A+B
delivery remain blocked until Root composes and qualifies those obligations.

Only small source/test/patch/hash artifacts were created. They are retained for
Root's pending handoff; no other task's evidence or checkout was touched or
removed. No space-reclamation claim is made.

## ACR1-01 final transfer cutoff correction

For a nonempty transfer, the closed privacy postimage verifier returns the minimum retained source-persona expiry in integer milliseconds. AccountStore passes this server-derived negative bound to the writer scope's finalizer. The SAME final `auth_clock` sample compares it using PostgreSQL numeric epoch arithmetic alongside exact captured S/C/C2 timestamptz deadlines. No intermediate check replaces it; no IO follows before COMMIT. No-transfer and absent-configuration callers keep the original final query. This optional bound can only shorten authorization. The 900-microsecond comparator fixture executes real SQL with a substituted final timestamp and demonstrates whole actual-method rollback; it is not measured wall-clock placement or PostgreSQL concurrency proof.

## ESM initialization boundary

Canonical npm testing exposed a real recording-first module cycle from the new static SongLibraryStore-to-Spotify-revocation dependency. Configured createUser now resolves the same revocation module before beginning its transaction; absent configuration never loads it through this edge. Construction remains synchronous and IO-free, auth/connection/privacy lock ordering and postcommit cleanup remain unchanged, and import failure becomes bounded unavailable. The existing recordingFingerprint alias and recording identity implementation are unchanged. Six fresh Node processes exercise real entry orders without a warm module cache. The canonical failed unit-stage receipt is retained; the proposed repair is independently reviewed and must pass the affected entries and canonical gate before delivery.

The IBR1-01 receiver correction invokes the selected cleanup function with `.call(this, ...)`, preserving the existing SongLibraryStore receiver for supplied functions as well as the undefined-only default. Its actual-method regression verifies the new credential already committed, callback receiver/arguments and successful return; no postcommit cleanup or source authorization semantics are otherwise changed.
