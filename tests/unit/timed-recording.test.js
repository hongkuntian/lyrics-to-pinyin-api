import test from 'node:test';
import assert from 'node:assert/strict';
import {findLyricsRecording} from '../../api/utils/recording-match.js';

// Original text, with the metadata shape that exposed the Mojito duplicate.
const text='一起唱歌慢慢听懂每一句话'.repeat(20);
const request={artist:'Artist',title:'Song',album:'Song - Single',duration:185.008};
const plain={...request,id:1,duration:185,lyricsData:{lines:[{text,timestamp:null}]}};
const timed={...plain,id:2,album:'Song',lyricsData:{lines:[{text:text.slice(0,60),timestamp:10},{text:text.slice(60),timestamp:90}]}};

test('timed lyrics can beat a release suffix when recording and complete text agree',()=>{
 for(const songs of [[plain,timed],[timed,plain]]) assert.equal(findLyricsRecording(songs,request).id,2);
 const adlib={...timed,lyricsData:{lines:[{text:text.slice(0,60)+' yeah',timestamp:10},{text:text.slice(60),timestamp:90}]}};
 assert.equal(findLyricsRecording([plain,adlib],request).id,2);
 assert.equal(findLyricsRecording([timed],request).id,2);
});
test('timing cannot override different recordings, conflicting text, or malformed timing',()=>{
 for(const change of [
  {artist:'Cover Artist'},{title:'Song (Live)'},{album:'Song (Live)'},{album:'Other Album'},
  {duration:186},{duration:null},
  {lyricsData:{lines:[{text:'different lyrics',timestamp:10}]}},
  {lyricsData:{lines:[{text,timestamp:10}]}},
  {lyricsData:{lines:[{text:text.slice(0,60),timestamp:10},{text:text.slice(60),timestamp:200}]}},
  {lyricsData:{lines:[{text:text.slice(0,60),timestamp:10},{text:text.slice(60),timestamp:null}]}},
  {lyricsData:{lines:[{text:text.slice(0,60),timestamp:10},{text:text.slice(60),timestamp:10}]}}
 ]) assert.equal(findLyricsRecording([plain,{...timed,...change}],request).id,1,JSON.stringify(change));
 assert.equal(findLyricsRecording([plain,timed],{...request,duration:undefined}).id,1);
});
test('conflicting timed duplicates keep the safe plain fallback; identical timing is deterministic',()=>{
 const other={...timed,id:3,lyricsData:{lines:timed.lyricsData.lines.map(l=>({...l,timestamp:l.timestamp+1}))}};
 assert.equal(findLyricsRecording([plain,timed,other],request).id,1);
 assert.equal(findLyricsRecording([plain,timed,{...timed,id:3}],request).id,2);
});
test('native script resolves romanized duplicates only after recording admission',()=>{
 const target={artist:'Hacken Lee',title:'紅日',album:'紅日',duration:287};
 const romanized={...target,id:9217531,lyricsData:{lines:[{text:'Meng wan jau shuin',timestamp:20},{text:'Thin bou lau lei',timestamp:24}]}};
 const native={...target,id:8812366,lyricsData:{lines:[{text:'这是测试歌词',timestamp:null},{text:'这是另一句',timestamp:null}]}};
 for(const rows of [[romanized,native],[native,romanized]])assert.equal(findLyricsRecording(rows,target),native);
 for(const wrong of [{artist:'Another singer'},{title:'紅日 (Live)'},{duration:310}])assert.equal(findLyricsRecording([romanized,{...native,...wrong}],target),romanized);
 assert.equal(findLyricsRecording([romanized],target),romanized);
});
