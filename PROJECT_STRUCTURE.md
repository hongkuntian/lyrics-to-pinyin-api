# Project Structure

```
lyrics-to-pinyin-api/
├── api/                          # Vercel serverless handlers and core logic
│   ├── romanize.js               # /api/romanize handler (DI factory + default export)
│   ├── music-romanize.js         # /api/music-romanize handler (DI factory + default export)
│   ├── processors/               # Language-specific romanization processors
│   │   ├── index.js
│   │   ├── chinese.js
│   │   ├── cantonese.js
│   │   ├── japanese.js
│   │   ├── korean.js
│   │   └── russian.js
│   ├── music-apis/               # Music provider adapters and registry
│   │   ├── index.js
│   │   ├── netease.js
│   │   ├── lrclib.js
│   │   ├── spotify.js            # Placeholder/not enabled in runtime registry
│   │   └── genius.js             # Placeholder/not enabled in runtime registry
│   └── utils/
│       ├── language-detection.js
│       ├── cache.js
│       └── response-formatter.js
├── contracts/                    # API response schemas for contract tests
│   ├── romanize-success.schema.json
│   ├── music-romanize-success.schema.json
│   └── error.schema.json
├── tests/
│   ├── corpus/                   # Language corpus fixtures
│   ├── unit/                     # Hermetic unit tests
│   ├── integration/              # Handler-level tests with mocks
│   ├── contracts/                # Schema + compatibility tests
│   ├── helpers/                  # Test request/response helpers
│   ├── api-tests.js              # Legacy/live-style script
│   ├── music-tests.js            # Legacy/live-style script
│   ├── run-language-tests.js     # Legacy language script
│   └── corpus-loader.js
├── scripts/
│   └── dev-server.js             # Local dev server wrapper for handlers
├── .github/workflows/
│   └── ci.yml                    # Required hermetic test workflow
├── AGENTS.md                     # Agent operating rules and DoD
├── CONTRIBUTING.md               # Contributor workflow and PR checklist
├── DEVELOPMENT.md                # Local dev/testing guide
├── README.md                     # User-facing overview
├── package.json
└── vercel.json
```

## Testing Entry Points

- `npm test`: `unit -> integration -> contract`
- `npm run test:live`: optional live upstream smoke tests
- `npm run test:legacy`: original ad hoc API test script

## Notes

- Runtime support matrix should be derived from registries (`api/processors/index.js`, `api/music-apis/index.js`) rather than hardcoded docs.
- Keep this file synced whenever test layout or runtime provider registration changes.
