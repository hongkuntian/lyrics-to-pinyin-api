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
request, `gpt-6-luna`, xhigh reasoning, standard tier and 16,384 output-token budget.
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

New requests use GPT-6 Luna with `xhigh` effort. Migration 015 permits both Luna
versions in review history. Already-admitted translation, Study and correction
requests retain GPT-5.6 Luna/high and its original accounting rates; saved content
is reused rather than regenerated. Standard GPT-6 accounting reserves US$0.125
per million input tokens and US$0.50 per million output/reasoning tokens (verified
2026-09-29). Output caps, timeouts and configured spending limits are unchanged.

## Deployment and operations

1. Connect a free Neon PostgreSQL resource through the Vercel Marketplace, with
   `LYRICA_LIBRARY_` environment prefix and region matching the function (iad1).
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
[Luna configuration/pricing](https://developers.openai.com/api/docs/models/gpt-6-luna),
[OpenAI spend limits](https://developers.openai.com/api/docs/guides/spend-limits),
[untrusted-input isolation](https://developers.openai.com/api/docs/guides/agent-builder-safety).

## Progressive translation delivery

A `translate` request can opt into `delivery:"progressive-v1"`. Cached and
already-running results keep their ordinary JSON shape. A claimed new/queued
job returns NDJSON frames: `start`, zero or more `line`, then `complete` or
`failed`. Each frame binds `version:1`, stream/job UUIDs, document/hash, target
and an increasing sequence beginning at 1. A line carries
`{sourceID,lyricText}`; complete carries the ordinary committed public translation.
The provider prompt, model, schema, recipe and accounting stay unchanged.

Lines are provisional display data: they have no accepted translation revision,
are never saved separately, and cannot be used as Study context. A completed
provider terminal, exact text identity, full-song coverage, source-note validation
and durable storage are required before complete. A later failure invalidates
the drafts. The claimed worker owns provider work and settlement independently
of the response observer. Disconnect or backpressure detaches the observer;
it never cancels settlement or submits another generation. Recover using the
same job's existing status/current/resume-only contracts, not another reservation.
There is no durable partial replay service.

## Starter songs

The app's first-run flow offers starter songs: for each language the person
picked, three songs from a fixed pool. `api/data/starter-songs.json` is that
pool (46 songs under `cmn`, `yue`, `ja`, `ko`, `es`, `fr`). Each song has an
`id`, display `title`, `artist` and `year`, and `recordings`: lyrics request
rows (`catalog_id`, `storefront`, `artist`, `title`, `album`, `duration`) that
were verified to return measured word timing. Both actions need the app session
and count toward the per-account rate limit like every other action; unknown
keys are `400 invalid_request`.

| Action | Fields | Result |
| --- | --- | --- |
| `starters` | `languages`: 1 to 6 distinct pool language keys | `200 {version:1,starters:[{language,songs:[{id,title,artist,year,recordings:[…]}]}]}` |
| `starter_event` | exactly one of `shown` (1 to 24 distinct pool song ids) or `picked` (one pool song id) | `200 {version:1,state:"recorded"}` |

`starters` returns one entry per requested language, in request order. Each
`songs` is that language's whole pool in an order the server chooses, for now a
uniform shuffle on every call. It counts and writes nothing. The app shows the
first three songs it can play in the listener's store, sends `shown` with those
ids, and sends `picked` with the one the person chose. Anything else (an unknown
language or id, a duplicate, both or neither of `shown` and `picked`, a wrong
type) is `400 invalid_request` and records nothing.

`starter_event` adds 1 to `shown` for each listed song, or 1 to `picked` for the
one song, in a single atomic statement. Migration `040-starter-song-totals.sql`
holds the totals: `starter_song_totals(song_id, shown, picked, updated_at)`, one
row per song. No account, device, address or per-event time is stored, and
nothing acts on the totals yet. The runtime login may select, insert and update
that table and nothing else on it; a runtime login created after 040 gets the
same grant from the role replay (`scripts/membership-role-grants.js`). The
migration also adds `study_explanations_user_period(user_id, created_at)`, which
serves the per-account count behind the free starter cap. An operator reads the
totals with the owner connection:

```sql
SELECT song_id, shown, picked, round(picked::numeric / nullif(shown, 0), 3) AS pick_rate, updated_at
FROM starter_song_totals ORDER BY shown DESC, song_id;
```

A pool song that was never shown has no row.

Starter songs are free: see [memberships](docs/memberships.md#starter-songs-are-free)
for the rule and how a starter document is recognised.

Deployment order: apply migration 040 with the owner connection, then deploy.
The production build refuses to continue without the 040 receipt, and the
migration only adds a table, so the previous backend keeps working in between.

```sh
node scripts/song-library-admin.js migrate --database-config-file ~/.config/lyrica/credentials/backend-admin/migration.json
```

```sql
SELECT name FROM library_schema_migrations WHERE name = '040-starter-song-totals.sql';
SELECT bool_and(has_table_privilege('lyrica_runtime_v1', 'public.starter_song_totals', p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE']) AS p; -- true
```
