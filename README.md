# Lyrics to Pinyin API

A serverless API that converts Chinese lyrics to pinyin with Redis caching powered by Upstash.

## Features

- Converts Chinese lyrics to pinyin with tone marks
- Caches results in Upstash Redis for improved performance
- Integrates with Netease Cloud Music API for song lookup
- Deployed on Vercel

## Setup Instructions

### 1. Upstash Redis Integration

You've already onboarded Upstash Redis to your Vercel project. Here's how to complete the setup:

#### Get Your Upstash Redis Credentials

1. Go to your [Vercel project dashboard](https://vercel.com/patricks-projects-6b005567/lyrics-to-pinyin-api)
2. Navigate to Settings → Environment Variables
3. Add the following environment variables from your Upstash Redis dashboard:
   - `UPSTASH_REDIS_REST_URL`: Your Upstash Redis REST URL
   - `UPSTASH_REDIS_REST_TOKEN`: Your Upstash Redis REST Token

#### Local Development

1. Create a `.env.local` file in your project root:
```bash
UPSTASH_REDIS_REST_URL=your_upstash_redis_rest_url_here
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_rest_token_here
```

2. Install dependencies:
```bash
npm install
```

3. Run locally (if you have Vercel CLI):
```bash
vercel dev
```

### 2. API Usage

Send a POST request to `/api/lyrics-to-pinyin` with:

```json
{
  "artist": "周杰伦",
  "title": "稻香"
}
```

Response format:
```json
{
  "song": {
    "title": {
      "original": "稻香",
      "pinyin": "dào xiāng"
    },
    "artist": {
      "original": "周杰伦",
      "pinyin": "zhōu jié lún"
    },
    "id": "123456"
  },
  "lines": [
    {
      "original": "对这个世界如果你有太多的抱怨",
      "pinyin": "duì zhè ge shì jiè rú guǒ nǐ yǒu tài duō de bào yuàn"
    }
  ]
}
```

### 3. Deployment

The project is configured for Vercel deployment with:
- Serverless function timeout: 30 seconds
- Environment variables automatically linked to Upstash Redis
- Automatic caching of API responses

## Dependencies

- `@upstash/redis`: Redis client for Upstash
- `pinyin-pro`: Chinese to pinyin conversion
- `chinese-conv`: Chinese character conversion utilities
- `express`: Web framework (via Vercel's serverless functions)
- `node-fetch`: HTTP client for API calls

## Environment Variables

- `UPSTASH_REDIS_REST_URL`: Your Upstash Redis REST URL
- `UPSTASH_REDIS_REST_TOKEN`: Your Upstash Redis REST Token

## Caching Strategy

The API caches responses using the format: `lyrics:{artist}-{title}` with no expiration to maximize performance for frequently requested songs. 