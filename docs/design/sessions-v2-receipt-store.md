# Sessions V2 atomic command receipts

Disabled server-only gateway on assigned backend `902b8e6b783678b73b7c810e7a1b93b1c38878bf`. It follows the complete approved R5 architecture, SHA-256 `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`, and the existing [storage contract](sessions-v2-storage-schema.md) and `db/030-listening-v2-schema.sql`. No HTTP adapter, runtime import/wiring, migration registration/application, capability, provider operation or V1 change is included. Root owns review, actual PostgreSQL/full qualification and publication.

The three owned files are `api/utils/listening-v2/receipt-store.js`, `tests/integration/listening-v2-receipt-store.test.js` and this document. The separately owned admission implementation is untouched.

## API and authority boundary

`createReceiptStore(options)` returns a frozen object with `execute(input)`. Required construction dependencies:

- `db.transaction(async tx => ...)`, where `tx.query(sql, params)` addresses the authoritative database. The wrapper must await the callback, COMMIT immediately after success, ROLLBACK after any exception, and release its connection. It must not rerun callbacks itself. Configure bounded lock/statement/transaction deadlines in this trusted database layer.
- A trusted normalized `environment`: `production`, `development`, `test`, or `preview:<deployment identity>` under the existing DDL syntax.
- `bindingKeys: [{version, secret: Buffer}]`, `activeBindingKeyVersion`, `ticketKeys: [{id, secret: Buffer}]`, `activeTicketKeyID`. Each ring has one to four entries and secrets have at least 32 bytes. The rings have separate purposes. Keys are copied at construction.
- `lockAuthorization`, the mandatory trusted transaction hook described below. Missing hooks fail at construction; invalid hook permits fail inside the transaction before mutation.
- `mutations`, a fixed server registry mapping each supported action name to an async reducer. Unknown actions refuse before transaction/receipt allocation.

`execute({authentication, rawCommand, creationTicket?})` returns `{version:2, sessionID, commandID, status, result, replayed}` only after `db.transaction` resolves. No actor identity, HMAC bindings, signing metadata, credentials, source ticket, room state or provider response is returned.

`authentication` is trusted prior app-auth context, including `principalID`, `keyID` and whatever authenticated credential/session evidence the hook needs. It is never a request-body identity. The hook must independently lock/revalidate that context on the supplied transaction connection; the prior authentication alone is insufficient. This module cannot be exposed as generic SQL or a request-selected callback interface.

For a room mutation, `rawCommand` is bounded raw JSON with exactly `version`, `action`, `sessionID`, `commandID`, `expected`, `payload`. The semantic hash includes protocol/action/session/expected/payload and excludes only commandID, matching the existing core protocol helper. For create/restart it instead has exactly `version`, `action`, `expected`, `payload`: both IDs come exclusively from the verified creation ticket. Restart requires `expected.sourceRecapRevision`, which is also independently ticket-bound. The hash excludes the ticket and server IDs. The complete creation semantic envelope is what the existing ticket helper must hash when issuing the ticket. Callers cannot provide a body digest or replay binding.

The existing raw JSON admission/parser supplies the 16 KiB bound, duplicate-key refusal, exact numeric-token policy and canonical lexical-key hashing. This gateway checks the envelope; the server reducer/action validator still owns its complete payload schema, permissions and domain invariants. This is an internal gateway API, not an added HTTP/wire schema.

Standalone roomless `privacy.erase` is outside this slice; the DDL's nullable-room representation does not implement that action. This gateway covers ticketed creation/restart and registered room mutations. Actual auth-store and privacy reducers remain separately owned work.

Each registered reducer receives `{tx, command, room, nowMS, actorPersonaID, actorPrivacyGeneration}`. Command and decoded room are frozen. It returns `{status, result, consumeReservedReceipt?}`. A valid durable refusal is an explicit returned status such as `refused` with `{code:'forbidden'}`. A thrown exception rolls back instead of creating a durable refusal. Create/restart refusal/expiry/cancellation must leave no room; accepted creation must create the ticket's exact room in this transaction. Restart's exact seed/permutation is stored in that room, so a retry does not invoke the reducer or reshuffle it.

Reducers are **trusted server code registered at construction**, never callbacks supplied by a request. They may write their already locked domain state, semantic events and outbox on `tx`. They must validate expected revisions and reserve domain/terminal capacity, enforce exact recording/seed semantics, maintain typed room state/privacy mirrors, and use deterministic event/outbox order. They may not write receipt rows/counters, discover and lock earlier scopes, open another pool/transaction, invoke providers/catalog/images/network, schedule an external effect, or perform after-commit work. External effects require separately qualified outbox/execution gateways. Retrying a rolled-back reducer is safe only under this boundary.

