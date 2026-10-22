# Language expansion preimplementation experiment

Research harness only. Root `698c1cc1-7143-4056-95b2-1ef5cdb05deb` owns corpus
adjudication, actual provider/account access, cumulative accounting, deployment
submission/recovery, independent output review and subsequent product decisions.
This milestone makes no provider calls, changes no production behavior, prompts,
policy, API, build configuration or deployment, and maintains no corpus. Authored
sources remain ignored until Root approves their exact hash. Commercial lyric
bodies do not belong in this experiment's maintained sources.

## Fixed experiment

The default `matrix728` contains 60 authored documents: six each for ja, ko, pt,
it, de, ru, vi, id and th; three each for hi and hi-Latn. Retained corpus array
order defines `docOrdinalWithinExactTag`; `globalTagIndex` follows that tag list.
Targets, in order, are en, fr, es, zh-Hans.

- 240 complete translations, every document into every target: 44 exact-tag
  directions, 40 nominal language-family directions.
- 240 original Study acceptance cases: 236 generations and four exact `ru-c`
  static refusals (`unsupported_selected_language`, actual selected tag `uk`).
- 248 translated Study cases. For every translation, explanation target index
  is `(docOrdinalWithinExactTag + targetIndex) % 4`. Each Hindi exact tag adds
  the four missing ordinal=3 target/explanation cells on its first document.
  This covers all 176 exact-source-tag × translated-target × explanation-target
  cells without claiming a population accuracy estimate.

`full1440` is an explicit optional plan mode with the full 960 translated Study
crossproduct (1,440 acceptance cases, at most 1,436 generations). It is not the
default acceptance requirement. The default has 728 cases and at most 724
generation jobs: 240 translations + 236 originals + 248 dependents. Failed
dependencies remain failures; no easier work replaces them.

The 33 Standard seed IDs are part of that same matrix: first document per exact
tag, translation target `globalTagIndex % 4`, original explanation target
`(globalTagIndex + 1) % 4`, and translated explanation target from the rotation
(first ordinal=0). Execute the 22 independent calls first, then the 11 dependent
calls. All families, both Hindi tags, all four outputs and both Study recipes
occur. Reuse the exact recovered results; never repeat the seed as extra calls.
Completed IDs cannot be admitted again. Registering the optional full plan
deduplicates identical job definitions and rejects changed source/body identities.

For every document, selection intent is declared before outputs. The original
selection is its exact authored occurrence/range. The dependent selection uses
the *same mapped occurrence*, selecting its complete translated row if it fits
the unchanged 80-grapheme production rule. An oversized, missing, invalid or
failed row is a retained dependent failure, not permission to select an easier
word. `snapshot().dependentFailures` reports these failures separately; their
worst-case reserves remain in the plan. No exact dependent body/range exists
until a valid parent translation is fully recovered.

## Source adapter and immutable inputs

Input is `{documents:[...]}` (or `{sources:[...]}`) with 60 unique document IDs.
Each source contains `id`, exact `language`, `lines`, and `selection`.
Lines may be strings or `{sourceID, order, text, utf8SHA256}`. Selection supplies
`sourceID` or zero-based `line`, `originalText`/`text`, and explicit `occurrence`
when wording repeats. An authored `range` additionally binds `startGrapheme`,
`endGrapheme`, `sourceUtf8SHA256`, `selectionUtf8SHA256`. All bounds are grapheme
indices, exclusive at the end, validated with production `selectionV2`.

The adapter uses existing `caseInput`/`makeDocument`. Author IDs such as ja-a:01
are **not** wire IDs. It retains both directions of the mapping to production
document-local L0001 IDs, in retained order, with source/lyric UTF-8 byte hashes.
Every job and result carries immutable `sourceDefinitionHash` and `definitionHash`,
plus qualification metadata; every result carries `sourceBindings` and its exact selection. Source bytes,
declared hashes/order and authored ranges must match. This does not assert that
authored language labels, glosses or readings have passed linguistic review.

The curated profile keeps the exact ja/ko/pt/it/de/ru/vi/id/th a–f IDs and Hindi
hi-b/d/f (`hi`) and hi-a/c/e (`hi-Latn`), in their retained within-tag order.
`preparePlan` requires the curated `routing-manifest.json` and its explicit
approved parsed-JSON hash as well as the approved corpus hash. It validates all
ten exact c controls, their family/exact/effective tags, dispositions and exact
selection bytes/bindings against each source's `effectiveSelectionLanguage` and
`selectionRouting`. This is a fixed definition, never an arbitrary exclusion list.

