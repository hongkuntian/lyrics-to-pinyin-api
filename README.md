# Lyrics Romanization API

A Node.js serverless backend (Vercel) for romanizing multilingual lyrics and text.

## Current Scope

- Languages: `zh`, `yue`, `ja`, `ko`, `ru`
- Endpoints:
  - `POST /api/romanize`
  - `POST /api/music-romanize`
  - `POST /api/song-library`
  - `POST /api/app-auth` (beta enrollment and renewal only)
- Music sources currently enabled in runtime registry:
  - `netease`
  - `lrclib`

Lyric discovery through LRCLIB accepts other language tags, including Latin,
Cyrillic, Arabic and Indic scripts. Discovery support does not guarantee provider
coverage or a pronunciation processor. Original words stay readable when a
language or pronunciation dialect cannot be established.

## Storefront-independent lyric resolution

Version 2.5 keeps catalog identity separate from localized display names. Send
the original `catalog_id`, `storefront`, album and duration; `account_storefront`
and `isrc` are optional hints. The server checks the item across US, HK, TW, CN,
JP, KR and the caller's territories with three concurrent reads under a 2.5 second
catalog budget. Fixed verified query order lets Japanese and international titles
find the same timed source. The total provider budget remains 16 seconds, with at
most four name queries and two concurrent providers per query.

Configure `APPLE_MUSIC_TEAM_ID`, `APPLE_MUSIC_KEY_ID` and
`APPLE_MUSIC_PRIVATE_KEY` in server environment variables. The ES256 private key
must stay outside source control and app bundles. Authenticated lookup negotiates
the storefront's advertised languages, requests equivalent IDs and falls back to
ISRC lookup. Cross-ID timing requires a single candidate with matching server
ISRC, full artist IDs, content rating, version markers and duration within 0.5
seconds. A client ISRC alone cannot establish equivalence. Same-ID public iTunes
lookup remains available if server authentication or Apple catalog calls fail.

Verified recordings share a bounded memory cache and in-flight provider work;
responses retain each caller's original catalog anchor. Migration 020 adds durable
catalog bindings and separate text, timing and reading revisions without changing
existing document IDs or generation keys. Complete lyrics outrank partial timing.
Translations bridge historical localized names only with verified catalog evidence
and exact ordered words, language and speaker turns. Archived source references
remain readable, while retired sources retain the existing paid-generation fence.

`metadata.language_details` reports script, estimated language, uncertainty and
mixed passages independently of reading support. Han text alone never proves
Mandarin or Cantonese. `metadata.timing_quality` separates usable timestamp
coverage from listening-reviewed alignment. `lyrics_resolution` logs contain
method, territory count, language and quality, without keys, tokens or lyric text.

Set `LYRA_CATALOG_EQUIVALENTS_ENABLED=0` to disable cross-ID recovery, or
`LYRA_CATALOG_RESOLUTION_ENABLED=0` to disable catalog discovery. No lyric words
or timing are synthesized. Missing provider coverage, ambiguous versions and
uncertain short-language samples remain explicit limits.

## Endpoints

App endpoints require a short-lived App Attest session bearer. Anonymous calls
and raw beta credentials are rejected. This is a deliberate breaking change;
see [API security and operator controls](docs/APP_AUTH.md) for enrollment,
deployment isolation, spend limits and revocation. The examples below show
business JSON bodies after authentication.

### `POST /api/romanize`
Romanize text with optional language override and per-language options.

Example request:

```json
{
  "text": "你好世界",
  "language": "zh",
  "romanization_system": "pinyin",
  "options": {
    "tone_style": "marks",
    "separator": " ",
    "case": "lower"
  }
}
```

### `POST /api/music-romanize`
Fetch and romanize song title/artist/lyrics.

Example request:

```json
{
  "artist": "周杰伦",
  "title": "稻香",
  "language": "zh",
  "romanization_system": "pinyin",
  "music_platform": "netease",
  "options": {
    "tone_style": "marks",
    "separator": " ",
    "case": "lower"
  }
}
```

## Setup

1. Install:

```bash
npm ci
```

2. Optional `.env.local`:

```bash
# Optional Redis cache (disabled locally if missing)
LYRICS_KV_REST_API_URL=your_kv_rest_api_url_here
LYRICS_KV_REST_API_TOKEN=your_kv_rest_api_token_here

# Optional creds for not-yet-enabled integrations
SPOTIFY_CLIENT_ID=your_spotify_client_id_here
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here
GENIUS_ACCESS_TOKEN=your_genius_access_token_here
```

3. Start local server:

```bash
npm run dev
```

## Quick Start For Agents

1. Sync and install:

```bash
git pull --rebase
npm ci
```

2. Make one scoped change.
3. Update tests first (or alongside code).
4. Run required gates:

```bash
npm test
```

5. Include test evidence in PR.

## Testing

This repo uses a gated, hermetic-first test model.

- `npm test`: runs all required hermetic gates
- `npm run test:unit`: pure module tests
- `npm run test:integration`: handler-level tests with mocked dependencies
- `npm run test:contract`: schema + compatibility checks
- `npm run test:live`: read-only production checks for anonymous/legacy credential denial
- `npm run test:legacy`: historical unauthenticated API script; incompatible with the secured endpoints

### Contract and compatibility tests

- JSON schemas are in `contracts/`
- Contract tests are in `tests/contracts/`
- Lyra compatibility test verifies decode-critical response fields used by the app model

## CI

GitHub Actions runs `npm test` on push/PR to `main`.

Workflow file:

- `.github/workflows/ci.yml`

## Agent-first workflow

- `AGENTS.md` defines operating rules and definition of done.
- `CONTRIBUTING.md` defines PR checklist and review expectations.

## Deployment

```bash
npm run deploy
```

Configured for Vercel via `vercel.json`.

## Multilingual song content

See [the backend contract and rollout guide](docs/MULTILINGUAL_BACKEND.md) for target-aware translations, independent explanation languages, and original or translated-text Study. New language directions remain disabled until evaluated.

See [pronunciation aids](docs/PRONUNCIATION_AIDS.md) for Japanese/Korean profiles, source alignment, migration, rollback and future notation support.
