# Contextual Study explanations

`POST /api/song-library` adds an authenticated `explain` action to v1. Existing
lyrics, translation, revision and report contracts remain compatible.

Input fields are strings: `documentID`, `sourceHash`, `translationID`, `sourceID`,
`lower`, `upper`. Offsets are source grapheme offsets with an exclusive upper
bound. Select 1–80 graphemes in one source occurrence. Clients cannot supply
source text, instructions, model, user identity or target language.

The service requires the current accepted English translation. It sends the
immutable whole-song source, selected range and accepted translation to the
existing Luna model with a strict schema. The answer contains `meaning`,
`context`, `grammar`, `uncertainty` and the exact selected `sourceQuote`.
Metadata includes source occurrence/range, document and translation revision,
and recipe `study-occurrence-2`. A line translation or dictionary result is not
substituted for a contextual explanation.

The second recipe clarifies classifier roles and requires ambiguity to remain
consistent across meaning, context and uncertainty. It also separates the lyric
speaker from the real performer. Its cache identity excludes earlier answers.

A new request returns `202 {version:1,state:"preparing"}`. Poll the **same action
and fields** at four-second intervals, with a bounded wait. Ready results return
`200 {version:1,state:"ready",explanation:{...}}`. Failed/unknown requests retain a
stable error and cannot dispatch another paid request. Cached results are shared
across authorized readers; every request still requires authentication and rate
limiting.

Migration `009-study-explanations.sql` extends the existing spending ledger.
Admission shares the settings-row lock, global daily/monthly limits, and combined
per-user translation/explanation attempt limits. A durable cache-key constraint
and queued-to-running claim prevent duplicate dispatch across instances. Unknown
provider usage remains reserved. Explanation spending is included in total spend
and excluded from the separate correction-review allowance. No settings or
allowance is raised by the migration. Original source and translation data are
unchanged.

Deploy the migration before the handler/store update. The new endpoint is used by
the native Study milestone; original clients do not issue this action. Local
cache keys must include document, source hash, translation revision, occurrence,
range, target and recipe. Offline cache reuse is valid only for that exact key.

Validation uses injected provider results, real PostgreSQL semantics through
PGlite, and the response contract: `npm test`. Live language-quality review and
native UI acceptance belong to the Study milestone and are separate from schema
validation. Provider prompts treat lyrics/metadata/translations as untrusted
quoted data, and model output has no write authority over accepted translations.
