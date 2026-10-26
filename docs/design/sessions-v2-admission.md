# Sessions V2 admission domain

Pure implementation of the admission/member-state portion of the approved [architecture](sessions-v2-architecture.md), SHA-256 `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`, and canonical Sessions P32–34/P40. Assigned base: `902b8e6b783678b73b7c810e7a1b93b1c38878bf`. Design approval is settled; this slice supplies source and focused executed proof, not live parity.

`api/utils/listening-v2/admission.js` has no database, routes, capabilities, network, provider or native operations. Existing V1 and the strict core V2 validator/schema remain unchanged. The local intent forms below are inputs for a forthcoming transaction service; they do not add actions to the published shared wire schema or enable a public endpoint.

## API

| Export | Input and result |
| --- | --- |
| `createAdmissionState(facts)` | Closed server facts `{environment, sessionID, nowMS, expiresAtMS, host, title}`. `host` contains `{install, persona, profile, memberID, scope}`. Creates a frozen slice with one original host, Ask=true, Take turns=false, zero request count and revisions, and invite generation 1. Maximum lifetime is eight hours. |
| `restoreAdmissionState(rawJSON)` | Hydrates the same slice from bounded JSON, validates closed shapes, identities, counters, ordinals, timestamps, host binding and capacity, then freezes/brands it. Never accepts a preparsed object. |
| `validateAdmissionCommand(rawJSON)` | Returns frozen `{command, bodyHash}`. Hash semantics match the core convention: protocol/action/room/expected/payload, excluding `commandID`. Does not authenticate or deduplicate. |
| `reduceAdmission(state, rawJSON, facts)` | Returns frozen `{state, result, effects}`. State must come from create/restore/this reducer. Server facts must be independently resolved and currently validated. |
| `expireAdmissions(state, nowMS)` | Server-clock pending-request sweep; returns the same result wrapper. Does not End the room, invalidate provider authority or release output guards. |
| `removeAdmissionMember(state, facts)` | Trusted lifecycle invalidation with `{nowMS, memberID, expectedLeaseVersion, reason}`. Reasons are `authorization_withdrawn` or `participation_closed`. Guest-only; no public kick/moderation action. Host invalidation belongs to the room End/fencing transaction. |
| `ADMISSION_LIMITS` | Frozen limits: pending 120,000 ms, denial cooldown 60,000 ms, 10 simultaneous pending, 25 lifetime members including host, 300 lifetime requests, 16,384 encoded slice bytes. |

Installation is exactly `{principalID,keyID,bundleID,audience,attestEnvironment}`; attestation environment is development/production. Persona references are `{id,generation}`. Server UUIDs/local UUID inputs use canonical lowercase UUID strings. Opaque identifiers/references are nonempty printable ASCII up to 160 bytes; reject oversize identities rather than truncate or hash-substitute them. Deployment environment uses migration 030's production/development/test or specific `preview:...` domain. `scope` and pair digest are lowercase SHA-256-sized server HMAC values, not identities selected by a client. This module does not compute or verify HMACs.

Profiles are resolved references `{reference,revision,roomConsentRevision,persona}`; room consent revision must be positive. No name, image bytes, URL, credential digest, bearer, resolve signing key or host lease secret is retained. Profile and consent references survive admission and are replaced from fresh resolved input on ordinary rejoin. The reducer verifies reference consistency; it cannot prove consent or privacy liveness.

Client-derived data enters only as raw JSON through `parseBoundedSessionJSON`: 16 KiB UTF-8 before parse/reflection, duplicate/escaped-alias rejection, source-number safety and inherited structural limits. Preparsed objects, buffers and proxies refuse before their properties are inspected. The HTTP adapter must independently bound its input stream before accumulation; serializing an unbounded `req.body` does not establish this boundary. Closed server fact validation rejects unknown fields, proxies and accessors. It is not an alternate network-input codec.

## Local intent forms

All forms have exactly `{version:2, action, sessionID, commandID, expected, payload}`. Invalid raw input throws content-free `SessionV2Error('invalid_request')`; invalid server-domain shapes throw content-free `TypeError`. Settings reuse the existing core validator, including its title/grapheme/bidi bounds.

| Action | Expected | Payload |
| --- | --- | --- |
| `admission.request` | `{}` | `{resolveTicket,profileReference,profileRevision,roomConsentRevision}` |
| `admission.decide` | `{requestVersion}` | `{requestID,decision:'approve'|'deny'}` |
| `admission.cancel` | `{requestVersion}` | `{requestID}` |
| `settings.update` | `{settingsRevision}` | Nonempty strict patch of `title`, `askBeforeJoin`, `takeTurns` |
| `leave` | `{memberLeaseVersion}` | `{}` |

