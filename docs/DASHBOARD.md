# Private translation dashboard

The dashboard is a separate Next.js application under `dashboard/`, deployed to its own Vercel project with Root Directory `dashboard`. It reads the existing Neon song library through curated PostgreSQL views and a dedicated login. It does not call the public lyric/translation endpoints or any model provider.

## Scope

- Overview: current UTC day/month accounted budget, remaining headroom, usage estimates versus uncertain reservations, saved content, outstanding reports, recent work and seven-day activity.
- Songs: bounded title/artist search, pagination, saved source versions, occurrence-aligned English and stored pronunciation.
- Jobs: state filters, queue/worker timing, error codes, uncertain charges and potentially stalled requests. Inspection never changes job state.
- Reports: status filters and the reported occurrence with surrounding lyrics. Text is escaped; report disposition does not mean a correction was applied.
- Translation history: immutable versions, exact occurrence-by-occurrence comparisons, and owner-authorized restoration of a saved version as a new revision.
- Automation: owner-only pause/resume of paid work, report review and correction publication; current limits, worker status and the latest 50 owner actions.

Routine [automatic corrections](AUTOMATED_CORRECTIONS.md) do not require owner approval. Owner controls preserve existing spending limits and never retry uncertain provider requests or invoke a model. Historical cache-hit rates are not recorded; no hit-rate or savings claim is inferred from saved counts.

## Run and verify

Use Node 24 and npm. From `dashboard/`:

