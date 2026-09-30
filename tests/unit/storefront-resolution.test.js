import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
import {sameCatalogRecording} from '../../api/utils/apple-catalog.js';

const request={catalog_id:'1721454114',storefront:'ca',artist:'Jay Chou',title:'Hair Like Snow',album:"November's Chopin",duration:301.64};
const english={kind:'song',trackId:1721454114,artistName:'Jay Chou',trackName:'Hair Like Snow',collectionName:"November's Chopin",trackTimeMillis:301640};
const chinese={...english,artistName:'周杰倫',trackName:'髮如雪',collectionName:'11月的蕭邦'};
const fixture=async url=>({ok:true,json:async()=>({results:new URL(url).searchParams.get('country')==='hk'?[chinese]:[english]})});
test('Canadian and Korean metadata can recover Hong Kong names under the original ID',async()=>{
 const aliases=await resolveCatalogAliases(request,{fetchFn:fixture,appleCatalog:null});
 assert.ok(aliases.some(a=>a.title==='髮如雪'&&a.artist==='周杰倫'));
 assert.equal(aliases.resolution.requested.catalog_id,request.catalog_id);
 assert.equal(aliases.resolution.canonical_recording_id,'apple:'+request.catalog_id);
 assert.deepEqual(await resolveCatalogAliases({...request,title:'Hair Like Snow (Live)'},{fetchFn:fixture,appleCatalog:null}),[]);
 assert.deepEqual(await resolveCatalogAliases({...request,artist:'Jay Chou & Guest'},{fetchFn:fixture,appleCatalog:null}),[]);
});
test('verified query order is independent of which storefront supplied the title',async()=>{
 const en={...english,trackId:1542182776,artistName:'YOASOBI',trackName:'Yoru ni kakeru',collectionName:'THE BOOK',trackTimeMillis:258840};
 const ja={...en,trackName:'夜に駆ける'};
 const fetchFn=async url=>({ok:true,json:async()=>({results:new URL(url).searchParams.get('country')==='us'?[en]:[ja]})});
 const base={catalog_id:String(en.trackId),artist:'YOASOBI',album:'THE BOOK',duration:258.84};
 const a=await resolveCatalogAliases({...base,title:en.trackName,storefront:'ca'},{fetchFn,appleCatalog:null});
 const b=await resolveCatalogAliases({...base,title:ja.trackName,storefront:'jp'},{fetchFn,appleCatalog:null});
 assert.deepEqual(a.resolution.searches,b.resolution.searches);
 assert.equal(b.resolution.searches[0].title,en.trackName);
});
test('equivalent IDs and matching ISRC do not excuse version, duration or performer conflicts',()=>{
 const anchor={catalog_id:'1',isrc:'USABC2300001',duration:220,title:'Song',artist:'Singer',album:'Album',artist_ids:['42'],content_rating:'explicit'};
 assert.ok(sameCatalogRecording(anchor,{...anchor,catalog_id:'2'}));
 for(const change of [{duration:224},{title:'Song (Live)'},{artist_ids:['42','99']},{content_rating:'clean'},{isrc:'USABC2300002'},{title:'Song (Remastered)'},{title:'Song (Acoustic)'}])
  assert.equal(sameCatalogRecording(anchor,{...anchor,catalog_id:'2',...change}),false);
 assert.equal(sameCatalogRecording({...anchor,isrc:null},{...anchor,catalog_id:'2'}),false);
});
test('authenticated cross-ID recovery requires an unambiguous exact recording',async()=>{
 const anchor={catalog_id:request.catalog_id,title:request.title,artist:request.artist,album:request.album,duration:request.duration,
  storefront:'us',isrc:'TWK970500905',artist_ids:['300117743'],genres:['Mandopop'],provenance:'apple_music'};
 const translated={...anchor,catalog_id:'123',title:'髮如雪',artist:'周杰倫',album:'11月的蕭邦',storefront:'hk'};
 const appleCatalog={lookup:async(id,country)=>country==='us'||country==='ca'?[{...anchor,storefront:country}]:[],
  equivalents:async(id,country)=>country==='hk'?[translated]:[],byISRC:async()=>[]};
 const empty=async()=>({ok:true,json:async()=>({results:[]})});
 const aliases=await resolveCatalogAliases(request,{appleCatalog,fetchFn:empty});
 assert.equal(aliases.resolution.method,'catalog_equivalent');assert.ok(aliases.some(s=>s.catalog_id==='123'));
 appleCatalog.equivalents=async()=>[translated,{...translated,catalog_id:'124'}];
 const ambiguous=await resolveCatalogAliases(request,{appleCatalog,fetchFn:empty});
 assert.equal(ambiguous.resolution.method,'same_catalog_id');assert.ok(ambiguous.every(s=>s.catalog_id===request.catalog_id));
 assert.deepEqual(await resolveCatalogAliases({...request,isrc:'USABC2300001'},{appleCatalog,fetchFn:empty}),[]);
});
