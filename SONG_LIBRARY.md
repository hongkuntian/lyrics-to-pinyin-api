# Persistent song library checkpoint

This adds an authenticated backend route for whole-song Luna translation and durable
shared reuse. The existing lyric/romanization routes remain compatible. The iOS app
does not use the new route until its client integration ships.

## Storage and identity

Vercel hosts the API; a managed PostgreSQL database holds lyrics, romanization,
ordered source occurrences, translations, pending reports, identities and spending.
The existing Redis service remains an optional cache for the original endpoints.
Accepted library documents do not expire after 24 hours. Provider retrieval time
and new model prompts do not invalidate a saved translation. Explicit source
selection revisions can replace the current request mapping while retaining old
documents and their translations for evidence and reports.
When the new selection rules return identical content, the existing document and
translation are reused. Its original creation revision remains in the history.

Recording identity includes Apple catalog ID and storefront. Request aliases also
retain artist, title, album and duration so a mismatched request cannot populate an
unrelated recording. The current lyric provider's recording checks run before a
new document is stored. Exact source text, occurrence order, pronunciation and
timing participate in the document fingerprint. Repeated identical lines have
different occurrence IDs. Known source speaker labels are declared by the server;
arbitrary colons are not treated as attribution. Additional speaker mappings need
recording-specific source evidence.

## API contract

`POST /api/song-library`, JSON body, `Authorization: Bearer <user token>`.
Responses include `version: 1` and use `Cache-Control: private, no-store`.
Tokens are issued by an operator, stored hashed and revocable. They identify one
beta user independently of devices. Rotating a token retains that user's quotas.
There is no anonymous token minting endpoint or bundled shared OpenAI credential.
A future app sign-in adapter can map verified identities to these same user records.

| Action | Fields | Result |
| --- | --- | --- |
| `lyrics` | `recording: {catalog_id,artist,title,album?,duration,storefront?}` | `200` with immutable `document`; concurrent cold lookup returns `202 loading_lyrics` |
| `translate` | `documentID, sourceHash` | `200 ready` with saved `translation`, or `202 preparing` with `job` |
| `status` | `jobID` | `200` with job state and translation when ready; polling never starts a generation |
| `report` | `documentID, translationID?, sourceID, category, detail` | `200` with pending report ID; no generation or publication |

The initial target is English. Clients cannot supply user IDs, lyric bodies, model
names, prompts, token limits or target overrides. Sources must first be obtained
and verified by the library route. Partial or oversized songs are withheld rather
than truncated. Errors have `code`; quotas/spending use `429`, missing credentials
use `401`, unavailable storage/configuration use `503`, changed sources and terminal
jobs use `409`. There is no silent Apple/cheaper-model fallback. Existing source
lyrics and playback can remain visible while preparation finishes or is unavailable.

## Generation and spend

Keep the evaluated `song-clause-4` instructions, lexical inventory, direct whole-song
request, `gpt-5.6-luna`, high reasoning, standard tier and 16,384 output-token budget.
The new parser independently rejects and retains invalid auxiliary notes; complete
lyric occurrence coverage and source-owned speaker structure stay strict. Accepted
notes and `[unclear source]` markers remain visible in the returned content. A valid
response is not a guarantee of semantic correctness. No model correction reviewer,
automatic source repair, Terra escalation, PCC or extra DeepL pass is introduced.

One database transaction locks the settings row, checks the shared result/job,
checks user quotas, and reserves the full estimated maximum before any provider
request. Unique document/target jobs and an atomic queued-to-running claim prevent
simultaneous workers from issuing duplicate calls. A new prompt alone cannot create
another job for an existing document/target. Cached reads do not consume generation
allowances. Defaults: 10 new attempts/day, 50/month, one unfinished job/user,
60 API requests/minute/user, 20 correction reports/day/user. Only operator-issued
identities exist in this beta. Paid generation defaults disabled with zero budget.

