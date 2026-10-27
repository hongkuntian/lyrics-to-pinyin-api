# Sessions V2 closed privacy storage codecs

Source candidate for redesign Root, based on backend `b88a1486fe0b5bc013ea7012695360aecbf61758`. This is a representation foundation for the disabled lifecycle composition, not lifecycle completion. Root must compose A+B, including real writers, first-retention, reads and processors. No public protocol, routes, tickets, HMACs, auth/liveness evaluator, SQL processor, erase implementation, migration registration, scheduler, provider/output action or capability is supplied here. Live retention capacity remains zero.

Root clarified reservation semantics in the retained `handoff/root-retention-clarification.md`: initial retention reserves exact-controller mandatory withdrawal; transfer separately preflights its actual target before source auth mutation. This clarification leaves the frozen plan and interface source bytes unchanged.

Authority: approved architecture SHA256 `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`; lifecycle plan R2 SHA256 `f745e92b644ba09ccf121406fc459d99cdb4ca0d2345907a4816dee9e349841d`; Root interface R1 SHA256 `19b58796ebadc21d71dadb87b342430bcaa90be72a9da45f9432ffabe32a3252`. Historical 030/031/032 and shared parser/ticket code are unchanged.

## API and returned values

The module exports exactly seven names. All errors are existing `SessionV2Error('invalid_request')` with status 400 and no input values, SQL, private identity, diagnostic payload or nested cause. Decoding never treats a valid representation as authorization.

- `decodePrivacyUInt(value)` accepts a primitive canonical PostgreSQL decimal string, a nonnegative bigint, or a safe nonnegative number, in `[0,9007199254740991]`. It returns an exact number. Decimal strings have no leading zero except `0`, sign, whitespace, decimal point or exponent. Numeric negative zero refuses. Objects, boxed values, Buffers and proxies are not coerced or reflected. The string length is checked before regex/conversion; bigint is compared before conversion. This scalar adapter is for trusted SQL int8 rows. Raw JSON uints must already be actual safe numbers; numeric strings inside JSON refuse.
- `decodePersonaTuple(rawJSON,{reserveFuture:false})` takes the exact raw eighteen-value array described below. The deeply frozen return has eighteen explicit snake_case SQL field properties, a detached frozen `tuple`, `normalizedBytes`, and `futureNormalizedBytes`. The last property is `null` unless future reservation was requested. With reservation, both current and conservative future byte requirements must fit 512 or decoding refuses. The separate in-process reserve option is a boolean data property; proxies and accessors refuse without invoking traps/getters. No arbitrary object storage-input API exists.
- `decodePrivacyDependency(rawJSON)` takes EXACT031's object, returning deeply frozen `{payload,normalizedBytes,futureNormalizedBytes}`. Both current and worst-cursor byte requirements must fit 512. Future size replaces only the cursor, exactly as 031 does; it does not invent new timestamp growth policy for an already enqueued job.
- `decodePrivacyScrub(rawJSON)` takes the exact scrub object below, returning deeply frozen `{payload,normalizedBytes}`. The current normalized payload must fit 4096.
- `privacyScrubMarker(jobID,phase)` returns only `p2:<lowercaseUUID>:<phaseCode>`. A marker is a compact job/phase mirror, not a claim, full cursor, authentication result or proof of completion.
- `PRIVACY_CODEC_FIELDS` is deeply frozen and has `personaTuple`, `dependency` and `scrub` arrays with exact field order/names. It does not supply dynamic field selection or SQL.
- `PRIVACY_CODEC_LIMITS` is frozen: `rawBytes:16384`, `parserNodes:4096`, `parserDepth:24`, `personaWrapperBytes:10`, `personaBytes:512`, `dependencyBytes:512`, `scrubBytes:4096`, `markerBytes:41`, `markerColumnBytes:96`, `identifierBytes:160`, `environmentBytes:128`, `maxUInt:9007199254740991`, `guestLifetimeMS:7776000000`, `scrubIntervalMS:86400000`, `eventSeqMax:30001`. These are representation limits, not service/IO/capacity claims.

## Raw boundary and shared parser restriction

