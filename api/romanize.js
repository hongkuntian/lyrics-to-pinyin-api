import {withAppAuth} from './utils/app-auth/http.js';
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

export function createRomanizeService(dependencies = {}) {
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

    if(typeof text!=='string'||text.length>8192||Buffer.byteLength(JSON.stringify(req.body??{}))>32768||
      (language!=null&&(typeof language!=='string'||language.length>32))||
      (romanization_system!=null&&(typeof romanization_system!=='string'||romanization_system.length>64))||
      !options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['tone_style','separator','case','include_metadata'].includes(k))||
      Object.values(options).some(v=>typeof v==='string'&&v.length>32))return res.status(400).json({code:'invalid_request'});
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
      logger.error("romanization_unavailable");
      return res.status(500).json({ error: "Server error" });
    }
  };
}

export function createRomanizeHandler(dependencies={}) {
  return withAppAuth(createRomanizeService(dependencies),{...dependencies,route:'romanize'});
}
const handler = createRomanizeHandler();
export default handler;
