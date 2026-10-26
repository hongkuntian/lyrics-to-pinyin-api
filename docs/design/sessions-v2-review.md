# Sessions V2 architecture review

Architecture implementation is held until all three independent reviewers approve the same immutable revision with >=90/100 each, every weighted category >=4/5, and no unresolved blocker or major finding. Category weights: authorization/privacy 20, consistency/idempotency 20, playback authority/recovery 20, product fidelity 15, operations/cost 15, testability/rollout 10. A design approval does not establish implementation or runtime acceptance.

## Round 1

Proposal SHA-256: `934160ce95abc1c79fb98e4324900bee248402170956278844c6e29e2e85286e`. Backend reference: `9077a2e39d2fe9231a69cc530bdc24b136d928b6`. Reviewers verified proposal bytes before and after read-only review.

| Independent reviewer | Auth | Consistency | Playback | Fidelity | Operations | Tests | Weighted total | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Security requirements | 4 | 4 | 3 | 3.5 | 3.5 | 4.5 | 74 | Request changes |
| Operations requirements | 4.5 | 4 | 2 | 3 | 3 | 4.5 | 69 | Request changes |
| Parity audit | 4 | 3 | 2 | 3 | 3 | 4 | 62 | Request changes |

Accepted findings requiring revision:

1. **Major: Spotify authority regression.** Draft lines 25/127/198/216/243 prohibit the existing durable host-bound broker executor, although backend service tick and integration tests intentionally support it. Preserve one broker executor scoped to the host authorization, captured device/context and epoch; do not require a running host app or add a competing native Spotify controller. Apple Music retains its original-host native executor.
2. **Major: event capacity.** Draft lines 145/172/177 make routine progress durable without a quota-compatible rule. Two-second reports yield 14,400 events in eight hours, exceeding the stated 10,000+1,000 budget. Separate replaceable playback progress from semantic transition events; prove reaction saturation cannot prevent control settlement, admission, history or End.
3. **Major: Undo revision ambiguity.** Ordinary progress must not invalidate a reversible effect. Specify a semantic transport/transition revision distinct from observation sequence and state version; test several same-visit observations within the Undo window and invalidation on natural advance/intervening control/epoch change.
4. **Major: admission delivery mechanism.** Optional wakeup plus quiet 5/15-second polling cannot establish <=3-second foreground delivery. Select a concrete baseline mechanism and honest fallback latency before implementation.
5. **Clarify: policy and scope.** Resolve engineering choices (fair ordering/ties/manual overrides, bounded Undo, polling, storage/retention mechanics, toast dwell) using Root judgement. Do not ask the owner to approve routine engineering details. Include executable fairness pseudocode and off/on, concurrent add, removal/skip and manual override examples.
6. **Clarify: approved P41.** Six choices are now approved: ❤️ 🔥 👏 😂 🎤 🥹, in that order; glass capsule picker; sender-face float/fade; per-song recap totals. Specify stable wire IDs.
7. **Clarify: P33 faces.** Implement explicit setup/upload disclosure and consent, redacting absent photos without permanently downgrading the approved join card. Define private storage and revocation, separately from public recap name consent.
8. **Clarify: observation freshness.** Host monotonic timestamps alone cannot establish server-comparable sample age. Specify challenge/receipt anchoring and delayed sample rejection, including increasing sequences after suspension.

9. **Major: reaction visit binding.** Draft reaction.send accepts occurrenceID while totals bind visitID. A delayed reaction for A before A→B→Back-to-A must not credit the new visit. Bind current visit/transition revision and reject stale delivery.
10. **Major: receipt expiration.** Create/restart receipts retained only through end+30 days cannot guarantee old commands never create rooms after deletion. Specify durable tombstones or authenticated expiring command tickets, with replay tests after retention.

No architecture approval, backend implementation, native execution, deployment or publication is established by round 1.

## Round 2

Proposal SHA-256: `93f3749f5e52cafb0f9d8095db6b561d158b7d5f5cf3c11ada5c77744922136b`. All three independent readers verified unchanged bytes; all requested changes.

| Reviewer | Auth | Consistency | Playback | Fidelity | Operations | Tests | Weighted total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Security | 4.5 | 3.5 | 3.5 | 4 | 3.5 | 4.5 | 77.5 |
| Operations | 4.5 | 3.5 | 3.5 | 4 | 4 | 4.5 | 79 |
| Parity | 4.5 | 3.5 | 3.5 | 3.5 | 4 | 4.5 | 77.5 |

