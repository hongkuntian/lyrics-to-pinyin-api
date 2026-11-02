# Initial release scope

The initial release is for individual listening and language learning: discover
lyrics, save and refresh song editions, read original words and pronunciation
aids, and use the existing learning and playback integrations. Removing a shared
listening feature must not weaken those ordinary paths.

## Shared Sessions are excluded

The release does not provide shared listening rooms, host/controller playback,
room membership or contribution queues, invitation codes or links, private room
personas, shared-session recaps or public recap pages. Neither the V1 Sessions
handler nor the disabled V2 protocol, admission, privacy, receipt or terminal
feature graph is part of the release. The Sessions worker and Sessions-only
command schemas, fixtures, tests and design contracts are removed with that graph.

`/api/sessions` and `/api/_listening-tick` are not release APIs. Do not interpret
archived feature plans or old qualification counts as evidence that those
capabilities remain available.

## Retained boundaries

- App authentication sessions, exact-bearer authorization, canonical auth writer
  locking and token-row privileges remain security requirements for ordinary
  account and credential operations.
- Account deletion, sign-out, revocation and credential rotation keep their
  existing data-integrity and provider-security guarantees.
- Spotify connection enrollment, current-track lookup, lyric acquisition,
  refresh ownership and revocation remain in scope. Shared-room playback and
  private session-playlist permissions are not prerequisites for those paths.
- `api/utils/listening-reviewed-recordings.js` reviews ordinary lyric timing. Its
  name does not make it part of shared Sessions; preserve it and its regression
  tests, together with source/document/learning identity safeguards.
- Dashboard browser sessions and provider authentication sessions are unrelated
  to shared Sessions and are not removed by this scope boundary.

Historical SQL migrations, applied migration receipts and the account-delete
privileges needed for existing database state are a separate compatibility and
security boundary. Removing runtime feature code does not authorize rewriting
migration history, dropping deployed tables or deleting user data.

Maintained authentication helpers live under `api/utils/app-auth`, and retained
account-data cleanup lives under `api/utils/membership/account-data-privacy.js`.
Neutral migration 036 preserves the catalog-checked optional V1 DELETE-predicate
privilege repair in normal upgrades and late-role provisioning. Historical
029/030/031/033/034/035 SQL remains unchanged but inactive.

Account deletion refuses with `account_data_cleanup_required` (503) whenever a
retained `listening_v2` namespace is present or its catalog check is inconclusive.
This fail-closed stopgap is not completed erasure. A populated retained schema
requires a qualified data-only disposition independent of the removed protocol,
without destroying output guards or external cleanup identifiers. Retiring the
worker also requires checking retained rooms, outbox work and provider-playlist
cleanup obligations; do not infer their absence from source removal.

For an existing database, apply the reviewed migration with
`migrateLibrary(database, {expectedPending: [{name, sha256}]})`. The runner holds
its transaction and advisory lock while checking every active receipt and the
complete ordered pending name/digest list, before applying any migration SQL.
Any additional, missing, already-applied or changed migration fails closed.
For this retirement, only `036-account-data-privacy.sql` is eligible; retain its
reviewed digest with the deployment evidence. Disable
`LYRA_LIBRARY_MIGRATE_ON_BUILD` for the production build after that bounded
upgrade. Its broad migration mode also repairs source content and translation
reuse and is not part of this release operation.

## Archived source

The removed feature source and its historical design/qualification evidence are
recoverable from the pushed tag
`archive/pre-initial-scope-cut-20261101-backend`, which resolves to commit
`20e8c3c9379e10740a538d245ae63f9fe7f27a63`. For example:

```bash
git show archive/pre-initial-scope-cut-20261101-backend:docs/SESSIONS.md
git show archive/pre-initial-scope-cut-20261101-backend:docs/design/sessions-v2-architecture.md
```

Recovery is for inspection. Reintroducing shared Sessions requires an explicit
future product decision and fresh implementation, security and release
verification; the archive is not an active release contract.
