# Development Guide

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Setup (Optional for Local Development)
Create a `.env.local` file in the project root:

```bash
# Upstash Redis Configuration (Required for production, optional for local development)
UPSTASH_REDIS_REST_URL=your_upstash_redis_rest_url_here
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token_here

# Music API Credentials (Optional - for enhanced music platform support)
SPOTIFY_CLIENT_ID=your_spotify_client_id_here
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here
GENIUS_ACCESS_TOKEN=your_genius_access_token_here

# Development Server Configuration (Optional)
PORT=3000
```

**Note**: The API works without Redis for local development, but caching will be disabled.

### 3. Start Development Server
```bash
npm run dev
```

The server will start on `http://localhost:3000`

### 4. Test the API
```bash
# Run the test suite
npm test

# Manual testing
curl -X POST http://localhost:3000/api/romanize \
  -H "Content-Type: application/json" \
  -d '{"text": "你好世界", "language": "zh"}'
```

## 🔧 Development Workflow

### Making Changes
1. Edit files in the `api/` directory
2. The server auto-restarts on file changes
3. Test your changes with `npm test` or manual API calls

### Testing
- **Full Test Suite**: `npm test`
- **Individual Endpoints**: Use curl or Postman
- **Golden Test Corpus**: Located in `tests/golden-test-corpus.json`

### Debugging
- Check server logs in the terminal
- Use the health endpoint: `curl http://localhost:3000/health`
- Monitor Redis connection status in logs

## 🐛 Troubleshooting

### Common Issues

#### "Cannot find package 'cors'"
```bash
npm install
```

#### "Redis configuration missing"
This is normal for local development. The API will work without Redis, just without caching.

#### "No music API available for script"
Currently only Chinese (zh) and Cantonese (yue) music APIs are implemented. Other languages will return this error.

#### Port already in use
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Or change port in .env.local
PORT=3001
```

### API Response Format

#### Generic Romanization (`/api/romanize`)
```json
{
  "original": "你好世界",
  "romanized": "nǐ hǎo shì jiè",
  "language": "zh",
  "romanization_system": "pinyin",
  "confidence": 0.95,
  "spans": [],
  "metadata": {
    "timestamp": "2025-08-16T16:36:23.517Z",
    "version": "2.0.0",
    "detected_script": "zh",
    "processing_time": 1,
    "processor": "ChineseProcessor"
  }
}
```

#### Music Romanization (`/api/music-romanize`)
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
    "id": 123456,
    "language": "zh",
    "romanization_system": "pinyin"
  },
  "lines": [
    {
      "original": "对这个世界如果",
      "romanized": "duì zhè ge shì jiè rú guǒ",
      "timestamp": 29.19
    }
  ],
  "quality": {
    "synced": true
  },
  "metadata": {
    "timestamp": "2025-08-16T16:36:36.244Z",
    "version": "2.0.0",
    "source": "NeteaseAPI"
  }
}
```

## 📁 Project Structure

```
lyrics-to-pinyin-api/
├── api/                    # Vercel serverless functions
│   ├── romanize.js        # Generic romanization endpoint
│   ├── music-romanize.js  # Music romanization endpoint
│   ├── processors/        # Language processors
│   ├── music-apis/        # Music platform integrations
│   └── utils/             # Shared utilities
├── scripts/
│   └── dev-server.js      # Local development server
├── tests/
│   ├── api-tests.js       # Test suite
│   └── golden-test-corpus.json
├── package.json
└── README.md
```

## 🚀 Deployment

```bash
# Deploy to Vercel
npm run deploy
```

Make sure to set up environment variables in your Vercel dashboard for production.
