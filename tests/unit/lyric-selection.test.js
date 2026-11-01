import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseLyricCandidate,chooseMeasuredLyricCandidate,timingQuality,needsTimingDiscovery,lyricResponseLifetimeMs} from '../../api/utils/lyric-selection.js';
const candidate=(partial,times)=>({song:{duration:220},lyrics:{partial,lines:times.map((timestamp,i)=>({text:'verse '+i,timestamp}))}});
test('complete text outranks partial timestamped text; useful timing improves complete text',()=>{
 const plain=candidate(false,[null,null,null]),partial=candidate(true,[1,20,40]),timed=candidate(false,[1,20,40]);
 assert.equal(chooseLyricCandidate(plain,partial),plain);
 assert.equal(chooseLyricCandidate(partial,plain),plain);
 assert.equal(chooseLyricCandidate(plain,timed),timed);
});
test('invalid or token timestamps do not claim a usable timeline or listening review',()=>{
 for(const times of [[0,null,null],[10,5,20],[1,20,300],[0,0,0]]) assert.equal(timingQuality(candidate(false,times)).usable,false);
 const quality=timingQuality(candidate(false,[1,20,40]));
 assert.equal(quality.usable,true);assert.equal(quality.alignment,'provider');
});
const source=(title,text,times=[1,20])=>({target:{title},song:{title,duration:220},lyrics:{lines:text.map((text,index)=>({text,timestamp:times[index]}))}});
test('native script outranks timed romanization without deleting the only readable fallback',()=>{
 const romanized=source('紅日',['Meng wan jau shuin','Thin bou lau lei']);
 const native=source('紅日',['这是测试歌词','这是另一句测试'],[null,null]);
 for(const choose of [chooseLyricCandidate,chooseMeasuredLyricCandidate]) {
  assert.equal(choose(romanized,native),native);
  assert.equal(choose(native,romanized),native);
  assert.equal(choose(null,romanized),romanized);
 }
 assert.equal(needsTimingDiscovery(romanized,{measured:false}),true);
 assert.equal(lyricResponseLifetimeMs({song:{title:{original:'紅日'}},lines:romanized.lyrics.lines.map(line=>({original:line.text})),quality:{synced:true}}),300000);
});
test('English, Latin-language songs, bilingual vocals and other scripts remain ordinary lyrics',()=>{
 for(const [title,text] of [['Red Sun',['The sun comes up','And we sing again']],['Canción',['Una canción para ti','Volvemos a cantar']],
  ['紅日',['这是测试歌词','Sing this English verse']],['한글',['한글 노래 가사','또 다른 노랫말']],['日本語',['これはテスト','もう一つの歌詞']],['Песня',['Это тестовая строка','Другая строка песни']]]) {
  assert.equal(needsTimingDiscovery(source(title,text),{measured:false}),false,title);
 }
});
