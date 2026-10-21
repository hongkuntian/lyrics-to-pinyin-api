import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRecordingText,recordingScore} from '../../api/utils/recording-match.js';
import {canonicalJSON,spotifyRequestHash} from '../../api/utils/song-library/spotify-recording.js';
import {lyricsFingerprint,isRejectedRecordingLyrics} from '../../api/utils/rejected-lyrics.js';
import {QQMusicAPI} from '../../api/music-apis/qq.js';
import {KugouAPI} from '../../api/music-apis/kugou.js';
import {LRCAPI} from '../../api/music-apis/lrclib.js';

const source={id:239188,title:'没那么简单',artist:'黄小琥',creditedArtistNames:['黄小琥'],album:'简单/不简单',duration:310.133};
const target={recordingProvider:'spotify',title:'沒那麽簡單',artist:'黃小琥',creditedArtistNames:['黃小琥'],album:'簡單不簡單',duration:310.133};
test('dictionary Chinese variants match catalogue metadata without granting recording or singer equivalence',()=>{
 for(const title of ['沒那麽簡單','沒那麼簡單','没那么简单'])assert.ok(recordingScore(source,{...target,title})>=0,title);
 for(const [a,b] of [['羣星','群星'],['牀邊故事','床边故事'],['祕密','秘密'],['山峯','山峰']])assert.equal(normalizeRecordingText(a),normalizeRecordingText(b));
 for(const changed of [{title:'没那么容易'},{artist:'黄小虎',creditedArtistNames:['黄小虎']},{duration:248.91},
  {title:'没那么简单 (Live)'},{album:'简单不简单 (Remastered)'},{creditedArtistNames:['黄小琥','Guest']},{explicit:true}])
  assert.equal(recordingScore({...source,...changed},{...target,explicit:false}),-1,JSON.stringify(changed));
 assert.notEqual(normalizeRecordingText('Rene Liu'),normalizeRecordingText('René Liu'));
 assert.notEqual(normalizeRecordingText('カナ祕'),normalizeRecordingText('カナ秘'));
 assert.notEqual(normalizeRecordingText('한祕'),normalizeRecordingText('한秘'));
});
test('catalogue normalization never changes raw Spotify request bytes or its hash',()=>{
 const recording={version:2,provider:'spotify',item_id:'4xZIMRwaaBx7CZMmM6KLuh',metadata:{origin:'spotify',title:target.title,artists:[target.artist],album:target.album,duration_ms:310133}};
 const bytes=canonicalJSON(recording),hash=spotifyRequestHash(recording);
 assert.ok(recordingScore(source,target)>=0);
 assert.equal(canonicalJSON(recording),bytes);assert.equal(spotifyRequestHash(recording),hash);
 assert.notEqual(spotifyRequestHash({...recording,metadata:{...recording.metadata,title:'没那么简单'}}),hash);
});
test('reviewed negative lyric fingerprints retain their published recipe across metadata normalization changes',()=>{
 const lines=[{text:'Invented 麽 羣 牀 祕 峯!'}];
 const old='e739f3a7c2d0d128cbbed1015c3844470ae60e1f95f7260b6464b6ab52705081';
 assert.equal(lyricsFingerprint(lines),old);
 assert.notEqual(lyricsFingerprint([{text:'Invented 么 群 床 秘 峰!'}]),old);
 assert.equal(isRejectedRecordingLyrics(lines,{catalog_id:'123'},[{catalogIDs:['123'],lyricsSha256:old}]),true);
});
test('QQ and Kugou discovery use canonical Chinese query spelling within their existing query budgets',async()=>{
 const queries=[];
 const fetchFn=async url=>{
  const u=new URL(url);queries.push(u.searchParams.get('key')??u.searchParams.get('w')??u.searchParams.get('keyword'));
  return {ok:true,url,status:200,headers:new Map(),json:async()=>u.hostname==='lyrics.kugou.com'?{status:200,candidates:[]}:
   {code:0,data:{song:u.pathname.includes('smartbox')?{count:0,itemlist:[]}:{list:[]}}}};
 };
 await new QQMusicAPI().searchSong(target.artist,target.title,{...target,fetchFn});
 await new KugouAPI().searchSong(target.artist,target.title,{...target,fetchFn});
 assert.equal(queries.length,3);assert.ok(queries.every(q=>q.includes('没那么简单')&&q.includes('黄小琥')));
});
test('LRCLIB broad script queries use canonical simplified and traditional spellings',async()=>{
 const queries=[];
 const fetchFn=async url=>{const u=new URL(url);queries.push(u.searchParams);return u.pathname.endsWith('/get')?{ok:false,status:404}:{ok:true,json:async()=>[]};};
 await new LRCAPI().searchSong(target.artist,target.title,{...target,fetchFn});
 const broad=queries.filter(p=>!p.has('artist_name')).map(p=>p.get('track_name'));
 assert.deepEqual(broad.sort(),['没那么简单','沒那麼簡單'].sort());
});
test('QQ Japanese and Korean discovery retains its original catalogue query spelling',async()=>{
 for(const title of ['愛のうた','한祕']){
  const queries=[];
  const fetchFn=async url=>{const u=new URL(url);queries.push(u.searchParams.get('key')??u.searchParams.get('w'));return {ok:true,url,headers:new Map(),json:async()=>({code:0,data:{song:u.pathname.includes('smartbox')?{count:0,itemlist:[]}:{list:[]}}})};};
  await new QQMusicAPI().searchSong('歌手',title,{duration:240,fetchFn});
  assert.deepEqual(queries,[title+' 歌手','歌手 '+title]);
 }
});