All three storage decoders reject non-string input using `typeof` before property access, Buffer inspection, serialization, enumeration or reflection. Raw UTF-8 bytes and UTF-16 code units are capped at 16,384 before further processing. Every accepted representation goes through the existing `parseBoundedSessionJSON`. It enforces the shared numeric source-token, node, depth, canonical byte and duplicate-key/escaped-alias rules, including numeric tokens in overwritten fields. Fractions/exponents that could round to integers are refused before JSON.parse. Duplicate keys and forbidden prototype names remain refused.

At b88, `canonicalCommandHash`, which the shared parser calls, **requires an object root**. Passing an array to it directly always refuses. The persona decoder therefore encloses the already byte-bounded raw array text in a constant internal `{"tuple":...}` object and calls the existing parser before inspecting any value. It then requires that internal object's sole key to be `tuple` and the parsed value to be an eighteen-element array. This does not change the caller's raw-array contract and cannot admit a second injected property or a duplicate escaped alias. No alternate JSON parser is introduced.

The wrapper consumes ten raw/canonical bytes, one root node and one additional depth level. Consequently an otherwise 16,384-byte standalone array cannot use the entire raw limit after wrapping: the internal parser's same 16,384-byte cap also applies. A valid <=512-byte normalized persona is far below the canonical/node/depth limits (one object root, one array and eighteen scalar nodes; maximum depth two). Excess whitespace near the raw limit can still refuse. That is a stricter raw-admission edge, not a reason to edit protocol.js or tickets.js. All dependency and scrub shapes fit the shared limits without wrapping. Tests include excess nodes/depth and attempted wrapper injection; they are not execution receipts.

After shared admission, all strings and object keys are checked for NUL and unpaired UTF-16 surrogates, which PostgreSQL UTF-8 text/jsonb cannot store. Valid surrogate pairs remain exact. No trimming, Unicode normalization, case conversion, Date parsing, identifier truncation or controller substitution occurs. Identity controls use C0/C1/DEL refusal; dependency principal selectors also refuse Unicode White_Space. Root's actual PostgreSQL differential must include non-ASCII POSIX-class cases under the qualification database's collation/ctype, rather than assume locale equivalence from JavaScript.

## Persona tuple, snapshot checks and reserved future

Exact order:

`[environment, persona_id, original_principal_id, original_key_id, controller_kind, controller_principal_id, controller_key_id, privacy_generation, status, guest_credential_digest, guest_credential_expires_at_ms, withdrawn_at_ms, scrub_due_at_ms, scrub_cursor, created_at_ms, updated_at_ms, controller_privacy_epoch, private_transfer_from_generation]`

The same 512-byte count includes **all eighteen** fields. Fields are neither omitted when null nor shortened to make a row fit.

Environment is exactly `production`, `development`, `test`, or `preview:[A-Za-z0-9][A-Za-z0-9._-]{0,119}`. UUIDs are lowercase structural `8-4-4-4-12` hex, including all-zero/all-f UUIDs admitted by SQL spelling; no extra RFC version/variant bits are required. Digests are exactly 64 lowercase hex. Original and nonnull controller identifiers retain their complete 1–160 UTF-8 bytes with no control characters. This is 030's identifier representation, not a claim that an original key is an authenticated App Attest key. The dependency selector's physical-key spelling is checked separately.

Controller kind is `guest`, `apple`, or `erased`; status is `live`, `withdrawn`, or `erased`. The original 030 shape is preserved, including that terminal status by itself does not require `controller_kind='erased'`:

- Guest controller principal/key equal the immutable original tuple. Digest and expiry are present; expiry is after creation and at most 7,776,000,000ms later. Captured epoch is zero; bridge is null.
- Apple controller principal is present; controller key and guest dependencies are null. Direct/legacy Apple rows may have null bridge. No historical bridge is fabricated for them.
- Erased controller requires erased status and null controller/dependency fields. A retained transfer bridge/captured epoch may remain; clearing them is not inferred from redaction.
- All uints have exact safe representation. Updated time is at least creation. Live status has null withdrawal/due/marker. Terminal status has nonnull withdrawal/due with due in the inclusive withdrawal to withdrawal+86,400,000ms interval. Safe subtraction avoids addition overflow near MAX. Terminal marker may be null or the canonical compact spelling.
- A nonnull bridge is below current privacy generation and cannot belong to a guest. A live bridged Apple tuple is exactly bridge+1; after withdrawal, subsequent higher generations do not broaden that bridge.