The extra leave CAS is a local domain precondition protecting a rejoined membership from an old Leave intent. Root must carry that captured version in its forthcoming adapter contract rather than derive a new version for an old queued intent. This module does not widen the existing core schema.

Common server facts are `{nowMS,actor}` with optional `join`, `approval`, `terminal`, `grant`. `actor={install,persona,lease}`, where lease is null or `{memberID,version}`. These fields come from authenticated server state, never caller claims. Time must be a safe integer at least the slice's last mutation time. Current DB time after locks is the transaction service's responsibility.

For a new request, `join` is required:

```js
{
  requestID, memberID,                 // server allocated; existing ID for rejoin
  pair: {environment, hostScope, guestKeyID, digest},
  cooldownUntilMS,                     // current pair-scoped lookup; 0 if none
  resolve: {ticket, sessionID, environment, install, inviteGeneration,
            issuedAtMS, expiresAtMS},  // verified 60-second resolve authority
  profile: {reference, revision, roomConsentRevision, persona}
}
```

The resolve ticket must match this installation/room/environment/current invite generation, be issued no later than now and expire strictly after now. Pair key and host scope must match the verified requester key and immutable hosting installation scope. Profile/consent references must exactly match the bounded intent and current actor persona. Any mismatch refuses. Current active membership and duplicate live requests return their existing result without allocating another slot. A conflicting active same-key installation must be invalidated by the lifecycle transaction before joining under changed identity.

For a pending decision, `approval={memberID,pair,requester:{install,persona}}` is required, including for denial. It binds the locked target request to the currently resolved requester and host pair; requester identity is never taken from the deciding client. Every current active member can decide using its current membership lease. Only the exact original host can update settings. Nonmembers and stale lease/persona/install bindings refuse.

## Grant authority and terminal results

`grant` is absent, `{status:'unavailable'}`, or the closed value:

```js
{status:'available', pair, policyRevision, grantID, generation,
 grantStatus:'none'|'active'|'revoked'}
```

`none` requires generation 0 and a reserved server grant UUID. An available value means the transaction service has loaded the current host-scoped pair policy under the approved locks, resolved key-version continuity, and checked both sides' current controller/generation/credential liveness. The reducer validates structure and exact pair equality only. A caller-supplied `active` string is never grant authority.

Ask=true needs available grant lookup authority even when lookup finds no grant. Missing/unavailable authority returns explicit `unavailable`, without creating a request or downgrading Ask. A mismatched pair refuses. An active current grant admits immediately. None/revoked requires a pending request. Ask=false admits new requests without grant lookup or remembered-grant creation. Changing Ask never auto-admits an existing pending request. A known denial cooldown applies before either bypass.

Explicit approval also needs available grant **write** authority. It emits one `effects.grant` intent containing pair, grant UUID, expected policy/grant generations, next grant generation, host/guest/approver persona generations, approver member, room and request provenance. The service must CAS/upsert that grant in the same transaction as membership and the terminal result; failure rolls back everything. Deny/cancel/expiry/terminal losers/Ask=false/remembered bypass never issue a grant. Forget/revocation is external current pair policy: it changes future bypass, not existing membership. A later explicit approval can produce a new grant generation.

Only live pending requests live in the slice. Every terminal transition removes that slot and emits an internal `effects.terminals` record, scoped to environment and session, with request version 2, terminal status, installation/persona binding, pair digest, decision provenance, member/lease references if admitted, and server time. The transaction service must persist/reconstruct the winning terminal authority through its durable receipt model and supply a targeted `facts.terminal` for later losers. No terminal table, lookup/index implementation or receipt mutation is added here. These internal records are not public DTOs and must not be blindly stored as a <=512-byte receipt result; project the small `result.admission` summary and retain bindings using the store's validated representation and budgets.

When the target is already terminal, an authorized decider or the exact requester cancel gets the first terminal summary, never a second member/grant. An absent or wrongly scoped terminal fact returns `not_found`; no outcome is fabricated. An admitted terminal summary may refer to a lease subsequently left/removed, and is deliberately never returned as a current `result.member`. Current member rights always require the current active record and lease.

## Transition and capacity rules

