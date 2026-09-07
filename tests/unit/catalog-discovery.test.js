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
