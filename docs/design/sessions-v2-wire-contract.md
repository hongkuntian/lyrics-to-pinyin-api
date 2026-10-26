# Sessions V2 core wire contract

This is the first **core room-mutation foundation**, based on backend `b7d50aefd65776260fd4dae50d37180a246f83e8`. The approved [architecture](sessions-v2-architecture.md) remains immutable at SHA-256 `7d4bd6a6d6b8b6c7be2044a2be61c0fd7841c1ba77d9e982bd592e7d1a24f049`; the [implementation plan](sessions-v2-implementation-plan.md) owns the later checkpoints. This contract does not enable a route, capability, room, provider operation or execution lane. The existing V1 validator and runtime are unchanged.

The maintained artifacts are [the command schema](../../contracts/sessions-v2-command.schema.json), [committed positive and negative fixtures](../../contracts/sessions-v2-fixtures.json), and the production validator at `api/utils/listening-v2/protocol.js`. Fixtures use synthetic identifiers and opaque references, without authentication or provider access.

## Admission and immutable results

`validateCommand(rawJSON, {transportActor} = {})` accepts **raw JSON text only**. It first calls the existing `canonicalCommandHash` to enforce the 16,384-byte UTF-8 bound before parsing, decimal safe-integer numeric tokens before rounding/overwriting, and the existing depth/node/forbidden-key bounds. Fractions and exponents refuse even when JSON parsing would produce an integer. Every numeric source token must pass, including overwritten properties. Protocol validation additionally refuses duplicate object keys at any depth, including escaped aliases. Arrays/batches, preparsed objects, buffers and nonobject roots refuse. No object parser API or HTTP adapter is added. A future adapter must cap the actual input stream before accumulation, rather than trust Content-Length or serialize an unbounded parsed body.

The result is `{command, bodyHash}`. The wrapper, command and every nested value are deeply frozen. The exact validated parsed instance is hashed and retained; no caller-owned object is retained, and no normalization, default patch values or actor identity is inserted. UUIDs accept versions 1–8 with valid variant and either letter case; string spelling is preserved. JSON object key order and insignificant whitespace do not affect the semantic hash.

All refusals here use the existing `SessionV2Error('invalid_request')` (HTTP status 400, public code only). These helpers perform validation and exact comparison only. They neither authorize a command nor create receipts or verify opaque source/selection references. Successful validation promises no durable acceptance or playback effect.

## Envelope and supported mutations

All seven core actions require exactly:

```json
{
  "version": 2,
  "action": "queue.add",
  "sessionID": "11111111-1111-4111-8111-111111111111",
  "commandID": "22222222-2222-4222-8222-222222222222",
  "expected": {"queueRevision": 12},
  "payload": {"catalogSelectionID": "selection.synthetic.1", "placement": "end"}
}
```

Every object rejects unknown keys. Revisions/epochs are integers in `[0, 9007199254740991]`; booleans must be JSON booleans. UUID fields are required where listed. An opaque reference is 1–4,096 visible ASCII characters without whitespace; this is a syntax/size bound, not signature verification.

| Action | Exact `expected` keys | Exact `payload` keys |
| --- | --- | --- |
| `queue.add` | `queueRevision` | `catalogSelectionID`, `placement` = `next` / `end` |
| `queue.move` | `queueRevision` | `occurrenceID`, required `beforeOccurrenceID` = UUID / null (end) |
| `queue.remove` | `queueRevision` | `occurrenceID` |
| `settings.update` | `settingsRevision` | Nonempty patch containing any of `title`, `askBeforeJoin`, `takeTurns` |
| `reaction.send` | Empty object | `occurrenceID`, `visitID`, `transitionRevision`, `reactionSetRevision` = 1, `reactionID` |
| `transport.request` | `authorityEpoch`, `transitionRevision`, `queueRevision`, `occurrenceID`, `visitID` | Discriminated shapes below |
| `transport.undo` | `authorityEpoch`, `transitionRevision`, `occurrenceID`, `visitID` | `controlID` |

