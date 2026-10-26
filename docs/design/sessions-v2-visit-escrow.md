# Sessions V2 finite visit escrow: pure domain handoff

Implementation candidate for Root to compile, test and review. No tests executed,
provider qualification, runtime verification, independent approval or delivery is
claimed by this worker. The approved architecture is unchanged.

R2 addresses source-review F1 (delayed Back ancestry) and F2 (execution ordinal
admission). The tests-only red candidate was sealed before source/doc changes;
its tests are identical to the final candidate's tests. Red/green execution and
fresh independent R2 review remain Root-owned, not worker evidence.

Authority: `docs/design/sessions-v2-architecture.md` at backend commit
`d7a6aa8ff2b20b4d1776276462db2aa1438ac793`, SHA256
`7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`.
The fungible-credit reference examples, Release predicate and observed ancestry
rules control this slice. This note defines a small implementation boundary, not
an amendment to the design or a provider capability grant.

## Boundary and invariant

`api/utils/listening-v2/visit-escrow.js` is synchronous, immutable and IO-free.
It imports only Node crypto and the accepted bounded JSON parser (whose pinned
dependency chain is pure protocol/tickets/errors). It does not import providers,
DB or auth; allocate random IDs; read clocks; dispatch calls; schedule jobs; or
perform room authorization. UUIDs and trusted time are supplied by the owning
transactional reducer. No planned path contains a future visit UUID.

The API supports one unsettled writer, one never-dispatched pending role and one
unaccepted inverse promise. Pending desired work is replaceable; an accepted
inverse is not. It deliberately refuses another control while a writer is
unsettled and another pending candidate while an inverse is accepted but not
dispatched. These are narrower scheduling choices within the sole-lane design.
There is no queue of multi-step operations: a caller must refuse a capability
requiring multiple independently reinstalling steps until an owner supplies
atomic sum-of-all-steps reservation. Do not split such acceptance into this API's
sequential reservations and claim the entire operation was prepaid.

Let C be `visits.length`, E be `remaining`, D/A be `pending.path.length` (desired
or accepted inverse), and I be `promise.plan.path.length`:

```
C + E + D/A + I <= 512
maximumVisitBytes = 192 * (C + E + D/A + I)
committedVisitEvents = C
reservedVisitEvents = E + D/A + I
```

Execution capacity is independently reserved, including for zero-length paths:

```
lastExecutionOrdinal + (pending !== null ? 1 : 0)
                     + (promise !== null ? 1 : 0) <= 1000
```

Every publish and trusted restore enforces both invariants. The active role has
already consumed its ordinal, which never returns on Release/cancel/End. Reserve
checks the complete replacement state atomically and returns `execution_capacity`
unchanged if it cannot fund all roles. At 998 a forward/inverse pair fits; at 999
only a single step fits; at 1000 no new step fits, even with an empty path. This
local counter is separate from the outer room's control/event/terminal budgets.
Dispatch transfers one pending reservation to the monotone assigned count;
accepting Undo transfers its promise reservation to pending without freeing it.
Replacement, qualified cancellation and closing an unaccepted promise release
only the corresponding unused roles. End closes the unaccepted promise while
retaining pending accepted work; expiry cannot reclaim an accepted inverse.

Every vector entry is counted, including duplicate slots, common prefixes and
equal recordings. There is no predecessor-token or recording deduplication.
`dispatch` adds the complete pending path to E, preserving all old E. An exact
new observation transfers one E credit to C. It cannot spend untouched I/D/A.
Release replaces E with the qualified residual length only if that length is
at most the current E. Thus the reference inequality `n + |R| <= |O| + |N|`
holds without enumerating predecessor combinations. No observations are omitted
to conceal an admitted hybrid.

