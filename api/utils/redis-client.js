import {Redis} from '@upstash/redis';

// Stable wrapper for the circuit breaker, fresh abort signal for each command.
export function createRedisFromEnv(env=process.env, Client=Redis) {
  const url=env.LYRA_CACHE_KV_REST_API_URL || env.LYRICS_KV_REST_API_URL;
  const token=env.LYRA_CACHE_KV_REST_API_TOKEN || env.LYRICS_KV_REST_API_TOKEN;
  if(!url || !token) return null;
  const client=()=>new Client({url,token,retry:false,signal:AbortSignal.timeout(300)});
  return {
    get:key=>client().get(key),
    set:(key,value)=>client().set(key,value),
    setex:(key,ttl,value)=>client().setex(key,ttl,value)
  };
}
