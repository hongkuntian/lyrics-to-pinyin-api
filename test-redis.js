import { Redis } from "@upstash/redis";
import "dotenv/config";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

async function testRedisConnection() {
  try {
    console.log("🔍 Testing Upstash Redis connection...");
    
    // Test basic set/get
    await redis.set("test:connection", "Hello from Upstash Redis!");
    const result = await redis.get("test:connection");
    
    console.log("✅ Redis connection successful!");
    console.log("📝 Test result:", result);
    
    // Test cache key format
    const testCacheKey = "lyrics:周杰伦-稻香";
    await redis.set(testCacheKey, { test: "data" });
    const cachedData = await redis.get(testCacheKey);
    
    console.log("✅ Cache key format test successful!");
    console.log("📝 Cached data:", cachedData);
    
    // Clean up test data
    await redis.del("test:connection");
    await redis.del(testCacheKey);
    
    console.log("🧹 Test data cleaned up");
    
  } catch (error) {
    console.error("❌ Redis connection failed:", error.message);
    console.log("\n🔧 Troubleshooting tips:");
    console.log("1. Check your UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
    console.log("2. Make sure your Upstash Redis database is active");
    console.log("3. Verify your environment variables are set correctly");
  }
}

testRedisConnection(); 