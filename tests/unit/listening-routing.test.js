import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviderGateway} from '../../api/provider-gateway.js';
import {createBillingGateway} from '../../api/billing-gateway.js';
import {createMockRes} from '../helpers/mock-http.js';
import {manifest} from '../../scripts/build-output.mjs';
test('canonical rewrites preserve provider and billing endpoint identity',async()=>{
 const calls=[];
 const gateways={
  '/api/provider-gateway':createProviderGateway({spotify:async()=>calls.push('spotify'),sessions:async()=>calls.push('sessions')}),
  '/api/billing-gateway':createBillingGateway({membership:async()=>calls.push('membership'),notifications:async()=>calls.push('store-notifications')})
 };
 for(const name of ['spotify','sessions','membership','store-notifications']){
  const route=manifest.routes.find(r=>r.src==='/api/'+name),url=new URL(route.dest,'https://example.invalid');
  await gateways[url.pathname]({query:Object.fromEntries(url.searchParams)},createMockRes());
 }
 assert.deepEqual(calls,['spotify','sessions','membership','store-notifications']);
 for(const gateway of Object.values(gateways)){
  for(const query of [{},{_lyrica_endpoint:'unknown'},{_lyrica_endpoint:['spotify','membership']}]){
   const res=createMockRes();await gateway({query},res);assert.equal(res.statusCode,404);
  }
 }
 assert.equal(calls.length,4);
});
test('billing gateway retains membership authentication and notification signature validation',async()=>{
 const gateway=createBillingGateway({notifications:undefined});
 const member=createMockRes();await gateway({method:'POST',headers:{},body:{action:'status'},query:{_lyrica_endpoint:'membership'}},member);assert.equal(member.statusCode,401);
 const notification=createMockRes();await gateway({method:'POST',headers:{},body:{},query:{_lyrica_endpoint:'store-notifications'}},notification);assert.equal(notification.statusCode,400);
});
test('deployment fits twelve functions with three isolated private queue consumers',()=>{
 assert.equal(manifest.entries.length,12);assert.equal(manifest.routes.length,11);
 const consumers=manifest.entries.filter(e=>e.experimentalTriggers);
 assert.equal(consumers.length,3);
 assert.deepEqual(new Set(consumers.flatMap(e=>e.experimentalTriggers.map(t=>t.topic))),new Set(['spotify-background-tick-v1','spotify-background-acquire-v1','lyrica-listening-session-v1']));
 for(const consumer of consumers)assert.equal(consumer.experimentalTriggers.length,1);
 for(const privatePath of ['/api/provider-gateway','/api/billing-gateway','/api/_spotify-tick','/api/_spotify-acquire','/api/_listening-tick'])assert(!manifest.routes.some(r=>r.src===privatePath));
});