```sh
npm ci
npm run dev -- --hostname 127.0.0.1
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Local development and preview deployments default to synthetic fixtures. `LYRA_DASHBOARD_MODE=empty` or `error` exercises alternate states. Production never falls back to fixtures. Backend tests remain `npm test` from the repository root; CI runs both suites and desktop/mobile browser checks.

For local control verification, run the built server on `127.0.0.1:4331` with `LYRA_DASHBOARD_FIXTURE_CONTROLS=1`. The sample unlock button creates an isolated, expiring in-memory session. It cannot run in any Vercel environment, including previews. Browser tests exercise signed-out denial, a second tab with stale controls, sign-out, exact restoration and mobile layout. Database tests exercise real SQL permissions, audit, idempotency and source/head fencing; fixture browser tests do not establish a live OIDC login.

## Data and cost semantics

`db/002-dashboard-views.sql` adds a dedicated schema with settings, songs, jobs, lines and reports views. `db/004-correction-dashboard.sql` adds curated shared spending and historical revision lines. Song pages follow the current translation; report details retain the reported version. The view owner can read the library; the dashboard login receives only schema USAGE and view SELECT. Views exclude beta tokens, user identities and raw provider responses. Runtime queries also use a repeatable-read, read-only transaction and require the expected login name.

The shared ledger's integer `accounted_micros` is authoritative for budget headroom, including held reservations for generation and review. Known usage is labeled a usage-based estimate. Pending/unknown work or absent usage remains reserved/uncertain. These totals are not provider invoices or OpenAI credit balance. UTC admission windows count known costs at settlement and carry all outstanding reservations forward regardless of age. The activity chart places settled costs on their settlement date and outstanding reservations on their creation date; older held reservations may therefore appear in headroom without appearing in the seven-day chart. Worker time is not user-perceived latency.

## Provision and deploy

1. Create a separate Vercel Next.js project, root `dashboard`, Node 24, region aligned with Neon. Configure **Vercel Authentication → All Deployments** before providing database credentials. Standard Protection does not protect production domains.
2. Verify intended team/project membership, grants, bypasses and exceptions. Check that unauthenticated production, deployment and branch URLs redirect to Vercel login or deny access, including data-bearing RSC requests. Vercel's deployment permissions establish viewing access; owner writes additionally require the application session below.
3. Apply the song library migrations with `node --env-file=<private-owner-env> scripts/song-library-admin.js migrate`. With the backend database owner credential available only to the local operator process, run `node --env-file=<private-owner-env> scripts/dashboard-access.mjs <private-reader-env>`. The script creates `lyra_dashboard_reader` and saves credentials with mode 0600. It refuses to replace an existing role or credential file. Keep that file outside version control. If provisioning fails after writing it, inspect actual role state before trying again.
4. Verify the reader can SELECT views but cannot SELECT base tokens/provider payloads or UPDATE any records. The login defaults to read-only with a statement timeout; production code enforces read-only transactions too.
5. Add production-scoped `LYRA_DASHBOARD_DATABASE_URL` (sensitive), `LYRA_DASHBOARD_MODE=production` and `LYRA_DASHBOARD_PROTECTION=vercel-all`. The protection value is an operator acknowledgement, not an authentication mechanism. No OpenAI key or backend database owner credential belongs in this project. Preview deployments must not receive production credentials.
6. Deploy and verify the authenticated site, ledger reconciliation, escaped report context, and signed-out denial. No iOS release is needed.

For CLI deployments launched from the repository root, link that checkout to the dashboard project and pass `--local-config dashboard/vercel.json`. A checkout used for dashboard delivery must not retain the API project's `.vercel/project.json`.

Connect the project to this GitHub repository with production branch `main`. On a Hobby team, Vercel must associate the latest commit author with the team owner. Use an email already associated with the owner's GitHub account for checkpoint commits; a machine-generated `.local` email can leave deployments blocked even when the CLI is authenticated. Verify GitHub's commit attribution before retrying. Do not change deployment protection or upgrade the plan to resolve an author-identity mismatch. See [Vercel's collaboration troubleshooting](https://vercel.com/docs/deployments/troubleshoot-project-collaboration#team-configuration).

Configure the API project's Ignored Build Step as `node scripts/ignore-vercel-build.mjs backend`. This skips complete dashboard-only diffs against `VERCEL_GIT_PREVIOUS_SHA`; unknown revisions, paths, mixed changes and migrations build normally. The dashboard project builds on shared-repository changes so schema changes cannot be silently missed. Use a reviewed, verified main checkpoint for delivery.

## Owner controls

1. Create a [Sign in with Vercel app](https://vercel.com/docs/sign-in-with-vercel/manage-from-dashboard) on the dashboard's team. Register the exact production origin plus `/auth/callback`, enable `client_secret_post`, generate a client secret, and allow only `openid`. Restrict sign-in to the owning team. No Vercel resource access, email/profile scopes or refresh tokens are needed.
2. Resolve the owner's stable Vercel user ID from authenticated `/v2/user`. Set `LYRA_DASHBOARD_OWNER_SUBJECT` to that ID; never infer it from a submitted form, email address or deployment-viewer header.
3. With the backend owner URL and owner subject in a private local environment, run `node --env-file=<private-env> scripts/dashboard-operator.mjs <private-operator-output>`. It applies migrations, creates `lyra_dashboard_operator`, inserts the owner allowlist entry and writes credentials mode 0600. It refuses to overwrite an existing file or role. Inspect actual state before recovering a partial provisioning failure.
4. Add only in **Production**: `LYRA_DASHBOARD_OPERATOR_DATABASE_URL`, `LYRA_DASHBOARD_OAUTH_CLIENT_ID`, `LYRA_DASHBOARD_OAUTH_CLIENT_SECRET`, `LYRA_DASHBOARD_OWNER_SUBJECT`, `LYRA_DASHBOARD_ORIGIN` (HTTPS origin with no trailing slash) and a random `LYRA_DASHBOARD_SESSION_SECRET` of at least 32 characters. Keep all credentials private. Incomplete owner configuration leaves the dashboard in viewing mode.
5. Verify owner OIDC sign-in and sign-out on the deployed origin, plus signed-out/cross-origin rejection and restricted database privileges. Do not move a real translation merely to test the UI; use synthetic local data for the complete restore journey.

Every server action verifies a signed, one-hour HttpOnly/Secure/SameSite=Lax host-only session and the exact configured Origin. OIDC uses PKCE, state, nonce and ID-token claim validation through `openid-client`; the OAuth flow cookie expires after ten minutes. The database independently checks the enabled owner allowlist on every mutation. Removing or disabling that entry blocks writes even while a browser session remains valid. Rotating the session secret invalidates all dashboard sessions. The session is not refreshed automatically.

`db/010-dashboard-controls.sql` grants the operator only schema usage and execution of two `SECURITY DEFINER` functions with a fixed `pg_catalog` search path and schema-qualified tables. It has no base-table read/write access and cannot change budgets, queue work, release reservations, edit model output or add operators. Curated history/audit views remain under the existing reader role. Exact request IDs deduplicate submissions; conflicting reuse is rejected.

Control changes compare a settings version incremented by every settings update, including worker safety pauses. Pauses do not cancel provider work already sent, suppress its accounting, or free held funds. Resuming preserves all caps and reservations. Publication needs all three switches enabled; assessments may continue when only publication is paused.

Restoration locks the same stable translation container as the automatic publisher, checks the expected current revision and source hash, copies the chosen immutable content/recipe, and saves a new revision plus audit record atomically. A concurrent correction makes the old preview stale. Prior content and report context remain intact. The phone's existing revision check can receive the new revision; this dashboard checkpoint requires no native release.

## Later work

Deduplicated email and dashboard incident alerts, budget-increase decisions and broader rollout evidence remain separate checkpoints. Keep uncertain charges reserved until billing is reconciled. Model assessments remain untrusted data; deterministic validation and publication controls enforce the approved automatic workflow.