Only the four `ru-c--original--{en,fr,es,zh-Hans}` entries are `static_refusal`.
`snapshot().staticRefusals` derives their separate immutable receipts, with
`providerCalled:false`, actual/accounted cost 0, selected language uk and exact
bindings. They do not enter `results` or unknown states and have no provider body.
Shard construction, admission, manifest validation and result creation reject
them, including named confirmations. They are never `valid:true` provider outputs.

The other six foreign original controls keep their exact selections:
ja-c→zh-Hans, ko-c→en, pt-c/it-c/de-c→es, th-c→en. They are diagnostic-only and
`familyDirectionPositiveEligible:false`; ru-c is likewise ineligible. All
translation and dependent cases, all 176 translated cells and the 33 first-document
seed IDs remain. vi-c/id-c/hi-c retain their curated qualification holds. No
synthetic protocol fixture or annotation grants linguistic qualification.

The profile is explicitly **legacy document-language-only mixed-context
research**. Production request bodies still use the document language unchanged.
Outside-body effective-language metadata never claims that the model received
resolved passage hints. A later context-aware recipe requires separate frozen
bodies/code and qualification. No such recipe is implemented here.

The per-source definition hashes the full authored spec, reconstructed document,
exact occurrence bindings/selection and routing under the fixed profile. Each
case additionally binds its schedule, execution disposition and qualification.
Plan unions reject changes under an existing case ID even when the production
wire bytes are identical. The profile/routing/qualification must be reviewed and
frozen before the paid seed. Old executor plans cannot execute after a code
change. The validated handover below preserves their results without a code-hash bypass.

`preparePlan` requires an explicit exact approved corpus hash. Plans retain code
hashes (including prompt/recipe/parser files), actual `requestBody` and
`explanationBody` values, their exact `JSON.stringify` UTF-8 bytes/hashes and
production `reservationMicros` results. Every execution revalidates those bytes,
current code hashes and production builder outputs. Changed/new code or source
hashes require a new reviewed plan. Do not edit a frozen plan to bypass a failure.

Model gpt-6-luna, reasoning xhigh, service_tier default, store false and production
output caps remain unchanged (32768 translation, 4096 Study). English v2 uses
`parseGroundedExplanation`; other explanations use `parseExplanation`, and
translations use `parseTranslation`, including rejected-evidence failure. These
are structural checks, never substitutes for semantic review.

## Budget and state

The cumulative ceiling is 20,000,000 integer microdollars. Before registration,
Root initializes prior actual charges and unknown holds from its external ledger.
Registration reserves every independent frozen body, every unfrozen dependent
Study upper bound (5048 at the current conservative repository rates), and every
named confirmation slot. An experiment body must satisfy
`UTF8(JSON.stringify(body)).bytes + 4096 <= 24000`. Reservations are recomputed;
the quoted rates/bounds are not an entitlement or invoice claim.

Up to 60 unique named Standard confirmation slots may be predeclared with
`--confirmation-names '["failure01", ...]'`. Each holds the larger translation
ceiling (19384) inside the same cumulative budget. A selected existing case may
be repeated explicitly as `<caseID>--confirmation--<name>` in a Standard shard;
the name is usable once across the external journal. Dependent confirmations
still require the same exact recovered parent. No new prompt is introduced.
All registered plans share one cumulative journal and one set of confirmation
names. Do not create a fresh zero-cost journal for another build.

Unknown usage/model/tier retains the reserve and stops. Known cost overrun also
stops. Semantic/structural failures with known usage remain charged failures.
All admitted cases begin as unknown *before dispatch*, including cases a killed
build may never have reached. The next shard is refused while any earlier shard
has unknown submission/cost, overrun or an unreconciled Batch shard. There is no blind retry, transport switch,
or release of uncertain holds. Resolving genuinely unknown costs/identities needs
Root's evidence and an explicit accounting disposition, not another submit call.
The harness intentionally supplies no automatic unknown-hold clearing command.

