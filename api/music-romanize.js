import { Redis } from "@upstash/redis";
import { detectLanguage, getDefaultRomanizationSystem } from "./utils/language-detection.js";
import { getProcessor } from "./processors/index.js";
import { formatMusicResponse } from "./utils/response-formatter.js";
import { getCacheKey, getCached, setCached } from "./utils/cache.js";
import { getMusicAPI, getAvailableAPIs, getSupportedCombinations } from "./music-apis/index.js";

function createRedisFromEnv() {
  if (process.env.LYRICS_KV_REST_API_URL && process.env.LYRICS_KV_REST_API_TOKEN) {
    return new Redis({
      url: process.env.LYRICS_KV_REST_API_URL,
      token: process.env.LYRICS_KV_REST_API_TOKEN,
    });
  }

  return null;
}

function getSupportedMusicAPIs() {
  return getSupportedCombinations();
}

export function createMusicRomanizeHandler(dependencies = {}) {
  const {
    redis = createRedisFromEnv(),
    detectLanguageFn = detectLanguage,
    getDefaultRomanizationSystemFn = getDefaultRomanizationSystem,
    getProcessorFn = getProcessor,
    formatMusicResponseFn = formatMusicResponse,
    getCacheKeyFn = getCacheKey,
    getCachedFn = getCached,
    setCachedFn = setCached,
    getMusicAPIFn = getMusicAPI,
    getAvailableAPIsFn = getAvailableAPIs,
    getSupportedMusicAPIsFn = getSupportedMusicAPIs,
    logger = console
  } = dependencies;

  return async function handler(req, res) {
    if (!process.env.LYRICS_KV_REST_API_URL || !process.env.LYRICS_KV_REST_API_TOKEN) {
      logger.error("❌ Missing Upstash Redis environment variables");
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
    } = req.body || {};

    if (!artist || !title) {
      return res.status(400).json({ error: "Missing 'artist' or 'title' parameter" });
    }

    try {
      const detectedScript = language || await detectLanguageFn(`${artist} ${title}`);
      let musicAPI = null;
      if (music_platform) {
        musicAPI = getMusicAPIFn(detectedScript, music_platform);
        if (!musicAPI) {
          return res.status(400).json({
            error: `Platform '${music_platform}' not available for script '${detectedScript}'`,
            supported_combinations: getSupportedMusicAPIsFn()
          });
        }
      }

      const system = romanization_system || getDefaultRomanizationSystemFn(detectedScript);
      const cacheKey = getCacheKeyFn(`${artist}-${title}`, detectedScript, system, options);

      if (redis) {
        const cached = await getCachedFn(redis, cacheKey);
        if (cached) {
          return res.status(200).json(cached);
        }
      }

      const availableAPIs = getAvailableAPIsFn(detectedScript);
      if (!availableAPIs.length) {
        return res.status(400).json({
          error: `No music API available for script '${detectedScript}' and platform '${music_platform}'`,
          supported_combinations: getSupportedMusicAPIsFn()
        });
      }

      const startTime = Date.now();
      let songData = null;
      let usedAPI = null;

      if (musicAPI) {
        songData = await musicAPI.searchSong(artist, title);
        usedAPI = musicAPI;
      } else {
        for (const api of availableAPIs) {
          logger.log(`Trying ${api.name} for song search...`);
          songData = await api.searchSong(artist, title);
          if (songData) {
            usedAPI = api;
            logger.log(`Found song using ${api.name}`);
            break;
          }
        }
      }

      if (!songData) {
        return res.status(404).json({
          error: "Song not found",
          details: `Tried ${availableAPIs.map(api => api.name).join(", ")}`
        });
      }

      const processor = getProcessorFn(detectedScript);
      if (!processor) {
        return res.status(400).json({
          error: `Script '${detectedScript}' is not supported for romanization`
        });
      }

      const [lyricsData, titleRomanized, artistRomanized] = await Promise.all([
        usedAPI.getLyrics(songData.id),
        processor.romanize(songData.title, system, options),
        processor.romanize(songData.artist, system, options)
      ]);

      if (!lyricsData) {
        return res.status(404).json({ error: "Lyrics not found" });
      }

      const romanizationPromises = lyricsData.lines
        .filter(line => line.text && line.text.trim())
        .map(async (line) => {
          const romanized = await processor.romanize(line.text, system, options);
          return {
            original: line.text,
            romanized: romanized.romanized,
            timestamp: line.timestamp || null
          };
        });

      const romanizedLines = await Promise.all(romanizationPromises);
      const processingTime = Date.now() - startTime;

      const response = formatMusicResponseFn(
        {
          title: songData.title,
          artist: songData.artist,
          id: songData.id,
          source: usedAPI.name
        },
        {
          title: titleRomanized.romanized,
          artist: artistRomanized.romanized,
          language: detectedScript,
          system,
          lines: romanizedLines,
          metadata: {
            detected_script: detectedScript,
            processing_time: processingTime,
            processor: processor.name,
            music_api: usedAPI.name
          }
        }
      );

      if (redis) {
        await setCachedFn(redis, cacheKey, response);
      }

      return res.status(200).json(response);
    } catch (err) {
      logger.error("Music romanization API error:", err);
      return res.status(500).json({ error: "Server error", details: err.message });
    }
  };
}

const handler = createMusicRomanizeHandler();
export default handler;