`result` is deliberately a small durable redacted projection. Allowed integer fields are `stateVersion`, `sessionRevision`, `queueRevision`, `settingsRevision`, `transitionRevision`, `authorityEpoch`, `eventSeq`, `privacyGeneration`, `count`; nullable UUID fields are `occurrenceID`, `visitID`, `executionID`, `admissionID`. It also accepts boolean `noop` and one existing public error `code`. Every other field or nested value refuses and rolls back. SQL additionally enforces its normalized JSON/aggregate receipt byte limits. This excludes names, photos, URLs, arbitrary text, tickets and provider bodies. Rich authorized room/recap projections are separate reads; the gateway does not synthesize them into receipts.

## Mandatory trusted hook

`lockAuthorization({tx, authentication, environment, command, bindingKeyManifest})` must acquire all required scopes up front in this order:

1. Existing applicable settings/admin/identity serialization anchors in their documented order.
2. Sorted library users/tokens, then sorted App Attest keys, including any host grant anchor. The exact authenticated key must be held **FOR UPDATE** to serialize this actor's commands across old/new HMAC writers.
3. Sorted Spotify connections, output guards, privacy personas, then host grant scopes.
4. Return to this gateway, which locks the addressed room and deterministic receipt identities. Reducers can then write already locked state and deterministically ordered event/outbox rows.

Missing/discovered earlier scopes require an abort and a newly prepared bounded attempt; no lower lock may be used to discover and acquire a higher one. The gateway has no general scope-discovery retry. Creation's absent room/receipt query is followed by insertion of that exact new room; an existing conflicting room never reaches its reducer. Creation replay across a different ticket room conflicts under the exclusive authenticated key anchor, without locking an unrelated room afterward.

The hook returns:

```js
{
  version: 1,
  environment, principalID, keyID,
  bindingKeyManifestHash,
  actorPersonaID,          // UUID or null
  actorPrivacyGeneration, // exact safe uint or null, paired with persona
  notAfterMS,             // minimum locked auth / referenced guest deadline
  revalidate: async ({tx, command, room, receipt, phase, nowMS}) => true
}
```

Identity/environment must exactly match the prior authenticated context. `notAfterMS` must be the minimum actual session, credential and all relevant guest-persona dependency deadlines, not a rolling/default lifetime. The final fresh clock sample also checks this deadline, covering time spent inside the last hook. Each `revalidate` must be a read-only same-connection check of the held rows; it must return exactly `true`. `false` produces `unauthorized`; absent/malformed answers produce `unavailable`. The hook may throw an existing safe `SessionV2Error` for a more specific permitted refusal.

Phases are `locked`, `mutation` or `replay`, then `commit`. The initial phase has no room/receipt. Subsequent phases receive their locked decoded rows. Recheck the actual current bearer/session, enabled principal, exact key ownership/bundle/audience/attestation environment, unrevoked matching credential and current expiry. Check membership/action rights, controller/generation and GuestLive for **every** privacy-bearing reference relevant to the operation/result, including referenced other participants. The fixture only models a small subset; it is not the production hook.

Replay requires current receipt-read entitlement/privacy, which can differ from permission to execute a new mutation. It must not rerun the original expected-revision comparison: an equal retry returns its original receipt. Ended/expired rooms may expose an entitled saved receipt; they cannot accept new mutations. Withdrawal, credential loss, controller changes or membership policy can deny that read even with retained bytes. Privacy checks occur before even disclosing a body-hash conflict. Revalidation must use current DB time at its SQL authorization point, not transaction-start `now()`, and may not obtain new earlier locks or redact/write rows as a side effect. Erasure/redaction belongs to its separately authorized transactional hooks.

### Key-version representation and continuity

Receipt principal/key bindings are separate HMAC-SHA256 domains over the exact verified IDs, version and environment. They are independent of bearer renewal and ticket signing versions. Principal/key moves deliberately do not make old actor results readable under a new principal. Every retained version is searched before writing under the active version; equal retries retain their original stored binding/version. Cross-version duplicate matches fail closed. An environment with any receipt version absent from the supplied ring refuses work rather than creating a fresh namespace. Keep the original secrets until all affected receipts have actually left retention; reaching the four-version overlap bound refuses further rotation.

The existing DDL has `binding_key_version` but **no version-to-secret fingerprint registry**. It cannot detect replacement of a secret under an existing number by itself. No second migration/registry/sentinel is added. The injected trusted hook must therefore validate `bindingKeyManifest` against separately provisioned, immutable per-environment key-version configuration before attesting `bindingKeyManifestHash`. This is a required remaining trusted integration, not proof supplied by a returned hash alone. Descriptors are sorted `{version, verificationHash}` values, where verificationHash is HMAC-SHA256 of JSON `['sessions-v2.receipt-key-check', version, environment]` under that version's secret. The manifest hash is SHA-256 of the descriptor JSON. The hook must compare each descriptor with its trusted configuration, not merely echo the supplied hash. Secret replacement/unknown version must refuse; no network/key-manager IO is allowed while locks are held. The focused fixture validates descriptors against its fixed synthetic immutable keys and reproduces replacement refusal.

