import test from 'node:test';
import assert from 'node:assert/strict';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
const lrc={id:1,trackName:'Song',artistName:'Artist',albumName:'Album',duration:240,syncedLyrics:'[00:10]一起唱歌\n[00:20]慢慢听懂'};
const context={album:'Album',duration:240};
const ok=data=>({ok:true,json:async()=>data});

test('LRCLIB exact signature uses all metadata and validates before returning',async()=>{
 const urls=[];
 const fetchFn=async url=>{urls.push(url);return ok(lrc);};
 const song=await new LRCAPI().searchSong('Artist','Song',{...context,fetchFn});
 assert.equal(song.id,1);assert.equal(urls.length,1);
 const url=new URL(urls[0]);assert.equal(url.pathname,'/api/get');
 assert.deepEqual(Object.fromEntries(url.searchParams),{artist_name:'Artist',track_name:'Song',album_name:'Album',duration:'240'});
});
test('an exact lookup cover or wrong duration is rejected before normal search',async()=>{
 for(const change of [{artistName:'Cover'},{duration:270}]) {
  let calls=0;
  const fetchFn=async url=>{calls++;return ok(new URL(url).pathname==='/api/get' ? {...lrc,...change}:[{...lrc,id:2}]);};
  assert.equal((await new LRCAPI().searchSong('Artist','Song',{...context,fetchFn})).id,2);
  assert.equal(calls,2);
 }
});
test('an exact 404 is a normal miss, and partial metadata skips the exact endpoint',async()=>{
 for(const partial of [false,true]) {
  const urls=[];
  const fetchFn=async url=>{urls.push(url);return new URL(url).pathname==='/api/get' ? {ok:false,status:404}:ok([lrc]);};
  assert.equal((await new LRCAPI().searchSong('Artist','Song',{...(partial ? {}:context),fetchFn})).id,1);
  assert.equal(urls.length,partial ? 1:2);
 }
});
test('exact plain lyrics still allow a verified timed release upgrade',async()=>{
 const plain={...lrc,albumName:'Album - Single',syncedLyrics:null,plainLyrics:'一起唱歌\n慢慢听懂'};
 const fetchFn=async url=>ok(new URL(url).pathname==='/api/get' ? plain:[plain,{...lrc,id:2}]);
 const song=await new LRCAPI().searchSong('Artist','Song',{...context,album:'Album - Single',fetchFn});
 assert.equal(song.id,2);
});
test('credit-only exact results do not stop discovery and explicit instrumentals retain their flag',async()=>{
 const fetchFn=async url=>ok(new URL(url).pathname==='/api/get' ? {...lrc,syncedLyrics:'[00:00]作词 : Someone\n[00:01]作曲 : Someone'}:[{...lrc,id:2}]);
 assert.equal((await new LRCAPI().searchSong('Artist','Song',{...context,fetchFn})).id,2);
 const api=new LRCAPI(),song=await api.searchSong('Artist','Song',{...context,fetchFn:async()=>ok({...lrc,instrumental:true,syncedLyrics:null})});
 assert.equal(song.instrumental,true);
 assert.equal((await api.getLyrics(song.id,{song})).instrumental,true);
 assert.deepEqual(song.lyricsData.lines,[]);
});
const netease=(id=1,change={})=>({id,name:'Song',artists:[{id:10,name:'Artist'}],album:{name:'Album'},duration:240000,...change});
const page=songs=>({code:200,result:{songs}});
test('NetEase expands only a missed search and can find the recording at position80',async()=>{
 const limits=[];
 const fetchFn=async url=>{
  const limit=Number(new URL(url).searchParams.get('limit'));limits.push(limit);
  const songs=Array.from({length:limit},(_,i)=>netease(i+100,{name:'Other Song',duration:180000}));
  if(limit===100) songs[79]=netease(80);
  return ok(page(songs));
 };
 assert.equal((await new NeteaseAPI().searchSong('Artist','Song',{...context,fetchFn})).id,80);
 assert.deepEqual(limits,[30,100]);
 const fast=[];
 assert.equal((await new NeteaseAPI().searchSong('Artist','Song',{...context,fetchFn:async url=>{fast.push(url);return ok(page([netease()]));}})).id,1);
 assert.equal(fast.length,1);assert.equal(new URL(fast[0]).searchParams.get('limit'),'30');
});
test('NetEase hydrates only bounded top metadata ties and reuses the selected lyrics',async()=>{
 const requests=[];
 const fetchFn=async url=>{
  requests.push(url);
  return ok(new URL(url).pathname==='/lyric' ? {code:200,lrc:{lyric:'[00:10]一起唱歌\n[00:20]慢慢听懂'}}:page([netease(2),netease(1)]));
 };
 const api=new NeteaseAPI(),song=await api.searchSong('Artist','Song',{...context,fetchFn});
 assert.equal(song.id,1);assert.ok(song.lyricsData);
 await api.getLyrics(song.id,{song,fetchFn});
 assert.equal(requests.length,3);assert.equal(requests.filter(url=>new URL(url).pathname==='/search').length,1);
});
test('conflicting or oversized NetEase ties stay ambiguous without unbounded lyric requests',async()=>{
 for(const count of [2,4]) {
  let lyrics=0;
  const fetchFn=async url=>{
   const parsed=new URL(url);
   if(parsed.pathname==='/lyric') {lyrics++;return ok({code:200,lrc:{lyric:`[00:10]original fixture ${parsed.searchParams.get('id')}\n[00:20]another line`}});}
   return ok(page(Array.from({length:count},(_,i)=>netease(i+1))));
  };
  await assert.rejects(()=>new NeteaseAPI().searchSong('Artist','Song',{...context,fetchFn}),{code:'recording_mismatch'});
  assert.equal(lyrics,count===2 ? 2:0);
 }
});

test('LRCLIB rate limiting stops same-provider discovery rather than cascading searches',async()=>{
 let calls=0;
 await assert.rejects(()=>new LRCAPI().searchSong('Artist','Song',{...context,fetchFn:async()=>{calls++;return {ok:false,status:429};}}),{status:429});
 assert.equal(calls,1);
});

test('LRCLIB credit-only synced metadata does not hide plain vocal lyrics or invent an instrumental',()=>{
 const api=new LRCAPI();
 const data=api.lyricsFromRecord({...lrc,instrumental:true,syncedLyrics:'[00:00]作曲 : Someone',plainLyrics:'一起唱歌\n慢慢听懂'});
 assert.equal(data.instrumental,false);assert.equal(data.lines.length,2);assert.ok(data.lines.every(line=>line.timestamp===null));
 assert.equal(api.lyricsFromRecord({...lrc,instrumental:false,syncedLyrics:'[00:00]作曲 : Someone'}),null);
});

test('LRCLIB uses one distinctive movement suffix only after full title queries fail',async()=>{
 const title='Forgotten Battlefied - Cemetery’s Boat',urls=[];
 const record={...lrc,trackName:title};
 const fetchFn=async url=>{
  urls.push(url);const parsed=new URL(url);
  if(parsed.pathname==='/api/get') return {ok:false,status:404};
  return ok(parsed.searchParams.get('track_name')==='Cemetery’s Boat' ? [record,{...record,id:2,trackName:'Cemetery’s Boat',artistName:'Cover'}]:[]);
 };
 assert.equal((await new LRCAPI().searchSong('Artist',title,{...context,fetchFn})).id,1);
 assert.equal(urls.filter(url=>new URL(url).searchParams.get('track_name')==='Cemetery’s Boat').length,1);
 assert.equal(urls.length,4);
});