`residual` retains the last qualified installed vector. Until a new Release, it
is a conservative provenance envelope, not a freshly sampled current playlist:
observations decrease E without modifying this vector. Missed starts get no
record or turn and free no credits by themselves. Release may also reconcile a
stable installed tail with no active writer, but requires the same explicit
terminal/writer-exclusion/residual evidence. The external adapter establishes
the actual residual at the bound observation sequence. A later natural advance
is covered by that sampled residual even when it was not observed yet.

## API and input shapes

All public functions return `{ok:true,...}` or `{ok:false,code,state}`. Creation
and restore refusals have `state:null`; reducer refusals return the exact input
state reference with no partial changes. Successful creation/reduction/restore
returns `{ok:true,state,accounting}`. State and descendants are frozen. Only
module-produced or restored state is accepted; fabricated objects/proxies are
rejected without reflection. Unknown fields, duplicate keys, unsafe numeric
tokens and invalid/case-aliased UUIDs refuse. UUIDs must be canonical lowercase;
slot identity is exact, not fuzzy matching.

`createVisitEscrow(rawInitJSON, rawTrustedEvidenceJSON)` accepts exactly
`{ledgerID,scopeID,residual}`. The two IDs are server-issued, non-PII UUIDs.
`residual` is an array of occurrence slots 0..99, length at most 512. This creates
zero observed records. It does not permit seeding an arbitrary observed count.
Include the adopted current occurrence in this initial budget if its first
observation is still to be committed; an already-recorded current visit is
excluded from subsequent remaining-start vectors.
Initialization qualification must already exist in the independent guard;
missing/legacy-quarantined guards cannot be initialized by calling this helper.

`reduceVisitEscrow(state, rawCommandJSON, rawTrustedEvidenceJSON?)` requires
`{expectedRevision,op,...}`. `expectedRevision` is the ledger revision, distinct
from queue, observation and transition revisions. The following table lists
all additional fields; there are no optional unknown fields. `null` is explicit.

| op | Additional fields | Effect |
| --- | --- | --- |
| `reserve` | `planID,path,replacePendingID,closePromiseID,inverse` | Replace only the named pending never-dispatched desired/control role; close only the named unaccepted promise atomically; install full new D plus I or refuse unchanged. With no predecessor those IDs are null. |
| `dispatch` | `planID` | Commit the may-have-been-sent state, merge the whole pending budget into E, assign the next execution ordinal, leave only one active writer. The caller commits this marker before IO. |
| `observe` | `observationSequence,visitID,occurrenceSlot,observedAtMS,startPositionMS,authorityEpoch,transitionRevision,executionOrdinal,kind,targetVisitID` | Append one exact newly confirmed start, consume one E credit and allocate its stable observed ordinal. |
| `progress` | `observationSequence,visitID` | Advance the last same-visit sample watermark; no history, turn, visit event or Undo invalidation. |
| `release` | `executionOrdinal,observationSequence,consumedVisits,residual,openUndoAtMS` | CAS exact latest ordinal, current sequence and total C; retain only the qualified installed residual and clear active uncertainty. Optionally open a confirmed reversible effect's Undo window. |
| `accept_undo` | `promiseID,nowMS` | Before the deadline, move the entire promise to nonreplaceable pending inverse work. No credit is released. |
| `close_undo` | `promiseID,reason,nowMS` | Close only the named unaccepted promise. Reason is `expired` (deadline reached) or trusted semantic `invalidated`. Never affects accepted inverse work. |
| `cancel` | `planID` | Cancel only a matching pending, provably never-dispatched role with writer-exclusion evidence. Preserve all active E. |
| `end` | none | Close unaccepted Undo, mark ended, retain E, active uncertainty, pending work and every record. Further reserve/dispatch refuse. |

`inverse` is null or exactly `{planID,path,preimageVisitID}`. Its preimage must be
the current committed visit at acceptance; dispatch of the forward control also
checks that preimage remains current. A nonempty inverse path begins with the
preimage occurrence and includes the entire frozen restored tail. An empty
inverse is allowed only for a separately qualified zero-start operation, such
as identity-preserving Pause Undo; it still has an execution role and terminal
allowance. All inverse/profile evidence is bound to the full acceptance command.

