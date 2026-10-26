# Sessions V2 automatic upcoming ordering

This implements only the pure `fair(slots, turns, joins)` reference in [the approved architecture](sessions-v2-architecture.md#queue-fairness-history-reactions-and-presentation), lines 240–286. Architecture SHA-256 remains `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`. R5 design reviews passed at 92/92/91.5; these design approvals and the local model tests do not establish live Take turns, server/provider parity or deployment qualification. The helper is unwired; this work makes no Runtime V2 or Take turns parity claim.

## Interface and boundary

```js
import {fair} from '../../api/utils/listening-v2/fairness.js';

// Upstream constructs this bounded four-field projection from its locked room.
const rawSlotsJSON = '{"slots":[{"id":"00000000-0000-4000-8000-000000000001","contributorID":"00000000-0000-4000-8000-000000000101","acceptanceSeq":1,"automatic":true}]}';
const orderedOccurrenceIDs = fair(rawSlotsJSON, observedTurns, firstJoinOrdinals);
```

The three positional arguments are required. `rawSlotsJSON` must be a primitive string of at most **16 KiB UTF-8**, encoding exactly one JSON object with the single key `slots`. That value must be a dense Array of 0–100 objects, each with exactly these four fields:

| Property | Domain |
| --- | --- |
| `id` | Immutable occurrence UUID; distinct across all supplied slots |
| `contributorID` | Immutable contributor UUID associated with this occurrence, regardless of who moves it |
| `acceptanceSeq` | Unique nonnegative safe integer across all supplied slots, assigned by upstream serialized acceptance |
| `automatic` | Boolean; only `true` slots participate in fairness |

Both IDs use UUID version 1–8 and RFC variant syntax, case insensitive. Duplicate occurrence UUIDs include case aliases. Returned occurrence strings and internal contributor attribution preserve their exact input spelling. Each contributor must use one consistent UUID spelling across supplied slots; mixed case aliases of the same contributor refuse instead of splitting its pending ordinals. Both Maps use keys that exactly match those contributor strings, as in the reference; the helper does not rewrite them. No recording matching or substitution occurs.

`observedTurns` and `firstJoinOrdinals` must be native Maps supplied by the trusted server domain, read-only for this call. Map subclasses are accepted, but caller methods, getters and iterators are bypassed with captured intrinsic Map lookups. Plain objects, iterable entries, WeakMaps and proxies are not accepted as maps. No conversion or provider callback runs. `Object.freeze(map)` is not a mutation lock; upstream owns snapshot consistency and must not mutate these Maps during use.

For each distinct contributor with **automatic** items, `observedTurns` may omit an entry to mean zero; a present entry must be a nonnegative integer <=512. Its sum across consulted contributors must also be <=512. Each needed `firstJoinOrdinals` entry is required and must be a nonnegative safe integer. Zero is valid for every integer field. Equal join ordinals resolve by acceptance sequence, as in the reference. Unrelated map entries, including contributors with only fixed items, are not enumerated, copied or validated. The caller must establish the room-wide <=512 actual observed visit bound, including contributors absent from automatic upcoming. This helper cannot validate unseen history.

The return value is a fresh frozen Array of UUID strings, one per input slot. It has no references to caller objects. The raw string, Maps, occurrence attribution and supplied order are never mutated. Empty and all-fixed arrays still require Maps but perform no contributor lookups. Invalid domain input throws `TypeError('Invalid fairness input')`, with no caller content in the message. The adapter translates bounded-parser refusals into that same programming error; it does not leak the supplied data or expose the parser's protocol error as a new HTTP contract. This is a local programming contract, not a wire schema, HTTP refusal policy, authorization decision or substitute for the existing wire validator.

Admission reuses `parseBoundedSessionJSON` from `protocol.js`, the existing private `parseRaw` routine with only its name/export and two direct internal call sites changed. Its body and core command/recording validation are unchanged. It first calls the reviewed `canonicalCommandHash`: primitive-string, code-unit and UTF-8 byte checks precede `JSON.parse`, reflection and canonicalization; numeric source tokens must be decimal safe integers, and canonical depth/node limits remain 24/4096. The parser additionally refuses duplicate keys and escaped aliases before returning parsed data. Only then does fairness inspect the closed wrapper, slot count/fields, UUIDs, unique occurrence IDs/sequences, nonnegative safe ordinals and boolean flags. An escaped key spelling alone is allowed when it decodes to the required field; two spellings of one key are ambiguous and refuse.

As `rawSlotsJSON`, every preparsed array/object, boxed string, accessor-bearing value or proxy (including revoked proxies) refuses without caller property reads, reflection, iteration, coercion or serialization. Unknown JSON wrapper/slot fields refuse, including large property names. JSON has no symbol, nonenumerable or extra array properties; preparsed values carrying those properties refuse at admission instead of being sanitized into acceptance. There is no raw-object compatibility wrapper and no `JSON.stringify` of caller objects, Maps or room state inside `fair`.

All parsed data and eager key enumeration are bounded by the 16 KiB ingress cap. After admission, copying, sorting and result storage are limited to 100 four-field slots and <=100 contributor summaries. One hundred distinct slots with maximal 16-digit acceptance sequences and `automatic: false` serialize to **15,211 UTF-8 bytes**, within the cap. Map size does not affect lookup work: at most one intrinsic `has` and one `get` on counts, and one `get` on joins, per needed contributor. Ordering uses O(n log n) work after bounded admission and O(n) ordering storage. The shared parser also retains only byte/depth/node-bounded data.

Before any future wiring, the server must build only this bounded projection from a locked, domain-validated room and retain its own count/snapshot consistency. Serializing an unbounded caller object or complete room merely to feed this API would move the resource gap upstream. No HTTP stream admission, route, wire version, command schema, actor identity, authentication or authorization policy changes here.

## Exact reference ordering

1. Collect only automatic items and sort them by `acceptanceSeq`.
2. Assign each contributor's automatic items a one-based `pendingOrdinal` in that acceptance order. Fixed items do not consume a pending ordinal or imply an observed turn.
3. Rank by `(observedTurns + pendingOrdinal, firstJoinOrdinal, acceptanceSeq)` ascending.
4. Walk the supplied upcoming slots and fill only automatic positions from that ranking. Every fixed slot retains its exact position and UUID.

Projected turns can exceed 512: they include pending, unobserved items. Only the supplied actual observed counts have the 512 bound. No turn is authorized, allocated or incremented here. An accepted add, a skip, a missing observation, progress on the same visit and moving a pick earn no turn. A qualified confirmed visit, including an intentional replay/restart, is counted upstream against the original immutable contributor; the recomputation receives that updated count. Authorization, deduplication of observations and provenance of counts/joins remain upstream responsibilities.

## Upstream composition

These policies describe how the caller prepares upcoming inputs. They are illustrated by tests, not implemented as another queue reducer here.

| Accepted operation | Input preparation before optional recomputation |
| --- | --- |
| End add with Take turns on | Append a new occurrence with `automatic: true`; preserve its accepted contributor/sequence; call `fair` |
| End add with Take turns off | Append with `automatic: false`, preserving accepted order |
| Play Next | Insert at upcoming index 0 with `automatic: false`; latest accepted insertion wins the head, previous pins remain fixed |
| Drag | Move the selected occurrence to the chosen upcoming index and set its `automatic: false`; preserve its UUID, contributor and acceptance sequence |
| Toggle off | Preserve the current displayed upcoming order and set **all old automatic flags** to false |
| Toggle on | Preserve all existing fixed flags/order; only subsequent End adds become automatic |
| Remove | After upstream authorization removes the occurrence, recompute surviving automatic slots; an unobserved removal earns no turn |
| Qualified observed start | Upstream records/deduplicates the actual visit and credits the immutable contributor, excludes current/played from upcoming, then recomputes automatic slots with the updated counts |

Only upcoming items belong in this API. Current and played records never enter it and cannot be invented by it. Fixed items are exempt from automatic contributor acceptance ordering; their explicit overrides persist until played, removed or moved. Moving another person's item cannot transfer turn credit to the mover. Distinct occurrences of the same exact recording stay distinct UUIDs. The helper receives no provider/catalog metadata, does not fuzzy-match recordings, merge duplicates, infer history, expose names/photos or derive a privacy controller. Upstream must preserve exact recording authority and apply the architecture's privacy/generation rules to attribution and projections; immutable IDs are not permission to disclose withdrawn attribution.

Root owns store/auth/receipts, room locks, ownership/CAS, observation qualification, history and capacity reservations, provider-plan admission/application, full backend verification and delivery. Applying a returned permutation to room state or playback requires those upstream gates; a pure result is not queue acceptance or observed playback. This helper adds no route, capability, provider/DB interaction or runtime enablement.

## Resource finding and local proof

R1 candidate `9ab4397fff8c80403d85befc1579cc022ed825ec` had 40 passing fairness tests and the 750-case comparison, but its object API called `Reflect.ownKeys` before rejecting wide arrays/slots. Root's retained `artifacts/sessions-v2-fairness-r1/resource-probe.mjs` supplied a four-field slot with 20,000 extra properties and observed a **20,004-key allocation before TypeError**. The retained red log is `/Users/hongkuntian/.codex/lyra-workflow/evidence/redesign-parity-20261025/backend-fairness-resource-red.log`. This repeated the earlier raw-admission eager-enumeration failure pattern; no enabled HTTP exposure is claimed.

This repair is based on Root's guard-cleanup HEAD `2a5a68deac57a40ed05ecbac14d5b893c49b06dd`, after R1. It changes only `fairness.js`, its unit tests, this note and the parser's export/name in `protocol.js`; Root's three SQL paths remain outside worker scope. The core wire candidate was previously reviewed at `3b32e1ee379dbe74efef69bcb4e103f5f929a430`. A built-in Node exact-text comparison against the assigned HEAD confirmed that the entire protocol diff is the export/rename and its two direct uses, without a parser-body, schema or role change.

Actual local checks with Node **v24.14.1**, using built-ins and the existing checkout dependencies only:

```sh
node --check api/utils/listening-v2/fairness.js
node --check api/utils/listening-v2/protocol.js
node --check tests/unit/listening-v2-fairness.test.js
node --test tests/unit/listening-v2-fairness.test.js
node --test --test-concurrency=1 tests/unit/listening-v2-protocol.test.js tests/unit/listening-v2-raw-admission.test.js tests/unit/listening-v2-tickets.test.js tests/contracts/sessions-v2.test.js
node artifacts/sessions-v2-fairness-r1/resource-probe.mjs
git diff --check
```

- **47/47 fairness tests passed**, retaining all 40 R1 test intents, including all approved examples and **750 seeded reference/invariant comparisons**. Valid bounded fixtures use test-only server-like serialization. Object-specific hostile tests call the raw API directly so serialization cannot invoke their hooks or hide extra fields.
- **35/35 core wire, ticket, raw-admission and contract tests passed**, including unknown-field, numeric-source and duplicate-key refusals.
- Syntax and whitespace checks passed. The original Root resource probe now passes with **`allocatedKeyEnumeration: 0`** on the old object API.
- New raw tests cover the exact 16 KiB boundary and next byte; oversize UTF-8, escaped strings, wide JSON and large keys refusing before `JSON.parse`; bounded unknown wrapper/slot keys; array extras; duplicate/escaped aliases; preparsed accessors/proxies and reflection/serialization traps; unsafe integer source text; depth/node bounds; and the maximum-width valid 100-slot projection.
- Before the implementation change, the selected new tests reproduced both valid-raw refusal and preparsed reflection on the old implementation (2 failures, 1 pass). After repair the complete fairness suite passes. The 750-case comparison still checks UUID permutation, per-contributor acceptance order, fixed positions, determinism and unchanged inputs independently of validation.

These are focused local pure-helper/core-wire checks. The worker did not run `npm test`, `npm ci`, installs, live/network/provider/API/DB/native calls, publication or preview delivery. Root owns combined-candidate review, full backend gates, integration and publication. Runtime V2 enablement, auth/store/CAS composition, qualified observed visits, provider execution and Take turns runtime parity remain outside this helper's evidence.