All ten round-one responses are coherent at design level except their capacity/delivery proofs need the following corrections. Qualification receipts remain required separately.

1. **Major: complete host transport inventory.** R2 lines 25/53/66-69/111/121/309 allow only Back/Pause/Next and empty create. Define original-host-only exact start/adopt-current, desired-playing=true Resume, and seek. A guest Pause followed by expired Undo must not disable the host Play button. Initial P31 following handoff must seed/adopt the exact current occurrence and position. Specify visit/turn behavior, permissions, epochs, idempotency and uncertain execution through the same native/broker lane.
2. **Major: visit capacity.** R2 lines 123/173/193/195-205 reserve event/receipt slots but not future observed visits. At visit 200 the next already-queued automatic transition or a valid Undo would exceed the bound. Reserve capacity for applied/desired automatic paths, accepted forward effects and available inverses before admitting capacity-consuming work. Keep old in-flight reservations until reconciliation; never omit real history or stop already-authorized audio merely to maintain a numeric bound. Include near-cap races and update event/storage arithmetic.
3. **Major: shared-NAT edge budget.** R2 lines 179/203 require 750 member polls/minute, or 1,050 including ten pending requesters, while pinned backend docs/APP_AUTH.md specifies 300 POST/minute/shared IP across /api/ including aliases. Specify a route-specific V2 edge/NAT policy or another concrete compatible delivery mechanism. Preserve V1/auth protection, installation budgets and alias coverage; test full room on one IP. Live firewall configuration remains uninspected.

Root accepts these findings. No backend runtime implementation is admitted by round 2.

## Round 3

Immutable proposal SHA-256: `e702844ca633f3d7fb687af404379d9514bdf27661cba4719657be9e50a627f7`. The following is the full retained R3 findings register, including scenarios and required resolutions, from `/Users/hongkuntian/.codex/lyra-workflow/evidence/redesign-parity-20261025/sessions-r3-review-findings.md` (preserved verbatim). No scores are changed and no finding is independently closed by the design author.

# Sessions architecture round 3 independent findings

Input SHA256 e702844ca633f3d7fb687af404379d9514bdf27661cba4719657be9e50a627f7. All three read the complete proposal/canonical source/prior responses and verified identical bytes before/after. All REQUEST CHANGES. Scores: security78 (auth3.5, consistency3.5, playback3.5, fidelity4.5, ops4.5, tests4.5); operations82 (auth4.5, consistency3.5, playback3.5, fidelity4.5, ops4.5, tests4.5); parity80.5 (auth4.5, consistency3.5, playback3.5, fidelity4, ops4.5, tests4.5). Weights20/20/20/15/15/10. Gate remains all three >=90, each category >=4 and no major/blocker.

1. MAJOR, all reviewers: future-visit exact-token union misses in-flight queue cutover hybrids. Lines208-234. Old A-B-C-D; dispatched candidate A-C-B-D. Old B starts after dispatch, then publication preserves B and establishes new remainder D (or A-B-C-B under an upcoming-only protocol). Old D token expects old C, candidate D expects candidate B with candidate C predecessor; neither covers old-B-to-D. Rebase-before-call does not exclude advancement after dispatch. At cap, token allocation cannot add the actual admitted hybrid. Detachment/excluding history is not a resolution for the service's own write. Specify a concrete cutover primitive ruling it out or capacity covering every reachable hybrid with event/bytes. Extend reference model through publication settlement and NEXT natural advance. A simpler fungible capacity-credit scheme independent of recording/predecessor identity may avoid combinatorial token paths, provided its conservative bound covers each permitted cutover and old uncertain writers retain reservations.
2. MAJOR parity/minor ops: planned ancestry versus observed Back ancestry. Lines208,226-236 and133. Observe A, miss B, observe C. C's planned predecessor B is not previous observed A; recycling B's slot can redirect retained Back reference. Separate planned transport order from stable observed navigation ancestry; no fabricated credit for B; preserve reference validity across slot reuse. Include A-[unobserved B]-C-Back and reuse test.
3. MAJOR operations: room-local uncertainty quarantine is insufficient across ownership changes. Lines111-115,150-152,229,339. S1 sends absolute Spotify operation to D, client times out, S1 ends. Explicit reconciliation or S2 on D starts, then old call lands. New epoch, stopped worker, fresh snapshot or confirmation tap cannot exclude an already-sent call. Define ONE release predicate applying to ordinary controls, cleanup and already-sent requests. Explicit reconciliation must satisfy it, not waive it. Persist quarantine at provider/target/connection scope across End/new rooms/new local owners; retain/refuse reacquisition when settlement/cancellation cannot be proven. Qualification later establishes whether a provider supports selected evidence; absence of runtime proof alone is not a design flaw.
4. MAJOR parity: P47 Play again/Start again need active-room boundary. Line341. Old recap playback cannot compete with current durable Spotify broker/uncertain cleanup. Active guest must leave before local audio; active host must End and meet same release predicate before new local/server ownership. End acceptance is not completed cleanup. Define idle, active guest, active host, ended-clean, ended-uncertain, other-account/provider/device cases with local generation and server CAS. Typed pending/refused until safe.
5. MAJOR security: actual guest-to-Apple principal move lifecycle. Pinned backend api/utils/membership/accounts.js71-105 moves SAME App Attest key K from guest G to Apple A, revokes credential and sessions; delete116-140 requires current Apple principal; existing scrub selected userID. G/K uploaded photo, gave prejoin/public-name consent, and owns contributions/grants/receipts. After K->A, who can revoke/delete G/K data? Account deletion A must not leave inaccessible old-persona PII. Define guest erasure, principal-move transaction hooks, old persona privacy-control authority or scrub policy, no audio authority transfer, returning-install identity consistency, and key-move/deletion/asset-read/receipt-read races. Inspect actual paths, do not guess account semantics. Other keys/principals must not inherit unrelated privacy rights.

