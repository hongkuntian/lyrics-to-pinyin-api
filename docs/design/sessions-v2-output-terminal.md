# Sessions V2 output/terminal storage and raw codec, first slice

Source-only proposal for redesign Root at backend `fefc00d1cac8f49ddb84972cb7d4ed4b6394052f`. Migration034 is deliberately unregistered. SQL has not been executed by this author; tests have been authored and sealed before behavior, then syntax checked only. Root owns actual red/green, independent review, combined acceptance, registration, publication and deployment.

Authority: approved R5 SHA256 `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049` and auth/output/terminal R2 SHA256 `d169891ee418cce32ce810d349a38640f1c67d8bd098102a58e585b8a5fedc5a`. The fresh R2 approval record reports95.75/95/95.75, every category>=4 and zero findings, opening the design gate only. Historical pending headings remain historical. Root narrowed this first migration to the two representations below; it is not a complete R2 storage replacement.

## Public key metadata

`public.app_attest_keys.sessions_install_binding_version smallint NULL CHECK(value=1)` records known convention only. LegacyNULL stays unknown; no backfill, metadata reconstruction or NULL->1 UPDATE is allowed. `sessions_authority_generation listening_v2.safe_uint NOT NULL DEFAULT0` is a separate nondecreasing ownership fence, bounded0..9007199254740991. Neither field grants audio authority.

The invoker trigger fixes K/bundle/audience/attestation environment for every anchor, and fixes its binding-version value including unknownNULL. Known v1 INSERT validates canonical standard base64 for exactly32 K bytes (44 characters with canonical pad bits), bundle1..128 ASCII letters/digits/dot/hyphen, audience1..64 ASCII letters/digits/underscore/hyphen and attestation environment production/development. SQL does not verify attestation, challenge consumption, policy membership or key possession. Only a later actual qualified enrollment producer may set v1 after genuine attestation. Legacy register/ACK/guest/session/signIn/signOut/delete remain on NULL/0, including public-key/receipt scrub and sign counter updates.

Version1 anchor DELETE refuses without scanning guards or acquiring another lock. Unknown legacy anchors retain their previous deletion behavior. There is no provenance upgrader or anchor compactor. No runtime owner, revoked, public-key, credential or generation grant is added. Account's existing footprint is unchanged. The current writer-auth finalizer includes new fields in its stable `to_jsonb(k)` image, so unchanged NULL/0 images remain compatible. Later actual writers must replace that check with exact operation-specific new-field comparisons before intentional changes; silently excluding those fields is forbidden.

The disjoint install-binding worker's frozen API is `createInstallBinding({policy}).deriveScope(rawTupleJSON)`: SHA256 of exact UTF-8 `lyrica.sessions.physical-install.v1`, NUL, then uint32BE length plus bytes for decoded K32, bundle, audience and attestation environment. The lowercase64-hex scope is a lookup, not proof. This slice neither imports nor reads that worker's partial implementation and validates scope syntax only.

## Closed terminal payload

`parseTerminalPayload(rawJSON)` accepts a raw JSON string only and returns the exact deeply frozen payload. It exports `TERMINAL_PAYLOAD_VERSION=2` and `TERMINAL_PAYLOAD_MAX_BYTES=4096`. It rejects caller objects before reflection/coercion and checks4096 UTF-8 bytes before the unchanged `parseBoundedSessionJSON` duplicate/escaped-alias/raw-number/depth/node guards. There is no caller-object serializer, option, callback, SQL/provider call, source authority or normalization/defaulting API.

Exact payload keys are `{version:2,environment,selector,invalidatedAtMS,phase,cursor}` plus optional `repair`. Environment is the existing production/development/test or preview deployment grammar, at most128 ASCII/UTF-8 bytes. Phase is rooms or complete. Cursor is null or the full `[targetEnvironment,canonicalUUID]`; complete requires null. UUIDs use lowercase8-4-4-4-12 hex, matching storage rather than imposing a new version/variant restriction. Digests are exactly64 lowercase hex. Every numeric domain field is an exact nonnegative safe integer; raw JS negative zero, fractions and exponent spelling refuse.

Selectors are exactly one of:

- `{kind:'credential',value:actualCDigest}`.
- `{kind:'installation',value:physicalScope,bindingVersion:1,throughGeneration:g}`.
- `{kind:'private-transfer',targetEnvironment,personaID,fromGeneration,toGeneration}`, with `toGeneration=fromGeneration+1` safely.

Repair is exactly `{rootJobID,predecessorJobID,originalCreatedAtMS,originalRetryUntilMS,repairOrdinal}`; ordinal is1..MAX, original retry is between original creation and creation+24h, and invalidation does not follow original creation. At the row boundary original creation cannot follow this row's creation; a new job cannot be its own predecessor/root. The repair representation is runtime-only: an INSERT requires the role's already-existing outbox table UPDATE privilege. Account has INSERT-only columns and cannot use repair. This check distinguishes trusted role capabilities, not authorized repair/source proof. A future trusted store derives lineage from the exact locked predecessor and requires separate finite repair authorization.

`listening_v2.terminal_payload_valid(jsonb)` is the independent SQL shape predicate. Both implementations check current normalized bytes and a fixed maximum future postimage with128-byte cursor environment,36-byte UUID, maximum safe numeric widths and every repair field within4096. SQL `octet_length(jsonb::text)` is authoritative. All admitted strings here are tightly bounded ASCII, so private JS punctuation spacing has no Unicode/escaping normalization ambiguity. The SQL predicate cannot recover duplicate keys, escaped aliases or exponent spellings already erased by JSONB parsing; those lexical guards belong to raw JS. Unknown fields never disappear silently.

