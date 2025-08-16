# Generic Romanization API - MVP

A serverless API that converts text from five core languages to their romanized forms, with support for multiple romanization systems and music platform integrations.

## Features

- **Five Core Languages**: Mandarin (zh), Cantonese (yue), Japanese (ja), Korean (ko), Russian (ru)
- **Automatic Language Detection**: Detects the language of input text automatically
- **Multiple Romanization Systems**: Choose from different romanization standards for each language
- **Music Platform Integration**: Fetch and romanize lyrics from Netease Cloud Music, Spotify, Genius
- **Redis Caching**: Caches results in Upstash Redis for improved performance
- **Plugin Architecture**: Easy to extend with new languages and romanization systems
- **Deployed on Vercel**

## API Endpoints

### 1. Generic Romanization (`/api/romanize`)

Convert any text to its romanized form.

**Request:**
```json
{
  "text": "你好世界",
  "language": "zh", // optional, auto-detected if not provided
  "romanization_system": "pinyin", // optional, defaults to standard for script
  "options": {
    "tone_style": "marks", // marks, numbers, none (for zh, yue)
    "separator": " ", // space or hyphen
    "case": "lower", // lower, upper, title
    "normalize_variants": true, // zh: normalize trad/simp before romanizing
    "long_vowels": "macron" // macron, circumflex, double (for ja)
  }
}
```

**Response:**
```json
{
  "original": "你好世界",
  "romanized": "nǐ hǎo shì jiè",
  "language": "zh",
  "romanization_system": "pinyin",
  "confidence": 0.95,
  "spans": [
    { "range": [0, 4], "script": "zh", "romanized": "nǐ hǎo shì jiè" }
  ],
  "metadata": {
    "detected_script": "zh",
    "processing_time": 45,
    "processor": "ChineseProcessor",
    "timestamp": "2024-01-01T00:00:00.000Z",
    "version": "2.0.0"
  }
}
```

### 2. Music Romanization (`/api/music-romanize`)

Fetch and romanize song lyrics from music platforms.

**Request:**
```json
{
  "artist": "周杰伦",
  "title": "稻香",
  "language": "zh", // optional
  "romanization_system": "pinyin", // optional
  "music_platform": "netease", // optional, auto-selected based on script
  "options": {
    "tone_style": "marks",
    "separator": " ",
    "case": "lower"
  }
}
```

**Response:**
```json
{
  "song": {
    "title": {
      "original": "稻香",
      "romanized": "dào xiāng"
    },
    "artist": {
      "original": "周杰伦",
      "romanized": "zhōu jié lún"
    },
    "id": "123456",
    "language": "zh",
    "romanization_system": "pinyin"
  },
  "lines": [
    {
      "original": "对这个世界如果你有太多的抱怨",
      "romanized": "duì zhè ge shì jiè rú guǒ nǐ yǒu tài duō de bào yuàn",
      "timestamp": 0
    }
  ],
  "quality": {
    "synced": true
  },
  "metadata": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "version": "2.0.0",
    "source": "netease",
    "detected_script": "zh",
    "processing_time": 120,
    "processor": "ChineseProcessor",
    "music_api": "NeteaseAPI"
  }
}
```

## Migration from v1.0

### Endpoint Changes
- **Old**: `/api/lyrics-to-pinyin`
- **New**: `/api/music-romanize`

### Response Structure Changes
- `pinyin` field → `romanized` field (more generic)
- New `quality` object with `synced` flag
- New `metadata` object with processing information
- `timestamp` field added to lyric lines

### Minimal Migration Example (Swift)

```swift
// Old endpoint
let url = URL(string: "https://lyrics-to-pinyin-api.vercel.app/api/lyrics-to-pinyin")

// New endpoint
let url = URL(string: "https://lyrics-to-pinyin-api.vercel.app/api/music-romanize")

// Old response model
struct LyricLine: Codable {
    let original: String
    let pinyin: String
}

// New response model
struct LyricLine: Codable {
    let original: String
    let romanized: String // Changed from "pinyin"
    let timestamp: Double? // New field
}
```

## Supported Scripts and Systems

### Mandarin (zh)
- **Pinyin** (default): Standard Chinese romanization with tone marks
- **Options**: `tone_style` (marks/numbers/none), `normalize_variants`