Minor: docs/design/sessions-v2-review.md line3 says at least TWO but gate is ALL THREE. Fresh-enrollment NAT arithmetic must include accounts.js24-34 guest challenge10/min/IP application limiter as well as edge auth300/min/IP; enrollment delays already allowed.

Earlier resolutions accepted: retained Spotify durable broker, no native competitor; replaceable progress and semantic/event reserves; Undo semantic revision separate from progress; concrete2s foreground polling and honest target; engineering fairness/Back/host transport inventory; approved reactions/photos/freshness/visit binding/creation-ticket expiry; V2-only canonical+alias edge exception and downstream budgets. R2 visit proof remains open under findings1-2. New actual encoder/DB/provider/native/WAF/load proofs remain IMPLEMENTATION qualification, not an excuse for missing transition contracts. Backend remains untouched; no implementation admitted.

## Round 4 candidate response

R4 responses and reference specification are in `sessions-v2-architecture.md`, especially “Fungible capacity credits”, “Durable output quarantine”, “P47 ownership boundary”, “Actual account key moves” and the complete Round-3 response register. R1's ten findings and R2's three findings remain in this review register and have explicit retained responses in the architecture; the R3 token proof is superseded, not claimed accepted. R4 replaces future semantic visit IDs with operation-budget escrow, adds observed-only ancestry, applies one non-waivable Release predicate across output owners/rooms/cleanup, gates recap playback at Leave/End + release, and specifies the actual AccountStore transaction hook with historical privacy control and guest erasure. Minor all-three gate and guest10/min/IP arithmetic are corrected.

At R4 candidate handoff, no independent R4 score/verdict existed yet; Root was to distribute the same committed architecture bytes/hash and this complete register to **all three** reviewers. That historical handoff is superseded by the independent results below. Gate remains >=90 each, every category >=4/5, no unresolved major/blocker; no waiver or self-approval. Reference assertions are design checks only. Actual DB/encoder/provider/native/WAF/load qualification is future implementation work; backend/app/native changes remain held until clean architecture review. Root owns delivery; this worker supplies only an immutable local docs candidate.

## Round 4 independent results

Immutable architecture SHA-256: `15afacb6748a6a522ee22bb9b782cf3c04ff65f2074a3d07aec06ea0f9fba0cd`; docs candidate `0af79198febe10ad71250f0daf0c54057c8b042e`, source `/Users/hongkuntian/.t3/worktrees/Lyra/t3-7ad079c8`. These scores/findings were supplied by Root for this R5 revision; this worker has not started reviewers or assigned scores.

| Reviewer | Auth | Consistency | Playback | Fidelity | Operations | Tests | Weighted total | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Parity | 5 | 4.5 | 4.5 | 4.5 | 4.5 | 4.5 | 92 | Approve |
| Security | 3.5 | 4.5 | 4.5 | 4.5 | 4.5 | 4.5 | 86 | Request changes |
| Operations | 4.5 | 4.5 | 3.5 | 4.5 | 4 | 3.5 | 82.5 | Request changes |

