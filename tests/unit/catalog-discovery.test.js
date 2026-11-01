import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
const request={artist:'Emil Wakin Chau',title:'Friends',album:'Friends',duration:312.333};
const en={kind:'song',trackId:161282089,artistName:request.artist,trackName:request.title,collectionName:'Friends',trackTimeMillis:312333};
const zh={...en,artistName:'周華健',trackName:'朋友',collectionName:'朋友'};
const fetchFn=async url=>({ok:true,json:async()=>({results:new URL(url).searchParams.get('country')==='tw' ? [zh]:[en]})});
test('reviewed label title aliases require the complete live catalog anchor',async()=>{
 const request={catalog_id:'1089186523',artist:'Ikimonogakari',title:'Blue Bird',album:'Chou Ikimonobakari Tennen Kinen Members Best Selection',duration:215.707};
 const anchor={kind:'song',trackId:1089186523,artistName:request.artist,trackName:request.title,collectionName:request.album,trackTimeMillis:215707};
 const context={appleCatalog:null,fetchFn:async()=>({ok:true,json:async()=>({results:[anchor]})})};
 const aliases=await resolveCatalogAliases(request,context);
 assert.ok(aliases.some(song=>song.title==='ブルーバード'&&song.artist===request.artist));
 assert.equal(aliases.resolution.method,'reviewed_alias');
 assert.equal(aliases.resolution.canonical_recording_id,'apple:1089186523');
 assert.ok(aliases.resolution.catalog_items.every(song=>song.provenance==='itunes'));
 for(const change of [{artist:'Cover'},{title:'Blue Bird (Live)'},{album:'Other album'},{duration:216.5},{catalog_id:'999'}]){
  assert.ok(!(await resolveCatalogAliases({...request,...change},context)).some(song=>song.title==='ブルーバード'));
 }
 for(const change of [{trackName:'Blue Bird (Live)'},{artistName:'Cover'},{collectionName:'Other album'},{trackTimeMillis:216500}]){
  const changed={...context,fetchFn:async()=>({ok:true,json:async()=>({results:[{...anchor,...change}]})})};
  assert.ok(!(await resolveCatalogAliases(request,changed)).some(song=>song.title==='ブルーバード'));
 }
});
test('quoted TV-theme suffix discovery retains original request proof and strict catalog evidence',async()=>{
 const target={artist:'Hacken Lee',title:'紅日 - 電視劇「他來自天堂」主題曲',album:'紅日',duration:287};
 const song={kind:'song',trackId:1443394970,artistName:target.artist,trackName:'紅日',collectionName:target.album,trackTimeMillis:287173};
 const context={appleCatalog:null,fetchFn:async()=>({ok:true,json:async()=>({results:[song]})})};
 for(const catalog_id of [undefined,'1443394970']){
  const aliases=await resolveCatalogAliases({...target,...(catalog_id?{catalog_id}:{})},context);
  assert.equal(aliases[0].title,'紅日');
  assert.equal(aliases.resolution.accepted_request.title,target.title);
  assert.equal(aliases.resolution.canonical_recording_id,'apple:1443394970');
 }
 for(const change of [{artist:'Cover Singer'},{album:'Other album'},{duration:289},{album:undefined},{title:target.title+' (Live)'},{title:'紅日 - Another song'}])
  assert.deepEqual(await resolveCatalogAliases({...target,...change},context),[]);
});
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

test('Dick & Cowboy is one reviewed artist and missing English storefronts use exact catalog anchors',async()=>{
 const req={catalog_id:'1443355415',artist:'Dick & Cowboy',title:'有多少愛可以重來',album:'傳奇',duration:293.493};
 const anchor={kind:'song',trackId:1443355415,artistName:'迪克牛仔',trackName:req.title,collectionName:req.album,trackTimeMillis:293493};
 const context={appleCatalog:null,fetchFn:async()=>({ok:true,json:async()=>({results:[anchor]})})};
 const aliases=await resolveCatalogAliases(req,context);
 assert.ok(aliases.some(s=>s.artist==='迪克牛仔'));
 assert.equal(aliases.resolution.method,'reviewed_alias');
 for(const change of [{artist:'Dick & Cowboy & Guest'},{title:req.title+' (Live)'},{album:'Another release'},
  {duration:300},{catalog_id:'999'}])assert.deepEqual(await resolveCatalogAliases({...req,...change},context),[]);
 assert.deepEqual(await resolveCatalogAliases(req,{...context,fetchFn:async()=>({ok:true,json:async()=>({results:[{...anchor,artistName:'Different singer'}]})})}),[]);
});
test('already included artist relationships disambiguate unknown band names with no extra reads',async()=>{
 const req={catalog_id:'123',artist:'Earth, Wind & Fire',title:'Song',album:'Album',duration:220};
 const entities=[{id:'42',name:req.artist}],zhEntities=[{id:'42',name:'风火土乐团'}];let calls=0;
 const appleCatalog={lookup:async(_,country)=>{calls++;return [{...req,artist:country==='us'?req.artist:'风火土乐团',storefront:country,
  artist_ids:['42'],artist_entities:country==='us'?entities:zhEntities,isrc:'USABC2300001',provenance:'apple_music'}]}};
 const context={appleCatalog,fetchFn:async()=>{throw new Error('Unexpected fallback read');}};
 const aliases=await resolveCatalogAliases(req,context);
 assert.ok(aliases.some(s=>s.artist==='风火土乐团'));
 assert.ok(aliases.resolution.artist_entities.some(s=>s.name===req.artist));
 assert.equal(calls,6);
 assert.deepEqual(await resolveCatalogAliases({...req,artist:req.artist+' & Guest'},context),[]);
});
