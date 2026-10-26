# Sessions V2 implementation

Architecture gate: three independent R5 approvals, 92/92/91.5, every category at least 4/5 and no unresolved major/blocker. The immutable [proposal](design/sessions-v2-architecture.md) has SHA-256 `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`. The [implementation sequence](design/sessions-v2-implementation-plan.md) distinguishes design approval from runtime qualification.

## Current boundary

This checkpoint adds server-only creation-ticket primitives. **No V2 HTTP route, capability, room, migration, worker or provider operation is enabled.** Existing V1 code is unchanged. It is a foundation, not Sessions parity or a deployed backend contract.

`api/utils/listening-v2/tickets.js` issues ten-minute HMAC-SHA256 tickets with server-allocated room/command UUIDs and a random nonce. The authenticated handler must derive the deployment, principal and verified App Attest key; callers cannot supply those authorities or choose expiry/UUIDs. Create and restart are separate intents; restart also binds the exact source recap revision.

The validated semantic intent hash excludes the creation ticket itself and the separately MAC-bound server UUIDs. It includes protocol/action, applicable expected revisions and payload. Object keys use lexical order (including numeric-looking keys); array order, exact integers and Unicode are preserved. Hashing refuses JSON values that would silently coerce/drop, non-plain objects, cycles and oversized/deep inputs. It streams into the digest after cumulative encoded-byte checks, including key names, escapes and punctuation, and collects only a width/byte-bounded key set before sorting. Hashing does not validate action rights or authorize execution.

`verify` is side-effect-free. It checks the signature, signing-key identity, exact context, fixed lifetime and server-clock validity before returning the immutable ticket payload. Unknown retired keys, altered bindings, future issuance and malformed encodings refuse; expiry returns `expired`. Verification does **not** consume a ticket or prevent replay by itself. The subsequent room/receipt transaction must enforce the reviewed unique keys, canonical-body conflict and current authorization/expiry checks. A lost result after expiry uses authenticated lookup; it never recreates the intent automatically.

Keys are server-only buffers with at least 256 bits of entropy, injected by the eventual runtime. Tests use fixed synthetic keys and clocks. No secret configuration is added in this checkpoint. Public errors expose stable codes without private state.

## Qualification

The unchanged fetched-main baseline passed `npm test`. The initial five ticket tests and full hermetic gate passed. Independent review then reproduced oversized-key and aggregate-escaping allocation before rejection. Three additional resource-bound regressions failed on that implementation and passed after streaming/bounded collection replaced whole-object serialization. Eight focused tests now cover allocation, intent/identity/environment binding, exact expiry, future issuance, rotation, tampering, restart revision and bounded canonical hashing. The revised full hermetic gate and fresh immutable source review must pass before publication. PostgreSQL receipt atomicity, auth integration, provider execution, scope initialization, deployed packaging/WAF and native behavior remain unimplemented or unqualified.
