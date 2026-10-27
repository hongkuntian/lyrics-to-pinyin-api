# Exact-session authorization for account writers

This disabled internal primitive extends `auth-context.js` at backend base `b88a1486fe0b5bc013ea7012695360aecbf61758`. It supplies no route, runtime import, migration, capability, lifecycle hook or provider call. Construction performs no SQL. Root must compose the complete approved lifecycle A+B checkpoint; this primitive alone does not implement lifecycle protection or Sessions erase.

Authority: approved R5 architecture SHA-256 `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`; lifecycle composition plan R2 SHA-256 `f745e92b644ba09ccf121406fc459d99cdb4ca0d2345907a4816dee9e349841d`; Root's R2 gate authorizes disabled A+B implementation, not runtime/public enablement. The existing normal reader retains its user `FOR UPDATE`, per-list limits, actor/deadline fields and revalidation semantics. Its only API addition is `assertFreshSession`; exact datetime columns added to its private SQL are not public fields.

## Closed API

```js
const writerAuth = createWriterAuthContext({authStore, environment});
const authentication = await writerAuth.prepare(exactBearer);
// AccountStore verifies Apple proof, when applicable, AFTER preparation.
```

`authStore` is the actual configured `AppAuthStore`, with its real `authenticate` method. Preparation hashes the exact bounded `lyra_s_` bearer before awaiting that method. The returned frozen `{principalID,keyID,bundleID,evidence}` contains closure-owned opaque evidence, not a reconstructable auth tuple. Shallow spreading preserves it; JSON serialization does not. Do not serialize this object as an endpoint result. It exposes neither the bearer nor its session digest. Existing underlying credential/session/key/user policy remains authoritative.

```js
const discovery = await writerAuth.discover({
  tx, authentication, operationRawJSON, requiredScopes
});
const writerScope = await writerAuth.lock({tx, discovery});
```

`operationRawJSON` is a server-generated UTF-8 JSON string of at most 2048 bytes with exactly one shape:

```js
JSON.stringify({kind: 'signOut'})
JSON.stringify({kind: 'delete'})
JSON.stringify({kind: 'signIn', targetPrincipalID, targetCredentialDigest})
```

Duplicate members (including escaped duplicates), unknown fields, nested authority, supplied clocks, callbacks and postimage-success booleans are unavailable as operation fields. The sign-in target must have been verified by actual AccountStore Apple identity handling before discovery. The module checks that the target user exists and is Apple-kind; locks cannot prove Apple identity. A fresh server-random credential, for example `lyra_a_` plus cryptographic random bytes, is minted before mutation. `targetCredentialDigest` is SHA-256 of that credential, not a request field. The module cannot attest the randomness of a supplied internal digest. Existing unique constraints remain the arbiter for concurrent absent-digest insertion; no lock on an absent row is claimed.

`requiredScopes` has only optional `userIDs`, `credentialDigests`, `keyIDs` arrays, each at most 64 entries before deduplication. Capture and validation occur synchronously before the first discovery await. These are server-derived supplemental lock anchors, never positive actor authority. The primitive adds actual source scopes and verified target user, rejects any resulting union above 64 in each category, and never trims a required identity. Caller user IDs cannot change the exact source identity.

The discovery object is opaque and frozen, exposing only `environment`. The scope is frozen with existing internal actor fields `{environment,principalID,keyID,bundleID,audience,attestEnvironment,credentialDigest,accessKind}` and these methods:

```js
await writerScope.revalidate({tx});
await writerScope.assertFreshSession({tx, maxAgeMS: 120000});
await writerScope.verifyPostimage({tx});
```

Plans bind the exact factory, client object and `pg_current_xact_id()` string, and permit one lock pass. Autocommit/pool-query facades do not supply a stable transaction ID. A retained scope fails on another transaction even if the pool reuses the same client object. A failed final check is consumed; neither retrying it nor revalidating can recover that scope. A wrong-client call to any acquired writer method or to the reader's new `assertFreshSession` fails before SQL and permanently invalidates that scope. Subsequent calls on its original client, including ordinary reader revalidation after a failed freshness call, refuse without further SQL. The old reader `revalidate` body remains unchanged. Roll back on every failure. Different factory instances cannot exchange evidence or plans. Consumers must not construct another factory to evade the one-pass contract.

## Discovery and lock categories

Sign-in adds exact source credential C, moving key K, every existing session selected by the complete required key union plus exact submitted S, verified target A, and the negative preimage of new C2. Sign-out derives **every currently source-owned key**, preserving the existing Spotify contract even though its credential selector narrows only connections. Delete derives **every currently source-owned token and key**. Required supplemental keys add all their current sessions too. Keys already owned by B are excluded from A's source-owned deletion set; adding historical privacy scope must never reclaim B's current auth keys.