- Pending request version is 1. First approval/deny/cancel/expiry wins at version 2. Expiry is inclusive at creation+120 seconds, clipped to room expiry. Due requests expire before a valid domain command; exact deadline approval loses. Sweep is idempotent.
- Ten pending slots are independent from 25 lifetime members. Pending creation may succeed at the member cap; approval checks membership capacity at commit. Independent `lifetimeMemberCount` survives future trusted privacy compaction of inactive records; new first-join ordinals use that counter rather than array length. Inactive members and cancelled/denied/expired requests never recycle lifetime counts. Every genuinely new request, including rejoin, spends one of 300 slots. Duplicate live/active requests spend none.
- Denial emits `effects.cooldown={pair,untilMS:now+60000}`. The service persists/checks it under the pair lock. Cancel emits no cooldown. Requester-only cancel never changes admitted membership; use explicit Leave.
- Join/leave/remove increment `membershipRevision` and the member's lease lifecycle; ordinary join starts at version 1, leave/remove advances to 2, same-install/persona rejoin advances to 3. Rejoin reuses member ID and first-join ordinal, requires fresh resolve/profile/consent, and consumes a new request. No trust bypass is fabricated from prior membership alone. Changed persona generation is refused; privacy lifecycle reconciliation must never revive a withdrawn generation by rewriting this slice.
- Settings advance only settings revision and state version. New/terminal requests advance state version. A sweep batch advances state version once; each due request has its own terminal version. State version is local to this admission projection; the enclosing room reducer must merge it into its authoritative room revisions/event watermark in the same transaction, not overwrite queue/transport state.
- Snapshots/effects are deeply frozen; reducer inputs are not mutated. Counter/lease/grant-generation overflow or encoded slice exhaustion returns unavailable with the original state and no effects. The slice reserves compact UTF-8 JSON plus ordinary normalized comma/colon spaces within 16 KiB. Count maxima are upper bounds; large valid identifiers may exhaust bytes earlier. Actual PostgreSQL encoding, surrounding room framing, privacy mirrors, receipts/events and combined room reservations remain independently required. Identity is never truncated.

`result.status` is accepted/refused/unavailable, with a stable error code for refusals. It describes a model decision only; acceptance is not a durable commit. Wrapper state/effects are internal and privacy-bearing. In particular a refusal can still carry pending expiry transitions; the service must commit **all** returned state/effects atomically or none. Invalid raw JSON/server facts do not produce such transitions. Never return the full wrapper to a client.

## Trusted obligations still outside this reducer

The service must perform real App Attest authentication, user/key/credential expiry/revocation and environment checks, persona `GuestLive` and privacy-generation joins for every referenced actor/requester/host/grant side, current room/profile consent, verified resolve MAC and invite generation, HMAC pair continuity, and current membership authorization under the approved lock order. This reducer does not implement a privacy hook, automatic credential-loss withdrawal, sign-in transfer, asset/recap/read ACL or erasure. Structural equality cannot prove credential liveness. Ordinary bearer renewal must not invalidate an unchanged live installation.

Actual database serialization/CAS, command-ID/hash dedupe and equal-body retry, unique server UUIDs, indexed winning-terminal lookup/retention, pair cooldown/rate buckets, grant Forget/update races, room-creation uniqueness, global/request budgets (including 3/min/install and 10/hour/host pair), reserved terminal receipts/events, event cursors, privacy mirrors, outbox, room End/expiry and rollback belong to the transaction service. A repeated command is not deduplicated by this reducer; it must be resolved through current-authorized durable receipts first. This slice has no database atomicity or concurrency receipt.

The original host identity/scope never changes through any reducer operation. A member lease version is a revocable participation CAS, not a transferable bearer or execution lease. Historical membership/returning trust grants no host privilege. Guest leave/remove/rejoin never transfers playback, OAuth, native/broker claims or output-guard ownership. Leave must be durably acknowledged before an external local-play handoff; this pure result is not that ACK. Original-host End/fencing and provider Release remain separate obligations.

## Focused qualification

```sh
node --test --test-concurrency=1 tests/unit/listening-v2-admission.test.js
```

The focused suite exercises byte bounds before reflection/parse, numeric overwrite/duplicate aliases, closed server facts, exact install/pair/profile bindings, unavailable grant authority, host and transitive guest permissions, Ask toggling, request/member/byte limits, deny/cancel/expiry, all terminal winner/loser pairs as serialized pure transitions, scoped terminal lookup, stale membership leases, leave/remove/rejoin, immutable original host and overflow rollback. It uses built-in Node only and no accounts, databases or network. These are deterministic pure-model orderings, not simultaneous PostgreSQL barrier tests. Root owns the combined full npm gate, immutable source review, integration, publication/deployment and all live qualification. Existing restored dependency/V1 minimatch mismatch is outside this slice.
