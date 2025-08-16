import { Redis } from "@upstash/redis";
import { detectLanguage, getDefaultRomanizationSystem } from "./utils/language-detection.js";
import { getProcessor } from "./processors/index.js";
import { formatMusicResponse } from "./utils/response-formatter.js";
import { getCacheKey, getCached, setCached } from "./utils/cache.js";
import { getMusicAPI } from "./music-apis/index.js";

// Initialize Redis only if environment variables are available
let redis = null;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  redis = new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
}

export default async function handler(req, res) {
  // Log Redis status but don't fail if missing (for local development)
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("❌ Missing Upstash Redis environment variables");
    // Don't return error - continue without caching
  }

  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { 
    artist, 
    title, 
    language, 
    romanization_system, 
    music_platform,
    options = {} 
  } = req.body;

  if (!artist || !title) {
    return res.status(400).json({ error: "Missing 'artist' or 'title' parameter" });
  }

  try {
    // Auto-detect script if not provided
    const detectedScript = language || await detectLanguage(`${artist} ${title}`);
    
    // Get appropriate music API for the script/platform
    const musicAPI = getMusicAPI(detectedScript, music_platform);
    if (!musicAPI) {
      return res.status(400).json({ 
        error: `No music API available for script '${detectedScript}' and platform '${music_platform}'`,
        supported_combinations: await getSupportedMusicAPIs()
      });
    }

    // Use default romanization system if not specified
    const system = romanization_system || getDefaultRomanizationSystem(detectedScript);

    // Generate cache key
    const cacheKey = getCacheKey(`${artist}-${title}`, detectedScript, system, options);
    
    // Check cache (only if Redis is available)
    if (redis) {
      const cached = await getCached(redis, cacheKey);
      if (cached) {
        return res.status(200).json(cached);
      }
    }

    // Search for song
    const startTime = Date.now();
    const songData = await musicAPI.searchSong(artist, title);
    if (!songData) {
      return res.status(404).json({ error: "Song not found" });
    }

    // Get lyrics
    const lyricsData = await musicAPI.getLyrics(songData.id);
    if (!lyricsData) {
      return res.status(404).json({ error: "Lyrics not found" });
    }

    // Get processor for romanization
    const processor = getProcessor(detectedScript);
    if (!processor) {
      return res.status(400).json({ 
        error: `Script '${detectedScript}' is not supported for romanization`
      });
    }

    // Romanize song metadata
    const titleRomanized = await processor.romanize(songData.title, system, options);
    const artistRomanized = await processor.romanize(songData.artist, system, options);

    // Romanize lyrics
    const romanizedLines = [];
    for (const line of lyricsData.lines) {
      if (line.text && line.text.trim()) {
        const romanized = await processor.romanize(line.text, system, options);
        romanizedLines.push({
          original: line.text,
          romanized: romanized.romanized,
          timestamp: line.timestamp || null
        });
      }
    }

    const processingTime = Date.now() - startTime;

    // Format response
    const response = formatMusicResponse(
      {
        title: songData.title,
        artist: songData.artist,
        id: songData.id,
        source: musicAPI.name
      },
      {
        title: titleRomanized.romanized,
        artist: artistRomanized.romanized,
        language: detectedScript,
        system: system,
        lines: romanizedLines,
        metadata: {
          detected_script: detectedScript,
          processing_time: processingTime,
          processor: processor.name,
          music_api: musicAPI.name
        }
      }
    );

    // Cache result (only if Redis is available)
    if (redis) {
      await setCached(redis, cacheKey, response);
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("Music romanization API error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}

async function getSupportedMusicAPIs() {
  // This would return the list of supported music API combinations
  return [
    { script: "zh", platforms: ["netease"] },
    { script: "ja", platforms: ["netease"] },
    { script: "ko", platforms: ["netease"] },
    { script: "en", platforms: ["netease"] }
  ];
}
