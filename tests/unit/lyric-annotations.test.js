import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {cleanLyrics} from '../../api/utils/lyric-quality.js';
import {LYRIC_NORMALIZATION_VERSION} from '../../api/utils/lyric-annotations.js';
const top={artist:'TOP Debut Boy Group',duration:271.291};
const rows=texts=>texts.map((text,i)=>({text,timestamp:i*4+1}));

test('TOP source formatting removes all 18 credits and 12 cues while retaining 37 ordered vocals',async()=>{
  const fixture=JSON.parse(await readFile(new URL('../fixtures/lyric-annotations-top.json',import.meta.url)));
  const result=cleanLyrics({lines:fixture.lines},{artist:fixture.artist,duration:fixture.duration});
  assert.deepEqual(result.lines,fixture.expectedVocalSourceIndices.map(i=>fixture.lines[i]));
  assert.equal(result.lines.length,37);
  assert.equal(result.lyricStructure.annotations.filter(a=>a.kind==='production_credit').length,18);
  assert.equal(result.lyricStructure.annotations.filter(a=>a.kind==='performer_cue').length,12);
  assert.deepEqual(result.lyricStructure.occurrences.map(o=>o.sourceIndex),fixture.expectedVocalSourceIndices);
});

test('bilingual role grammar consumes the complete label without changing sung text',()=>{
  const data={lines:rows(['編曲 Arrangement：Example','Recording Engineer（录音师）：Example',
    '混音/母带处理工作室Mixing/Mastering Studio：Example','人声编辑Vocal Editing：Example',
    '统筹：Example','出品人：Example','编曲Anything：保留','我说：别走','凌晨3:30','(oh yeah)'])};
  const result=cleanLyrics(data);
  assert.deepEqual(result.lines,data.lines.slice(6));
  assert.equal(result.lyricStructure.annotations.length,6);
  assert.deepEqual(result.lyricStructure.sourceRows,data.lines);
});
test('standalone member and combined labels become hidden turns without moving vocal timestamps',()=>{
  const data={lines:rows(['编曲Arrangement：Example','合：','第一句测试歌词','张极Jeremy：',
    '第二句测试歌词','[张泽禹Zack/左航LEFT]','第三句测试歌词','合：','第一句测试歌词'])};
  const result=cleanLyrics(data,top),s=result.lyricStructure;
  assert.deepEqual(result.lines,[data.lines[2],data.lines[4],data.lines[6],data.lines[8]]);
  assert.deepEqual(s.occurrences.map(o=>o.sourceIndex),[2,4,6,8]);
  assert.deepEqual(s.occurrences.map(o=>o.startsTurn),[true,true,true,true]);
  assert.deepEqual(s.speakers.map(x=>x.displayName),['All','张极','张泽禹 / 左航']);
  assert.equal(s.version,LYRIC_NORMALIZATION_VERSION);
  assert.deepEqual(cleanLyrics(result,top),result);
});
test('inline prefixes preserve the words and source mapping across subsequent cleanup',()=>{
  const data={lines:[{text:'  張極Jeremy：  我说：别走  ',timestamp:9},{text:'朱志鑫22X：张极Jeremy：这是引用',timestamp:20},
    {text:'【张泽禹Zack】：我说：别走',timestamp:23}]};
  const result=cleanLyrics(data,top);
  assert.deepEqual(result.lines.map(l=>l.text),['我说：别走','张极Jeremy：这是引用','我说：别走']);
  for(const o of result.lyricStructure.occurrences) assert.equal(o.sourceText.slice(o.sourcePrefix.length).trim(),o.lyricText);
  assert.deepEqual(cleanLyrics(result,top),result);
});
test('unknown and partial identities, colon punctuation and ordinary brackets survive',()=>{
  const data={lines:rows(['我说：','别走','合：一起唱','[oh yeah]','张极Jeremy/陌生人：保留','未知：保留','Chorus: love / hope'])};
  assert.deepEqual(cleanLyrics(data,top).lines,data.lines);
  const other={lines:rows(['张极Jeremy：','合：','实际歌词'])};
  assert.deepEqual(cleanLyrics(other,{artist:'Another band'}).lines,other.lines);
});
test('a generic cue needs a confirmed performer context and does not consume sung chorus words',()=>{
  const data={lines:rows(['张极Jeremy：第一句','Chorus: sing this line with me','合：重复的歌词'])};
  assert.deepEqual(cleanLyrics(data,top).lines.map(l=>l.text),['第一句','sing this line with me','重复的歌词']);
});
test('provider identities and reviewed artist aliases work without inferring arbitrary names',()=>{
  const data={lines:rows(['甲：一起唱','乙：再唱一遍'])};
  const result=cleanLyrics(data,{performers:[{name:'A',aliases:['甲']},{name:'B',aliases:['乙']}]});
  assert.deepEqual(result.lines.map(l=>l.text),['一起唱','再唱一遍']);
  const legacy=cleanLyrics({lines:rows(['卢：一起唱','王：再唱一遍'])},{catalogID:'342794615'});
  assert.deepEqual(legacy.lyricStructure.speakers.map(s=>s.displayName),['Lo','Wang']);
});
test('an initial context-free pass retains source rows for a later verified artist and retiming',()=>{
  const data={lines:rows(['作词：Example','张极Jeremy：','实际歌词','实际歌词'])};
  const first=cleanLyrics(data);
  const result=cleanLyrics({...first,lines:first.lines.map(l=>({...l,timestamp:l.timestamp+2}))},top);
  assert.deepEqual(result.lines,[{...data.lines[2],timestamp:11},{...data.lines[3],timestamp:15}]);
  assert.deepEqual(result.lyricStructure.sourceRows,data.lines);
  assert.deepEqual(result.lyricStructure.occurrences.map(o=>o.sourceIndex),[2,3]);
});