Internally, pending desired plans keep `preimageSlot:null`. R2 dispatch records
the then-current observed slot in the active desired plan (null only if no visit
exists). This preserves the existing path-only Back API with a frozen departure
instead of deriving it from later chronology. Reversible controls retain their
original acceptance preimage unchanged; the dispatch precondition does not rule
out a natural advance after send. No extra command fields or public wire changes
are introduced. The caller still owns the immutable control operation and its
actual endpoint/target binding; a desired vector alone is not evidence of Back.

`openUndoAtMS` is null or the trusted server time of qualified application.
Non-null requires the active source plan's still-funded promise, no pending
work, a current observed postimage and `confirmed_reversible_application`.
The deadline is exactly `openUndoAtMS + 8000`, with overflow refusal. Acceptance
at equality refuses. A later exact transition closes an open unaccepted promise;
progress does not. If source Release has `openUndoAtMS:null`, its unaccepted
promise closes as terminal without a confirmed reversible application. Release
after End cannot open Undo. No expiry timer is required inside this module.

End alone does not cancel pending work: the outer reducer can compose End and
`cancel` under the same transaction once it has the never-dispatched proof.
Already-sent work always remains quarantined, even when E has reached zero.
Late exact observations and qualified Release remain accepted after End.
This helper intentionally has no cleanup-dispatch or owner-handoff API.
An empty `active` field is not guard removal or ownership-release permission:
the installed tail can still be reserved in E and the independent guard still
has its own scope, ownership and retention obligations.

## Observation and ancestry contract

The occurrence table is owned by the room reducer: slots 0..99 never recycle and
resolve to exact immutable occurrence/recording metadata. The ledger neither
looks up a recording nor proves native/provider item mapping. The adapter must
distinguish an exact new start from same-visit progress and unknown identity.
Do not pass an ambiguous sample as `observe`; retain diagnostics separately.
Uncertain actor/provider causality alone must not suppress an exact admitted
start. `kind:'forward'` represents normal observed navigation when no proven
restart/Back/Undo ancestry applies, without claiming which request caused it.

Compact records follow the approved shape:

```
[visitUUID, occurrenceSlot, previousObservedSlotOrNull,
 backPredecessorSlotOrNull, observedAtMS, startPositionMS,
 authorityEpoch, transitionRevision, executionOrdinal, kindCode,
 [heart, fire, clap, laugh, microphone, teary_eyed]]
```

`kindCode` is 0 forward, 1 restart, 2 Back, 3 Undo. Previous is always the prior
committed ordinal; forward Back predecessor is that same ordinal. Known restart
and Back require a non-inverse active plan, its exact execution ordinal and
qualified profile. Restart must match the frozen dispatched departure's exact
occurrence and inherits that departure's Back predecessor, even when newer
chronological visits have arrived. Back requires that departure's Back target. That target's exact
observed UUID must resolve to the reported occurrence and the active path's first
occurrence. Back inherits the target's ancestry, even if newer chronological
visits have arrived since dispatch. Undo requires the active accepted inverse's frozen preimage target and
inherits that preimage's ancestry. `targetVisitID` is null for forward/restart
and the exact observed UUID for Back/Undo. No existing record is rewritten.

For Z-A-B-oldC with Back B->oldA dispatched, old C may be observed before the
Back lands. New A' keeps chronological previous C and Back predecessor Z from
old A; both C and A' remain separate committed visits. With no intervening C,
A' instead has chronological previous B and the same Back Z. The latest
record's Back predecessor must not retarget or reject an immutable dispatched
Back. A mismatched target, first path occurrence, ordinal, inverse role or absent
active plan refuses; neither an arbitrary old visit nor a false `kind:'back'`
claim supplies a control. The trusted `navigation_cause` assertion must establish
the exact start's causal mapping to that dispatched control. Structural checks
and matching hashes do not themselves prove provider causality.

