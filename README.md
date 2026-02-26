# Lyrics Romanization API

A Node.js serverless backend (Vercel) for romanizing multilingual lyrics and text.

## Current Scope

- Languages: `zh`, `yue`, `ja`, `ko`, `ru`
- Endpoints:
  - `POST /api/romanize`
  - `POST /api/music-romanize`
- Music sources currently enabled in runtime registry:
  - `netease`
  - `lrclib`

## Endpoints

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
- `npm run test:live`: optional live upstream smoke tests (non-blocking)
- `npm run test:legacy`: original ad hoc API script

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