## Eighth-relation family and transition envelope

The existing outbox gains only kind `authority_terminal`; job key is exactly `authority-terminal:<job_id>`. Room, guard, persona, asset, privacy generation, guard revision and send ordinal references must all beNULL. Existing count0..10, safe epoch, nonce/lease, created<=due<=retry<=created+24h, completion/deletion and4096-byte constraints remain. States are pending/claimed/published/dead, never cancelled. Initial rows are pending/count0/epoch0/rooms; nonrepair cursor isnull. Repair can retain a prior rooms cursor.

Unique unfinished `(coordinator environment, exact selector JSONB)` covers pending, claimed and dead. Installation cutoff/private-transfer generations are inside the selector. Invalidation timestamp is excluded, so a newer timestamp cannot create a second unfinished credential era. Published/new-era eligibility still needs the actual producer's retained source anchors and no-resurrection/new-retention rules. INSERT privilege alone authenticates no selector.

The family-scoped invoker trigger obtains no cross-row data locks. It preserves kind/job identity, selector/cutoff/repair lineage, initial creation/retry and allNULL references. Due may only advance on a pending settlement within the existing original retry interval; claim/publication/death keep the observed due. Completion/deletion truth cannot change after terminalization. DELETE of new-family rows conservatively refuses pending a later reviewed compactor, including published predecessor evidence. Every old-family transition returns through the unchanged path.

| Transition | Row-local requirement |
| --- | --- |
| Due pending -> claimed | Before original retry; a<10; a+1 and epoch+1; nonce present; future lease<=retry. |
| Expired claimed -> new claimed | Old lease expired; retain its debit and add exactly one new debit/epoch, distinct current nonce; no live renewal. |
| Live claimed -> pending success | Same epoch, exactly a-1, clear claim, strictly larger full environment-C/UUID cursor, phase remains rooms. |
| Live claimed -> published success | Same epoch, exactly a-1, rooms->complete and cursor null, clear claim, terminal metadata. |
| Claimed -> pending failure | Retain exact a/epoch/payload, clear claim; a<10 and original retry remains. Expired claim can settle its already-charged debit once. |
| Exhaustion/deadline -> dead | No refund/reset; preserve payload/count/epoch; ten genuine failures or original retry reached. |
| Dead -> published predecessor handoff | State changes only; unchanged original payload/cursor/count/chronology/completion/deletion. No work reopens and no refund. |

In pending `a=f`; in live claimed `a=f+1`, with one provisional current debit. Live claimed10 may succeed to pending9 and later publish at9 after many pages. Ten genuine failures become dead. Unchanged cursor, stale epoch, silent source/chronology mutation or reopening cannot refund. The old privacy engine's cumulative count behavior, `claimScrub`, failure/dead replacement and all refusals remain unchanged.

Row-local permitted progress is not a semantic proof. The future actual store must discover/lock source and all earlier dependencies before room/result locks, with the job last. Every success needs a same-client full-envelope CAS of exact source/selector, payload/cursor, state, expected count, epoch, nonce, lease, original creation/due/retry and completion fields, plus fresh final DB time. Exact semantic room/events/receipts/credit effects and the one-debit refund commit together or all roll back. Final complete additionally requires the entire covered selector range and exhausted suffix rechecked under source/new-retention anchors. An unsupported room, earlier fresh incarnation or zero-progress poll does not refund. No full CAS or source proof can be inferred from UPDATE grants or the trigger.

Dead predecessor publication only reserves the representation for a future exact successor handoff; the trigger does not prove a successor exists. The later trusted store must atomically publish that predecessor, INSERT the exact authorized successor and transfer the unique unfinished slot, preserving original invalidation/deletion/overdue lineage. No generic mark-success function, public callback, SECURITY DEFINER or actual repair API exists here.

## Deferred gates and evidence

Root stages guard install/C bindings and indexes, canonical provider-account absence anchor, room active-install/C mirrors, nonempty runtime/history codec and returning approval-witness fields in a later additive migration only after their actual consumers are closed. This slice omits them. Also remaining: actual verified enrollment/capture and scope integration, writer-auth operation-specific field comparisons, auth closure producers, terminal store/semantic End/participation reducer, full-CAS refund/repair/source-era composition, retention compactor/scheduler and measured deadlines. No ninth relation or cap increase is proposed. No raw principal, bearer, arbitrary provider verb, End-success assertion or SQL appears in the payload.

PW-01/02/03 stay unchanged; publicV2 and all cohort activation remain off, live retained-profile capacity0. Semantic job completion is neither provider Release nor audio permission. Shared writer gating/bootstrap, provider terminal evidence, deployed roles/pools/queries, account/native capture and publication remain unqualified.

Tests authored before behavior cover raw closed vectors and traps, independent SQL/JS acceptance and actual normalized maximum widths, real030/031/032/033/034 DDL with eight relations and preserved checks/indexes/roles, legacy NULL/0 actual default-off auth paths with only external cryptography/Apple fixtures, syntactic seeded v1 anchors, role denials, manual fresh/expired/progress/failure/repair row states and stale full-row CAS. Expired claims are owner-seeded preimages with only this new trigger temporarily disabled, actual CHECKs retained. These fixtures are explicitly not real attestation, actual eleven-room semantic processing, multi-client PostgreSQL, provider or runtime qualification. This author ran only `node --check` on the three owned JS postimages; Root must execute all tests on the applied combined candidate without skips, retries, assertion weakening or timeout inflation.
