# Development Guide

## Quick Start

1. Install dependencies:

```bash
npm ci
```

2. Optional environment variables in `.env.local`:

```bash
LYRICS_KV_REST_API_URL=your_kv_rest_api_url_here
LYRICS_KV_REST_API_TOKEN=your_kv_rest_api_token_here
PORT=3000
```

Redis is optional for local dev; caching is skipped if env vars are missing.

3. Start local API:

```bash
npm run dev
```

4. Run hermetic test gates:

```bash
npm test
```

## Test Architecture

### Required gates (merge blockers)

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:contract`

`npm test` runs all of the above in sequence.

### Optional live checks

- `npm run test:live`

Use for periodic upstream validation only. Do not treat as deterministic CI signal.

## Local Manual Testing

Romanize endpoint:

```bash
curl -X POST http://localhost:3000/api/romanize \
  -H "Content-Type: application/json" \
  -d '{"text":"你好世界","language":"zh"}'
```

Music endpoint:

```bash
curl -X POST http://localhost:3000/api/music-romanize \
  -H "Content-Type: application/json" \
  -d '{"artist":"周杰伦","title":"稻香","language":"zh"}'
```

## Debugging

- Health check: `curl http://localhost:3000/health`
- Review server logs from `npm run dev`
- If Redis is missing locally, expect a warning but not a hard failure

## Conventions

- Keep handler logic dependency-injectable for testability.
- Keep default tests hermetic.
- Update contracts in `contracts/` when response shape changes.
- For process rules and definition of done, follow `AGENTS.md` and `CONTRIBUTING.md`.

## Deployment

```bash
npm run deploy
```

Set required environment variables in Vercel project settings.
