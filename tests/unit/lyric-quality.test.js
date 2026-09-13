import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanLyrics,hasUsableLyrics} from '../../api/utils/lyric-quality.js';

test('credits alone and placeholder instrumental text are not sung lyrics',()=> {
  assert.equal(hasUsableLyrics({lines:[{text:'作词 : Example',timestamp:0},{text:'作曲：Example',timestamp:1}]}),false);
  assert.equal(hasUsableLyrics({lines:[{text:'纯音乐，请欣赏',timestamp:0}]}),false);
  assert.equal(hasUsableLyrics({lines:[],instrumental:true}),true);
  assert.equal(hasUsableLyrics({lines:[]}),false);
});
test('adaptation and publisher credits in the matching Mandarin source are not vocals',()=>{
  const lines=[{text:'改编词 : Example',timestamp:0.225},{text:'改編詞：Example',timestamp:0.25},
    {text:'Publisher : Example Publishing',timestamp:0.3},{text:'这是演唱的测试文字',timestamp:0.515}];
  assert.deepEqual(cleanLyrics({lines}).lines,[lines[3]]);
});
test('musician and source credits are removed without discarding a sung chorus label',()=>{
  const lines=['Acoustic Guitar：Example Player','Guitar Solo：Example Player','Strings：Example Ensemble',
    'Programming：Example Player','Chorus：歌手甲 / 歌手乙',
    '取材自歌曲《测试曲》(词：词作者 曲：曲作者)',
    'Chorus: sing this line with me','这是演唱的测试文字'].map(text=>({text,timestamp:200}));
  assert.deepEqual(cleanLyrics({lines}).lines,[lines[4],...lines.slice(-2)]);
});
test('retain real short lyrics and colons while clearing invalid vocal timing',()=> {
  const result=cleanLyrics({instrumental:true,lines:[{text:' 作词：Example ',timestamp:0},
    {text:'我说：你好',timestamp:28},{text:'啊',timestamp:500},{text:'come home',timestamp:-1}]},{duration:241});
  assert.equal(result.instrumental,false);
  assert.deepEqual(result.lines,[{text:'我说：你好',timestamp:28},{text:'啊',timestamp:null},{text:'come home',timestamp:null}]);
});

test('NetEase fixed instrumental marker is explicit evidence only without remaining vocals',()=>{
 const marked={source:'netease',lines:[{text:'作词：Writer',timestamp:0},{text:'纯音乐，请欣赏',timestamp:2}]};
 assert.deepEqual(cleanLyrics(marked).lines,[]);
 assert.equal(cleanLyrics(marked).instrumental,true);
 assert.equal(cleanLyrics({...marked,source:'unknown'}).instrumental,false);
 assert.equal(cleanLyrics({...marked,lines:[...marked.lines,{text:'A sung phrase',timestamp:10}]}).instrumental,false);
 assert.equal(cleanLyrics({...marked,lines:[{text:'作词：Writer',timestamp:0}]}).instrumental,false);
});
