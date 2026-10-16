import test from 'node:test';
import assert from 'node:assert/strict';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
test('fresh LRCLIB ID returns independent metadata and words, ignoring stale lyricsData',async()=>{
 const api=new LRCAPI(),urls=[];
 const value=await api.getRecording('42',{artist:'Singer & Guest',title:'Song',duration:240,song:{lyricsData:{lines:[{text:'STALE'}]}},fetchFn:async url=>{urls.push(url);return {ok:true,json:async()=>({id:42,trackName:'Song',artistName:'Singer + Guest',albumName:'Album',duration:240,syncedLyrics:'[00:12]new words'})};}});
 assert.equal(urls.length,1);assert.match(urls[0],/\/get\/42$/);assert.equal(value.song.artist,'Singer & Guest');assert.equal(value.lyrics.lines[0].text,'new words');
 await assert.rejects(api.getRecording('42',{fetchFn:async()=>({ok:true,json:async()=>({id:43})})}),{reason:'source_id_changed'});
});
