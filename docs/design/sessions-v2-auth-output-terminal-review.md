# Sessions auth/output/terminal R2 design approval

All three independent R2 reviews approve the exact frozen design triplet below. This register governs its current approval state; the snapshot retains its historical “pending” header and original artifact addresses unchanged. Approval permits implementation. It does not qualify runtime, deployment, provider terminality, or public activation.

| Committed frozen input | SHA-256 |
| --- | --- |
| [R2 plan](sessions-v2-auth-output-terminal-plan.md) | `d169891ee418cce32ce810d349a38640f1c67d8bd098102a58e585b8a5fedc5a` |
| [R2 pins](sessions-v2-auth-output-terminal-plan.pins.json) | `9b4bee73859119b2e8775cfe68aee74dea94acb029393a477f135f8cf4007395` |
| [R2 responses](sessions-v2-auth-output-terminal-plan-responses.json) | `bf575accfa32ca132ddee86d2e7a2fecee44bccaedd6cd7af96ed78134dc4f80` |

The committed copies preserve the reviewed bytes. Paths inside the frozen provenance files identify the original review inputs, not relocated runtime dependencies. The original retained inputs and complete read/hash certificates remain Root-owned evidence while implementation and qualification continue.

## Independent results

Weights are authorization/privacy20, consistency20, playback/recovery20, product15, operations15, tests/rollout10. The gate requires all three totals >=90, every category >=4/5, and no unresolved major/blocker on the same bytes.

| Reviewer | Authorization | Consistency | Playback | Product | Operations | Tests/rollout | Total /100 | Findings |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Security | 4.75 | 4.75 | 4.75 | 5 | 4.75 | 4.75 | 95.75 | None |
| Operations | 4.75 | 4.75 | 4.75 | 4.75 | 4.75 | 4.75 | 95 | None |
| Product parity | 4.75 | 4.75 | 4.75 | 5 | 4.75 | 4.75 | 95.75 | None |

| Review evidence | SHA-256 |
| --- | --- |
| `/Users/hongkuntian/.codex/lyra-workflow/evidence/redesign-parity-20261025/auth-output-terminal-plan-security-review-r2/report.md` | `d510652692394274e741c41c3471b8274e61278e4da210d1304b13386d3b977d` |
| `/Users/hongkuntian/.codex/lyra-workflow/evidence/redesign-parity-20261025/auth-output-terminal-plan-operations-review-r2/report.md` | `950fdb1ab2e6a6be6a98c5dab653414e62b289935a91aa57cbc8183ebcbccf8b` |
| `/Users/hongkuntian/.codex/lyra-workflow/evidence/redesign-parity-20261025/auth-output-terminal-plan-parity-review-r2/report.md` | `761d28bfab1159f879653df06433fbc998df20ee02d2118f8ec84d88eda96c34` |

## Finding resolution

R1 remains historically closed: security95 and parity95 approved, but operations89.75 reported OPS-01. It identified eleven ordinary retained rooms exhausting ten cumulative claim attempts despite successful processing. R2 independently closes this design gap for the new `authority_terminal` family: successful strict cursor/phase progress or final range-verified publication refunds exactly that current claim’s provisional debit in the same transaction; prior genuine failures, complete claim CAS, original deadlines and retained dead debt remain. Ten genuine failures still exhaust the allowance. The existing privacy engine is unchanged. Symbolic traces are authored requirements, not executed proof.

## Implementation boundary

The first implementation slice adds the physical-install encoder and additive public-key metadata/closed terminal-job representations. It preserves unknown legacy provenance, existing coarse PW-01/02/03 refusals, eight relations and all caps. Guard bindings and the canonical account anchor, room selection mirrors/nonempty authority codecs, approval witnesses, actual enrollment/capture, runtime terminal settlement and every shared provider writer remain required before the complete replacement is claimed. Staging metadata and job constraints alone establishes none of those behaviors.

Actual code must retain default-off/schema-absent behavior and be qualified against the current backend base and all participating consumers. No migration is registered or applied by this approval. Public V2 and live retained-profile capacity remain off/0. All A+B implementation/concurrency/role, C deployment/scheduler/provider/native, and the single Release predicate remain separate gates. No drawing, playback, native, provider or install result is inferred from the design scores.
