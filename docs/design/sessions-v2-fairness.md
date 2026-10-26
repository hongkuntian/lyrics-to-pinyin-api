# Sessions V2 automatic upcoming ordering

This implements only the pure `fair(slots, turns, joins)` reference in [the approved architecture](sessions-v2-architecture.md#queue-fairness-history-reactions-and-presentation), lines 240–286. Architecture SHA-256 remains `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`. R5 design reviews passed at 92/92/91.5; these design approvals and the local model tests do not establish live Take turns, server/provider parity or deployment qualification. Runtime V2 remains off.

## Interface and boundary

```js
import {fair} from '../../api/utils/listening-v2/fairness.js';

const orderedOccurrenceIDs = fair(upcomingSlots, observedTurns, firstJoinOrdinals);
```

The three positional arguments are required. `upcomingSlots` is a dense ordinary Array of 0–100 plain objects (Object or null prototype), each with exactly these four own data properties:

| Property | Domain |
| --- | --- |
| `id` | Immutable occurrence UUID; distinct across all supplied slots |
| `contributorID` | Immutable contributor UUID associated with this occurrence, regardless of who moves it |
| `acceptanceSeq` | Unique nonnegative safe integer across all supplied slots, assigned by upstream serialized acceptance |
| `automatic` | Boolean; only `true` slots participate in fairness |

Both IDs use UUID version 1–8 and RFC variant syntax, case insensitive. Duplicate occurrence UUIDs include case aliases. Returned occurrence strings and internal contributor attribution preserve their exact input spelling. Each contributor must use one consistent UUID spelling across supplied slots; mixed case aliases of the same contributor refuse instead of splitting its pending ordinals. Both Maps use keys that exactly match those contributor strings, as in the reference; the helper does not rewrite them. No recording matching or substitution occurs.

`observedTurns` and `firstJoinOrdinals` must be native Maps supplied by the trusted server domain, read-only for this call. Map subclasses are accepted, but caller methods, getters and iterators are bypassed with captured intrinsic Map lookups. Plain objects, iterable entries, WeakMaps and proxies are not accepted as maps. No conversion or provider callback runs. `Object.freeze(map)` is not a mutation lock; upstream owns snapshot consistency and must not mutate these Maps during use.

For each distinct contributor with **automatic** items, `observedTurns` may omit an entry to mean zero; a present entry must be a nonnegative integer <=512. Its sum across consulted contributors must also be <=512. Each needed `firstJoinOrdinals` entry is required and must be a nonnegative safe integer. Zero is valid for every integer field. Equal join ordinals resolve by acceptance sequence, as in the reference. Unrelated map entries, including contributors with only fixed items, are not enumerated, copied or validated. The caller must establish the room-wide <=512 actual observed visit bound, including contributors absent from automatic upcoming. This helper cannot validate unseen history.

The return value is a fresh frozen Array of UUID strings, one per input slot. It has no references to caller objects. Slots, Maps, occurrence attribution and input order are never mutated. Empty and all-fixed arrays still require Maps but perform no contributor lookups. Invalid domain input throws `TypeError('Invalid fairness input')`, with no caller content in the message. This is a local programming contract, not a wire schema, HTTP refusal policy, authorization decision or substitute for the existing wire validator.

The helper rejects sparse/custom arrays, unknown string/symbol/nonenumerable fields, missing fields, accessors, proxies (including revoked proxies), invalid UUIDs, duplicate IDs/sequences, unsafe integers and nonboolean flags. It inspects own keys for strict array/slot shape and reads only own data descriptors; it does not copy arbitrary properties or traverse their values. Copying, sorting and result storage are limited to 100 four-field slots and <=100 contributor summaries. Map size does not affect lookup work: at most one intrinsic `has` and one `get` on counts, and one `get` on joins, per needed contributor. Ordering uses O(n log n) work after shape validation and O(n) retained storage.

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

## Local proof

Run from the backend checkout with built-in Node only:

```sh
node --check api/utils/listening-v2/fairness.js
node --check tests/unit/listening-v2-fairness.test.js
node --test tests/unit/listening-v2-fairness.test.js
```

Tests cover every approved worked example, rank ties, acceptance order, observed versus skipped/unobserved inputs, fixed pins, latest Play Next, another contributor's moved item, toggle composition, deterministic immutable output, empty/100/101 boundaries, strict hostile shapes and hook avoidance. A seeded 750-case comparison uses a direct tuple transcription of the approved reference and independently checks UUID permutation, automatic per-contributor acceptance order, fixed positions, determinism and unchanged inputs. These are local pure-model receipts only. The worker does not run the full npm gate, installation, network/provider/DB/native verification or deployment.