A future context-aware executor/matrix is separate qualification, not part of this
legacy plan. Complete the old fixed-code Batch to terminal reconciliation before
freezing the next executor version. Preserve its external global actual/unknown
ledger and carry all costs/holds into the new version; a new recipe, journal or
code hash never resets cumulative accounting. Root separately reserves any future
matrix against the same 20,000,000-micro ceiling. Integrating changed selection or
timing code also invalidates this executor's plan hashes; freeze only the final
combined reviewed candidate. No paid plan is frozen by these fake-provider tests.

## Root journal and transport recovery

Keep the journal outside disposable builds and public/static output. It contains
immutable plans/shards and a hash-chained, fsynced append-only `journal.jsonl`.
Root commands use a brief exclusive mutation lock; no provider work holds it.
Never delete a lock or truncate the journal to resume after interruption.
`snapshot` verifies the complete chain, immutable file hashes, admission, bodies,
costs and recovered payloads. Log imports reject the offending record and retain
their verified prefix, including completed earlier cases; the real CLI reads
JSONL incrementally and stops at the first malformed JSON record, preserving the
verified preceding records and never accepting a later tail. Incomplete cases
keep unknown holds. Import only fresh records, not a previously imported prefix.

Standard shards have at most four cases and run serially. Production deadlines
remain 270 seconds translation/240 seconds Study. Four worst-case 270-second
calls plus 300 seconds packaging margin total 1380 seconds, below 45 minutes.
This arithmetic is a planning bound, not measured default-tier latency.

Before provider work, `claimStart` durably consumes the whole external ticket
once. A second claim/build admission is refused, independently of `/tmp` markers.
Root may preclaim before a single evaluation-only deployment and freeze that
start receipt into the immutable branch. A receipt binds Root's prior journal
decision; **it is not a server-side deduplication token**. Root must never submit
the same evaluation branch twice or rebuild it: after an uncertain deployment
create, recover that deployment/build ID and its logs or STOP. An immutable
receipt replayed in another container cannot by itself enforce exactly once.
Root explicitly owns this deployment-submission boundary; no new spend service
or database is introduced here.

Standard emits `language_expansion_submitting` before each call, then complete
case payload chunks immediately. Events carry plan/shard/body hashes, case ID,
transport and reservation. Chunk data is base64, at most 2000 characters; records
are <=16384 bytes, with complete byte/chunk counts and SHA256. Recovery accepts
out-of-order chunks, and rejects duplicates, drops, invalid/unknown chunks or
hash/count mismatches. Incomplete output remains unknown. No raw exception or
credential is emitted. A credential echoed by the provider becomes a redacted
failure. Retained logs/results are private because they contain full outputs.

Batch is allowed only after all 33 valid Standard seed results exist and Root
explicitly accepts representative outputs and actual Batch entitlement. A short
operation uploads/creates, inspects, recovers, or retrieves; it never waits 24h.
`custom_id` and plan/shard/input hashes in metadata are correlation, not dedup.
The exact production body is submitted to `/v1/responses`, with 24h completion.
Standard conservative reserves remain held even when Batch is planned; validated
Batch usage is accounted at the production accounting function's Batch rate.
Batch outputs explicitly require the expected model/default-tier metadata and
valid usage; Batch results do not prove Standard latency or account entitlement.

After a lost create response, use the known Batch ID or bounded list/metadata
recovery **plus exact downloaded input-file hash**. Zero/ambiguous matches,
incomplete listing or mismatched bytes leave the shard unknown; recovery never
calls create. Keep known input/Batch/output/error-file IDs in the external ledger.
Retrieve both output and error files before expiry. Match exact custom IDs across
both files; duplicate, unknown or missing cases fail. Completed rows survive
expiry/cancellation/failure and remain charged. Each case retains its raw JSONL
row, file ID/index and file-role binding. Complete file receipts include byte/row
counts, final-newline state and hash. Together these reconstruct the exact JSONL
files. Do not claim a reconstructed file matches until its complete receipt hash
has been checked. Invalid UTF-8 is rejected.

Every admitted Batch also has a durable `shardStates` gate, independent of case
settlement. Only a validated `language_expansion_reconciled` record closes it.
That record binds terminal Batch/input/output/error identities and status,
complete per-file hashes/bytes/row counts/newline state, exact row coverage hash
and request counts. Replay recomputes all of these from retained rows and file
receipts. Both files are required when declared, including an empty error file.
Missing reconciliation, a failed second-file retrieval, truncated rows, changed
identities, bad counts or an interrupted import keep the next admission blocked
even if every case already settled. A terminal build record or a retained-case
receipt cannot clear this gate. Read-only exact-file recovery may complete the
same reconciliation; there is no automatic release, create, retry or resubmit.

