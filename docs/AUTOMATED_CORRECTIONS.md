# Automatic translation corrections

The approved workflow is reports → grouping → scheduled Luna assessment → fresh Luna comparison for proposed corrections → automatic publication → device refresh. Routine processing does not require manual launch or approval. Ambiguous cases keep the existing translation. The owner receives actionable budget/account/operational alerts through email and the dashboard.

Only `gpt-5.6-luna` is allowed for assessment and verification. No alternate model, paid ranking pass, unbounded research, automatic provider fallback, or automatic resubmission after an uncertain outcome is authorized by this design. Source lyrics, timing and pronunciation corrections need a later evidence workflow; the first automatic publisher changes translations only.

## Checkpoint 1: revision and spending foundation

Implemented in `db/003-correction-foundation.sql`, `db/004-correction-dashboard.sql`, and the song-library modules:

- Original `song_translations` rows and generation jobs remain intact. Every saved translation has an immutable revision and a current head. Revision 1 retains the original UUID, including for existing reports and cached iPhone content.
- Publication locks the stable translation container, validates the exact base revision and source hash, validates every source occurrence through the translation parser, then inserts a revision and moves its head in one transaction. Publication keys are idempotent and conflicting reuse is rejected. A rollback copies a historical revision into a **new** revision so refresh checks also detect reversions.
- Reports can refer to historical or current revisions. Dashboard song views follow the current head; report context shows the exact reported translation. API v1 report submission continues to acknowledge receipt with `pending`, including duplicate submissions whose stored disposition has changed. That acknowledgment does not reset the stored assessment.
- `library_spend_operations` accounts for generation, assessment and verification in integer USD microdollars. `library_spend_events` retains immutable transitions. Compatibility triggers capture writes from the previous generation worker during rolling deployments.
- A locked settings row serializes budget admission across both kinds of work. A review reserves **both** model stages together or reserves neither. It is coalesced by source translation revision, even when the policy string changes. The initial foundation permits one review per revision; bounded reopening for genuinely new evidence is a later explicit policy.
- Reserved, submitted and unknown operations count against **every current daily/monthly window**, regardless of their creation date. Known costs use the UTC settlement window. Unknown charges stay held until reconciled. This is deliberately conservative around period rollover.
- A claim is recorded before a network submission. Submitted/unknown operations cannot be claimed again; only a never-submitted reservation can be released. Known usage settles once; conflicting settlement cannot overwrite it. A cost overrun is recorded in full and disables new paid work rather than hiding the overrun or releasing its reservation.
- The model has no database credentials. Publication and review primitives are internal server methods; the public API exposes no publication, budget, reservation or rollback actions. These primitives do not themselves establish semantic quality. The later worker must validate its persisted assessment and comparison before publishing.

Review defaults are **disabled**, at most five new song-version assessments per UTC day, US$0.25/day and US$1/month. Review amounts sit inside the existing overall generation/review budget; they do not increase that budget. An empty queue will eventually incur no model usage. This checkpoint adds no scheduled worker, model calls, automatic publication, email delivery or iPhone refresh behavior.

### Read-only refresh contract

Authenticated `POST /api/song-library` with:

```json
{"action":"current","documentID":"<source document hash>","sourceHash":"<source hash>","revisionID":"<optional cached UUID>"}
```

The response remains `version: 1`, private and non-cacheable by shared HTTP caches:

- `state: "unchanged"`, `revisionID`: the cached revision is current.
- `state: "ready"`, `translation`: the current revision using the existing translation wire format.
- `state: "missing"`: the document exists but has no saved translation.
- Source mismatch, malformed input and invalid credentials retain ordinary errors.

This action never calls a provider, starts generation, or requires an OpenAI key. Existing `translate` and generation-job `status` reads also return the current revision. Installed clients retain their existing local cache behavior until the later iOS checkpoint.

### Migration and operation

Run with the database owner credential in a private environment file:

```sh
node --env-file=<private-env> scripts/song-library-admin.js migrate
node --env-file=<private-env> scripts/song-library-admin.js usage
```

The migration runner applies the ordered files in one transaction, under an advisory lock, and records checksums. A rerun skips matching receipts; altered migration history fails closed. The initial deployment can adopt databases created before migration receipts existed. Apply migrations before deploying the updated API and dashboard. The original worker remains compatible with the migrated schema; historical translations and reports are not rewritten.

The dashboard reader receives only the new curated spend, budget and revision-line views. It cannot read provider payloads, tokens, raw revision records or alter records. No OpenAI key or owner database credential belongs in the dashboard project.

The existing generation `configure` command retains its explicit global limits. `configure-reviews --daily-usd 0.25 --monthly-usd 1 --max-daily 5` sets the review sublimits; `--enable` must be supplied to enable review admission. `disable` pauses both kinds of paid work while preserving saved reads. Setting review admission does not install or schedule a worker.

## Remaining implementation checkpoints

1. **Durable queue and batches.** Group reports by revision, rank through bounded deterministic rules, and persist batch submission/result states. Add a protected daily cron route to the API project's explicit Vercel builds/routes. Reconcile existing work before submitting new work. Use unique result IDs, process partial batches, and never blindly retry a timed-out submission. The planned OpenAI Batch path has a [24-hour completion window and 50% discount](https://developers.openai.com/api/docs/guides/batch); daily reconciliation of two stages can take several days. Daily scheduling fits [Vercel Hobby limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).
2. **Luna policy and automatic publication.** Full-song assessment returns keep/correct/defer with source evidence. Only correction candidates receive a fresh comparison with candidate order varied and the proposer's rationale withheld. Persist the exact candidate, judgments, prompt/policy versions, usage and review provenance. Enforce permitted fields, source alignment and unchanged head in code. Malicious reports remain untrusted data, never instructions or executable tools. Same-model agreement is an AI assessment, not proof of correctness.
3. **Device refresh and exceptions dashboard.** Show cached content immediately, coalesce bounded read-only revision checks and replace validated content at a safe UI boundary. Preserve offline access, selection, manual scrolling and passive playback. Add revision/review history, rollback controls with owner authorization, and deduplicated email plus dashboard alerts. Only budget increases and operational decisions require owner input; uncertain semantics remain deferred.
4. **End-to-end rollout.** Exercise correct/keep/defer fixtures, injection attempts, report floods, concurrency, partial provider completion, uncertain charges, rollover and stale revisions. Verify a correction and rollback reaching the iPhone. Complete backend/dashboard checks and focused, Full and UI native verification before mainline delivery and the iPhone preview.

Review quality and real token usage determine whether to adjust these limits. The system cannot increase its own budget or substitute another model.
