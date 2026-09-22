# Multilingual backend checkpoint

The backend retains immutable source documents and existing document-plus-target
translation containers. This checkpoint changes no iOS app files. Legacy requests,
English prompts, recipe identities, and cached explanations remain compatible.
The source fingerprint is unchanged.

## Rollout and capabilities

Apply migrations with `node scripts/song-library-admin.js migrate` before deploying
the new handler. Migration 012 adds nullable request snapshots and Study metadata;
legacy workers can continue inserting their previous row shapes. Existing Study rows
remain contract version 1, explanation language `en`, with their original IDs.
The checksum-based migration runner applies it once. Rollback the code if needed;
leave the additive columns in place.

When the owner credential exists only in Vercel, deploy with
`vercel --prod --skip-domain --build-env LYRA_LIBRARY_MIGRATE_ON_BUILD=1`.
The `vercel-build` hook uses the production credential inside the build environment,
applies the same checksummed migration runner, and logs only migration names.
Multiple function builds coalesce through its transaction advisory lock. Normal
production builds only verify the latest migration receipt and fail if it is absent;
local and preview builds never access the database. The migration flag is a one-build
option, not a persistent project setting. Inspect the build receipt and exercise the
new deployment before `vercel promote <deployment-url>`. No admin endpoint is added.

`POST /api/song-library` with `{"action":"capabilities"}` and the normal bearer
credential returns configured generation directions, known targets, Study limits,
and automatic correction targets. A known target is not a quality certification.
Both generation policies default to `["*:en"]`, preserving existing source admission
and English behavior. Configuration must be an explicit JSON array of canonical
`source:target` pairs. An empty array disables new work of that kind:

- `LYRA_TRANSLATION_DIRECTIONS`, e.g. `["*:en","zh:fr","en:zh-Hans"]`
- `LYRA_EXPLANATION_DIRECTIONS`, e.g. `["*:en","zh:fr","zh-Hans:fr"]`

These are examples for evaluation, not enabled production directions. Use exact
source tags from the document (or the studied translation target); there is no
automatic regional or script stripping on source matching. `*` is explicit broad
admission, retained only for the existing English default unless an operator adds it.
Saved artifacts remain readable when a direction or generation is disabled.
A policy change does not cancel an already claimed provider request.

Known output targets are `en`, `fr`, `es`, `zh-Hans`, and `zh-Hant`. BCP-47 case is
canonicalized. Declared aliases are en-US/GB/CA/AU → en, fr-FR/CA → fr, es-ES/MX → es,
zh-CN/SG → zh-Hans, and zh-TW/HK → zh-Hant. Other unsupported tags are rejected;
`zh` is deliberately ambiguous as an output target. Script does not choose a
pronunciation language. No new pronunciation, source-acquisition, UI localization,
or automatic correction capability is implied by these targets.

The current broad source-language label does not prove every passage is in one
language. This checkpoint therefore adds no server-side same-language suppression
based solely on that label. Source-only Study is available without manufacturing a
translation. A later same-language optimization needs reliable passage evidence,
including mixed-language and script cases.

## Translation contract

`translate` and `current` accept `target`; omission means legacy English. New clients
must send it explicitly. `status` continues using the job ID and returns its bound
target. Translation responses now carry server-assigned `target`, `documentID`,
`sourceHash`, and `notesLanguage`; these are taken from storage, never model output.
`missing` and `unchanged` current responses also identify the requested target and
source. Different targets have independent heads, histories, jobs, and correction
report revisions. Existing accepted content is not regenerated for a new recipe.

```json
{"action":"translate","documentID":"…","sourceHash":"…","target":"fr"}
```

Generation runs directly from the entire original source, preserving occurrence IDs,
speaker ownership, ambiguity, and clause fidelity. The English recipe stays frozen;
new target instructions use the shared fidelity template plus language and uncertainty
marker conventions. Source-note prose uses the translation's target language.
Model schema validity is not evidence of linguistic accuracy.

Each new job persists the exact provider request that was priced at admission.
Workers use that snapshot after a deployment, not the current request builder.
Legacy queued English jobs can use their recognized frozen English recipe; an
unrecognized job without a snapshot fails without a provider call. Spending and
per-user allowances remain shared across targets and Study requests.

## Study v2

The outer API envelope remains `version: 1`. The `explain` action opts into the new
selection contract using `contractVersion: 2`. The legacy flat source selection
remains supported, including explicit `contractVersion: 1`, and retains its cached
identity and English prompt.

Canonical request schema: [study-v2-request.schema.json](../contracts/study-v2-request.schema.json).
Responses: [song-library.schema.json](../contracts/song-library.schema.json).

