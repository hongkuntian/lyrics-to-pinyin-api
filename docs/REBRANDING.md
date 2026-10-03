# Lyrica backend and dashboard naming

Current app/dashboard copy, alert email text, private dashboard package, source
fixtures and app compatibility test use **Lyrica**. The app's installed name is
Lyrica; **Lyrica: Learn with Lyrics** is its App Store marketing title.

The existing `lyrics-to-pinyin-api` package/repository name is descriptive and
unchanged. This is the same backend and dashboard. API response shape, sessions,
registrations and data formats are unchanged.

Retain the existing production API and `lyra-dashboard-roan.vercel.app` URLs,
`LYRA_*` environment variables, `lyra_s_` auth tokens, database roles/schemas,
`lyra_batch_id` provider metadata, batch filenames, alert idempotency keys,
dashboard session cookies/audiences, credentials paths and deployed resource
names. These are compatibility values, not product text. Dated recording/cache
verification records, older-build references and archived experiments retain
historical names. Third-party dependencies remain unchanged.

No backend/dashboard deployment, email sending, remote rename or account update
is part of the local rename. Apply the reviewed source through the existing
release workflow when publication is separately authorized. Existing hosted
copy continues to show its previous brand until then. Store listing and Xcode
Cloud project/scheme selections are separate manual follow-ups in the iOS repo's
`docs/REBRANDING.md`.
