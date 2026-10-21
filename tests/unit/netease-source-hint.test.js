import test from 'node:test';
import assert from 'node:assert/strict';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {hintedRecording,prioritizeHintedTargets} from '../../api/utils/source-hint.js';
import {createVerifiedContextCache} from '../../api/utils/verified-lyric-context.js';

const request={artist:'Eason Chan',title:'Synthetic Song',album:'Synthetic Album',duration:240};
const raw=()=>({id:42,name:'Synthetic Song',dt:240000,al:{name:'Synthetic Album'},ar:[{id:2116,name:'Independent Singer'}]});
const context=changes=>({...request,...changes});
function network({record=raw(),profileID=2116,aliases=['Eason Chan']}={}) {
 const calls=[];
 const fetchFn=async url=>{const path=new URL(url).pathname;calls.push(path);
  const data=path==='/song/detail'?{code:200,songs:Array.isArray(record)?record:[record]}
   :path==='/artist/detail'?{code:200,data:{artist:{id:profileID,name:'Independent Singer',alias:aliases}}}
   :{code:200,lrc:{lyric:'[00:12]Fresh invented words\n[01:00]Another invented line'}};
  return {ok:true,status:200,json:async()=>data};
 };
 return {calls,fetchFn};
}
test('NetEase ID hint fetches fresh metadata, provider-owned aliases and lyrics without search or prior lyricsData',async()=>{
 const n=network(),api=new NeteaseAPI();
 const result=await api.getRecording('42',context({fetchFn:n.fetchFn,song:{lyricsData:{unsafe:true}}}));
 assert.equal(result.song.id,42);assert.equal(result.song.artist,'Eason Chan');
 assert.equal(result.lyrics.lines[0].text,'Fresh invented words');
 assert.deepEqual(n.calls,['/song/detail','/artist/detail','/lyric/new']);
});
test('NetEase ID hint rejects changed/absent/duplicate IDs and incompatible recordings before fetching words',async()=>{
 for(const record of [{...raw(),id:43},[],[raw(),raw()],{...raw(),dt:260000},{...raw(),name:'Synthetic Song (Live)'},{...raw(),ar:[]},{...raw(),ar:[{id:'bad',name:'Independent Singer'}]}]){
  const n=network({record});await assert.rejects(()=>new NeteaseAPI().getRecording('42',context({fetchFn:n.fetchFn})));
  assert.equal(n.calls.includes('/lyric/new'),false);
 }
 for(const id of ['spotify:track:42','42&ids=43','',0])assert.equal(await new NeteaseAPI().getRecording(id,context({fetchFn:()=>assert.fail('invalid ID must not fetch')})),null);
});
test('artist aliases require the matching provider artist ID and actual independent equivalent name',async()=>{
 for(const options of [{profileID:999},{aliases:['Unrelated Performer']}]){
  const n=network(options);await assert.rejects(()=>new NeteaseAPI().getRecording('42',context({fetchFn:n.fetchFn})));
  assert.equal(n.calls.includes('/lyric/new'),false);
 }
});
test('Apple verified clean catalog evidence rejects a fresh explicitly marked NetEase source before words',async()=>{
 const n=network({record:{...raw(),explicit:true}});
 await assert.rejects(()=>new NeteaseAPI().getRecording('42',context({explicit:false,fetchFn:n.fetchFn})),{code:'recording_mismatch'});
 assert.equal(n.calls.includes('/lyric/new'),false);
});
test('Spotify fresh ID keeps whole credited names and never drops a guest or splits band punctuation',async()=>{
 const spotify={artist:'Band & Name & Guest',title:request.title,album:request.album,duration:240,recordingProvider:'spotify',creditedArtistNames:['Band & Name','Guest'],isrc:'USABC2600001',explicit:false};
 const record={...raw(),ar:[{id:1,name:'Band & Name'},{id:2,name:'Guest'}],isrc:'USABC2600001',explicit:false};
 const n=network({record}),result=await new NeteaseAPI().getRecording('42',{...spotify,fetchFn:n.fetchFn});
 assert.deepEqual(result.song.creditedArtistNames,['Band & Name','Guest']);assert.equal(n.calls.includes('/artist/detail'),false);
 for(const changed of [{ar:[record.ar[0]]},{isrc:'USABC2600002'},{explicit:true},{dt:260000}]){
  const bad=network({record:{...record,...changed}});await assert.rejects(()=>new NeteaseAPI().getRecording('42',{...spotify,fetchFn:bad.fetchFn}));
  assert.equal(bad.calls.includes('/lyric/new'),false);
 }
});
test('existing verified context persists NetEase signature only and does not extend expiry',async()=>{
 let now=1000;const disk=new Map(),pending=[];
 const deps={redis:{},now:()=>now,ttlMs:100,policy:{selection:'s'},getFn:async(_,k)=>disk.get(k),setFn:async(_,k,v)=>disk.set(k,structuredClone(v)),waitUntilFn:p=>pending.push(p)};
 const r={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:request.title,artists:['Eason Chan'],duration_ms:240000}};
 const cache=createVerifiedContextCache(deps),base=cache.spotify(r,{recordingBinding:{sourceHash:'a'.repeat(64)}},10);
 const hinted=cache.hint(base,{api:{name:'NeteaseAPI'},song:{id:42,...request,source:'netease',lyricsData:{privateWords:true}},target:request});
 assert.equal(hinted.hints[0].provider,'NeteaseAPI');assert.equal(hinted.hints[0].signature.lyricsData,undefined);cache.save(hinted);await Promise.all(pending);
 now=1020;const recovered=await createVerifiedContextCache(deps).read(r,'spotify');assert.equal(recovered.expiresAtMS,1100);
 cache.save(cache.hint(recovered,{api:{name:'NeteaseAPI'},song:{id:42,...request},target:request},20));await Promise.all(pending);
 now=1100;assert.equal(await createVerifiedContextCache(deps).read(r,'spotify'),null);
});
test('a NetEase source hint uses its bounded provider-specific budget and keeps ordinary fallback deadline',async()=>{
 const target={...request},hint={provider:'NeteaseAPI',id:'42',signature:{id:42,...request},target};
 let suppliedSignal;const api={name:'NeteaseAPI',getRecording:async(_,c)=>{suppliedSignal=c.signal;return {song:{id:42,...request},lyrics:{lines:[{text:'invented',timestamp:1}]}};}};
 const result=await hintedRecording(api,target,{hints:[hint]},{deadline:Date.now()+100,budgetMs:10,neteaseBudgetMs:30});
 assert.equal(result.song.id,42);assert.ok(suppliedSignal);
 const controller=new AbortController();controller.abort();let calls=0;
 assert.equal(await hintedRecording({...api,getRecording:async()=>{calls++;}},target,{hints:[hint]},{deadline:Date.now()+100,signal:controller.signal}),null);assert.equal(calls,0);
});

test('hint ordering only promotes an exact current target and leaves proof and unrelated targets untouched',()=>{
 const original={...request,catalog_id:'123'},localized={...original,artist:'Independent Singer'},targets=[original,localized];
 const hint={hints:[{provider:'NeteaseAPI',target:structuredClone(localized)}]},before=JSON.stringify(targets);
 assert.deepEqual(prioritizeHintedTargets(targets,hint),[localized,original]);assert.equal(JSON.stringify(targets),before);
 for(const changed of [{duration:241},{album:'Changed'},{catalog_id:'124'},{artist_entities:[{id:'new',name:'Independent Singer'}]}])
  assert.equal(prioritizeHintedTargets([original,{...localized,...changed}],hint)[0],original);
 assert.equal(prioritizeHintedTargets(targets,{hints:[{provider:'LRCAPI',target:localized}]}),targets);
});