Batch retrieval policy `batch-files-1` is frozen in each new plan and Batch
manifest. Construction, admission and build validation enforce at most **32
cases**, unchanged exact input JSONL <=1 MiB, **64 MiB per file AND combined
output+error**, **1 MiB per raw line**, **64 KiB input chunks**, and exactly one
predeclared selected case per read. `maxRawBytes` remains the existing **1 MiB
full case payload** bound. Standard bodies, caps, deadlines and local four-case
limit are unchanged. These are two logical dependent phases split into fixed
shards; each shard must reconcile before the next admission.

A retrieval build accepts `selectedCaseID`, known Batch/input IDs, optional exact
prior terminal identity and partial file pins (`expectedIdentity`, `expectedFiles`,
`expectedScan`). Root freezes this descriptor with its exact deployment intent.
The first terminal inspection establishes status/counts/both declared file IDs.
All later reads must agree, including completed file pins from interrupted reads.
Downloads are serial full-file GETs, with the existing deadlines. The adapter
uses a bounded BYOB reader where supported; fallback reads reject chunks above
64 KiB before copying. Failure/early exit cancels the underlying reader and
releases its lock. No Range or compression assumption is made.

The byte-framed scanner validates every row (fatal UTF-8, exact IDs, no duplicate
across files, valid JSON envelope, CRLF and valid no-final-LF preserved), retaining
one fixed line buffer, at most 32 descriptors and only the selected row. Each
completed file emits `language_expansion_file_scan` with version, terminal
identity hash, role/ID, exact bytes/SHA, row count, final-LF and coverage hash,
**before** the selected result. The result additionally binds `filePayloadHash`.
Only that case is emitted through the existing chunk protocol. Its full payload
still includes raw row, provider response, parsed content, definitions, exact
source bindings/selection and accounting. If its duplication exceeds 1 MiB,
STOP with the inherited holds; no larger cap, easier selection, retry or lower
production output limit is authorized. Completed file pins survive this failure.
A later-file failure can retain an earlier selected result but never closes the
shard barrier. Empty declared files still require their own receipt.

At both EOFs, `language_expansion_scan` binds the complete terminal identity,
both exact file receipts, sorted row-coverage hash/count and reconciled provider
request counts. It is not `language_expansion_reconciled` and cannot clear
`shardStates`. After separately recovering every selected case, Root invokes
local `finalize`. It incrementally reconstructs every file in line-index order
including raw CR and the final LF, checks all file/scan pins and coverage, and
re-runs **production `responseResult`**, usage pricing and translation/Study
parsers on every retained raw row. It compares complete result/source/selection/
qualification identities and accounting, then appends `language_expansion_reconciled`.
Every journal replay recomputes that same proof. Old file/reconciliation event
formats are not accepted as new proof; they remain readable only by the retained
old executable in a validated sealed handover prefix.

A deliberately repeated read is first privately staged in full. `stage-repeat`
validates exactly one complete selected payload, compares every prior chunk and
completion byte-for-byte, and imports only missing payload records plus validated
control/file/scan records. It does not collapse duplicate incoming records or log
multiplicity. Direct imports still reject duplicate chunks/completions. A malformed
or incomplete staged payload does not import anything; ordinary incremental
`import` retains its verified prefix as before. No provider download holds the
journal mutation lock. A scan/finalize never releases unknown-cost holds or a cost
overrun, and configuration/credential failures still stop.

Root's separate evaluation-only wrapper/collector must additionally qualify the
unchanged paced <=1900-byte records, <=2,600,000 evaluator stdout bytes, actual
installer/platform allowance, deployment identity and intentional nonzero build.
The generic build configuration is outside this change. Local synthetic adapter,
journal and CLI evidence is not remote recovery or Batch account entitlement.

### Executor version handover