Root reports all R1/R2 findings closed at design level and all five R3 responses accepted except the newly exposed lifecycle/bootstrap gaps below. Prior registers, source pointers, models and qualification requirements are preserved. The new majors keep implementation held; design acceptance does not qualify actual DB/provider/native/WAF/rollout behavior.

1. **MAJOR security R4-S1: guest privacy control after actual credential loss.** Retained key K cannot erase guest data after its actual90-day credential expires: privacy.erase requires a fresh normal session, while `AppAuthStore.credential()` rejects that expired token before session assertion. Shared credential case: G has K1 and K2 (`register` allows another key for the same G credential); K1 signs into Apple A, the existing account transaction revokes their shared credential, and narrow privacy transfer correctly moves only G/K1 to A. K2 then cannot obtain fresh sessions to erase G/K2. Delete A correctly excludes K2 and therefore cannot be the repair. Define narrowly scoped erasure authenticated by a real retained-key mechanism **or** automatic generation withdrawal/scrubbing on lost credential control. Do not transfer unrelated personas to A/B, do not transfer audio authority, and preserve output quarantine. Inspect immutable backend9077a2e `accounts.js65,96–102` and `app-auth/store.js18–21,46–61,69–75,87–94`. Add expiry/shared-revoke cases to asset/receipt/consent/late-upload races. Do not claim existing App Attest can authenticate a new privileged key-only erasure path.
2. **MAJOR operations M1: pre-ledger predecessor at first acquisition.** No output guard does not prove the first V2 acquisition is clean. V1 dispatches Play to D, its4-second HTTP call times out with unknown late effect; ledger deployment does not retroactively track that send. V2 captures D and the old Play then lands. Define uninitialized legacy scope separately from initialized idle. Fence old deployments, consumers and participating native writers; require qualified terminal evidence for every possible predecessor on an existing scope or prove a genuinely unused/disjoint scope. Otherwise refuse indefinitely. Preserve the rollback boundary. Inspect immutable backend9077a2e `listening/service.js68–72` and `listening/spotify.js23–27`. Add the exact **predeploy timeout→enablement→first V2→late legacy** regression, not only a ledgered V2 S1/S2 test.
3. **MINOR parity: Undo navigation ancestry.** For observed Z→A→B, UndoNext restores A as a **new visit**. Specify whether Back restores preimage navigation ancestry, justify the selected semantics against the existing contract, and add an assertion next to the observed-ancestry reference model. Keep chronological history distinct from Back navigation.

## Round 5 candidate response

R5 architecture SHA-256: `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`. This is a two-document candidate based on Root `c45fac48`, after cherry-picking immutable R4 as `febf3ea3`. R4 input hash was verified before edits from Git and the supplied absolute source; the backend was inspected only through `git show 9077a2e…` and remains clean at HEAD `d5d44d2ea35cbb2b9df2aa7e704813c8cd82ba22`.

R5 selects automatic guest-data withdrawal at underlying credential expiry/revocation, with all-audience liveness checks independent of scrub scheduling, same-transaction invalidation hooks and bounded indexed cleanup. G/K1 alone transfers to A while live; shared-C revocation withdraws G/K2 without transferring its rights or requiring K2 authentication. It distinguishes uninitialized/legacy-quarantined scope from initialized idle; qualified writer fencing plus complete predecessor terminality or proved genuinely unused/disjoint reach is required before the first write grant. Unknown legacy sends remain quarantined indefinitely through compatible rollback. UndoNext restores preimage navigation ancestry while recording a new chronological visit. The architecture's Round-4 response register maps each finding to the rule and required qualification.

Embedded fairness, capacity/bytes, observed ancestry, controller-selection, Release/P47 and new lifecycle/bootstrap reference assertions are design checks only. No backend/app/native implementation/tests, provider calls, independent reviews, publication or deployment occurred. Real auth/DB/role/deadline/scheduler, emitted packaging/WAF, provider/native identity/terminality and load/cost proof remain separate implementation qualification.

No independent R5 verdict/score exists. Root must distribute the same R5 architecture bytes/hash and this complete R1–R4 history to **all three** reviewers. Each must independently reach >=90 weighted total with every category >=4/5 and zero unresolved major/blocker; R4 parity approval does not carry over to changed bytes. Gate remains closed until that fresh review. Root owns review/integration/delivery; this worker supplies only an immutable local docs commit.