For Z-A-B with restart B dispatched, old C may start before the restart lands.
New B' keeps chronological previous C and Back predecessor A from the frozen B.
An intervening forward start of the same occurrence is still a different visit;
its Back ancestry must not replace the dispatched departure. Restart and Back
share the frozen departure/path/ordinal checks and profile binding. Unknown or
mismatched control causality cannot be repaired by relabeling a proven restart
as forward. The trusted codec permits an earlier observed departure with the
stored occurrence/ancestry; it does not reconstruct or authenticate provider
causality after the active plan has been released.

The adapter chooses Back versus restart using the qualified position rule; this
module does not infer a three-second boundary from a guessed or stale sample.
For A-[missed B]-C, C points to observed A. For Z-A-B-UndoNext-A', A' has previous
B and Back Z. Cancellation/replacement cannot recycle those slots. Reaction
counters start at zero; this slice does not implement reaction mutation, actor
turn aggregation, recap projection or contribution/PII storage.

Observation sequence must strictly increase, except an identical last-sample
retry returns the same state. The digest includes the complete observation
payload, but excludes the reducer revision. A same-sequence altered sample or
older sequence refuses. Reusing a visit UUID for a new sample refuses; callers
use `progress` for the current visit. Durable command/challenge retry receipts
remain the outer reducer's responsibility. Restore retains the last digest;
this module does not retain an unbounded set of observation IDs.

## Trusted qualification envelope and obligations

Evidence is a separate raw JSON argument, never copied from a client payload:

```
{kind,ledgerID,scopeID,commandHash,profileHash,evidenceHash,assertions}
```

`commandHash` is lowercase SHA256 of the **exact UTF-8 raw command argument**,
including expectedRevision/observation watermark/count/path. It is an evidence
binding, not the protocol's canonical semantic command hash. `profileHash` and
`evidenceHash` are lowercase 64-character digests of retained immutable adapter
qualification and concrete evidence. This module checks shape, binding and
required assertions; it cannot authenticate the adapter, resolve those hashes
or establish their truth. Supplying a JSON assertion is not qualification.
The future trusted adapter must retain and verify those referenced bytes, and
must be unreachable through client-controlled evidence or checkpoint routes.

Required exact assertion sets (order is irrelevant, extras/duplicates refuse):

| kind | assertions |
| --- | --- |
| `initialize` | `initialized_scope`, `writer_fence`, `no_remaining_possible_writers`, `finite_exact_residual`, `room_event_byte_terminal_allowance` |
| `reserve` | `single_splice`, `finite_exact_paths`, `repeat_shuffle_autoplay_off`, `zero_start_when_empty`, `room_event_byte_terminal_allowance`; additionally `complete_inverse_and_terminal_allowance` when an inverse is promised |
| `dispatch` | `current_authority`, `no_intersecting_unsettled_writer`, `pre_send_fence` |
| `observe` | `fresh_exact_start`, `admitted_continuation`, `navigation_cause` |
| `progress` | `fresh_same_visit` |
| `release` | `no_remaining_possible_writers`, `qualified_terminal_or_neutralized`, `exact_installed_residual`; additionally `confirmed_reversible_application` when opening Undo |
| `cancel` | `no_remaining_possible_writers`, `provably_never_dispatched` |

Dispatch/cancel must use the pending role's exact profile; Release uses the
active profile, or the last qualified residual profile if no writer is active.
Back observations must use the active plan's exact profile. Other evidence
binds exact command/ledger/scope and its selected profile. The
adapter, not this scalar ledger, must qualify that profile and validate path
order/mapping and an observation's membership in an admitted continuation.

Root's later transactional/adapter owner must supply all of the following:

1. Initialized independent output guards, scope intersection/account-wide lane
   exclusion, minimum writer fencing, legacy predecessor coverage, current
   credentials/authority and exact immutable endpoint/body/claim/send identity.
   A missing guard, new room/token/epoch or repeated snapshot proves none of this.