These are snapshot constraints. Initial INSERT not fabricating a bridge, sole live guest→Apple CAS from actual old generation, captured target epoch equality, capture/bridge immutability, current controller rights, monotone user epoch and no resurrection require SQL OLD/NEW plus the real service transaction. A maliciously fabricated but well-shaped snapshot is not proof of those facts. The codec does not compare caller history, look up a controller, sample a clock or prove source-created <= job-created.

`reserveFuture:true` means **mandatory terminal withdrawal of the supplied exact identity/controller**, as clarified by Root. For a live tuple, it keeps environment, UUID, original principal/key, controller kind/principal/key, creation time, captured epoch, transfer bridge, and guest digest/expiry exact; reserves privacy generation at the checked exact `current+1`; changes status to withdrawn; reserves unknown future withdrawal/due/updated times at full safe-uint width and the complete 41-byte marker. The two maximum timestamp witnesses satisfy the inclusive withdrawal/deadline relation without addition overflow. A live generation at MAX refuses; MAX−1 can reserve its mandatory terminal MAX, with no promise of a later transfer. Decimal rollovers such as9→10 are counted exactly. The returned requirement is the maximum of current bytes and this terminal envelope, and it must be<=512.

For an already terminal tuple, original generation/withdrawal/due/controller/dependencies/capture/bridge remain exact. Reservation covers the existing representation plus full-width updated time and the complete progress marker. It does not invent another withdrawal, generation increment or controller change. Every later actual writer must check its own exact proposed postimage and any required next increment. This reserve is not a guarantee for arbitrary future mutations.

**One-time transfer has a separate actual-target admission dependency.** Under the real source/target anchors, Root's service must derive the live guest→Apple postimage using the actual target's complete principal ID, actual captured target epoch, bridge equal to the exact source generation, new privacy generation=source+1, and null guest controller-key/dependencies. Before **any source auth mutation**, decode that exact target tuple with `{reserveFuture:true}`. Refuse/defer the whole transfer if either its current tuple or mandatory terminal requirement exceeds512 or any required increment overflows. Only then can the real transaction authorize/CAS the sole transfer; a valid decoded target is not authority or permission to mutate source auth. No raw caller-selected target, replacement/truncation, borrowed controller, broad history bridge or unbounded identity assumption is permitted. The codec API needs no new argument: the same exact-tuple decoder handles both independently derived states.

Normal guest initial retention is therefore **not** required to reserve an unknown arbitrary160-byte Apple identity. The previous worker interpretation that did so was superseded by Root before consumer assignment; its old test seal/postimages remain in the ignored evidence, not in this candidate. A supplied42-byte Apple target can fit even when a different160-byte highly escaped target cannot. An independent minimal-identity witness has a current450-byte exact quote-only160-byte Apple tuple whose mandatory-withdrawal requirement is533, so transfer must refuse before source mutation. Another independent full-width bridge/capture witness is510 live→578 terminal. These demonstrate target-specific preflight, not global guest-retention unavailability. The revised sealed test exercises normal guest reserve, a42-byte actual target reserve, an oversize exact target refusal, guest MAX−1/ MAX and decimal rollover. Root owns actual PostgreSQL comparisons and real source-auth rollback/race qualification.

## Exact dependency envelope

`{version:2,environment,selector,cursor,invalidatedAtMS}` contains no extra/missing keys. Selector is exactly `{kind,value}` for `credential`, `guest-key`, `guest-user`, `apple-controller`, or exactly `{kind:'indexed-sweep'}`. Credential is 64 lowercase hex. Guest key matches `^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$`, retaining the exact canonical 32-byte base64 spelling. Guest-user/controller selector is 1–160 UTF-8 bytes without whitespace/controls. Sweep invalidation is null; targeted invalidation is an actual safe uint. Cursor is null or `[validEnvironment,lowercasePersonaUUID]`, with no requirement to match the coordinator environment because selection crosses namespaces.

