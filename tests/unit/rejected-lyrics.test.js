import test from 'node:test';
import assert from 'node:assert/strict';
import {lyricsFingerprint,isRejectedLyrics} from '../../api/utils/rejected-lyrics.js';

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