Never edit an old frozen plan's code hashes. Before replacing the executable,
retain an immutable selective copy of its exact source and the entire external
global journal. Finish every active old execution and reconcile old Batch shards
under that executable. Unknown *costs* and overruns may be carried, but remain
blocking; unknown in-flight submissions and unreconciled Batch shards refuse
handover. Freeze a **new** plan with current code hashes and identical generation
source definitions, exact bodies, schedule/33 seeds, static refusals and named
confirmation allocations. `handover` operates in the **same journal**, without
`init`, ledger reset, result rewriting or resubmission.

The handover records the old immutable executable path/hash set, all old plan/
shard hashes, unchanged root identity, byte-exact journal prefix/chain tip and
replayed snapshot hash. On each new snapshot it verifies the old executable's
full enumerated `codeHashes`, replays the sealed prefix using that executable's
own `validatePlan`/journal semantics in a temporary private view, validates the
new plan with current code hashes, compares generation code/definitions/bodies,
and replays only the new suffix. Old manifests/results/deployment/Batch/file IDs,
actual/unknown costs and all reserves remain in the global state. The validated
33 Standard outputs satisfy the new seed gate without resubmission. Appending new
old-plan events after handover is refused. Keep that old executable available;
it is required provenance, not a dispensable cache. If the old plan was frozen
on the evaluation branch, its `package.json` pins that build command: retain
those exact bytes and freeze the next plan under the same package configuration.
Matching core modules alone does not match all code hashes; a normal-only
archive correctly refuses an evaluation-package plan. The bridge compares
package/dependency hashes too, with no exemption for wrapper changes. Root owns
its separate evaluation configuration; this patch does not change it.
This explicit one-hop bridge
is for the unchanged legacy generation recipe, not authority for a future recipe
or arbitrary ledger import. A later version requires its own reviewed handover.

## Commands (private Root paths; no live command in this milestone)

Use Node 24. Source authoring/review and approval precede the first command.
The corpus hash is SHA256 of `JSON.stringify(parsedCorpus)`, not the raw pretty
printed file. `hash` is exported to compute it without copying the corpus.

```sh
node scripts/evaluate-language-expansion.mjs prepare --corpus /private/approved-corpus.json --approved-corpus-hash CORPUS_HASH --routing-manifest /private/routing-manifest.json --approved-routing-hash ROUTING_HASH --mode matrix728 --out /private/plan.json
node scripts/evaluate-language-expansion.mjs init --journal /private/root-journal --prior-micros 0 --unknown-held-micros 0
node scripts/evaluate-language-expansion.mjs register --journal /private/root-journal --plan /private/plan.json --approved-plan-hash PLAN_HASH
node scripts/evaluate-language-expansion.mjs freeze --journal /private/root-journal --plan /private/plan.json --approved-plan-hash PLAN_HASH --case-ids CASE_ID_1,CASE_ID_2 --transport standard --out /private/shard.json
node scripts/evaluate-language-expansion.mjs admit --journal /private/root-journal --plan /private/plan.json --approved-plan-hash PLAN_HASH --manifest /private/shard.json --approved-shard-hash SHARD_HASH --execution-id ROOT_FIXED_ATTEMPT --out /private/ticket.json
node scripts/evaluate-language-expansion.mjs start --journal /private/root-journal --plan /private/plan.json --approved-plan-hash PLAN_HASH --manifest /private/shard.json --approved-shard-hash SHARD_HASH --ticket /private/ticket.json --out /private/start-receipt.json
node scripts/evaluate-language-expansion.mjs import --journal /private/root-journal --events /private/recovered-protocol.jsonl
node scripts/evaluate-language-expansion.mjs status --journal /private/root-journal --out /private/reconciled-snapshot.json
```

`freeze` binds dependent bodies using complete recovered results. Use `--transport
batch` only after Standard review; admission also needs `--batch-accepted yes
--representative-reviewed yes`. Root explicitly chooses each next fixed shard
after recovery. Source/plans/results must not be bundled into a public route.
An optional credentialed local executor is explicit (`execute --live yes` plus
exact `--allocation-micros`, ticket and operation); **do not preclaim with `start`
for that local executor**, because it consumes the authoritative claim itself.
This implementation worker has zero live allocation.

## Evaluation-only build entry for Root wiring

No changes to existing `build-output.mjs`, `vercel-library-build.js`, preflight,
normal vercel.json, routes or schema hooks are part of this milestone.

