import test from 'node:test';
import assert from 'node:assert/strict';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
import {lyricsFingerprint,isRejectedLyrics} from '../../api/utils/rejected-lyrics.js';
import {createMusicRomanizeHandler} from '../../api/music-romanize.js';
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