```json
{
  "action": "explain",
  "contractVersion": 2,
  "documentID": "…",
  "sourceHash": "…",
  "studyText": {
    "layer": "translation",
    "revisionID": "…",
    "occurrenceID": "L0001",
    "target": "zh-Hans"
  },
  "selection": {
    "offsetUnit": "grapheme",
    "ranges": [{"lower": 2, "upper": 4}],
    "textHash": "SHA-256 of exact selected text encoded as UTF-8"
  },
  "explanationLanguage": "en"
}
```

For `original`, omit `studyText.target` and set `studyText.revisionID` to the immutable
**document ID**. Offsets address the occurrence's **lyricText**, excluding performer
prefixes. For `translation`, offsets address that revision's **lyricText**, never
its decorated display `text` or the original source. The server reconstructs the
selection; client text is not accepted. `textHash` is lowercase hex SHA-256 of the
selected graphemes, with no Unicode normalization. Bounds are zero-based, upper
exclusive, integer offsets. Only one contiguous range of 1–80 graphemes containing
letters or numbers is currently supported. Multiple ranges are explicitly rejected,
not widened into a span. Unsupported display transforms must map back to this text
or withhold the Study action.

Original Study may omit translation context entirely, or include
`contextTranslation: {"target":"fr","revisionID":"…"}`. Translation Study already
uses its selected revision and rejects a second context translation. A current-head
check fences every referenced translation before returning cached content or reserving
new work. After a correction, clients must discard/reselect stale translated ranges.

V2 responses add `contractVersion`, `explanationLanguage`, `studyText`, and `selection`.
`translationID` identifies the used revision, or is null for source-only Study.
Cache identity includes exact source, text layer and revision, occurrence, selection,
explanation language, supporting revision, and recipe. Explanation-language changes
never generate translations. Translated-text explanations distinguish translator
wording from original grammar and do not imply those words occur in the recording.

## Verification and remaining app work

`npm test` covers legacy compatibility, language isolation, admitted request recovery,
source-only Study, translated selection, stale revision fences, shared quotas,
migrations, correction reports, rollback, and response schemas. Provider responses
are fixtures; these tests establish behavior, not translation quality.

Shared grapheme fixtures are in `contracts/study-selection-fixtures.json`. Run both
the backend unit suite and `swift scripts/verify-study-graphemes.swift` from this
repository to check the same combining-mark, emoji, Indic, Chinese, and bidirectional
selections. This is a standalone Swift check, not an iOS app build.

Before enabling additional generation directions, evaluate direct translations and
explanations with source-grounded bilingual review, including changed refrains,
agency/negation, uncertainty, mixed-language passages, and untranslated proper names.
Non-English reports persist with their exact revisions but the existing automatic
English correction pipeline refuses them; multilingual correction evaluation is
still required. No new direction is automatically enabled by deployment.

The app now has independent content preferences, target-aware caches and jobs,
late-result fencing, revision-bound selection, separate practice histories, and
translated pronunciation capability. UI localization and linguistic release
evaluation remain.
Translated text should use meaning alignment, not recording word timing. English
source fixtures here do not certify live English-song acquisition coverage.


## Reproducible multilingual evaluation

`evaluation/multilingual/corpus.json` contains four original, ten-line evaluation
songs in English, French, Spanish and Mandarin. The changed refrain distinguishes
not asking someone to stay from asking them not to stay. Other checks cover speaker
agency, negation, metaphor, uncertainty, proper names and mixed-language passages.
This is a targeted regression corpus, not a representative commercial-song benchmark.

Run `node scripts/evaluate-multilingual.js --live` with an authorized provider key.
The runner uses production whole-song translation and Study request builders,
retains source and output together, and evaluates 12 direct translation directions,
12 original-text explanations and three translated-text explanations in English.
Two workers share a conservative two-dollar reservation ceiling. Provider model,
recipe, service tier and request limits remain unchanged. No production library,
cache or language policy is written. The output is evidence for bilingual review;
successful JSON never marks a language direction approved.

When the key is available only inside Vercel, use an **unpromoted** deployment with
`vercel --prod --skip-domain --build-env LYRA_MULTILINGUAL_EVALUATE_ON_BUILD=1`.
The explicit build flag runs this same corpus once per build container, after the
schema check. The flag is not a persistent project setting. Evaluation failure
fails that build. Inspect its build logs for `multilingual_evaluation_case` records,
retain them in ignored artifacts, and review all source/output pairs before changing
language admission. Do not promote an evaluation build as a language release.
Errors log only bounded provider codes/types, never credentials or raw error bodies.
Normal builds perform no evaluation/provider calls.

The September 21 attempted evaluation was rejected with `invalid_api_key` for the
production provider credential. No translation or explanation quality result was
obtained, and no new direction was enabled. Replacing that credential and repeating
the live evaluation is required before the multilingual beta can be admitted.