Discovery records source/target users, token/key owners and complete auth row images. Before locking, a newly occupied C2 refuses. Under the sorted user anchors, the primitive re-enumerates the operation's full source sets and refuses any changed or additional identity in those sets. Sign-in's source key set is exact moving K: inserting an unrelated source-owned sibling after discovery does not widen that union or invalidate it. The sign-in postimage leaves that sibling and its sessions untouched; sign-out/delete instead enumerate every source-owned key and refuse such an added key before token/key/session locking. It never adds an earlier owner after preflight. Lock order is fixed:

1. Every required existing user, UTF-8/C order, `FOR NO KEY UPDATE`.
2. Every required existing credential, digest order, `FOR UPDATE`.
3. **All** required keys, UTF-8/C order, `FOR UPDATE`.
4. The complete affected session union, globally digest/C order, `FOR UPDATE`, including exact prepared S.
5. Only then may Root acquire Spotify/guard/persona/grant/room and lower deterministic locks.

No second auth-locking pass belongs after keys, sessions or lower locks. The stronger ordinary reader user `FOR UPDATE` is intentionally unchanged; exposing a caller-selectable reader lock mode would reintroduce the V1 actor-FK concern described in `sessions-v2-auth-writer-order.md`.

Enumeration uses at most 65 returned rows to detect overflow of a 64-row supported set, then refuses the entire operation. This bounds retained candidates/locks, not physical rows scanned, IO, sorts, latency or contention. Root owns actual PostgreSQL plans, role and multi-client qualification.

## Preintent and intended postimages

`revalidate({tx})` is read-only and belongs before intentional auth mutation. It rereads the bound scopes, exact prepared session, source identity, metadata, current revocation/disabled state and fresh DB deadlines. S replacement, disappearance, revocation, owner drift or changed exact deadline refuses; another live session for K never rescues S. This method acquires no new row lock. Do not call it after deliberately moving K, revoking C or deleting S.

`verifyPostimage({tx})` reads actual database rows for the already closed operation. It does not invoke a caller callback or accept a success claim.

| Operation | Required auth postimage |
| --- | --- |
| signOut | Source owner/user and all captured keys/sessions preserved, except C is revoked. Other locked credentials are unchanged. |
| signIn | Exact K now belongs only to locked verified A, other key material/metadata preserved; C revoked; all captured K sessions removed and no replacement inserted; C2 was absent before, now belongs to A, unrevoked and finite/live; target user enabled, Apple-kind; unrelated locked auth rows unchanged. Same-A sign-in is supported. |
| delete | Source user disabled; every actual source token revoked; every actual source key still source-owned, revoked and public-key/receipt scrubbed; source-key sessions absent; supplemental/foreign scopes unchanged. Extra source tokens/keys/sessions or escaped/missing rows refuse. |

The checked auth image includes exact timestamp text and stable database JSON text for unrelated columns, avoiding JS int8/time rounding. Auth/refresh quota counters/windows are not authorization identity and may change without a refusal. Other unrelated auth columns remain unchanged. This is a closed check over discovered auth scopes, not a proof about unselected arbitrary database rows or Root's privacy/identity/nonce/output postimages. A future intentional auth-column change needs an explicit closed contract and review; do not introduce caller-approved postimage bypasses.

After all auth-postimage reads, **the final SQL** materializes fresh `clock_timestamp()` and compares the captured exact source-session and credential deadlines using PostgreSQL `timestamptz` values. It preserves microseconds and existing nullable credential expiry; it does not parse a Date or floor epoch milliseconds. That final sample also checks new C2's captured postimage deadline for sign-in and the same transaction ID. Deliberate source closure/deletion is expected; the original unchanged-source predicate is not applied afterward. The caller must return directly to its transaction wrapper's COMMIT, with no further SQL, provider/queue call, privacy hook, asynchronous observer, logging IO or other awaited work. Time can still cross during COMMIT itself; this primitive does not promise otherwise.

## Root consumer seam

At this base `api/account.js` discards the exact extracted bearer after `authenticate`, and AccountStore takes a four-field user tuple. Root must instead prepare the exact bearer once and pass opaque evidence privately into the actual account methods before external Apple IO, retaining V1 body/result/error contracts and quota semantics. Do not authenticate a second bearer or accept an HTTP-supplied prepared tuple. A source actor ID needed for existing nonce/identity lookups is `authentication.principalID`; the credential digest is available internally on the locked writer scope.

Root replaces these existing passes in `membership/accounts.js`: signIn's source/target `lockAuthWriter`, signOut's owner/allKeys pass, and delete's owner/allTokens/allKeys/sessions pass. Earlier existing settings/nonce/account-identity anchors remain before writer discovery/locking. Verified target resolution and any fresh transaction-private user insertion occur before the discovery call; do not lock an existing target user separately ahead of the sorted union.

