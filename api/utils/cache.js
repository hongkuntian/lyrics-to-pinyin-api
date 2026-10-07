import crypto from 'crypto';
import {profiles} from './pronunciation-aids.js';

// Cache outages must not add repeated DNS/network work to every lyrics request.
const retryAfter = new WeakMap();
export const cacheUnavailable = redis => (retryAfter.get(redis) || 0) > Date.now();
export function suspendCache(redis, error) {
  retryAfter.set(redis, Date.now() + 60_000);
  console.warn('Optional cache unavailable; bypassing for 60 seconds:', error.message);
}

// Cache key generation
export function getCacheKey(text, language, romanizationSystem, options = {}) {
  const keyData = {
    text: text.trim(),
    language,
    system: romanizationSystem || 'default',
    options: JSON.stringify(options)
  };
  const profile=profiles.find(p=>p.sourceLanguage===language&&p.kind==='romanization');
  if(profile)keyData.pronunciationEngine=profile.engineVersion;
  
  // Create a hash of the key data for consistent cache keys
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(keyData))
    .digest('hex');
  
  return `romanize:${hash}`;
}

// Get cached data
export async function getCached(redis, key) {
  if (cacheUnavailable(redis)) return null;
      try {
      const cached = await redis.get(key);
      if (cached) {
        return cached;
      }
      return null;
  } catch (error) {
    suspendCache(redis, error);
    return null;
  }
}

// Set cached data
export async function setCached(redis, key, data, ttl = null) {
  if (cacheUnavailable(redis)) return;
  try {
    if (ttl) {
      await redis.setex(key, ttl, data);
    } else {
      await redis.set(key, data);
    }

  } catch (error) {
    suspendCache(redis, error);
    // Don't throw - caching failure shouldn't break the API
  }
}

// Refresh and ordinary acquisitions share one content key. Commit by acquisition
// start, so a slow older lookup cannot replace a newer successful refresh.
// The comparison is atomic across instances and even after a caller times out.
export async function setLyricsCached(redis, key, data, ttl) {
  if (cacheUnavailable(redis)) return;
  const script = `
    local previous = redis.call('GET', KEYS[1])
    if previous then
      local ok, value = pcall(cjson.decode, previous)
      if ok and value.metadata and tonumber(value.metadata.acquisition_started_at or 0) > tonumber(ARGV[2]) then
        return 0
      end
    end
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
    return 1
  `;
  try {
    await redis.eval(script, [key], [JSON.stringify(data), data.metadata.acquisition_started_at, Math.max(1, Math.floor(ttl))]);
  } catch (error) { suspendCache(redis, error); }
}

// Cache management utilities
export async function clearCache(redis, pattern = 'romanize:*') {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);

    }
    return keys.length;
  } catch (error) {
    console.error('Cache clear error:', error);
    return 0;
  }
}

export async function getCacheStats(redis) {
  try {
    const keys = await redis.keys('romanize:*');
    const stats = {
      totalEntries: keys.length,
      patterns: {}
    };
    
    // Group by language pattern
    for (const key of keys) {
      const match = key.match(/romanize:([a-f0-9]{64})/);
      if (match) {
        // In a real implementation, you might store metadata with each cache entry
        // For now, we'll just count them
        stats.patterns['romanize'] = (stats.patterns['romanize'] || 0) + 1;
      }
    }
    
    return stats;
  } catch (error) {
    console.error('Cache stats error:', error);
    return { totalEntries: 0, patterns: {} };
  }
}

// Cache TTL constants
export const CACHE_TTL = {
  SHORT: 300,    // 5 minutes
  MEDIUM: 3600,  // 1 hour
  LONG: 86400,   // 24 hours
  PERMANENT: null // No expiration
};
