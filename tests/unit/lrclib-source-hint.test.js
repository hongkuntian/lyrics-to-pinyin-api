import test from 'node:test';
import assert from 'node:assert/strict';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
test('fresh LRCLIB ID returns independent metadata and words, ignoring stale lyricsData',async()=>{
 const api=new LRCAPI(),urls=[];
 const value=await api.getRecording('42',{artist:'Singer & Guest',title:'Song',duration:240,song:{lyricsData:{lines:[{text:'STALE'}]}},fetchFn:async url=>{urls.push(url);return {ok:true,json:async()=>({id:42,trackName:'Song',artistName:'Singer + Guest',albumName:'Album',duration:240,syncedLyrics:'[00:12]new words'})};}});
 assert.equal(urls.length,1);assert.match(urls[0],/\/get\/42$/);assert.equal(value.song.artist,'Singer & Guest');assert.equal(value.lyrics.lines[0].text,'new words');
 await assert.rejects(api.getRecording('42',{fetchFn:async()=>({ok:true,json:async()=>({id:43})})}),{reason:'source_id_changed'});
});
test('a timed romanized exact match still searches for native words without losing outage fallback',async()=>{
 const raw={id:9217531,trackName:'紅日',artistName:'Hacken Lee',albumName:'紅日',duration:287,syncedLyrics:'[00:20]Meng wan jau shuin\n[00:24]Thin bou lau lei'};
 for(const available of [true,false]) {
  const urls=[],api=new LRCAPI();
  const result=await api.searchSong('Hacken Lee','紅日',{album:'紅日',duration:287,fetchFn:async url=>{
   urls.push(url);
   if(url.includes('/get?'))return {ok:true,json:async()=>raw};
   if(!available)throw new Error('offline');
   return {ok:true,json:async()=>[raw,{...raw,id:8812366,syncedLyrics:null,plainLyrics:'这是测试歌词\n这是另一句测试'}]};
  }});
  assert.ok(urls.some(url=>url.includes('/search?')));
  assert.equal(result.id,available?8812366:9217531);
 }
});
test('a rate-limited native search retains an admitted exact fallback and stops further requests',async()=>{
 const urls=[],api=new LRCAPI();
 const result=await api.searchSong('Hacken Lee','紅日',{album:'紅日',duration:287,fetchFn:async url=>{
  urls.push(url);
  if(url.includes('/get?'))return {ok:true,json:async()=>({id:9217531,trackName:'紅日',artistName:'Hacken Lee',albumName:'紅日',duration:287,syncedLyrics:'[00:20]Meng wan jau shuin\n[00:24]Thin bou lau lei'})};
  return {ok:false,status:429,headers:new Headers({'retry-after':'30'})};
 }});
 assert.equal(result.id,9217531);assert.equal(urls.length,2);
});