2. A finite old-prefix/new-subsequence single-splice profile, including all-old
   followed by all-new after arbitrary delay. Disable repeat/shuffle/autoplay,
   retries/refills and unsupported identity/terminality cases before dispatch.
   Empty candidate vectors require qualified absence of new starts; UI labels
   such as Pause or cleanup are insufficient. No provider settlement time is
   assumed here and no provider profile is qualified by this handoff.
3. Exact fresh item/start/occurrence mapping, challenge/authority checks,
   observed causal ancestry when used, correct captured position and same-visit
   classification. Allocate the UUID only for the committed observation. Store
   diagnostic gaps separately without fabricated turns or dropped actual starts.
   For Back, bind `navigation_cause` to the retained control/body/ordinal, frozen
   preimage and exact historical target, including a delayed cutover after old
   natural starts. A matching occurrence or observed target alone is not causal
   proof; do not relabel a proven Back as unknown forward to bypass validation.
4. Release evidence excluding every possible old writer/callback/retry, plus
   qualified terminal completion/neutralization of all effects and the exact
   installed residual. A 2xx, timeout, lease expiry, worker stop, End, revoke or
   any number of snapshots alone is insufficient. Recompute settlement after
   an intervening observation; never recredit unobserved natural progress as
   committed history. Unsupported/lost terminal evidence retains quarantine
   indefinitely; this slice contains no recovery timeout or operator waiver.
5. One room/guard transaction for pending replace-vs-dispatch CAS, queue edits,
   original/inverse acceptance, all-ledger page writes, event/byte/terminal
   allowances, observation/turn updates, receipts and recap revisions. Persist
   `dispatch` before IO; a crash after its marker is already-sent. Closing a
   pending role must revoke all pre-send rights. Pure revisions are not DB locks.
6. Server-derived permission, authoritative clock and Undo validity/window,
   latest transition/epoch/occurrence bindings, no-op/application semantics and
   intervening path edits. No outward applied/Undo UI before the qualified
   observed postimage. Late observations after End update retained history and
   recap safely without restoring erased attribution or command authority.
7. Retention of the non-PII guard, E, effect/qualification references and needed
   observation truth across End, privacy deletion, room deletion, reconnect and
   output ownership changes. Serialize/retain this capsule before retiring a
   room; removing private recap material is not permission to release an output.

The envelope is intentionally a typed trusted assertion surface, not a generic
`release:true` switch. Its hashes provide exact references and CAS binding, not
cryptographic authorization. A later adapter remains a separately reviewed
trust boundary; this module alone must never enable a capability.

## Storage and safe arithmetic

Only exact safe nonnegative integers are accepted; position is at most
2^31-1, execution ordinal at most 1000, slots at most 99/511, counters at most
10000. Monotone revision/ordinal exhaustion and deadline overflow refuse. Every
record is checked for `UTF8(JSON.stringify(record)).length + 1 <= 192`. Safe
arithmetic and the funded cap keep the visit/event budgets integral.

The approved disjoint room arithmetic remains
`100*1024 + 512*192 + 16384 + 32768 + 4096 + 8192 = 262144` bytes. The ledger's
header (including vectors/proof references and framing allowance) is checked
against the 32768-byte executor slice, and against 16384 bytes for its internal
checkpoint chunk. Full room metadata/profile/control/event/terminal bounds
are **not** implemented here. In particular the caller must enforce
`committed_semantic + reserved_visit_transition + reserved_terminal <= 20000`
and all forward/inverse terminal/receipt/event allowances before acceptance.
The qualification assertion records this caller obligation; it is not an
independent measurement of the room encoder, PostgreSQL or actual event rows.

