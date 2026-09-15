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

## Checkpoint 2: scheduled assessment batches

Implemented in `db/005-correction-batches.sql`, `db/006-batch-dashboard.sql`, `review-queue.js`, `review-assessment.js`, and `batch-provider.js`:

- Report insertion only updates a durable queue. Translation reports sharing an exact revision share one assessment; later reports never reopen completed work. Other report categories remain outside the paid queue. Existing pending translation reports are backfilled by the migration.
- Free deterministic selection prioritizes reports older than seven days, then distinct reporter count capped at three, then age. A run examines at most 25 pending revisions and admits at most five (also limited by the configured daily allowance). A prompt includes at most ten reports, at most two from each reporter. Full-song source context is preserved; oversized songs are deferred instead of truncated.
- Admission freezes the prompt, selected report IDs/text and policy version, and reserves both assessment and future verification costs in one transaction. Only assessment is submitted in this checkpoint. A correction candidate retains its verification reservation; keep/defer, rejected output, expired unexecuted requests and superseded results release only the never-submitted verification operation once assessment billing is known.
- A six-minute database lease fences overlapping workers. A separate unique active-batch constraint and durable transitions prevent another batch during an uncertain submission. Database transactions do not remain open during HTTP requests.
- Uploads and batch submissions are attempted once. An uncertain upload is found by its unique filename and verified against the stored input hash and exact bytes. An uncertain batch submission is found by its local batch ID, input file and request hash in provider metadata. No matching result means funds remain held, not permission to resubmit. Reconciliation scans at most five pages of 100 objects per run; incomplete searches require operational attention.
- Requests use only `gpt-5.6-luna`, high reasoning, the default service tier, strict structured output, no tools and full-song context. Reports and lyrics are explicitly untrusted data. The parser rejects unknown fields, duplicate JSON keys/occurrence IDs, invented source quotes and malformed replacement lines. A candidate is validated as a complete aligned translation. These controls constrain actions and output structure; they do not establish semantic correctness or eliminate all model susceptibility to misleading text.
- Result files are matched by custom ID, independent of output order. Duplicate or foreign identities stop settlement. Each assessment, source-grounded candidate, input/output token counts, provider response ID and cost settlement commits atomically. Completed siblings are not charged again during partial reconciliation. Missing usage remains reserved, including on expired, failed or cancelled batches unless a per-request `batch_expired` record confirms it was unexecuted.
- Accounting uses conservative Batch cache-write input pricing (US$0.125/million input tokens) and output pricing (US$0.60/million output tokens), with a byte-based input upper bound plus overhead below 100,000 tokens. Verification reserves the maximum allowed request size. Prices are estimates against the fixed policy; a reservation overrun or unexpected response model/tier pauses new paid work. [Luna pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [Batch discount and lifecycle](https://developers.openai.com/api/docs/guides/batch).
- The dashboard displays queue counts, review sublimits, last worker/batch status and the saved assessment for the reported revision through curated read-only views. It receives no provider key, submission permissions or raw request/response payloads.

### Schedule and recovery

The API project runs `GET /api/review-reports` daily at `0 8 * * *` UTC. Vercel Hobby may start it anywhere in the scheduled hour. The route requires production, the existing OpenAI key and a separate `CRON_SECRET` of at least 32 characters sent as `Authorization: Bearer …`. It accepts no model, budget or report parameters. Configure the secret only on the API project and apply migrations before deploying. [Vercel scheduling limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

Enable review admission with the existing owner-only command after deployment:

```sh
node --env-file=<private-env> scripts/song-library-admin.js configure-reviews --enable --daily-usd 0.25 --monthly-usd 1 --max-daily 5
```

These sublimits remain inside the global US$1/day and US$5/month settings. Removing `--enable` pauses new assessments without preventing reconciliation of submitted work. No automatic budget increases occur. An empty queue makes no provider calls. Batch processing can take 24 hours, and the next daily run collects results. A run that reconciles a previous batch admits new work on the following run, keeping each invocation bounded.

Provider input/output files expire after 30 days; audit data remains in Postgres. Investigate missing/uncertain provider records before those files expire. The worker will never clear an unresolved charge simply because time has passed. Unknown outcomes, contradictory provider identities or validation failures requiring billing evidence stay held and visible; operator recovery must establish the charge without resetting submission state or issuing another paid request. Drain active batches before changing the assessment policy version or pricing.

This checkpoint saves **assessments only**. Reports retain their existing disposition, current translation heads are unchanged, and no correction is published. Fresh comparison, automatic publication, email alerts and device refresh remain below.

## Checkpoint 3: fresh comparison and automatic publication

Implemented in migrations 007/008 and the review verification/publication modules:

- Proposed corrections receive a separate Luna Batch request. Both complete translations are labeled A/B, with one random order frozen before submission. The verifier sees full source and lexical context, without reports, the assessor's rationale or candidate identity. It cannot rewrite either option or invoke tools.
- Publication requires the proposed candidate to win, explicit source-sufficiency/material-improvement/no-regression checks, and exact source evidence for every changed occurrence. Ties, uncertainty, missing evidence and malformed responses preserve the current translation. This is a conservative **AI assessment**, not proof of correctness or bilingual human validation; same-model errors can be correlated.
- The comparison request freezes source, baseline, candidate, assessment and policy hashes. Before publishing, the worker reconstructs and validates the assessment and exact comparison request, requires settled non-error billing for both Luna stages, rechecks the source and locks the current translation head. The model cannot select a destination, publication key, actor, budget or execution action.
- The publisher copies only the exact first-pass candidate. Revision creation, head update, immutable outcome receipt and report dispositions commit together. Interrupted transactions roll back, and a later scheduled run resumes persisted work without repeating model calls. Rollback retains both versions and creates a new current revision.
- Only reports included in the frozen assessment receive outcome metadata. Kept translations reject those reports; publication accepts only included reports attached to changed occurrences. Unshown, late and uncertain reports remain pending without reopening paid work. Assessment and comparison results remain attached to the historical revision.
- Verification uses its existing reservation; it never requests a second allowance. Eligible comparisons run before new assessments, in groups of at most five. Unknown charges stay held. Review/global disable pauses admission and publication while allowing submitted work to reconcile. A separate publication switch pauses new comparisons and publication, also without blocking reconciliation.
- The read-only dashboard shows correction/retention/uncertainty counts, assessment and comparison outcomes, and exact before/after lines through curated views. It has no model key, owner database credential or publication authority.

### Safe activation and rollback of the worker

Pause review admission with `configure-reviews` using the existing amounts and **without** `--enable`. Confirm that no worker lease or active batch remains before migrating: the prior worker understands assessment batches only. Apply migrations 007/008, deploy the updated API and dashboard, then enable publication and resume the same review limits:

```sh
node --env-file=<private-env> scripts/song-library-admin.js configure-publication --enable
node --env-file=<private-env> scripts/song-library-admin.js configure-reviews --enable --daily-usd 0.25 --monthly-usd 1 --max-daily 5
```

`configure-publication` without `--enable` pauses verification admission/publication. Disabling this switch does not undo published revisions or release submitted charges. Before rolling back to an assessment-only worker, disable admission/publication and drain all active verification batches with the new worker. Never run an old worker against active verification batches.

The daily schedule means two model stages can span several days. A run that collects an assessment prepares its comparison on the following scheduled run. Retained translations remain readable throughout. Empty or completed queues make no provider requests. No budget increase, new model or extra scheduler is introduced.

## Checkpoint 4: operational alerts

Migration 011 and `operational-alerts.js` add deterministic incident detection and a durable email outbox to the **existing daily route**, after review processing. There is no new scheduler, per-report email, model call, subscription, budget increase, provider retry or change to held reservations. The alert pass still runs if OpenAI configuration is missing or the review worker throws, provided the database is available.

Conditions cover exhausted global/review ledger limits, a same-UTC-day review admission blocked by a reservation that cannot fit, unknown charges, generation/Study reservations unfinished for more than ten minutes, review batches unfinished for more than 48 hours, worker/reconciliation failures and recorded cost/configuration safety pauses. Ordinary daily review-count limits, successful corrections, intentionally paused unsubmitted work and ambiguous semantics do not require owner alerts. A safety-pause incident clears when the affected switches are resumed after investigation. Budget-denial history from the review worker clears after a successful later run or UTC rollover; the live ledger condition remains if reservations still exhaust the current budget. Denied individual translation requests are not logged as incidents in this checkpoint.

Each incident family has at most one open episode. Repeated runs update its last-seen timestamp; changing counts or more reports do not create more emails. A successful check resolves absent conditions. Reopening after a recorded resolution creates a new episode. New, still-active episodes share **one digest**, with a hard limit of **one email attempt per UTC day and five per UTC month**, including failures and interrupted sends. Unsent episodes wait for allowance; ones that resolve while waiting never send. No recovery email or periodic reminder is sent.

Claiming the digest, freezing its exact sender/recipient/body and linking all included episodes happens in one transaction under a monitor-row lock, before any network call. There is exactly one HTTP send attempt. A timeout, process interruption or lost send receipt remains unknown and is **not automatically resent**, even on a later day. Rejected sends also remain visible without retrying. This deliberately avoids duplicate mail outside [Resend's 24-hour idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys). The frozen digest also supplies a stable provider idempotency key. A sending claim older than ten minutes becomes unknown on the next pass. The owner investigates delivery configuration/provider logs if needed; there is no public requeue endpoint.

Email content comes exclusively from a fixed incident catalog with links to the private dashboard. No source lyrics, model content, reports, user identities, billing payloads or arbitrary error text are sent. Recipient, sender and API key come only from private API-project configuration. A strict single-address validator rejects header injection and multiple-recipient strings. Previews and local environments never send, and missing config retains fully working dashboard incidents.

### Email setup and verification

1. Apply migrations before deploying API/dashboard. Use a Resend Free account. For this private checkpoint, `onboarding@resend.dev` can send only to the Resend account owner's address; an owned and verified sending domain is needed before expanding recipients ([Resend sender restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)). Do not select a paid plan. See [Resend on Vercel](https://vercel.com/marketplace/resend) and [domain setup](https://resend.com/docs/dashboard/domains/introduction).
2. Configure **Production only on the API project**: `RESEND_API_KEY` (sending-only key, restricted to the verified domain when available), `LYRA_ALERT_FROM` (one address on that domain, or the account-only onboarding sender), `LYRA_ALERT_TO` (owner-selected address), and `LYRA_ALERT_EMAIL_ENABLED=true`. Keep the key out of shell arguments, logs, chat, the dashboard and version control. Removing the enable flag suppresses sending while retaining dashboard checks. Existing recipient-bound attempts are never silently reassigned.
3. Run hermetic backend tests and dashboard tests/build/browser gates. Test concurrency, quiet queues, grouped incidents, caps, claim rollback, lost responses, missing configuration, worker failure, held charges and read-only grants without real provider calls.
4. After delivery configuration, send one identified setup email to the selected owner address and distinguish provider acceptance from actual inbox receipt. Check live incident state through the dashboard and verify the next scheduled alert receipt. Do not create a fake production billing incident or change translations/budgets merely to test mail.

The dashboard computes live conditions independently of persisted episodes, including an alert check overdue by 36 hours. **A stopped scheduler or inaccessible database cannot reliably send its own outage email.** This checkpoint relies on Vercel's deployment/runtime evidence and a live dashboard for that case; an independent uptime watchdog and provider delivery webhooks are future work. Daily scheduling means a new persistent issue may wait until the next run to email, and transient issues that clear between runs may not produce an email. Existing spend admission checks protect the budget throughout that delay.

## Remaining implementation checkpoints

1. **Delivery configuration and budget decisions.** Complete owner-selected email delivery setup and live receipt verification. Add a separately authorized budget-change flow if usage warrants it. Routine corrections remain automatic; uncertain semantics remain deferred.
2. **End-to-end rollout.** Verify a correction and rollback reaching the iPhone. Complete backend/dashboard checks and focused, Full and UI native verification before mainline delivery and the iPhone preview. Backend tests already cover correction/retention/uncertainty, injection-shaped output, concurrency, partial completion, uncertain charges, budget rollover, stale revisions and crash recovery; they do not measure real-world semantic success rates.

Review quality and real token usage determine whether to adjust these limits. The system cannot increase its own budget or substitute another model.
