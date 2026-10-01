import test from 'node:test';
import assert from 'node:assert/strict';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
import {lyricsFingerprint,isRejectedLyrics,isRejectedRecordingLyrics} from '../../api/utils/rejected-lyrics.js';
import {createMusicRomanizeService as createMusicRomanizeHandler} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

const request={artist:'Jacky Cheung',title:'我等到花兒也謝了',album:'真愛 新曲+真正精選',duration:278.507,catalog_id:'1440912488'};
// Original fixture words, with the metadata of the mislabeled public record.
const bad={id:13004903,artistName:request.artist,trackName:request.title,albumName:request.album,duration:278,
  syncedLyrics:'[00:02]这是错误版本的测试文字',plainLyrics:'这是错误版本的测试文字'};
const records=[{provider:'lrclib',id:String(bad.id),lyricsSha256:lyricsFingerprint([{text:bad.plainLyrics}])}];
const rejectLyrics=(provider,id,lines)=>isRejectedLyrics(provider,id,lines,records);
const fetchFn=async url=>({ok:true,json:async()=>new URL(url).pathname.startsWith('/api/get') ? bad:[bad]});

test('exact lookup, search, and direct lyric fetch all reject a reviewed bad transcription',async()=>{
  const api=new LRCAPI({rejectLyrics});
  assert.equal(await api.searchSong(request.artist,request.title,{...request,fetchFn}),null);
  assert.equal(await api.getLyrics(bad.id,{fetchFn}),null);
  const corrected={...bad,syncedLyrics:'[00:25]这是更正版本的测试文字'};
  assert.ok(api.lyricsFromRecord(corrected));
});
test('a bad synced field can use corrected plain lyrics, but cannot imply instrumental',()=>{
  const api=new LRCAPI({rejectLyrics});
  assert.equal(api.lyricsFromRecord({...bad,instrumental:true}),null);
  assert.equal(api.lyricsFromRecord({...bad,plainLyrics:'这是更正版本的测试文字'}).lines[0].timestamp,null);
});
test('handler falls back after rejection and never serves the known bad words during an outage',async()=>{
  for(const available of [true,false]) {
    const lrclib=new LRCAPI({rejectLyrics});
    const source={name:'LRCAPI',searchSong:(artist,title,context)=>lrclib.searchSong(artist,title,{...context,fetchFn}),getLyrics:(id,context)=>lrclib.getLyrics(id,{...context,fetchFn})};
    const fallback={name:'NeteaseAPI',searchSong:async()=>available ? {...request,id:189873,duration:278.506}:null,
      getLyrics:async()=>({lines:[{text:'这是更正版本的测试文字',timestamp:25}]})};
    const res=createMockRes();
    await createMusicRomanizeHandler({redis:null,getAvailableAPIsFn:()=>[source,fallback],hedgeDelayMs:1,
      lookupOfficialTranscriptionFn:async()=>null,lookupReviewedRecordingFn:async()=>null,resolveCatalogAliasesFn:async()=>[],
      getProcessorFn:()=>({romanize:async text=>({romanized:text})}),logger:{error(){}}})(createMockReq({body:request}),res);
    assert.equal(res.statusCode,available ? 200:404);
    if(available) {assert.equal(res.body.song.id,189873);assert.equal(res.body.lines[0].original,'这是更正版本的测试文字');}
  }
});

const recordingReviews=[{catalogIDs:[request.catalog_id],lyricsSha256:lyricsFingerprint([{text:bad.plainLyrics}])}];
const rejectRecordingLyrics=(lines,recording)=>isRejectedRecordingLyrics(lines,recording,recordingReviews);
test('LRCLIB filters duplicated wrong-version words before ranking, including direct and cached reads',async()=>{
  const api=new LRCAPI({rejectRecordingLyrics});
  const duplicate={...bad,id:999999};
  const good={...bad,id:888888,albumName:'Another compilation',syncedLyrics:'[00:25]这是更正版本的测试文字',plainLyrics:null};
  const fetchFn=async url=>({ok:true,json:async()=>new URL(url).pathname.startsWith('/api/get') ? duplicate:[duplicate,good]});
  assert.equal((await api.searchSong(request.artist,request.title,{...request,fetchFn})).id,good.id);
  assert.equal(await api.getLyrics(duplicate.id,{...request,fetchFn}),null);
  assert.equal(await api.getLyrics(duplicate.id,{...request,song:{lyricsData:{lines:[{text:bad.plainLyrics}]}}}),null);
  assert.ok(api.lyricsFromRecord(duplicate,{...request,catalog_id:'456'}));
  assert.equal(api.lyricsFromRecord({...duplicate,instrumental:true},request),null);
  assert.equal(api.lyricsFromRecord({...duplicate,plainLyrics:good.syncedLyrics},request).lines[0].timestamp,25);
});
test('every provider rejects a known wrong language version and preserves legitimate requests',async()=>{
  const wrong={name:'NeteaseAPI',searchSong:async()=>({...request,id:999999}),getLyrics:async()=>({lines:[{text:bad.plainLyrics,timestamp:25}]})};
  for(const available of [true,false]) {
    const fallback={name:'LRCAPI',searchSong:async()=>available?{...request,id:888888}:null,
      getLyrics:async()=>({lines:[{text:'这是更正版本的测试文字',timestamp:25}]})};
    const handler=createMusicRomanizeHandler({redis:null,getAvailableAPIsFn:()=>[wrong,fallback],hedgeDelayMs:1,
      rejectRecordingLyricsFn:rejectRecordingLyrics,lookupOfficialTranscriptionFn:async()=>null,
      lookupListeningReviewedRecordingFn:async()=>null,lookupReviewedRecordingFn:async()=>null,resolveCatalogAliasesFn:async()=>[],
      getProcessorFn:()=>({romanize:async text=>({romanized:text})}),logger:{error(){}}});
    const result=createMockRes();await handler(createMockReq({body:request}),result);
    assert.equal(result.statusCode,available?200:409);
    if(available)assert.equal(result.body.song.id,888888);
    const legitimate=createMockRes();await handler(createMockReq({body:{...request,catalog_id:'456'}}),legitimate);
    assert.equal(legitimate.statusCode,200);assert.equal(legitimate.body.song.id,999999);
  }
});
