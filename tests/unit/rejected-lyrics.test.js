import test from 'node:test';
import assert from 'node:assert/strict';
import {lyricsFingerprint,isRejectedLyrics,isRejectedRecordingLyrics} from '../../api/utils/rejected-lyrics.js';
import {lyricSourceNeedsRefresh} from '../../api/utils/timing-corrections.js';

const lines=[{text:'這是測試文字',timestamp:10},{text:'我們一起練習',timestamp:20}];
const records=[{provider:'lrclib',id:'123',lyricsSha256:lyricsFingerprint(lines)}];
test('reviewed rejection binds the provider, record ID, and lyric content',()=>{
  assert.equal(isRejectedLyrics('lrclib',123,lines,records),true);
  assert.equal(isRejectedLyrics('netease',123,lines,records),false);
  assert.equal(isRejectedLyrics('lrclib',124,lines,records),false);
  assert.equal(isRejectedLyrics('lrclib',123,[{text:'已经更正的测试文字'}],records),false);
  assert.equal(isRejectedLyrics('lrclib',123,[],records),false);
});
test('retiming, punctuation, script, and wrapping cannot rehabilitate the same rejected words',()=>{
  const reformatted=[{text:'这是测试文字，我们一起练习！',timestamp:40}];
  assert.equal(isRejectedLyrics('lrclib','123',reformatted,records),true);
});
test('recording-specific rejection follows duplicated words without rejecting their legitimate version',()=>{
  const reviews=[{catalogIDs:['123'],lyricsSha256:lyricsFingerprint(lines)}];
  const reformatted=[{text:'这是测试文字，我们一起练习！',timestamp:40}];
  assert.equal(isRejectedRecordingLyrics(reformatted,{catalog_id:'123'},reviews),true);
  assert.equal(isRejectedRecordingLyrics(reformatted,{catalog_id:'124'},reviews),false);
  assert.equal(isRejectedRecordingLyrics(reformatted,{},reviews),false);
  assert.equal(isRejectedRecordingLyrics([{text:'已经更正的测试文字'}],{catalog_id:'123'},reviews),false);
  assert.equal(isRejectedRecordingLyrics([],{catalog_id:'123'},reviews),false);
});
test('cache freshness uses the same recording-specific content rejection independently of timing',()=>{
  const reviews=[{catalogIDs:['123'],lyricsSha256:lyricsFingerprint(lines)}];
  const response={lines:lines.map(line=>({original:line.text,timestamp:line.timestamp}))};
  assert.equal(lyricSourceNeedsRefresh(response,{catalog_id:'123'},{recordingRejections:reviews}),true);
  assert.equal(lyricSourceNeedsRefresh(response,{catalog_id:'124'},{recordingRejections:reviews}),false);
  assert.equal(lyricSourceNeedsRefresh({...response,lines:response.lines.map(l=>({...l,timestamp:null}))},{catalog_id:'123'},{recordingRejections:reviews}),true);
});
