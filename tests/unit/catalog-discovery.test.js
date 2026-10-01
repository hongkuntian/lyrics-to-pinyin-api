import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
const request={artist:'Emil Wakin Chau',title:'Friends',album:'Friends',duration:312.333};
const en={kind:'song',trackId:161282089,artistName:request.artist,trackName:request.title,collectionName:'Friends',trackTimeMillis:312333};
const zh={...en,artistName:'周華健',trackName:'朋友',collectionName:'朋友'};
const fetchFn=async url=>({ok:true,json:async()=>({results:new URL(url).searchParams.get('country')==='tw' ? [zh]:[en]})});
test('catalog discovery without a supplied ID still verifies complete metadata and exact album',async()=>{
 const aliases=await resolveCatalogAliases(request,{fetchFn});
 assert.ok(aliases.some(a=>a.title==='朋友' && a.artist==='周華健' && a.catalog_id==='161282089'));
 for(const changed of [{artist:'Cover'},{duration:350},{album:'Different album'}]) assert.deepEqual(await resolveCatalogAliases({...request,...changed},{fetchFn}),[]);
 assert.deepEqual(await resolveCatalogAliases({...request,album:undefined},{fetchFn}),[]);
});
test('a mixed localization may combine only names verified on the same catalog ID',async()=>{
 const aliases=await resolveCatalogAliases({...request,title:'朋友',catalog_id:'161282089'},{fetchFn});
 assert.ok(aliases.some(a=>a.artist==='周華健'));
 assert.deepEqual(await resolveCatalogAliases({...request,catalog_id:'999'},{fetchFn}),[]);
});
test('ambiguous catalog discovery refuses to guess between distinct IDs',async()=>{
 const ambiguous=async()=>({ok:true,json:async()=>({results:[en,{...en,trackId:2}]})});
 assert.deepEqual(await resolveCatalogAliases(request,{fetchFn:ambiguous}),[]);
});

test('a band name containing with retains same-recording Chinese aliases without losing guests',async()=>{
 const request={catalog_id:'1597707697',artist:'Your Woman Sleep with Others',title:'Teens Edge',album:'Stolen Childhood - Single',duration:347.058};
 const en={kind:'song',trackId:1597707697,artistName:request.artist,trackName:request.title,collectionName:request.album,trackTimeMillis:347058};
 const zh={...en,artistName:'老王樂隊',trackName:'我還年輕 我還年輕',collectionName:'吾十有五而志於學 - Single'};
 const context={appleCatalog:null,fetchFn:async url=>({ok:true,json:async()=>({results:[new URL(url).searchParams.get('country')==='us'?en:zh]})})};
 const aliases=await resolveCatalogAliases(request,context);
 assert.ok(aliases.some(s=>s.artist===zh.artistName&&s.title===zh.trackName));
 assert.equal(aliases.resolution.canonical_recording_id,'apple:1597707697');
 for(const change of [{artist:'Your Woman Sleep with Others with Guest'},{title:'Teens Edge (feat. Guest)'},{title:'Teens Edge (Live)'},{duration:350},{album:'Different'},{catalog_id:'999'}])
  assert.deepEqual(await resolveCatalogAliases({...request,...change},context),[]);
 const withGuest={...zh,artistName:zh.artistName+' & Guest'};
 const incomplete=await resolveCatalogAliases(request,{...context,fetchFn:async url=>({ok:true,json:async()=>({results:[new URL(url).searchParams.get('country')==='us'?en:withGuest]})})});
 assert.ok(incomplete.every(s=>s.artist!==withGuest.artistName));
});

test('reviewed English MusicKit signature bridges a missing storefront without accepting near matches',async()=>{
 const req={catalog_id:'536009642',artist:'Jay Chou',title:'Nocturne',album:'11月的蕭邦',duration:228.773};
 const anchor={kind:'song',trackId:536009642,artistName:'周杰倫',trackName:'夜曲',collectionName:'11月的蕭邦',trackTimeMillis:228773};
 const context={fetchFn:async()=>({ok:true,json:async()=>({results:[anchor]})})};
 assert.equal((await resolveCatalogAliases(req,context))[0].title,'夜曲');
 for(const change of [{artist:'Cover'},{title:'Nocturne (Live)'},{album:'Different'},{duration:225},{catalog_id:'999'}]) {
  assert.deepEqual(await resolveCatalogAliases({...req,...change},context),[]);
 }
 assert.deepEqual(await resolveCatalogAliases(req,{fetchFn:async()=>({ok:true,json:async()=>({results:[{...anchor,trackName:'Different'}]})})}),[]);
});
