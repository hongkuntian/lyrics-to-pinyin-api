# Sessions V2 physical-install binding foundation

Source-only first R2 component on backend `fefc00d1cac8f49ddb84972cb7d4ed4b6394052f`. This pure component is unused. It adds no route, factory composition, enrollment flag, migration, query, provenance backfill or public DTO. Public V2/capabilities and live profile/guard/room capacity remain off/0. Root owns actual checks, review, composition and delivery.

Authority: approved full R5 app architecture SHA256 `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`; approved auth/output/terminal R2 plan SHA256 `d169891ee418cce32ce810d349a38640f1c67d8bd098102a58e585b8a5fedc5a`, especially section2.1. Root's separate approval certificate opens the design gate only. Its older b88 source inventory is historical; this component uses the assigned fef base. R1 stays retained unchanged.

## API and admission

`INSTALL_BINDING_VERSION = 1`. `createInstallBinding({policy})` returns a frozen object exposing only `deriveScope(rawTupleJSON)`. The constructor is synchronous and side-effect-free. It snapshots the explicit server AppAuth policy's audience, attestation environment and bundle strings, validates prefix, then excludes prefix from encoding. It reads no environment/configuration service, database, clock, principal or auth evidence. It neither freezes nor retains mutable caller configuration. Named configuration fields must be own enumerable data properties on a plain/null-prototype object; policy/array proxies, getters and sparse bundle arrays refuse without invoking them. Only named fields are consumed, with no general object canonicalization or eager configuration enumeration.

The declared predicates match `authPolicy`'s intended ASCII values: audience1..64 of `[A-Za-z0-9_-]`, environment exactly `development` or `production`, prefix exactly10 of `[A-Z0-9]`, nonempty bundle array with each1..128 of `[A-Za-z0-9.-]`. The constructor bounds that array to64 before indexing it. Case and spelling are exact; no trim, normalization, default or deployment-namespace substitution. The composer must supply an already selected server policy; this encoder does not reproduce `authPolicy`'s environment/deployment checks. Existing `auth-context.configuration` independently bounds its bundles to32; this unused helper's64 bound does not widen that consumer or authorize its wiring.

Input is a primitive raw JSON **string**, at most2048 UTF8 bytes including whitespace/escapes. Objects, proxies, string wrappers, buffers and all other preparsed inputs refuse before enumeration/property reads or parsing. Apply the string/byte cap before calling existing `parseBoundedSessionJSON`; retain its syntax, numeric-token, duplicate-key/escaped-alias, depth24 and node4096 rules. The stricter2KiB cap dominates the4096-node ceiling. This introduces no public protocol change. The parsed object has exactly `key_id`, `bundle_id`, `audience`, `environment`, all strings. Key order, JSON whitespace and valid JSON escapes are immaterial after decoding; decoded values are otherwise exact.

`key_id` is canonical **standard** base64:44 ASCII characters,43 alphabet characters followed by one `=`, decode length32, and reencode byte-for-byte equality. This rejects base64url, omitted/extra padding, whitespace and nonzero pad-bit aliases. Bundle must equal an entry in the captured policy; audience and environment must equal the captured policy. The environment is App Attest's stored environment, **not** `listening_v2`'s test/preview storage namespace.

Invalid/missing server policy throws existing `SessionV2Error('unavailable')` (503). Malformed/mismatching internal raw tuple throws existing `SessionV2Error('invalid_request')` (400). Errors contain the stable code only, with no raw tuple/key, policy value or underlying cause. This is an internal classification, not a new HTTP mapping: a future trusted resolver must classify missing/corrupt stored bindings as unavailable at its own boundary. The helper performs no authentication and cannot distinguish fabricated well-formed tuple text from genuine stored text.

## Exact R2 v1 frame

Encode UTF8 literal `lyrica.sessions.physical-install.v1`, followed by **one zero byte**. Then append each field below, each preceded by its unsigned32-bit big-endian **byte** length:

1. Decoded K32 bytes (length32, not the44-byte base64 text).
2. Exact UTF8 `bundle_id`.
3. Exact UTF8 `audience`.
4. Exact UTF8 App Attest `environment`.

