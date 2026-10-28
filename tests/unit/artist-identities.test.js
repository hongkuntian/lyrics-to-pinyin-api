import test from 'node:test';
import assert from 'node:assert/strict';
import {createArtistIdentityResolver,validArtistIdentity,ARTIST_IDENTITY_CAPABILITY} from '../../api/utils/artist-identities.js';
import {identityFixture,artistIDs,claim} from '../helpers/artist-identities.js';
import {cacheUnavailable} from '../../api/utils/cache.js';

const start=1800000000000;
test('the production Redis writer receives its acquisition-order envelope without suspending healthy caches',async()=>{
 const f=identityFixture();let writes=0;
 const redis={get:async()=>null,eval:async(script,keys,args)=>{
  writes++;assert.equal(keys.length,1);assert.match(keys[0],/lyrics:artist-identity:/);
  assert.equal(typeof args[1],'number');assert.equal(JSON.parse(args[0]).metadata.acquisition_started_at,args[1]);assert.ok(args[2]>0);return 1;
 }};
 assert.equal((await createArtistIdentityResolver({fetchFn:f.fetchFn,redis,now:()=>start})([artistIDs[0]])).length,1);
 assert.equal(writes,1);assert.equal(cacheUnavailable(redis),false);
});
test('exact artist IDs resolve multilingual alias snapshots and reuse memory and shared cache',async()=>{
 let time=start;const f=identityFixture(),disk=new Map();
 const options={fetchFn:f.fetchFn,now:()=>time,redis:{},getFn:async(_,k)=>disk.get(k),setFn:async(_,k,v)=>disk.set(k,structuredClone(v))};
 const resolve=createArtistIdentityResolver(options),first=await resolve(artistIDs);
 assert.equal(first.length,2);assert.equal(f.calls.length,2);
 assert.equal(first[0].spotifyArtistID,artistIDs[0]);assert.equal(first[0].entityID,'Q101');assert.equal(first[0].entityRevision,101);
 assert.ok(first[0].names.includes('张雨生'));assert.ok(first[0].names.includes('Tom Chang'));
 assert.ok(first.every(value=>validArtistIdentity(value,{now:time,fresh:true})));
 assert.ok(first.every(value=>value.policy===ARTIST_IDENTITY_CAPABILITY));
 first[0].names.push('Mutable caller');assert.ok(!(await resolve(artistIDs))[0].names.includes('Mutable caller'));
 assert.equal(f.calls.length,2);assert.equal((await createArtistIdentityResolver(options)(artistIDs)).length,2);assert.equal(f.calls.length,2);
 time+=86400001;assert.equal((await resolve(artistIDs)).length,2);assert.equal(f.calls.length,4);
});
test('ambiguous IDs, changed entity claims and invalid revisions cannot create aliases',async()=>{
 for(const mutate of [
  f=>f.rows.push({...f.rows[0],entity:{type:'uri',value:'http://www.wikidata.org/entity/Q103'}}),
  f=>f.entities.Q101.claims.P1902=[claim(artistIDs[1])],
  f=>f.entities.Q101.claims.P1902[0].rank='deprecated',
  f=>f.entities.Q101.lastrevid=0,
  f=>f.entities.Q101.id='Q999',
  f=>f.rows[0].entity.value='https://attacker.invalid/Q101',
 ]) {
  const f=identityFixture();mutate(f);const found=await createArtistIdentityResolver({fetchFn:f.fetchFn,now:()=>start})([artistIDs[0]]);
  assert.deepEqual(found,[]);
 }
});
test('identity input, response bounds and malformed Unicode fail without accepting a truncated prefix',async()=>{
 for(const ids of [[],[artistIDs[0],artistIDs[0]],['bad'],[...artistIDs,...artistIDs]]) {
  const f=identityFixture();assert.deepEqual(await createArtistIdentityResolver({fetchFn:f.fetchFn})(ids),[]);assert.equal(f.calls.length,0);
 }
 for(const mutate of [f=>f.entities.Q101.labels.en.value='x\ud800',f=>f.entities.Q101.aliases.en=Array.from({length:600},(_,i)=>({value:'Alias '+i})),
  f=>f.rows.push(...Array.from({length:20},()=>f.rows[0]))]) {
  const f=identityFixture();mutate(f);assert.deepEqual(await createArtistIdentityResolver({fetchFn:f.fetchFn,now:()=>start})([artistIDs[0]]),[]);
 }
});
test('expired or tampered cache is revalidated; absence is short-lived and transport errors do not become negatives',async()=>{
 let time=start;const f=identityFixture(),disk=new Map();
 const options={redis:{},fetchFn:f.fetchFn,now:()=>time,getFn:async(_,k)=>disk.get(k),setFn:async(_,k,v)=>disk.set(k,structuredClone(v))};
 const record=(await createArtistIdentityResolver(options)([artistIDs[0]]))[0];assert.ok(record);
 for(const value of disk.values())if(value.identity)value.identity.names.push('Forged alias');
 assert.equal((await createArtistIdentityResolver(options)([artistIDs[0]])).length,1);assert.equal(f.calls.length,4);
 const absent=identityFixture();absent.rows.length=0;const resolve=createArtistIdentityResolver({fetchFn:absent.fetchFn,now:()=>time});
 assert.deepEqual(await resolve([artistIDs[0]]),[]);assert.deepEqual(await resolve([artistIDs[0]]),[]);assert.equal(absent.calls.length,1);
 time+=300001;await resolve([artistIDs[0]]);assert.equal(absent.calls.length,2);
 let attempts=0;const flaky=createArtistIdentityResolver({fetchFn:async(...args)=>{if(++attempts===1)throw new Error('offline');return f.fetchFn(...args);},now:()=>time});
 assert.deepEqual(await flaky([artistIDs[0]]),[]);assert.equal((await flaky([artistIDs[0]])).length,1);
 assert.equal(validArtistIdentity({...record,names:[...record.names,'Forged']}),false);
 assert.equal(validArtistIdentity(record,{now:time+86400000,fresh:true}),false);
 assert.equal(validArtistIdentity(record),true,'a historical verified snapshot remains readable after cache expiry');
});
test('parent cancellation and fixed lookup deadline settle without publishing a cache entry',async()=>{
 for(const abort of [false,true]) {
  let writes=0,started;const ready=new Promise(r=>started=r),controller=new AbortController();
  const fetchFn=(_,options)=>{started();return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));};
  const resolve=createArtistIdentityResolver({fetchFn,budgetMs:30,redis:{},getFn:async()=>null,setFn:async()=>writes++});
  const result=resolve([artistIDs[0]],{signal:controller.signal});await ready;if(abort)controller.abort();
  assert.deepEqual(await result,[]);assert.equal(writes,0);
 }
});
test('a stalled optional cache write cannot discard the rest of an already verified artist batch',async()=>{
 const f=identityFixture(),third='3123456789ABCDEFGHIJKL';
 f.rows.push({spotify:{type:'literal',value:third},entity:{type:'uri',value:'http://www.wikidata.org/entity/Q103'}});
 f.entities.Q103={...structuredClone(f.entities.Q101),id:'Q103',claims:{P1902:[claim(third)]}};
 const resolve=createArtistIdentityResolver({fetchFn:f.fetchFn,budgetMs:40,cacheTimeoutMs:200,redis:{},getFn:async()=>null,setFn:()=>new Promise(()=>{})});
 assert.equal((await resolve([...artistIDs,third])).length,3);
});
