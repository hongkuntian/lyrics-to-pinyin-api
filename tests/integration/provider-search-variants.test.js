import test from 'node:test';
import assert from 'node:assert/strict';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
const record={id:1,trackName:'說好不哭',artistName:'Jay Chou feat. Ashin Chen',albumName:'說好不哭',duration:222,syncedLyrics:'[00:00.00]一起唱'};
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