The architecture's Undo `expectedTransitionRevision`, `expectedOccurrenceID` and `expectedVisitID` are represented by `expected.transitionRevision`, `expected.occurrenceID` and `expected.visitID`. Undo admits neither `queueRevision` nor a hold proof. Reaction's current-visit bindings are carried in its payload, with an empty `expected` object. Later room transactions must check every binding against authoritative state; syntax alone cannot detect stale CAS values.

Settings titles contain nonblank text with at most 80 graphemes and 320 UTF-8 bytes. Controls (C0/C1), DEL, bidi embedding/override/isolate marks and directional marks refuse. Text is preserved, without trimming, Unicode normalization or HTML interpretation; future presentation must escape it.

## Transport shapes and server-derived classification

For `transport.request` only, the **server** must supply `transportActor: 'original_host' | 'guest'`, derived from authenticated installation and authoritative room state. Missing or unknown classification refuses. The command cannot supply actor ID, host Boolean, original-key claims or provider verbs. The classification only selects the wire shape: it does not prove membership, original-host rights or permission to execute. Future handlers must authenticate and recheck rights/state under the required locks; a caller-provided role must never be copied into this argument.

| `payload.op` | Allowed classification | Other required payload keys |
| --- | --- | --- |
| `start` | `original_host` | `targetOccurrenceID` |
| `adopt_current` | `original_host` | `sourceReference`, `origin` = `owned` / `following` |
| `resume` | `original_host` | None |
| `seek` | `original_host` | Integer `positionMS` in `[0, 86400000]` |
| `back`, `pause`, `next` | `original_host` | None: ordinary host tap |
| `back`, `pause`, `next` | `guest` | `holdProofVersion` = 1 |

Only `seek` accepts `positionMS`. Only guest back/pause/next accept a hold key; host taps refuse it. `start` alone accepts a target occurrence, and adoption alone accepts a source reference/origin. There is no toggle or arbitrary provider operation. Hold-proof syntax is not proof that a gesture occurred.

Occurrence and visit IDs must both be UUIDs, except that **both may be null for start/adopt only** to represent the pre-first-visit case. Mixed null/UUID pairs and nulls on resume/seek/back/pause/next/Undo/reaction refuse. The validator cannot know whether a first visit has occurred: the future room transaction must permit the null pair only before the first committed visit. Nonnull start bindings can describe the last ended visit; they do not authorize restarting an active one. Actual seek duration, exact target availability, capture MAC/expiry/ownership, current observation freshness, paused/playing state, Undo window/effect, capacity and execution authority remain domain checks. There is no request-supplied current duration or actor identity to trust.

## Exact shared recording descriptor

`validateRecordingDescriptor(rawJSON)` has the same bounded raw admission and returns a deeply frozen descriptor. The reusable schema lives at `$defs.recordingDescriptor`. It is a shared tuple for later catalog/selection/observation contracts, **not** an alternate recording payload for queue.add:

```json
{
  "provider": "appleMusic",
  "catalogID": "1234567890",
  "storefront": "us",
  "versionMetadata": {"title": "Exact song", "artist": "Exact artist", "album": "Studio version", "durationMS": 210000},
  "catalogRevision": 1
}
```

Provider is exactly `appleMusic` or `spotify`. Apple IDs are positive decimal **strings** of 1–20 digits without leading zero; Spotify IDs are exactly 22 ASCII base62 characters. URIs, numeric IDs and cross-provider ID forms refuse. Storefront is exactly two lowercase ASCII letters; catalogRevision is a nonnegative safe integer. These are wire syntax checks, not catalog or storefront availability claims.

