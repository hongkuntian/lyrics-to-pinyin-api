# Sessions V2 implementation checkpoints

Root opened the architecture implementation gate on 26 October 2026. The approved proposal remains immutable; its design-only header distinguishes it from this execution record. Implementation qualification and deployment enablement are separate gates.

| Independent R5 review | Score | Lowest category | Unresolved major/blocker |
| --- | --- | --- | --- |
| Security | 92/100 | 4.5/5 | None |
| Product parity | 92/100 | 4.5/5 | None |
| Operations | 91.5/100 | 4.5/5 | None |

All three reviewed commit `3fdbc2506436efc05fdb3222158c5986bc69b874` on identical bytes. Architecture SHA-256: `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`; review-register SHA-256: `b517418bcce07713aa0d86c709dbed5d949fdee5f64aa061bced815251bc3f19`. Root incorporated the two-doc changes as `88bc540e` and `d8e381a3`, preserving those file hashes. Each reviewer read the complete proposal, canonical records, prior findings and pinned backend sources, and executed the four reference blocks. These are design approvals, not runtime receipts.

## Sequence and ownership

1. **Explicit wire boundary and disabled capability discovery.** Root owns a backend checkout from freshly fetched main, separate from the primary checkout. Add strict V2 schemas, stable refusals, exact recording/occurrence/visit identifiers, ordered reaction vocabulary and hermetic contract fixtures before handler behavior. Keep live V1 DTOs strict. Capabilities remain unavailable until their implementation and qualification gates pass.
2. **Transactional state and privacy.** Add environment-scoped storage, idempotency/creation tickets, member/admission state, fairness and visit escrow, then output guards and credential-liveness withdrawal. Exercise transaction orderings with real PostgreSQL barriers in addition to deterministic models; do not rename model passes as DB proof. Preserve non-PII quarantine through erasure, End and rollback.
3. **Execution and delivery lanes.** Extend the existing durable Spotify broker and native Apple executor through the shared ownership protocol. Implement observations, expiry, guest hold/Undo, queue publication, reactions and recap settlement. Initialize legacy scopes only with the reviewed evidence predicate; unsupported uncertainty stays refused. Qualify emitted function/alias packaging, queues, NAT/WAF policy, latency and cost before enablement.
4. **App protocol and unprotected presentation.** Delegate independent typed client/reducer and presentation slices against committed backend fixtures. Root integrates them and runs combined native acceptance. Reuse the approved invite, People, pill, guest and recap surfaces; do not silently substitute V1 when Ask-on creation is unavailable.
5. **Protected player integration.** Wait for the prioritized lyric branch to land or an explicit sequencing agreement. Then rebase and wire the session button/pill, guest controls, reactions beside lyrics, queue names/Played and recap handoff in the actual player shapes. Retire Sing together in code and `STUDY_INTERACTION_SPEC.md` together. Never overwrite lyric rendering, timing, motion or interaction repairs.
6. **Qualified rollout and final milestone.** Run the backend hermetic gate, applicable app checkpoint and native scenarios, provider/account ownership/terminality checks, deployed packaging/WAF/load checks and final Full. Enable canaries only for qualified capabilities. Publish verified checkpoints to their respective mains, deliver the app's Sqim personal preview and clean up owned outputs. P45 TV stays excluded.

The app's first nonplayer redesign checkpoint is independent of V2 enablement. Its reusable Sessions interfaces do not establish live V2 parity. Remaining server/provider and protected-player work stays visible in the [parity matrix](redesign-parity-matrix.md).
