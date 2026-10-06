# Lyrica backend and dashboard naming

Current app/dashboard copy, alert email text, private dashboard package, source
fixtures and app compatibility test use **Lyrica**. The app's installed name is
Lyrica; **Lyrica: Learn with Lyrics** is its App Store marketing title.

The existing `lyrics-to-pinyin-api` package/repository name is descriptive and
unchanged. This is the same backend and dashboard. API response shape, sessions,
registrations and data formats are unchanged.

Retain the existing production API and legacy dashboard URL,
`LYRA_*` environment variables, `lyra_s_` auth tokens, database roles/schemas,
`lyra_batch_id` provider metadata, batch filenames, alert idempotency keys,
dashboard session cookies/audiences, credentials paths and deployed resource
names. These are compatibility values, not product text. Dated recording/cache
verification records, older-build references and archived experiments retain
historical names. Third-party dependencies remain unchanged.

The official cutover publishes this source through the same API and dashboard
projects. The dashboard project is `lyrica-dashboard`, with canonical origin
`https://lyrica-dashboard.vercel.app`. The registered legacy URL
`https://lyra-dashboard-roan.vercel.app` forwards there with HTTP 307, preserving
paths and query strings. The production API stays at
`https://lyrics-to-pinyin-api.vercel.app`.

The **Lyrica Owner Dashboard** OAuth client keeps its client ID, credentials,
team-only access and scopes. Both exact `/auth/callback` URLs remain registered.
Production `LYRA_DASHBOARD_ORIGIN` selects the Lyrica origin; deploy the same
verified source after changing that environment value. Host-only flow/session
cookies require sign-in on the canonical origin. Keep Vercel Authentication on
all deployments, and verify signed-out denial, owner login/logout and legacy
URL forwarding before considering an origin change complete. See
[dashboard provisioning](DASHBOARD.md#owner-controls).

The iOS repo's `docs/REBRANDING.md` describes its App Store and Xcode Cloud
configuration. Runtime identities, persisted contracts and historical evidence
remain compatible across both repositories.
