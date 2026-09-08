import test from 'node:test';
import assert from 'node:assert/strict';
import {findRecording} from '../../api/utils/recording-match.js';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
import {detectLanguage} from '../../api/utils/language-detection.js';

const request = {artist:'Eric Chou', title:'Unbreakable Love', duration:258.264};
// Provider metadata from the investigation; the lyric content is an original test fixture.
const lyricsData = {lines:[{text:'一起唱', timestamp:0}, {text:'慢慢听', timestamp:4}]};
const english = {id:6822199, ...request, duration:258, album:'The Chaos After You', lyricsData};
const duplicate = {...english, id:36456654, album:'如果雨之后'};

test('equivalent localized-album duplicates resolve deterministically without an album', () => {
  assert.equal(findRecording([duplicate,english],request).id,6822199);
  assert.equal(findRecording([english,duplicate],request).id,6822199);
  assert.equal(findRecording([duplicate,english],{...request,album:'如果雨之後'}).id,36456654);
});
test('deduplication does not conceal conflicting timing, text, versions or unknown lyrics', () => {
  for (const changed of [
    {...duplicate,lyricsData:{lines:[{text:'一起唱',timestamp:1},{text:'慢慢听',timestamp:4}]}},
    {...duplicate,lyricsData:{lines:[{text:'别的歌',timestamp:0}]}},
    {...duplicate,album:'Live'}, {...duplicate,album:'Demo'},
    {...duplicate,lyricsData:null}
  ]) assert.throws(()=>findRecording([english,changed],request),/recording/i);
  assert.throws(()=>findRecording([{...english,artist:'Cover Artist'}],request),/recording/i);
  assert.throws(()=>findRecording([{...english,duration:40}],request),/recording/i);
});

test('explicit instrumental duplicates with the same recording metadata resolve deterministically', () => {
  const song={id:35279058,title:'Forgotten Battlefield - Lueur Déclinante',artist:'Lorien Testard',album:'Clair Obscur: Expedition 33 (Original Soundtrack)',duration:196,
    lyricsData:{source:'lrclib',instrumental:true,lines:[]}};
  const duplicate={...song,id:24445380,album:`Optional("${song.album}")`};
  const query={...song,catalog_id:'1808472926',title:'Forgotten Battlefied - Lueur Déclinante'};
  for(const songs of [[song,duplicate],[duplicate,song]]) assert.equal(findRecording(songs,query).id,24445380);
});

test('instrumental deduplication requires explicit evidence and cannot hide conflicting recordings', () => {
  const song={id:1,title:'Quiet Movement',artist:'Composer',album:'Original Soundtrack',duration:196,
    lyricsData:{source:'lrclib',instrumental:true,lines:[]}};
  const query={artist:song.artist,title:song.title,duration:196};
  for(const changed of [
    {lyricsData:null}, {lyricsData:{lines:[]}},
    {lyricsData:{instrumental:true,lines:[{text:'Actual vocal words',timestamp:5}]}},
    {album:undefined}, {album:'Other Soundtrack'}, {album:'Original Soundtrack (Live)'}
  ]) assert.throws(()=>findRecording([song,{...song,id:2,...changed}],query),/recording/i);
  assert.throws(()=>findRecording([song,{...song,id:2,duration:197}],{...query,duration:196.5}),/recording/i);
});

const catalogEnglish = {trackId:1321295664,kind:'song',trackName:request.title,artistName:request.artist,collectionName:english.album,trackTimeMillis:258264};
const catalogChinese = {...catalogEnglish,trackName:'永不失聯的愛',artistName:'周興哲',collectionName:'如果雨之後'};
const fetchFn = async url => ({ok:true,json:async()=>({results:[new URL(url).searchParams.get('country')==='tw' ? catalogChinese : catalogEnglish]})});
test('localized aliases require the same Apple catalog identity and matching request metadata', async () => {
  const aliases=await resolveCatalogAliases({...request,catalog_id:'1321295664'},{fetchFn});
  assert.ok(aliases.some(a=>a.title==='永不失聯的愛' && a.artist==='周興哲'));
  assert.deepEqual(await resolveCatalogAliases({...request,artist:'Cover Artist',catalog_id:'1321295664'},{fetchFn}),[]);
  assert.deepEqual(await resolveCatalogAliases({...request,duration:290,catalog_id:'1321295664'},{fetchFn}),[]);
  assert.deepEqual(await resolveCatalogAliases({...request,catalog_id:'library-id'},{fetchFn}),[]);
  assert.deepEqual(await resolveCatalogAliases({...request,catalog_id:'999'},{fetchFn}),[]);
});
test('a catalog outage cannot fail an otherwise ordinary lyrics lookup', async () => {
  assert.deepEqual(await resolveCatalogAliases({...request,catalog_id:'1321295664'},{fetchFn:async()=>{throw new Error('offline');}}),[]);
});
test('lyric language handles mixed Latin text and Japanese with Han characters', async () => {
  assert.equal(await detectLanguage('一起唱 慢慢听 再唱一遍 oh'), 'zh');
  assert.equal(await detectLanguage('沒有關係 聯繫你和我'), 'zh');
  assert.equal(await detectLanguage('世界で君を待っている'), 'ja');
  assert.equal(await detectLanguage('hello world'), 'en');
});