```js
// Sketch inside the already-authorized real AccountStore path, not new APIs.
const authentication = await writerAuth.prepare(exactBearer); // before Apple IO
const verified = await apple.authenticate(existingInput);     // signIn/delete only
// Existing verification/revocation/preconditions remain AccountStore-owned.
await database.transaction(async tx => {
  // Existing settings/nonce/exact identity anchors first; resolve verified A.
  const discovery = await writerAuth.discover({tx, authentication,
    operationRawJSON: JSON.stringify({kind: 'signIn',
      targetPrincipalID: verifiedTargetID, targetCredentialDigest: digest(newCredential)}),
    requiredScopes: serverDerivedSupplementalScopes});
  const scope = await writerAuth.lock({tx, discovery}); // old lockAuthWriter REMOVED
  // Root acquires complete predeclared lower categories in approved order.
  await scope.revalidate({tx}); // before intentional source mutation
  // Existing auth mutations + actual Root lifecycle/negative responsibility.
  // Root validates intended privacy/identity/output postimages HERE.
  await scope.verifyPostimage({tx});
  // Return immediately; transaction wrapper sends COMMIT next.
});
// Existing Spotify cleanup/wakes only after successful joint COMMIT.
```

`revokeSpotifyInTransaction` currently combines sorted connection locks with capability/outbox writes. Root must split its preparation/persistence at the real entry so lower lifecycle locks fit before final lower-row writes. Calling a V2 hook after that combined helper is not ordered composition. No V2 query is needed merely to construct the writer context while V2 is off. Actual schema-dependent lifecycle work remains a separate explicit Root gate.

## Exact-session freshness for private erase

Both locked normal reader and writer scopes expose `assertFreshSession({tx,maxAgeMS})`. The server selects a safe integer limit in `[0,900000]`; Root erase hardcodes `120000`, never takes it from the body. The check is read-only, same-client/xid, and compares the exact persisted S expiry against its locked exact deadline and current actual database clock. Issuance is derived only as `S.expires_at - interval '15 minutes'`. An otherwise valid but too-old or future-issued session throws `SessionV2Error('expired')`; an invalid, replaced or revoked source throws `unauthorized`. No replacement lookup or production caller-clock override exists.

Freshness alone does not authorize erase, choose guest/Apple scope, supply confirmation or expected generation, execute a lifecycle transition or establish replay semantics. Root's actual guest and Apple erase method/receipt boundary must qualify those separately, including exact <=120-second and immediately-beyond cases.

## Authored verification and outstanding gates

The new integration file imports the factory namespace so feature absence can be tested after registration rather than failing a top-level missing named export. Its actual AppAuthStore challenge/register/session/authenticate calls use all registered public migrations 001–029 plus 032, with no V2 schema. Only external crypto is replaced. SQL instrumentation forwards real database queries and mutates fixture state; it never fabricates a positive auth response. Auth mutations are representative SQL for the actual AccountStore sequence, not claims that those actual methods are already wired. PGlite supplies one connection and proves no multi-client blocking.

Authored cases cover all closed operations, live/invalid preimages, postimage omissions and corruption, rollback, exact-S replacement with another live session, real DB deadline crossings before locks/before intent/after intent, nullable C expiry, globally sorted unions and lock modes, wrong client/xid/reuse, mutation of caller input across await, overflow, owner drift, C2 collisions, supplemental-anchor non-authority, 121-second otherwise-valid freshness, source unauthorized versus too-old distinction, and microsecond timestamp checks. Pure exact-age SQL vectors are explicitly supplemental, not injected-clock execution of the method and not actual erase proof. Added-key drift cases use sign-out/delete; the exact-K sign-in ownership-drift case remains. The sign-in sibling-insertion control commits the intended auth postimage and compares complete sibling key/session rows. Wrong-client regressions cover writer revalidation, writer freshness and reader freshness, then require original-client refusal with zero further queries; the finalizer has its own unchanged consumption control.

The postimage worker ran only `node --check`, text/hash/source inspection. No red/green, imports, PGlite/PG, npm, network, runtime/native, resource claims, configuration, migration, deployment or publication occurred. Root owns actual tests-first negative control, focused green, byte-identical existing 35 reader regressions, all hermetic checks, owner/restricted-role PostgreSQL with observed blocking, full A+B composition/review, actual guest/Apple erase and deployment/provider qualification. All V2 capabilities stay off.

## Optional final negative deadline

`writerScope.verifyPostimage({tx, notAfterMS})` accepts an optional server-derived nonnegative safe integer, captured once. Undefined preserves the original final SQL and exact S/C/C2 rules. A supplied value is an additional strict numeric epoch-millisecond cutoff in the SAME materialized DB-clock statement; it cannot replace or extend any exact source/target deadline. Invalid values retire the scope; an elapsed bound denies authorization. The method still consumes the scope once and remains the last SQL before the caller returns directly to COMMIT. This is neither a caller clock nor a positive privacy permit.
