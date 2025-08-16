import crypto from 'crypto';

// Cache key generation
export function getCacheKey(text, language, romanizationSystem, options = {}) {
  const keyData = {
    text: text.trim(),
    language,
    system: romanizationSystem || 'default',
    options: JSON.stringify(options)
  };
  
  // Create a hash of the key data for consistent cache keys
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(keyData))
    .digest('hex');
  
  return `romanize:${hash}`;
}

// Get cached data
export async function getCached(redis, key) {
      try {
      const cached = await redis.get(key);
      if (cached) {
        return cached;
      }
      return null;
  } catch (error) {
    console.error('Cache retrieval error:', error);
    return null;
  }
}

// Set cached data
export async function setCached(redis, key, data, ttl = null) {
  try {
    if (ttl) {
      await redis.setex(key, ttl, data);
    } else {
      await redis.set(key, data);
    }

  } catch (error) {
    console.error('Cache storage error:', error);
    // Don't throw - caching failure shouldn't break the API
  }
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
