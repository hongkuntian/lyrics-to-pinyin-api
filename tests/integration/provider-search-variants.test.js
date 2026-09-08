import test from 'node:test';
import assert from 'node:assert/strict';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
const record={id:1,trackName:'說好不哭',artistName:'Jay Chou feat. Ashin Chen',albumName:'說好不哭',duration:222,syncedLyrics:'[00:00.00]一起唱'};
test('LRCLIB returns a verified timed release duplicate without another network lookup',async()=>{
 const plain={id:10,trackName:'Song',artistName:'Artist',albumName:'Song - Single',duration:185,plainLyrics:'一起唱\n慢慢听'};
 const timed={...plain,id:11,albumName:'Song',syncedLyrics:'[00:10]一起唱\n[00:20]慢慢听'};
 let calls=0;
 const fetchFn=async()=>{calls++;return {ok:true,json:async()=>[plain,timed]};};
 const api=new LRCAPI(),song=await api.searchSong('Artist','Song',{album:'Song - Single',duration:185.008,fetchFn});
 assert.equal(song.id,11);
 assert.deepEqual((await api.getLyrics(song.id,{song,fetchFn})).lines.map(l=>l.timestamp),[10,20]);
 assert.equal(calls,1);
});
test('LRCLIB tries title and Chinese script variants without weakening candidate validation',async()=>{
 const urls=[];
 const fetchFn=async url=>{const p=new URL(url).searchParams;urls.push(url);return {ok:true,json:async()=>p.get('track_name')==='說好不哭' && !p.has('artist_name') ? [record,{...record,id:2,artistName:'Cover Singer'}]:[]};};
 const result=await new LRCAPI().searchSong('Jay Chou & Ashin Chen','说好不哭',{duration:222.333,album:'说好不哭 - Single',fetchFn});
 assert.equal(result.id,1);assert.ok(urls.length<=3);
});
test('broad discovery never selects a solo credit, wrong recording, or cover',async()=>{
 for(const changed of [{artistName:'Jay Chou'},{artistName:'Cover Singer'},{duration:231}]){
  const fetchFn=async()=>({ok:true,json:async()=>[{...record,...changed}]});
  await assert.rejects(()=>new LRCAPI().searchSong('Jay Chou & Ashin Chen','说好不哭',{duration:222.333,fetchFn}),/recording/i);
 }
});
test('a failed primary or script query does not discard another successful query',async()=>{
 const fetchFn=async url=>{
  const p=new URL(url).searchParams;
  if(p.has('artist_name') || p.get('track_name')==='说好不哭') return {ok:false,status:503};
  return {ok:true,json:async()=>[record]};
 };
 assert.equal((await new LRCAPI().searchSong('Jay Chou & Ashin Chen','说好不哭',{duration:222.333,fetchFn})).id,1);
});


test('NetEase discovers featured songs by base title and still validates every guest',async()=>{
 const {NeteaseAPI}=await import('../../api/music-apis/netease.js');
 const fetchFn=async url=>{
  assert.equal(new URL(url).searchParams.get('keywords'),'郑可为 小幸运');
  return {ok:true,json:async()=>({code:200,result:{songs:[{id:1,name:'小幸运',artists:[{name:'郑可为'},{name:'沈志豪'}],album:{name:'七年之氧'},duration:320226}]}})};
 };
 const result=await new NeteaseAPI().searchSong('鄭可為','小幸運 (feat. 沈志豪)',{duration:320.227,fetchFn});
 assert.equal(result.id,1);
 await assert.rejects(()=>new NeteaseAPI().searchSong('鄭可為','小幸運 (feat. Other)',{duration:320.227,fetchFn}),/recording/i);
});


test('NetEase verifies performer translations against the same artist IDs and caches them',async()=>{
 const {NeteaseAPI}=await import('../../api/music-apis/netease.js');
 const api=new NeteaseAPI();let details=0;
 const fetchFn=async url=>({ok:true,json:async()=>{
  if(url.includes('/artist/detail')) {details++;assert.equal(new URL(url).searchParams.get('id'),'10');return {code:200,data:{artist:{id:10,name:'郑可为',transNames:['Tay Kewei'],alias:[]}}};}
  return {code:200,result:{songs:[{id:1,name:'小幸运',artists:[{id:10,name:'郑可为'},{id:20,name:'沈志豪'}],album:{name:'七年之氧'},duration:320226}]}};
 }});
 for(let i=0;i<2;i++) {
  const song=await api.searchSong('Tay Kewei','小幸运 (feat. 沈志豪)',{duration:320.227,fetchFn});
  assert.equal(song.artist,'Tay Kewei & 沈志豪');assert.equal(song.id,1);
 }
 assert.equal(details,1);
});
test('NetEase artist aliases cannot hide wrong IDs, singers, guests or durations',async()=>{
 const {NeteaseAPI}=await import('../../api/music-apis/netease.js');
 for(const change of [{id:999,transNames:['Tay Kewei']},{id:10,transNames:['Other Singer']},{id:10,transNames:['Tay Kewei'],duration:330000},{id:10,transNames:['Tay Kewei'],guest:'Other Guest'}]) {
  const fetchFn=async url=>({ok:true,json:async()=>url.includes('/artist/detail') ? {code:200,data:{artist:{name:'郑可为',...change}}} : {code:200,result:{songs:[{id:1,name:'小幸运',artists:[{id:10,name:'郑可为'},{id:20,name:change.guest || '沈志豪'}],album:{name:'七年之氧'},duration:change.duration || 320226}]}}});
  await assert.rejects(()=>new NeteaseAPI().searchSong('Tay Kewei','小幸运 (feat. 沈志豪)',{duration:320.227,fetchFn}),/recording/i);
 }
});