Return **only** lowercase64-hex `SHA256(frame)`. No JSON framing, extra domain/version, App ID prefix, implicit delimiter or trailing byte. Deliberately exclude principal/userID, credential/source C, bearer, connection/epoch, provider/device and local mode. Returning-pair, receipt and provider HMAC domains stay unchanged.

Independent authoring vector: K `AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=`, bundle `com.test.Lyrica`, audience `test`, environment `development` has114-byte frame and scope `765a7e146db7177aad6de946fc3c76ab817d43ecc4caf44bfb494f03b9f5a456`. Unit tests contain full literal frames/digests, zero/FF K vectors and two different field-length vectors whose unframed metadata concatenation is identical. Expected bytes/hashes were authored with standard-library primitives, not evaluated application code.

## Source fit and authority limits

At the assigned base, `AppAuthStore.register` and `AccountStore.guest` persist the four fields in `public.app_attest_keys` after their verification seam. `verification.attest` checks App Attest identity/RP/environment through the pinned verifier. Actual `AccountStore.signIn` changes `user_id`, closes the source credential and deletes that key's app sessions; it leaves these four fields unchanged. A new assertion/session after each G→A→B move supplies actual current auth, but not new physical identity. `AppAuthStore.authenticate` returns only `{id,keyID,bundleID,credentialDigest}`; never reconstruct a verified captured tuple from that DTO alone. Ordinary same-C bearer replacement is distinct from source credential replacement. Distinct K is a distinct scope even for the same principal/C.

The021 schema stores the tuple but no binding-version provenance or install authority generation. Necessary031 indexes and033 privacy-controller epoch/bridge metadata do not add those facts. Computing the v1 digest **does not** mark an old row known, attest possession, enroll version1, establish locked capture/provenance, grant a permission receipt, transfer private history/audio authority, prove anonymous/public identity, physical hardware uniqueness or provider Release. K compromise/clone resistance belongs to actual attestation/assertion qualification. This is linkable pseudonymous lookup data: never return it in public/member DTOs or put it in general logs.

Later Root-owned composition must re-read and validate the actual locked tuple with genuine enrollment/capture provenance, retain its protected source anchor and bind the independent persisted authority generation in the existing ordered SQL transaction. Missing legacy provenance remains unknown/unavailable; no blind v1/033 upgrade. Scope collisions/incompatible full bindings must refuse there. No hash grants or substitutes for those predicates. Auth writers,034 SQL/terminal codec, output guards, shared send gate, enrollment and runtime remain separately owned; this component alters none of them or the existing PW-01/02/03 refusals.

## Authored tests and remaining proof

Unit tests cover exact independent binary vectors, concatenation ambiguity, domain/NUL/decoded-K lengths, every field difference, JSON order/escaped values/whitespace, prefix exclusion, policy snapshot and caller immutability, config bounds/accessors/proxies, canonical K aliases/lengths, metadata mismatch, raw byte/depth/width/duplicate/unknown/numeric/type/proxy guards and typed errors.

Integration tests use actual default-off `AppAuthStore`/`AccountStore` fixture registration, challenge consumption, assertions, sessions and stored rows. They author the real exact-bearer G→A→B sequence with a new session per move, same-C bearer renewal, real sibling K registration on C, source-C revocation and stored-owner checks. They cover schema absent and030/031/033 present with privacy construction omitted, assert unchanged provenance-column absence and empty V2 relations, and treat existing-key ACK as no fresh enrollment. Only external crypto/Apple identity is fixtured; SQL/auth responses and owner moves are actual method results. These tests do not create Sessions rooms/guards/capture or inspect another worker's candidate.

The author sealed both test snapshots before creating behavior code. They remain authored/unexecuted: no behavioral red, missing-export red run, green, PGlite/PostgreSQL, concurrency, provider, native or deployment proof is claimed. Only the three JS postimages receive `node --check` syntax receipts. Root must apply/review the exact four-new-file candidate and run affected/all required gates before any composition/delivery. No timeout, retry, assertion weakening or existing schema/factory/API change is proposed.
