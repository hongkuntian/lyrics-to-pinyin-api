import { Redis } from "@upstash/redis";
import { detectLanguage, getDefaultRomanizationSystem } from "./utils/language-detection.js";
import { getProcessor, getSupportedLanguages as getSupportedProcessorLanguages } from "./processors/index.js";
import { formatResponse } from "./utils/response-formatter.js";
import { getCacheKey, getCached, setCached } from "./utils/cache.js";

function createRedisFromEnv() {
  if (process.env.LYRICS_KV_REST_API_URL && process.env.LYRICS_KV_REST_API_TOKEN) {
    return new Redis({
      url: process.env.LYRICS_KV_REST_API_URL,
      token: process.env.LYRICS_KV_REST_API_TOKEN,
    });
  }

  return null;
}

function getSupportedScripts() {
  return getSupportedProcessorLanguages();
}

export function createRomanizeHandler(dependencies = {}) {
  const {
    redis = createRedisFromEnv(),
    detectLanguageFn = detectLanguage,
    getDefaultRomanizationSystemFn = getDefaultRomanizationSystem,
    getProcessorFn = getProcessor,
    formatResponseFn = formatResponse,
    getCacheKeyFn = getCacheKey,
    getCachedFn = getCached,
    setCachedFn = setCached,
    getSupportedScriptsFn = getSupportedScripts,
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

    const { text, language, romanization_system, options = {} } = req.body || {};

    if (!text) {
      return res.status(400).json({ error: "Missing 'text' parameter" });
    }

    try {
      const detectedScript = language || await detectLanguageFn(text);
      const processor = getProcessorFn(detectedScript);
      if (!processor) {
        return res.status(400).json({
          error: `Script '${detectedScript}' is not supported`,
          supported_scripts: getSupportedScriptsFn()
        });
      }

      const system = romanization_system || getDefaultRomanizationSystemFn(detectedScript);
      const cacheKey = getCacheKeyFn(text, detectedScript, system, options);

      if (redis) {
        const cached = await getCachedFn(redis, cacheKey);
        if (cached) {
          return res.status(200).json(cached);
        }
      }

      const startTime = Date.now();
      const result = await processor.romanize(text, system, options);
      const processingTime = Date.now() - startTime;

      const response = formatResponseFn({
        original: text,
        romanized: result.romanized,
        language: detectedScript,
        romanization_system: result.system,
        confidence: result.confidence,
        metadata: {
          detected_script: detectedScript,
          processing_time: processingTime,
          processor: processor.name
        }
      });

      if (redis) {
        await setCachedFn(redis, cacheKey, response);
      }

      return res.status(200).json(response);
    } catch (err) {
      logger.error("Romanization API error:", err);
      return res.status(500).json({ error: "Server error", details: err.message });
    }
  };
}

const handler = createRomanizeHandler();
export default handler;
