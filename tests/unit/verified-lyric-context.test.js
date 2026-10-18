import test from 'node:test';
import assert from 'node:assert/strict';
import {createVerifiedContextCache,verifiedCatalogProof} from '../../api/utils/verified-lyric-context.js';
const request={catalog_id:'123',storefront:'us',artist:'Artist',title:'Song',album:'Album',duration:240};
function aliases(){const values=[];Object.defineProperty(values,'resolution',{value:{version:'catalog-recording-1',method:'same_catalog_id',requested:{catalog_id:'123',storefront:'us'},accepted_request:{catalog_id:'123',artist:'Artist',title:'Song',album:'Album',duration:240},canonical_recording_id:'apple:123',catalog_items:[{catalog_id:'123',storefront:'us',provenance:'apple_music'}],searches:[request]}});return values;}
test('verified context serializes catalog resolution explicitly and preserves age through hint updates',async()=>{
 let now=1000;const disk=new Map(),pending=[],deps={redis:{},getFn:async(_,k)=>disk.get(k),setFn:async(_,k,v)=>disk.set(k,structuredClone(v)),waitUntilFn:p=>pending.push(p),now:()=>now,ttlMs:100,policy:{selection:'selection',normalization:'normalization',response:'response'}};
 const a=createVerifiedContextCache(deps),context=a.catalog(request,aliases(),10);assert.ok(context);a.save(context);await Promise.all(pending);
 now+=20;const restored=await createVerifiedContextCache(deps).read(request);assert.equal(restored.verifiedAtMS,1000);assert.equal(restored.expiresAtMS,1100);assert.equal(restored.resolution.canonical_recording_id,'apple:123');
 const hinted=a.hint(restored,{song:{id:42,artist:'Artist',title:'Song',album:'Album',duration:240,lyricsData:{unsafe:true}},api:{name:'LRCAPI'},target:request});assert.equal(hinted.expiresAtMS,1100);assert.equal(hinted.hints[0].signature.lyricsData,undefined);
 a.save(hinted);await Promise.all(pending);now=1100;assert.equal(await createVerifiedContextCache(deps).read(request),null);
});
test('empty evidence, wrong request, policy changes and expiry cannot certify context',async()=>{
 let stored;const deps={redis:{},getFn:async()=>stored,setFn:async()=>{},now:()=>1000,ttlMs:100,policy:{selection:'a',normalization:'b',response:'c'}};
 const cache=createVerifiedContextCache(deps);assert.equal(cache.catalog(request,[],1),null);
 stored=cache.catalog(request,aliases(),1);assert.equal(verifiedCatalogProof(stored.resolution,{...request,artist:'Cover'}),false);
 assert.equal(await cache.read({...request,title:'Song (Live)'}),null);
 stored.policy.selection='older';assert.equal(await cache.read(request),null);
});
test('an older held Redis read cannot replace or return ahead of a newer local acquisition',async()=>{
 let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const cache=createVerifiedContextCache({redis:{},getFn:async()=>{entered();await gate;return older;},setFn:async()=>{},now:()=>1000,ttlMs:100,policy:{selection:'a',normalization:'b',response:'c'}});
 const older=cache.catalog(request,aliases(),10),newer=cache.catalog(request,aliases(),20);
 const read=cache.read(request);await ready;cache.save(newer);release();
 assert.equal((await read).metadata.acquisition_started_at,20);assert.equal((await cache.read(request)).metadata.acquisition_started_at,20);assert.equal(older.metadata.acquisition_started_at,10);
});
test('malformed optional context is a nonthrowing miss',async()=>{
 let stored;const deps={redis:{},getFn:async()=>stored,setFn:async()=>{},now:()=>1000,ttlMs:100,policy:{selection:'a',normalization:'b',response:'c'}};
 const base=createVerifiedContextCache(deps).catalog(request,aliases(),10);
 for(const mutate of [x=>delete x.aliases,x=>x.aliases=[null],x=>x.hints=[null],x=>x.hints=[{provider:'LRCAPI',id:'42',signature:{id:42}}],x=>x.resolution.catalog_items=[null],x=>x.resolution.searches=[null]]){
  stored=structuredClone(base);mutate(stored);assert.equal(await createVerifiedContextCache(deps).read(request),null);
 }
});

test('QQ source hints persist only exact metadata and require fresh source revalidation',async()=>{
 const {hintedRecording}=await import('../../api/utils/source-hint.js');
 const disk=new Map(),pending=[],deps={redis:{},getFn:async(_,k)=>disk.get(k),setFn:async(_,k,v)=>disk.set(k,structuredClone(v)),
  waitUntilFn:p=>pending.push(p),now:()=>1000,ttlMs:100,policy:{selection:'expanded'}};
 const cache=createVerifiedContextCache(deps),base=cache.catalog(request,aliases(),10);
 const song={id:'42',source:'qq',artist:request.artist,title:request.title,album:request.album,duration:240,lyricsData:{private:'must not persist'}};
 const hinted=cache.hint(base,{api:{name:'QQMusicAPI'},song,target:request});cache.save(hinted);await Promise.all(pending);
 const restored=await createVerifiedContextCache(deps).read(request);assert.equal(restored.hints[0].provider,'QQMusicAPI');
 assert.equal(restored.hints[0].signature.lyricsData,undefined);assert.equal(restored.expiresAtMS,base.expiresAtMS);
 let calls=0;const api={name:'QQMusicAPI',getRecording:async id=>{calls++;assert.equal(id,'42');return {song,lyrics:{lines:[{text:'Fresh',timestamp:1}]}};}};
 assert.ok(await hintedRecording(api,request,restored,{deadline:Date.now()+1000}));assert.equal(calls,1);
 api.getRecording=async()=>({song:{...song,title:'Song (Live)'},lyrics:{lines:[{text:'Wrong',timestamp:1}]}});
 assert.equal(await hintedRecording(api,request,restored,{deadline:Date.now()+1000}),null);
});
