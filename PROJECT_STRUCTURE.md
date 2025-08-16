# Project Structure

```
lyrics-to-pinyin-api/
├── api/                          # API endpoints (Vercel serverless functions)
│   ├── romanize.js              # Generic romanization endpoint
│   ├── music-romanize.js        # Music romanization endpoint
│   ├── processors/              # Language processors
│   │   ├── index.js            # Processor registry
│   │   ├── chinese.js          # Mandarin (zh) processor
│   │   ├── cantonese.js        # Cantonese (yue) processor
│   │   ├── japanese.js         # Japanese (ja) processor
│   │   ├── korean.js           # Korean (ko) processor
│   │   └── russian.js          # Russian (ru) processor
│   ├── music-apis/             # Music platform integrations
│   │   ├── index.js            # Music API registry
│   │   ├── netease.js          # Netease Cloud Music
│   │   ├── spotify.js          # Spotify
│   │   └── genius.js           # Genius
│   └── utils/                  # Utility modules
│       ├── language-detection.js
│       ├── cache.js
│       └── response-formatter.js
├── scripts/                     # Development and build scripts
│   └── dev-server.js           # Local development server
├── tests/                       # Test files
│   ├── api-tests.js            # API test suite
│   └── golden-test-corpus.json # Test data for each language
├── package.json                 # Project configuration
├── vercel.json                  # Vercel deployment config
├── .gitignore                   # Git ignore rules
├── README.md                    # Project documentation
└── PROJECT_STRUCTURE.md         # This file
```

## Directory Purposes

### `/api/`
Contains all Vercel serverless functions and supporting code:
- **Endpoints**: Main API entry points
- **Processors**: Language-specific romanization logic
- **Music APIs**: Platform integrations for fetching lyrics
- **Utils**: Shared utility functions

### `/scripts/`
Development and deployment scripts:
- **dev-server.js**: Local development server for testing

### `/tests/`
Testing infrastructure:
- **api-tests.js**: Comprehensive API test suite
- **golden-test-corpus.json**: Test data for regression testing

## Key Files

### API Endpoints
- `api/romanize.js`: Generic text romanization
- `api/music-romanize.js`: Music lyrics romanization

### Language Processors
- `api/processors/chinese.js`: Mandarin pinyin conversion
- `api/processors/cantonese.js`: Cantonese jyutping conversion
- `api/processors/japanese.js`: Japanese romaji conversion
- `api/processors/korean.js`: Korean romanization
- `api/processors/russian.js`: Russian transliteration

### Music Platform Integrations
- `api/music-apis/netease.js`: Chinese music platform
- `api/music-apis/spotify.js`: Global music platform
- `api/music-apis/genius.js`: English/Russian lyrics

## Development Workflow

1. **Local Development**: `npm run dev`
2. **Testing**: `npm test`
3. **Deployment**: `npm run deploy`

## Adding New Languages

1. Create processor in `/api/processors/`
2. Register in `/api/processors/index.js`
3. Add detection patterns in `/api/utils/language-detection.js`
4. Add test cases in `/tests/golden-test-corpus.json`
5. Update documentation in `/README.md`
