import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {parseQRC} from '../../api/utils/qq-qrc.js';
import {cleanLyrics} from '../../api/utils/lyric-quality.js';
import {revalidatedVocalLine,validVocalTiming} from '../../api/utils/vocal-timing.js';

const parse=body=>parseQRC(`<QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="${body}"/></LyricInfo></QrcInfos>`,{songId:4932646,duration:253});
// Two diagnostic rows captured from QQ 4932646 on 2026-11-10. The provider
// times the labels too: one has a colon gap, the other a separate colon cue.
const shaonian=JSON.parse(readFileSync(new URL('../fixtures/shaonian-performer-timing.json',import.meta.url)));
const options={title:'少年',artist:'光良/曹格',duration:253};

test('Shaonian removes both singer labels while preserving every sung word interval',()=>{
 const before=structuredClone(shaonian),cleaned=cleanLyrics(shaonian,options);
 assert.deepEqual(cleaned.lines.map(l=>l.text),['你又想起某个夏天','记忆中的那个少年']);
 cleaned.lines.forEach((line,i)=>{
  assert.ok(validVocalTiming(line,options));
  assert.equal(line.timestamp,shaonian.lines[i].timestamp);
  assert.deepEqual(line.vocalTiming,{...shaonian.lines[i].vocalTiming,
   segments:shaonian.lines[i].vocalTiming.segments.filter(s=>s.utf16Start>=2).map(s=>({...s,utf16Start:s.utf16Start-2}))});
 });
 assert.deepEqual(cleanLyrics(cleaned,options),cleaned);
 assert.deepEqual(cleaned.timingSource,shaonian.timingSource);
 assert.deepEqual(shaonian,before);
});

test('title, credit and standalone cue removal do not change the neighboring measured rows',()=>{
 const raw=parse('[0,500]Fixture(0,400)\n[500,500]作词：Someone(500,400)\n[1000,500]合：(1000,400)\n[2000,2000]第一句(2100,1000)\n[5000,2000]男：(5000,100)第二句(5200,1000)');
 const cleaned=cleanLyrics(raw,{title:'Fixture',duration:253});
 assert.deepEqual(cleaned.lines.map(l=>l.text),['第一句','第二句']);
 assert.deepEqual(cleaned.lines[0],raw.lines[3]);
 assert.deepEqual(cleaned.lines[1].vocalTiming.segments,[{...raw.lines[4].vocalTiming.segments[1],utf16Start:0}]);
});

test('performer projection supports bracket labels, surrounding spaces and multicode-unit graphemes',()=>{
 const raw=parse('[1000,2000]  [Mira]  😀(1100,400)é (1600,600)  ');
 const cleaned=cleanLyrics(raw,{artist:'Mira',duration:253});
 assert.equal(cleaned.lines[0].text,'😀é');
 assert.deepEqual(cleaned.lines[0].vocalTiming.segments,[
  {utf16Start:0,utf16Length:2,text:'😀',start:1.1,end:1.5},
  {utf16Start:2,utf16Length:2,text:'é',start:1.6,end:2.2}]);
 assert.deepEqual(cleanLyrics(cleaned,{artist:'Mira',duration:253}),cleaned);
});

test('prefix authorization is exact and cannot repair bad timing or rewrite lyrics',()=>{
 const line=shaonian.lines[0];
 assert.equal(revalidatedVocalLine(line,line.text.slice(2)).vocalTiming,undefined);
 for(const [prefix,text] of [['曹：',line.text.slice(2)],['光：','different'],['光：',line.text.slice(3)]]){
  assert.equal(revalidatedVocalLine(line,text,{removedPerformerPrefix:prefix}).vocalTiming,undefined);
 }
 for(const mutate of [l=>l.vocalTiming.segments[1].text='wrong',l=>l.vocalTiming.segments[1].start=0]){
  const invalid=structuredClone(shaonian);mutate(invalid.lines[0]);
  assert.equal(cleanLyrics(invalid,options).lines[0].vocalTiming,undefined);
 }
 const split=parse('[1000,2000]男：́Alpha(1100,400)');
 assert.equal(cleanLyrics(split,{duration:253}).lines[0].vocalTiming,undefined);
});

test('nested syllable ranges rebase with their parent and keep their measured intervals',()=>{
 const line={text:'Mira: Alpha',timestamp:1,vocalTiming:{end:3,segments:[
  {utf16Start:6,utf16Length:5,text:'Alpha',start:1.1,end:2.2,syllables:[
   {utf16Start:6,utf16Length:2,text:'Al',start:1.1,end:1.5},
   {utf16Start:8,utf16Length:3,text:'pha',start:1.5,end:2.2}]}]}};
 const before=structuredClone(line),cleaned=cleanLyrics({lines:[line]},{artist:'Mira',duration:253}).lines[0];
 assert.deepEqual(cleaned.vocalTiming,{end:3,segments:[{...line.vocalTiming.segments[0],utf16Start:0,
  syllables:line.vocalTiming.segments[0].syllables.map(s=>({...s,utf16Start:s.utf16Start-6}))}]});
 assert.deepEqual(line,before);
});

test('malformed nested syllables are rejected before cleanup can conceal the damage',()=>{
 const source={text:'Mira: Alpha',timestamp:1,vocalTiming:{end:3,segments:[
  {utf16Start:0,utf16Length:6,text:'Mira: ',start:1,end:1.1},
  {utf16Start:6,utf16Length:5,text:'Alpha',start:1.1,end:2.2,syllables:[
   {utf16Start:6,utf16Length:2,text:'Al',start:1.1,end:1.5},
   {utf16Start:8,utf16Length:3,text:'pha',start:1.5,end:2.2}]}]}};
 for(const mutate of [
  l=>l.vocalTiming.segments[1].syllables[0].text='wrong',
  l=>l.vocalTiming.segments[1].syllables[0].utf16Start=7,
  l=>l.vocalTiming.segments[1].syllables[1].start=1.4,
  l=>l.vocalTiming.segments[1].syllables.pop(),
  l=>l.vocalTiming.segments[1].syllables[0].syllables=[],
  l=>l.vocalTiming.segments[0].syllables=[{utf16Start:0,utf16Length:6,text:'wrong',start:1,end:1.1}]
 ]){
  const invalid=structuredClone(source);mutate(invalid);
  assert.equal(validVocalTiming(invalid),false);
  assert.equal(cleanLyrics({lines:[invalid]},{artist:'Mira',duration:253}).lines[0].vocalTiming,undefined);
 }
});

test('a cue spanning label and lyrics retains its interval and rebases nested sung syllables',()=>{
 const line={text:'男：你好',timestamp:1,vocalTiming:{end:3,segments:[
  {utf16Start:0,utf16Length:4,text:'男：你好',start:1,end:2.5,syllables:[
   {utf16Start:0,utf16Length:2,text:'男：',start:1,end:1.1},
   {utf16Start:2,utf16Length:1,text:'你',start:1.1,end:1.8},
   {utf16Start:3,utf16Length:1,text:'好',start:1.8,end:2.5}]}]}};
 const cleaned=cleanLyrics({lines:[line]},{duration:253}).lines[0];
 assert.equal(validVocalTiming(cleaned),true);
 assert.deepEqual(cleaned.vocalTiming,{end:3,segments:[{utf16Start:0,utf16Length:2,text:'你好',start:1,end:2.5,
  syllables:line.vocalTiming.segments[0].syllables.slice(1).map(s=>({...s,utf16Start:s.utf16Start-2}))}]});
});
