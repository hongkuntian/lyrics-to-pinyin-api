# Private translation dashboard

The dashboard is a separate Next.js application under `dashboard/`, deployed to its own Vercel project with Root Directory `dashboard`. It reads the existing Neon song library through curated PostgreSQL views and a dedicated login. It does not call the public lyric/translation endpoints or any model provider.

## Scope

- Overview: current UTC day/month accounted budget, remaining headroom, usage estimates versus uncertain reservations, saved content, outstanding reports, recent work and seven-day activity.
- Songs: bounded title/artist search, pagination, saved source versions, occurrence-aligned English and stored pronunciation.
- Jobs: state filters, queue/worker timing, error codes, uncertain charges and potentially stalled requests. Inspection never changes job state.
- Reports: status filters and the reported occurrence with surrounding lyrics. Text is escaped; report disposition does not mean a correction was applied.

All controls are read-only apart from navigation and refresh. Spending controls, report decisions, regeneration, and automated correction judging are later checkpoints. Historical cache-hit rates are not recorded; no hit-rate or savings claim is inferred from saved counts.

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

## Data and cost semantics

`db/002-dashboard-views.sql` adds a dedicated schema with settings, songs, jobs, lines and reports views. Source tables and existing API contracts are unchanged. The view owner can read the library; the dashboard login receives only schema USAGE and view SELECT. Views exclude beta tokens, user identities and raw provider responses. Runtime queries also use a repeatable-read, read-only transaction and require the expected login name.

The ledger's integer `accounted_micros` is authoritative for budget headroom, including held reservations. Completed or failed work with valid recorded token usage is labeled a usage-based estimate. Pending/unknown work or absent usage remains reserved/uncertain. These totals are not provider invoices or OpenAI credit balance. UTC windows match admission checks, including their creation-time basis. Worker time is not user-perceived latency.

## Provision and deploy

1. Create a separate Vercel Next.js project, root `dashboard`, Node 24, region aligned with Neon. Configure **Vercel Authentication → All Deployments** before providing database credentials. Standard Protection does not protect production domains.
2. Verify intended team/project membership, grants, bypasses and exceptions. Check that unauthenticated production, deployment and branch URLs redirect to Vercel login or deny access, including data-bearing RSC requests. The access boundary is Vercel's deployment permissions, not application-level operator roles.
3. With the backend database owner credential available only to the local operator process, run `node --env-file=<private-owner-env> scripts/dashboard-access.mjs <private-reader-env>`. The script applies views, creates `lyra_dashboard_reader`, and saves credentials with mode 0600. It refuses to replace an existing role or credential file. Keep that file outside version control. If provisioning fails after writing it, inspect actual role state before trying again.
4. Verify the reader can SELECT views but cannot SELECT base tokens/provider payloads or UPDATE any records. The login defaults to read-only with a statement timeout; production code enforces read-only transactions too.
5. Add only production-scoped `LYRA_DASHBOARD_DATABASE_URL` (sensitive), `LYRA_DASHBOARD_MODE=production` and `LYRA_DASHBOARD_PROTECTION=vercel-all`. The protection value is an operator acknowledgement, not an authentication mechanism. No OpenAI key or backend owner credential belongs in this project. Preview deployments must not receive production credentials.
6. Deploy and verify the authenticated site, ledger reconciliation, escaped report context, and signed-out denial. No iOS release is needed.

For CLI deployments launched from the repository root, link that checkout to the dashboard project and pass `--local-config dashboard/vercel.json`. A checkout used for dashboard delivery must not retain the API project's `.vercel/project.json`.

Connect the project to this GitHub repository with production branch `main`. On a Hobby team, Vercel must associate the latest commit author with the team owner. Use an email already associated with the owner's GitHub account for checkpoint commits; a machine-generated `.local` email can leave deployments blocked even when the CLI is authenticated. Verify GitHub's commit attribution before retrying. Do not change deployment protection or upgrade the plan to resolve an author-identity mismatch. See [Vercel's collaboration troubleshooting](https://vercel.com/docs/deployments/troubleshoot-project-collaboration#team-configuration).

Configure the API project's Ignored Build Step as `node scripts/ignore-vercel-build.mjs backend`. This skips complete dashboard-only diffs against `VERCEL_GIT_PREVIOUS_SHA`; unknown revisions, paths, mixed changes and migrations build normally. The dashboard project builds on shared-repository changes so schema changes cannot be silently missed. Use a reviewed, verified main checkpoint for delivery.

## Boundaries for later work

Before write controls, add per-operator authorization and an audit log. Vercel viewing permission alone is not an editor role. Keep uncertain requests reserved until billing is reconciled; never implement an automatic retry button that can duplicate provider charges. Applying corrections requires versioned records and rollback. Any future AI reviewer must treat lyrics and report text as untrusted data, use source grounding, and have no direct permission to publish a canonical correction.