```js
await runLanguageExpansionBuild({
  planPath, planHash, manifestPath, manifestHash,
  shardID: manifestHash, ticketPath, startReceiptPath,
  operation: 'standard', allocationMicros,
  // Batch only: batchID, inputFileID, representativeReviewed, batchAccepted,
  // retrieval: selectedCaseID, expectedIdentityPath, expectedFilesPath, expectedScanPath,
  // optional retainedResultsPath (map of exact recovered case results)
}, {env: process.env, fetchFn: globalThis.fetch, emit});
```

CLI: `node scripts/language-expansion-build.mjs --config /private/reviewed-config.json`.
Config supplies the same named fields, never a key. This reads the existing
Sensitive provider key only in the production build; it does not export a key or
edit persistent environment settings. The direct callable also accepts injected
`client`/`claimStart` for fake rehearsals. Legacy opt-in export
`evaluateLanguageExpansionInBuild(env, {loadBundle, claimStart, emit, fetchFn, client})`
is available but intentionally unwired; every enabled path uses the same
terminal/forced-nonzero contract and requires an authoritative external claim.

Root's separate immutable evaluation branch must run only this adapter, with no
normal packaging/schema/migration/repair hooks. The direct entry always emits
`language_expansion_terminal` with `evaluation_only_complete` or
`evaluation_only_interrupted` and `intentionalBuildFailure:true`, and always
throws/finishes **nonzero**. The CLI uses `process.exitCode=1` to flush stdout;
do not catch this into a successful build. This code alone does not prove
deployment/domain isolation: Root owns the exact branch/config and checks actual
build state/log identity. The terminal event does not settle missing case output or reconcile a Batch shard.

## Fake-provider recovery reproduction and acceptance

```sh
node --test tests/unit/language-expansion-evaluation.test.js
node --test --test-name-pattern 'SIGTERM|lost Batch|chunks|evaluation-only' tests/unit/language-expansion-evaluation.test.js
```

These use injected providers and synthetic original fixtures, no global network
requests. The SIGTERM test launches a real child, waits for its first complete
case and second submitting event, kills that child, then verifies the first
payload survives in the external journal and restart is refused. Other cases
exercise >2 MiB incremental output, exact code/body/source hashes, all matrix/seed
counts, reservations/prior unknown costs, missing dependencies, double builds,
invalid external journals, corrupt/out-of-order chunks, lost Batch identity,
output/error files, partial expiry and retrieval caps. Temporary fixtures are
removed by the tests. These are harness evidence only.

Review the complete retained source/output pairs independently. Preserve fidelity,
target-language compliance, teaching and naturalness as separate 0–4 scores.
Require zero critical errors, no unresolved substantive disputes, every artifact
fidelity/teaching >=3 and mean naturalness >=3.5. Wrong target prose automatically
fails. Identity/occurrence corruption, reversed agency/negation, invented facts,
unsupported certainty or readings and translated words presented as sung are
critical. No output omission, easier selection or weaker criteria follows an
executor failure. Provider transport success, structural tests and author drafts
do not activate product directions. Root reviews actual experiments first.

Official contracts inspected for this implementation:
[Batch guide](https://developers.openai.com/api/docs/guides/batch) and
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna).
Account access/queue limits, accepted pricing and successful live recovery remain
unverified. This milestone makes no default-tier latency, semantic qualification,
deployment, native, phone-install or release claim.

Local recovery examples (all paths private, no provider calls):

```sh
node scripts/evaluate-language-expansion.mjs stage-repeat --journal /private/root-journal --events /private/complete-selected-read.jsonl --approved-shard-hash SHARD_HASH --case-id CASE_ID
node scripts/evaluate-language-expansion.mjs finalize --journal /private/root-journal --approved-shard-hash SHARD_HASH
node scripts/evaluate-language-expansion.mjs handover --journal /private/root-journal --plan /private/new-plan.json --approved-plan-hash NEW_PLAN_HASH --legacy-code-root /private/immutable-old-executable
```

The local execute path takes `--case-id`, `--expected-identity`,
`--expected-files` and `--expected-scan` (JSON files); its existing explicit
Root live/allocation/ticket gate remains. The direct build config uses the
corresponding `selectedCaseID` and `*Path` fields. The legacy opt-in bundle carries
`selectedCaseID`, `expectedIdentity`, `expectedFiles`, `expectedScan` directly.
Both build adapters validate before GET and retain terminal intentional failure.
