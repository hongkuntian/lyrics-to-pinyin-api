import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {createBillingGateway} from '../../api/billing-gateway.js';
import {createMockRes} from '../helpers/mock-http.js';
import {manifest,deploymentRoutes} from '../../scripts/build-output.mjs';
const root=new URL('../../',import.meta.url);
test('canonical rewrites preserve billing endpoint identity',async()=>{
 const calls=[];
 const gateways={
  '/api/billing-gateway':createBillingGateway({membership:async()=>calls.push('membership'),notifications:async()=>calls.push('store-notifications')})
 };
 for(const name of ['membership','store-notifications']){
  const route=manifest.routes.find(r=>r.src==='/api/'+name),url=new URL(route.dest,'https://example.invalid');
  await gateways[url.pathname]({query:Object.fromEntries(url.searchParams)},createMockRes());
 }
 assert.deepEqual(calls,['membership','store-notifications']);
 for(const gateway of Object.values(gateways)){
  for(const query of [{},{_lyrica_endpoint:'unknown'},{_lyrica_endpoint:'sessions'},{_lyrica_endpoint:'spotify'},{_lyrica_endpoint:['membership','store-notifications']}]){
   const res=createMockRes();await gateway({query},res);assert.equal(res.statusCode,404);
  }
 }
 assert.equal(calls.length,2);
});
test('billing gateway retains membership authentication and notification signature validation',async()=>{
 const gateway=createBillingGateway({notifications:undefined});
 const member=createMockRes();await gateway({method:'POST',headers:{},body:{action:'status'},query:{_lyrica_endpoint:'membership'}},member);assert.equal(member.statusCode,401);
 const notification=createMockRes();await gateway({method:'POST',headers:{},body:{},query:{_lyrica_endpoint:'store-notifications'}},notification);assert.equal(notification.statusCode,400);
});
test('deployment retains eight functions, the daily reporting cron and no private queue consumers',()=>{
 assert.equal(manifest.entries.length,8);assert.equal(manifest.routes.length,9);
 assert.deepEqual(manifest.entries.map(e=>e.entry),['api/romanize.js','api/music-romanize.js','api/song-library.js','api/review-reports.js',
  'api/app-auth.js','api/live-lyrics.js','api/account.js','api/billing-gateway.js']);
 assert.deepEqual(manifest.entries.filter(e=>e.experimentalTriggers),[]);
 assert.deepEqual(manifest.crons,[{path:'/api/review-reports',schedule:'0 8 * * *'}]);
 for(const privatePath of ['/api/billing-gateway','/api/provider-gateway','/api/_spotify-tick','/api/_spotify-acquire','/api/_listening-tick','/api/spotify'])assert(!manifest.routes.some(r=>r.src===privatePath));
 assert(!manifest.routes.some(r=>/spotify|provider-gateway/.test(r.src+r.dest)));
});

test('unknown, retired Spotify and direct gateway paths resolve to static 404 bytes rather than running an entry function',()=>{
 const routes=deploymentRoutes(manifest.routes);
 for(const pathname of ['/api/spotify','/api/spotify/','/api/provider-gateway','/api/_spotify-tick','/api/_spotify-acquire','/api/billing-gateway',
  '/api/_listening-tick','/api/sessions','/api/sessions/','/api/sessions.js','/api/membership.js','/unknown']){
  const selected=routes.find(route=>new RegExp('^(?:'+route.src+')$').test(pathname));
  assert.equal(selected.status,404);assert.equal(selected.dest,'/_lyrica-not-found.json');
  assert(!manifest.entries.some(e=>'/'+e.entry.replace(/\.js$/,'')===selected.dest));
 }
 for(const route of manifest.routes)assert.deepEqual(routes.find(r=>new RegExp('^(?:'+r.src+')$').test(route.src)),route);
});

test('the retired Spotify gateway, broker and queue consumer sources are gone',async()=>{
 for(const path of ['api/spotify.js','api/provider-gateway.js','api/_spotify-tick.js','api/_spotify-acquire.js','api/utils/spotify'])
  await assert.rejects(access(new URL(path,root)),{code:'ENOENT'},path);
});