Version metadata requires exactly title, artist, album and durationMS. Title/artist are nonblank; album may be empty. Title and album allow at most 300 Unicode code points / 1,200 UTF-8 bytes; artist at most 500 / 2,000 bytes. They use the same control/bidi refusal as settings text. Duration uses the existing listening-track range, integer 1,000–86,400,000 ms. These bounded snapshots do not establish a recording match by title or duration.

`sameRecordingDescriptor(leftRawJSON, rightRawJSON)` independently validates both raw inputs and compares **every** field: provider, catalogID, storefront, catalogRevision and all four versionMetadata values. Invalid input throws; a different valid tuple returns false. There is no case folding, Unicode normalization, metadata repair, version substitution, cross-provider matching, ISRC extension or fuzzy lookup. Repeated recordings will still require distinct server-allocated occurrences/visits in the later state model.

## Reaction vocabulary

Revision 1 is immutable in this exact picker order: `heart`, `fire`, `clap`, `laugh`, `microphone`, `teary_eyed`. Both the frozen `SESSION_V2_REACTION_SET` export and the fixture/schema reaction-set definition pin the sequence. Raw emoji or other IDs refuse. The payload binds occurrence, visit and transition revision; the future transaction must reject delayed A→B→Back-to-A reactions and count durable retries only once. No event batch, presentation or count mutation is implemented here.

## Hash and future durable key

For room mutations the semantic body hash is `canonicalCommandHash(JSON.stringify({version, action, sessionID, expected, payload}))` **after** admission/validation. It includes all the expected/CAS and payload fields and retains exact strings, including UUID spelling. `commandID` is mandatory but excluded from the semantic hash because it identifies the durable intent. Changing it describes a new intent, not an automatic retry. Server actor classification, authentication and caller identity are excluded; identity keys in the body refuse.

The future durable receipt key is `(environment, sessionID, principalID, verifiedKeyID, commandID)`, with environment/principal/key supplied by the server. Same key + same body hash must return the saved currently authorized receipt; same key + changed body hash must conflict. This module implements neither deduplication nor that transaction. Creation/restart ticket hashes have their separately reviewed semantics in `tickets.js`; these actions remain refused by this core validator.

## Schema checking and remaining contracts

The JSON Schema describes semantic values. Its `x-rawAdmission` annotation names the separate mandatory lexical boundary. Standard semantic validation cannot recover a fraction rounded by JSON.parse or a discarded duplicate key. `x-transportActor` is a server-context branch constraint, not a request property; a standard schema consumer that ignores it sees the host/guest shape union and cannot enforce the server role. `x-maxUTF8Bytes` and `x-maxGraphemes` supply limits JSON Schema's code-point maxLength cannot express. They are mandatory in production and in the scoped contract checker.

`tests/contracts/sessions-v2.test.js` interprets every validation keyword used here, including references, additionalProperties, required, numeric/string bounds, oneOf cardinality and the named extensions. It fails on unrecognized keywords and compares committed valid/invalid decisions with the actual production validator. It does not use or change the deliberately incomplete existing `schema-validator.js`. Independent unit cases exercise raw admission before parsing, a golden semantic hash, deep immutability, exact matching and transport distinctions. V1 envelopes and legacy/unknown fields are explicitly refused by the new V2 validator; existing V1 runtime coverage stays with Root's full gate.

Focused local command:

```sh
node --test tests/unit/listening-v2-raw-admission.test.js tests/unit/listening-v2-tickets.test.js tests/unit/listening-v2-protocol.test.js tests/contracts/sessions-v2.test.js
```

Root owns the full `npm test` gate, independent review, publication and deployment. Create/restart, host capture/authorization, execution/observation, admission, capability/response/snapshot/event envelopes, recap, privacy, handoff and batches are intentionally not specified or implemented by this core command schema. Unknown/unimplemented actions refuse. No capability-projection helper is exported and no authenticated discovery route exists; validator availability must never enable a capability. Auth, storage, receipt atomicity, real DB barriers, provider execution, deployment packaging, live qualification and native acceptance remain later checkpoints.
