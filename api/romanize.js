import { Redis } from "@upstash/redis";
import { detectLanguage, getDefaultRomanizationSystem } from "./utils/language-detection.js";
import { getProcessor } from "./processors/index.js";
import { formatResponse } from "./utils/response-formatter.js";
import { getCacheKey, getCached, setCached } from "./utils/cache.js";

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

  const { text, language, romanization_system, options = {} } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Missing 'text' parameter" });
  }

  try {
    // Auto-detect script if not provided
    const detectedScript = language || await detectLanguage(text);
    
    // Get appropriate processor for the script
    const processor = getProcessor(detectedScript);
    if (!processor) {
      return res.status(400).json({ 
        error: `Script '${detectedScript}' is not supported`,
        supported_scripts: await getSupportedScripts()
      });
    }

    // Use default romanization system if not specified
    const system = romanization_system || getDefaultRomanizationSystem(detectedScript);

    // Generate cache key
    const cacheKey = getCacheKey(text, detectedScript, system, options);
    
    // Check cache (only if Redis is available)
    if (redis) {
      const cached = await getCached(redis, cacheKey);
      if (cached) {
        return res.status(200).json(cached);
      }
    }

    // Process romanization
    const startTime = Date.now();
    const result = await processor.romanize(text, system, options);
    const processingTime = Date.now() - startTime;

    // Format response
    const response = formatResponse({
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

    // Cache result (only if Redis is available)
    if (redis) {
      await setCached(redis, cacheKey, response);
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("Romanization API error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
}

async function getSupportedScripts() {
  // This would return the list of supported scripts
  return ["zh", "ja", "ko", "th", "ar", "en"];
}