Production must supply this immutable configuration plus cooperative same-DB auth/lifecycle locks before enablement. A compromised/misimplemented trusted hook or an incompatible writer bypassing the exact-key lock cannot be repaired by this gateway. Root must qualify credential rotation, sign-in/out, key moves, revocation, deletion, no-resurrection and every receipt/privacy audience against the shared auth store.

## Atomicity, expiry and retention

One supplied `db.transaction` contains current authorization, room/receipt locks, retained-version lookup, canonical conflict check, the reducer, room receipt accounting and receipt INSERT. It returns no tentative result. Equal retry reads the saved redacted result and does not mutate the room or invoke a reducer. Different semantics/action under the same room/actor/command conflict; create and restart additionally share the schema's global actor/command namespace across all rooms.

Creation tickets are verified by the existing helper before opening a transaction, at locked authorization, and with fresh database wall time after all transactional work immediately before returning to the wrapper's COMMIT. Default clock SQL uses `clock_timestamp()`, not `now()`. A crossing at the final check throws `expired` and rolls back all room/event/outbox/counter/receipt writes. Final new-mutation authorization also checks room expiry. Expired tickets refuse even when a receipt remains, and cannot recreate a room after retention deletion; use a separately authenticated lookup after ticket expiry. No automatic renewal/new IDs are issued here. As with any callback transaction API, the final check linearizes just before the wrapper commits; the supplied wrapper must not insert delayed/external work between callback success and COMMIT.

The gateway owns incrementing `receipt_count` and optionally consuming one existing reserved receipt slot. Unreserved work refuses when committed+reserved capacity is full. A trusted reducer may request a reserved slot only for the terminal operation whose reservation it already owns; the gateway checks a slot exists. It does not invent domain reservation attribution. Roomless durable creation refusals still require the enclosing service's bounded admission/lifetime quotas, which this slice does not implement.

Receipt retention is at least write time+30 days and the room's immutable maximum expiry+30 days (or its larger actual receipt-retention field), covering a later End. Ticket deadline is retained separately. No retention worker/deletion is added. Near-safe-integer overflow in timestamps/retention fails and rolls back. `decodeSafeUInt` accepts only nonnegative safe Numbers, canonical decimal strings or in-range BigInts; it checks range before converting int8 strings. Relational room/receipt int8 fields and public receipt integers use it. This is not a general typed room/capsule encoder or validator.

Only SQLSTATE `40001` and `40P01` retry: at most two retries/three total attempts with the same immutable intent and a new supplied transaction each time. There are no sleeps, provider retries or retry on connection/ambiguous-commit failures. Exhaustion returns retryable `conflict`; other unknown failures become `unavailable` without SQL/private error details. A caller resolves a lost response with the same intent or authenticated lookup, never an automatically generated command/room.

## Focused evidence and remaining gates

Command: `node --test --test-concurrency=1 tests/integration/listening-v2-receipt-store.test.js`, Node `v24.14.1`, installed PGlite `0.5.8` dependency. The suite applies the actual existing migration once and uses one embedded connection with small synthetic auth/clock tables. It has **27 passing tests, zero failures/skips** on the current candidate.

Coverage includes equal/different semantic retries, action/room/actor namespaces, global create/restart conflict, fixed restart seed, expired-ticket replay after receipt deletion, commit-time deadline crossing, actual domain/event/outbox rollback on receipt-insert failure, auth/key/token revocation and ownership loss, SQL persona withdrawal/credential deadline denial without scrub, final-auth deadline crossing, default DB-clock query, missing/malformed trusted permits, environment isolation, retained-version lookup/missing-key refusal, immutable key-secret policy, copied key material, closed/expired rooms, durable roomless refusals, redacted-result refusal, reserved receipt quota, bounded synthetic serialization/deadlock retries and ambiguous connection refusal, exact int8 maximum/overflow and malformed raw input.

The first test invocation preceded the module and failed with `ERR_MODULE_NOT_FOUND`. Iteration also exposed two fixture assertions: the high-time overflow fixture first hit its credential deadline, and the final-deadline test initially counted only committed reducer calls despite an earlier rolled-back invocation. The corrected fixtures preserve the stronger assertions and all gateway authorization rules. Run logs and hashes belong in ignored `artifacts/sessions-v2-receipt-r1/`, not a status-only commit.

This is **single-connection embedded PostgreSQL/PGlite proof**, not multi-connection PostgreSQL, real App Attest/auth-store/lifecycle-hook, role/pool configuration, production clock/load/WAL/index, object deletion, provider, HTTP, packaging, native or deployment proof. The serialization SQLSTATE faults are injected after real SQL rollback work; they do not create actual concurrent serialization/deadlock races. Key-before-room order is observed in the fixture; all real cross-feature scopes still need barrier/role review. Full/npm-ci gates, network/provider/native/install work were explicitly excluded from this worker. Root retains the actual PostgreSQL/full gates and publication; all enablement stays off.
