import test from 'node:test';
import assert from 'node:assert/strict';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
import {KugouAPI} from '../../api/music-apis/kugou.js';
import {getAvailableAPIs,getMusicAPI} from '../../api/music-apis/index.js';
const context={recordingProvider:'spotify',creditedArtistNames:['Band & Name','Guest'],duration:240};
const reply=body=>new Response(JSON.stringify(body));
test('NetEase preserves structured source credits and bypasses Apple-style artist alias hydration',async()=>{
  const api=new NeteaseAPI();api.namesForArtist=()=>assert.fail('Spotify full credited names never use artist alias hydration');
  const raw={id:42,name:'Song',duration:240000,artists:[{id:1,name:'Band & Name'},{id:2,name:'Guest'}],album:{name:'Album'}};
  const result=await api.searchSong('Band & Name & Guest','Song',{...context,fetchFn:async()=>reply({code:200,result:{songs:[raw]}})});
  assert.deepEqual(result.creditedArtistNames,['Band & Name','Guest']);
  await assert.rejects(api.searchSong('Band & Name & Guest','Song',{...context,creditedArtistNames:['Band','Name','Guest'],fetchFn:async()=>reply({code:200,result:{songs:[raw]}})}),{code:'recording_mismatch'});
});
test('LRCLIB plain source credits are parsed against complete names before legacy filtering',async()=>{
  const raw={id:42,trackName:'Song',artistName:'Band & Name & Guest',albumName:'Album',duration:240,syncedLyrics:'[00:12]One line\n[01:00]Another line'};
  const api=new LRCAPI();
  const result=await api.searchSong('Band & Name & Guest','Song',{...context,fetchFn:async()=>reply([raw])});
  assert.equal(result.id,42);
  await assert.rejects(api.searchSong('Band & Name & Guest','Song',{...context,fetchFn:async()=>reply([{...raw,creditedArtistNames:['Band','Name','Guest']}])}),{code:'recording_mismatch'});
  await assert.rejects(api.searchSong('Band & Name & Guest','Song',{...context,fetchFn:async()=>reply([{...raw,artistName:'Band & Name'}])}),{code:'recording_mismatch'});
});
test('Kugou complete-name comparison runs before flat-name filtering and rejects structured conflicts',async()=>{
  const raw={id:42,song:'Song',singer:'Band & Name & Guest',duration:240000,product_from:'官方推荐歌词',accesskey:'fixture'};
  const fetchFn=async url=>url.includes('/search?')?reply({status:200,candidates:[raw]}):reply({status:200,content:Buffer.from('[00:12]One line\n[01:00]Another line').toString('base64')});
  assert.equal((await new KugouAPI().searchSong('Band & Name & Guest','Song',{...context,fetchFn})).id,'42');
  await assert.rejects(new KugouAPI().searchSong('Band & Name & Guest','Song',{...context,fetchFn:async()=>reply({status:200,candidates:[{...raw,creditedArtistNames:['Band','Name','Guest']}]})}),{code:'recording_mismatch'});
});
test('the invented Spotify sample remains disabled and independent sources stay registered',()=>{
  assert.equal(getMusicAPI('en','spotify'),null);
  for(const script of ['en','zh','ja'])assert.ok(getAvailableAPIs(script).every(api=>['LRCAPI','NeteaseAPI','KugouAPI'].includes(api.name)));
});
