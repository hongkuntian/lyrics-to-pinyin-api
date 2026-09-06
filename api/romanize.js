import {createRedisFromEnv} from './utils/redis-client.js';
import {withDeadline} from './utils/fetch-json.js';
import {waitUntil} from '@vercel/functions';
import { detectLanguage, getDefaultRomanizationSystem } from "./utils/language-detection.js";
import { getProcessor, getSupportedLanguages as getSupportedProcessorLanguages } from "./processors/index.js";
import { formatResponse } from "./utils/response-formatter.js";
import { getCacheKey, getCached, setCached, cacheUnavailable, suspendCache } from "./utils/cache.js";

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
    logger = console,
    cacheTimeoutMs = 300,
    waitUntilFn = waitUntil
  } = dependencies;

  return async function handler(req, res) {
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

      if (redis && !cacheUnavailable(redis)) {
        const cached = await withDeadline(() => getCachedFn(redis, cacheKey), cacheTimeoutMs)
          .catch(error => { suspendCache(redis, error); return null; });
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

      if (redis && !cacheUnavailable(redis)) {
        waitUntilFn(withDeadline(() => setCachedFn(redis, cacheKey, response, 86400), cacheTimeoutMs)
          .catch(error => suspendCache(redis, error)));
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