### Cantonese (yue)
- **Jyutping** (default): Cantonese romanization with tone numbers
- **Options**: Always returns tone numbers

### Japanese (ja)
- **Hepburn** (default): Most common romanization system
- **Options**: `long_vowels` (macron/circumflex/double)

### Korean (ko)
- **Revised** (default): South Korean government standard
- **Features**: Handles 받침 assimilation (e.g., 국물 → gukmul)

### Russian (ru)
- **ISO 9** (default): International standard
- **BGN/PCGN** (optional): Alternative system
- **Features**: Handles ё vs е, ый endings, щ/ь/ъ

## Music Platform Support

| Script | Platforms |
|--------|-----------|
| Mandarin (zh) | Netease Cloud Music, Spotify |
| Cantonese (yue) | Spotify |
| Japanese (ja) | Spotify |
| Korean (ko) | Spotify |
| Russian (ru) | Spotify, Genius |
| English (en) | Spotify, Genius |

## Setup Instructions

### 1. Environment Variables

Create a `.env.local` file in your project root:

```bash
# Required: Upstash Redis
UPSTASH_REDIS_REST_URL=your_upstash_redis_rest_url_here
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token_here

# Optional: Music API credentials
SPOTIFY_CLIENT_ID=your_spotify_client_id_here
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here
GENIUS_ACCESS_TOKEN=your_genius_access_token_here
```

### 2. Installation

```bash
npm install
```

### 3. Development

```bash
npm run dev
```

### 4. Deployment

The project is configured for Vercel deployment with automatic environment variable linking.

## Architecture

```
/api/
├── romanize.js              # Generic romanization endpoint
├── music-romanize.js        # Music romanization endpoint
├── processors/              # Script processors
│   ├── index.js            # Processor registry
│   ├── chinese.js          # Mandarin romanization
│   ├── cantonese.js        # Cantonese romanization
│   ├── japanese.js         # Japanese romanization
│   ├── korean.js           # Korean romanization
│   └── russian.js          # Russian romanization
├── music-apis/             # Music platform integrations
│   ├── index.js            # API registry
│   ├── netease.js          # Netease Cloud Music
│   ├── spotify.js          # Spotify
│   └── genius.js           # Genius
└── utils/                  # Utility modules
    ├── language-detection.js
    ├── cache.js
    └── response-formatter.js
```

## Testing

The project includes a golden test corpus (`tests/golden-test-corpus.json`) with sample text for each language:

- **Mandarin**: "不对", "很好", "一共有"
- **Cantonese**: "行", "更" (polyphonic characters)
- **Japanese**: Words with long vowels, sokuon, chōon
- **Korean**: 받침 assimilation (e.g., 국물 → gukmul)
- **Russian**: ё vs е, ый endings, щ/ь/ъ handling

## Implementation Notes

### Language Libraries
- **Mandarin (zh)**: `pinyin-pro` + `chinese-conv` for normalization
- **Cantonese (yue)**: `jyutping` or `cantonese.js` dictionaries
- **Japanese (ja)**: `kuroshiro` + `kuromoji`
- **Korean (ko)**: `hangul-romanization` or `korean-romanizer`
- **Russian (ru)**: `cyrillic-to-translit-js` or mapping table

### Rollout Order
1. ✅ Mandarin + Japanese (base libraries are stable)
2. ✅ Korean
3. ✅ Russian
4. ✅ Cantonese

## Caching Strategy

- **Cache Keys**: SHA-256 hash of text, script, system, and options
- **TTL**: Configurable per endpoint (default: no expiration)
- **Pattern**: `romanize:{hash}` for generic, `music:{hash}` for music

## Error Handling

The API provides detailed error responses with:
- HTTP status codes
- Error messages
- Timestamps
- API version information

## Performance

- **Script Detection**: ~5ms
- **Romanization**: ~10-50ms per line
- **Music API Calls**: ~100-500ms
- **Cache Hits**: ~1-5ms

## Dependencies

- `@upstash/redis`: Redis client for Upstash
- `pinyin-pro`: Chinese to pinyin conversion
- `chinese-conv`: Chinese character conversion utilities
- `express`: Web framework (via Vercel's serverless functions)
- `node-fetch`: HTTP client for API calls

## License

MIT License - see LICENSE file for details. 