Daily/monthly USD ceilings are explicit operator settings, counted in UTC by job
admission time. Spending includes completed and failed attempts plus outstanding
reservations. The input bound uses UTF-8 request bytes plus overhead, priced at the
conservative cache-write input rate; all permitted output/reasoning tokens are
reserved. Completed usage is conservatively accounted, not a provider invoice.
If reported cost exceeds the reservation, generation switches off for inspection.
An unexpected provider model or service tier also disables generation and retains
the reservation because Luna pricing cannot account for an unknown configuration.
All app OpenAI traffic must use this route/key; unrelated project/key spending is
outside this ledger. Configure an OpenAI project hard spend limit as a second layer.

There are no automatic paid retries. Provider/storage timeouts keep reservations.
A crashed running job becomes `unknown` after six minutes, and cannot be reclaimed.
Queued jobs can be resumed safely because they have not claimed provider execution.
An unknown job stays reserved and requires operator reconciliation against provider
usage before any replacement attempt. A function timeout is not proof of zero cost.
`waitUntil` runs the bounded worker for up to the function's 300-second lifetime;
the provider timeout is 270 seconds. This is an at-most-one-dispatch checkpoint,
not a guarantee that every accepted job completes after a server interruption.

## Deployment and operations

1. Connect a free Neon PostgreSQL resource through the Vercel Marketplace, with
   `LYRA_LIBRARY_` environment prefix and region matching the function (iad1).
2. Pull environment variables privately and run `node --env-file=.env.local
   scripts/song-library-admin.js migrate`. The new database starts disabled.
3. Keep `OPENAI_API_KEY` server-side in the Vercel project. Use a dedicated project
   key and hard spend limit before general beta traffic.
4. Configure only the user's explicitly selected budget using `configure
   --daily-usd <amount> --monthly-usd <amount> --enable`. `disable` is the kill switch.
5. Issue a distinct beta credential with `user --id <stable-user> --token-file
   <private-path>`. The file is created exclusively with mode 0600; do not put it in
   Git, app bundles, logs or chat. Reusing the same user ID revokes previous tokens.
6. `usage` displays accounted microdollars. `reports` lists pending proposals for
   operator review (including their current status). Export/back up the database before any later schema migration
or bulk correction; the schema is portable PostgreSQL.

This checkpoint records immutable versions and pending reports; it does not yet
provide correction publication, rollback or unknown-job reconciliation commands.
Do not delete a failed/unknown job to enable another attempt without reconciling
its provider usage. Public self-service signup and the iOS sign-in/client flow are
separate work before opening generation to general users.

Automated correction assessment is deferred. Preserve the exact source and
translation revision, report, supporting evidence, assessment and replacement
history when adding it. Treat all reports, lyrics and retrieved material as untrusted;
the model must have no direct write authority or secrets. Publication requires
backend validation, bounded correction scope and rollback. First run assessments
without publishing changes, evaluate source-grounded correctness and adversarial
reports, then automate only validated categories. Judgment calls share the same
budget/abuse controls and duplicate reports must not cause repeated paid work.
Personal pronunciation overrides stay separate from shared corrections; Mandarin
pinyin and Cantonese Jyutping remain distinct pronunciation systems.

## Verification

`npm test` includes actual embedded PostgreSQL tests for restart persistence,
concurrent admission/claims, global and user limits, unknown-cost handling,
source revisions, reports and authenticated HTTP flow. Provider calls are injected
and hermetic. Managed PostgreSQL and deployed-route checks are separate evidence;
an embedded database test alone does not certify a live deployment or invoice cap.
The explicit response schema lives in `contracts/song-library.schema.json`.

Sources: [Vercel storage](https://vercel.com/docs/storage),
[Neon integration](https://vercel.com/marketplace/neon),
[function duration](https://vercel.com/docs/functions/limitations),
[Luna configuration/pricing](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[OpenAI spend limits](https://developers.openai.com/api/docs/guides/spend-limits),
[untrusted-input isolation](https://developers.openai.com/api/docs/guides/agent-builder-safety).
