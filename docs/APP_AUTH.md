# Lyrica private beta API security

This is a hard cutover. Every app API call requires a session issued to an
attested Lyrica installation with valid beta access. Older app builds, raw beta
credentials and anonymous scripts cannot use the business endpoints. Saved
content and the bundled practice song continue to work offline.

## Trust boundary and protocol

`POST /api/app-auth` is the only endpoint that accepts the existing beta
credential, in `Authorization: Bearer <credential>`. Credentials are generated
randomly, held in iOS Keychain and stored as SHA-256 digests on the server.
No common app secret or provider key is embedded in the binary.

All messages contain `action`, `keyID` (base64 of 32 bytes) and `bundleID`.
The challenge action also supplies `purpose: register|session`. It returns a
random 32-byte base64url string. The client hashes the UTF-8 bytes of that exact
string with SHA-256 for App Attest's `clientDataHash`; it does not decode the
string before hashing. Challenges expire after 120 seconds and bind the
credential, key, bundle, purpose and deployment audience in Postgres.

The register action sends `challenge` and base64 `attestation`. Verification
checks the Apple certificate chain and validity, nonce, public key ID, App ID,
initial counter, credential ID and exact production/development environment.
The response is only `{version:1, registered:true}`. Repeating registration can
recover a lost acknowledgment; it can never issue a session.

The session action sends a fresh challenge and base64 `assertion`. The server
verifies the signature and App ID and advances the strictly increasing counter
under a database lock. Consumed challenges and counter races cannot mint another
session. The response contains `{version:1, token, expiresAt}`. The opaque
`lyra_s_…` token expires in 15 minutes and is stored only as a digest server-side.
Issuing a new session retires previous sessions for that key.

`/api/music-romanize`, `/api/romanize` and `/api/song-library` accept only these
session bearers. Each request checks current credential, account and key
revocation, audience, allowed bundle, environment and expiry before domain work.
Responses are private and never CDN-cacheable. Library-internal lyric loading
calls the domain service directly; request headers cannot select that path.
`GET /api/review-reports` remains an operator cron endpoint requiring its
production-only `CRON_SECRET`, with no app-session or anonymous access.

## Limits and containment

- Auth: 30 calls per minute per account; at most eight outstanding challenges.
- Business APIs: 60 calls per minute per account across all instances/routes.
- Explicit lyric refresh: six calls per minute per account.
- Bodies: auth/text/music 32 KiB, library 8 KiB. Text, metadata, base64 and
  option fields have additional bounds.
- Coarse Vercel IP rule: POST under `/api/`, 300 requests per 60 seconds.
  This covers Vercel's `.js` function aliases as well as the canonical app routes;
  the cron uses GET. Shared IPs share this allowance. Counters are per region.
- Emergency spend: default $5 per UTC day and $50 per UTC month, including
  held reservations, generation, Study, retries and reviews. Personal unlimited
  access bypasses ordinary quotas, never these emergency caps. Database triggers
  serialize admissions. Workers recheck the kill switch and emergency budget;
  user-owned generation also rechecks account disable before submission.

The emergency cap bounds admitted reservations, not an absolute billing promise.
A request already submitted cannot be recalled; unexpectedly higher actual
provider cost disables further paid work through existing settlement controls.

## Deployment configuration

Production requires these server variables:

| Variable | Purpose |
| --- | --- |
| `LYRA_APP_AUTH_AUDIENCE` | `lyra-production` |
| `LYRA_APP_ATTEST_ENVIRONMENT` | `production` |
| `LYRA_APP_ID_PREFIX` | Actual App ID prefix from Apple Developer |
| `LYRA_APP_BUNDLE_IDS` | Comma-separated exact bundle allowlist |
| `LYRA_LIBRARY_DATABASE_URL` | Restricted runtime role |
| `LYRA_LIBRARY_MIGRATE_ON_BUILD` | `0`; migrations are operator-only |

Apple Music, OpenAI, Redis, mail, cron and database credentials must be Sensitive,
production-only Vercel variables. Preview/development receive no production keys,
database or cache. With no auth policy/database, app endpoints fail closed. Local
hermetic tests inject fixtures explicitly; there is no runtime test bypass.

The runtime role cannot create schema, rotate credentials, grant unlimited
access, change budget caps or run migrations. Keep the owner connection outside
Vercel. On the developer Mac, owner and restricted runtime configurations live
in `~/.config/lyra/credentials/backend-admin/{migration,runtime}.json` with mode
0600 inside a 0700 directory. MusicKit credentials stay in the separate private
Apple Music credential directory. Never commit these files or print their values.

Apply the latest migration with the owner connection before deploying. Live Lyrics push requires migrations 022 and 023, including the restricted runtime grants for its two tables. Production builds
verify the latest migration receipt; they do not migrate with elevated runtime
permissions. Deploy the updated server and install the updated app together.

## Operator commands

Run from this repository; `--database-config-file` reads the owner-only private
JSON directly, avoiding secrets in command arguments, shell exports and logs:

```sh
node scripts/song-library-admin.js usage --database-config-file ~/.config/lyra/credentials/backend-admin/migration.json
node scripts/song-library-admin.js configure-emergency --daily-usd 5 --monthly-usd 50 --database-config-file ~/.config/lyra/credentials/backend-admin/migration.json
node scripts/song-library-admin.js disable --database-config-file ~/.config/lyra/credentials/backend-admin/migration.json
node scripts/song-library-admin.js disable-user --id USER_ID --database-config-file ~/.config/lyra/credentials/backend-admin/migration.json
node scripts/song-library-admin.js revoke-sessions --id USER_ID --database-config-file ~/.config/lyra/credentials/backend-admin/migration.json
node scripts/song-library-admin.js revoke-key --id BASE64_KEY_ID --database-config-file ~/.config/lyra/credentials/backend-admin/migration.json
node scripts/song-library-admin.js user --id USER_ID --token-file /private/path/new-access.txt --database-config-file ~/.config/lyra/credentials/backend-admin/migration.json
```

Credential rotation preserves account usage and immediately invalidates sessions
bound to older credentials. Disabling an account revokes its credentials, keys
and sessions. Session-only revocation permits fresh attestation assertions to
renew access; key revocation prevents that installation from renewing.
The global disable command stops new paid work and reviews, while saved reads
remain available. Re-enable only after inspection with the existing `configure`
and `configure-reviews` commands and explicit budget values.

## Verification and accepted limits

`npm test` is hermetic. It verifies HTTP denial before provider/cache work,
real recorded Apple cryptographic fixtures, nonce/counter replay, expiry,
credential/key/account revocation, deployment isolation, durable quotas,
concurrent emergency admissions and worker shutdown. Fixtures do not prove live
Apple availability: use the Debug-only physical app probe to verify production
enrollment, renewal and authenticated lyric/romanization calls on an actual
signed iPhone. Simulators have no production fallback.

App Attest raises the cost of impersonation; it does not make a public URL
private or prevent abuse by an authorized device. A stolen bearer can be replayed
until expiry or revocation. This beta deliberately uses 15-minute sessions rather
than request-by-request assertion signatures. There is no user login system,
device-count policy, jailbreak detection or Apple receipt risk assessment yet.

See Apple's [validation guide](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server)
and Vercel's [rate limiting guide](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting).
