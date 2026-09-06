import test from 'node:test';
import assert from 'node:assert/strict';
import {createRedisFromEnv} from '../../api/utils/redis-client.js';
test('all cache commands use replacement credentials and fresh bounded signals',async()=>{
 const seen=[];
 class Client {
   constructor(options){seen.push(options);}
   get(){return 1;}set(){return 'OK';}setex(){return 'OK';}
 }
 const redis=createRedisFromEnv({LYRA_CACHE_KV_REST_API_URL:'https://replacement.test',LYRA_CACHE_KV_REST_API_TOKEN:'fixture-new',LYRICS_KV_REST_API_URL:'https://old.test',LYRICS_KV_REST_API_TOKEN:'fixture-old'},Client);
 assert.equal(await redis.get('a'),1);await redis.set('a',2);await redis.setex('a',60,2);
 assert.equal(seen.length,3);assert.ok(seen.every(x=>x.url==='https://replacement.test' && x.token==='fixture-new' && x.retry===false));
 assert.equal(new Set(seen.map(x=>x.signal)).size,3);
 assert.equal(createRedisFromEnv({}),null);
});