Current bytes and bytes after replacing cursor by `[repeat('x',128),'ffffffff-ffff-ffff-ffff-ffffffffffff']` must both fit 512, exactly matching 031's size-only reservation expression. The literal x environment in this internal witness is not itself an admitted namespace. This future reservation may refuse a small current null-cursor envelope with an overly escaped selector.

The actual service must enforce payload environment equals row environment, fixed coordinator namespace, exact job key/UUID, references null, invalidation <= row creation, authentic timestamp provenance, row/selector/payload equality and all source-era/claim/CAS/final-publication obligations. Representation cannot establish them, and the codec deliberately admits a representable uint timestamp without inventing a row creation clock.

## Exact scrub envelope and compact marker

`{version:2,environment,personaID,privacyGeneration,withdrawnAtMS,scrubDueAtMS,phase,cursor}` contains no extra/missing keys and is normalized <=4096. It uses the same environment/UUID/uint/deadline rules. No PII, arbitrary claims, provider data, execution fields or strings posing as dates are accepted.

| Phase | Cursor, or null before the first page | Marker code |
| --- | --- | --- |
| rooms | session UUID | r |
| grants-host | grant UUID | h |
| grants-guest | grant UUID | g |
| grants-approver | grant UUID | a |
| events | `[sessionUUID,seq]`, SQL seq1–30001 | e |
| receipts | `[sessionUUID,principalBinding64hex,keyBinding64hex,commandUUID]` | c |
| assets | `[personaUUID,privacyGeneration,assetGeneration,assetUUID]` | o |
| complete | null only | x |

The assets persona and privacy generation exactly equal the payload's persona/generation; asset generation is a safe uint. All four receipt suffix fields survive verbatim, so the same command UUID under different principal/key bindings remains distinct. No suffix is hashed, truncated or substituted. Canonical `p2:<jobUUID>:<phaseCode>` is 41 ASCII bytes (43 JSON string bytes), below the existing 96-byte scalar bound. Full phase cursors live only in the scrub payload. A complete marker or phase does not prove that cleanup, object deletion, backups or claim work completed.

These closed shapes are substantially below 4096 even at maximal admitted cursor/namespace values. There is no valid padding/name/claim field that can approach the ceiling. Tests exercise maximal legal shapes and reject padding near/over4096 rather than invent a large arbitrary valid cursor.

## Normalized bytes and qualification boundary

Byte accounting encodes arrays with comma-space, objects with comma-space/colon-space, and admitted scalars with JSON.stringify, preserving UTF-8 and required JSON escaping. Object ordering affects no length. This is a Node-side logical text calculation, not physical storage/IO/latency. It must be compared to actual PostgreSQL `octet_length(jsonb::text)` on the admitted value classes before Root qualifies it. No tolerance, compact-JSON shortcut or estimate-as-runtime-proof is appropriate.

Unexecuted independent literal vectors in the sealed unit suite are guest tuple195 bytes, bridged Apple tuple131, indexed-sweep envelope117 and basic room scrub187. A separate string scanner inserts spaces outside quoted text for bounded reference comparisons; it does not call the production normalizer. Tests cover Unicode/escaping, the exact 512/513 aggregate edge, source numeric rounding/exponents, duplicate aliases, resource caps, frozen returns, all cursor phases, receipt binding collisions, safe uint/generation overflow, redacted errors and future reserves. These are authored expectations, not red/green results. Object literal key order in golden strings is for length only; PostgreSQL need not emit that order.

Root acceptance still requires the **exact sealed test bytes** first failing against b88, then passing with this postimage, affected/full hermetic checks, actual PostgreSQL JSONB text/locale differential, source+role review and real A+B composition. Include exact-controller guest/Apple mandatory reserves, the450→533 and510→578 target witnesses, and all eighteen fields in actual SQL measurements. Unit/source/syntax proof cannot replace SQL OLD/NEW invariants, user epoch checks, positive GuestLive, current auth, retention/withdrawal rights, receipts, claims, durable processing, scheduler/deletion deadline capacity or installation/publication evidence.