The complete history cannot fit in a 16 KiB command. There is deliberately no
API that reflects/stringifies an arbitrary caller state or parses a larger
external command. `encodeVisitEscrow(state)` returns `{ok:true,header,pages}`
of raw JSON **strings** from branded bounded state. It splits observed records
into pages of `floor((16384-64)/192)=85` rows: at most seven pages for 512 rows.
The 64-byte wrapper allowance covers `{offset,visits}`; 85 maximal records also
remain below the parser's 4096-node limit. These bounds derive from the approved
record allowance and existing parser, not a new guessed room/wire cap.

`restoreVisitEscrow(rawHeaderJSON, ...rawPagesJSON)` requires exactly the page
count/row lengths/offsets advertised by the header, bounded by 512 rows and
seven arguments. Every individual raw string passes `parseBoundedSessionJSON`
before reflection. Restoring validates record uniqueness, chronological links,
observed-only Back references, supported kind rules, integer/record/vector/role
bounds and the combined credit invariant. There is no omitted-record default or
history truncation. Root can retain these chunks in the room/guard transaction
without reparsing the entire compact ledger through an enlarged wire limit.
Do not expose restore as a network action: syntactic validation does not make
caller-supplied history/guards authoritative. The storage adapter must bind all
pages to one trusted ledger/scope/revision; this codec is not an anti-tamper log.

R2 restoration permits Back ancestry supported by an earlier observed preimage
and its observed Back target, rather than only the chronological predecessor's
target. The stored occurrence/Back-ancestry pair must match that historical
target. The compact 11-field/192-byte record remains unchanged and does not
persist a full control/target replay log; restore cannot independently recover
or authenticate causal attribution after an active effect is released. Trusted
storage must preserve that provenance externally and bind all checkpoint pages.

The internal version/field shapes stay unchanged; active desired preimage
semantics and ordinal admission are stricter as described above. R1 checkpoints
with an overcommitted ordinal budget now refuse `execution_capacity` intact.
An R1 active desired plan with a null preimage cannot authorize a Back by
guessing its departure from the newest visit. No migration/backfill, role
expiration, history deletion or cap increase is supplied; retain original bytes
for Root's integration review. This is an unshipped source candidate, not a
claim of compatibility with previously deployed persistent data.

## Authored verification and handoff

`tests/unit/listening-v2-visit-escrow.test.js` contains synthetic domain cases for
all old-prefix/new-subsequence continuations and every settlement split,
old B to qualified D then natural D, A-B-C-B, all-old then all-new, coalescing at
500, forward/inverse at 504, refusal at 508, natural 511 to 512, zero-start work
at 512, restart, missed B, Back/Undo preimage ancestry, late inverse after End,
deadline equality, stale settlement, refusal without mutation, qualified
cancellation, bounded restoration and hostile raw input. Synthetic assertions
do not prove provider continuation, terminality, real transaction atomicity,
writer fencing or deployment readiness.

Appended R2 cases cover the exact old Z-A-B-C then delayed Back A' trace, its
no-intervening positive control, independent persisted-record restoration,
round-trips before/after Release, false/mismatched controls/targets/ordinals and
evidence, duplicate-occurrence target identity and path-only dispatch ancestry.
Ordinal cases cover 998 forward+inverse through 1000, 999 pair refusal/single
acceptance, 1000 step refusal, replacement/cancellation, unaccepted expiry versus
accepted retention across expiry/End, and overcommitted checkpoint refusal.
Boundary setup uses explicitly trusted restoration fixtures for previously
settled queue edits that emitted no visits, not executed 999-operation receipts.

Worker authorization permits only `node --check` on the two new JS files.
The test suite is authored but unexecuted. Root owns compilation/test execution,
independent review, any integration changes, Full/main/publication and cleanup.
Source files remain untracked, unstaged and uncommitted. The ignored
`artifacts/sessions-v2-visit-escrow-r1/` directory remains byte-for-byte unchanged.
`artifacts/sessions-v2-visit-escrow-r2/` retains before/after manifests, a sealed
`red/` tests-only postimage/patch, complete final postimages, unapplied R1-relative
and new-file patches, syntax-only receipts and one handoff inventory.
