import test from 'node:test';
import assert from 'node:assert/strict';
import {parseYRC} from '../../api/utils/netease-yrc.js';
import {validVocalTiming} from '../../api/utils/vocal-timing.js';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {cleanLyrics} from '../../api/utils/lyric-quality.js';

const good='[10000,2000](10000,0,0)!(10000,500,9)你 (10750,500,0)😀(11250,750,0)e\u0301';
const parse=(raw,options={})=>parseYRC(raw,{songId:'42',duration:240,...options});
test('whole YRC edition preserves exact Unicode text, absolute seconds and zero-duration gaps',()=>{
 const result=parse(good),line=result.lines[0];
 assert.equal(line.text,'!你 😀e\u0301');assert.equal(line.timestamp,10);
 assert.deepEqual(line.vocalTiming,{end:12,segments:[
  {utf16Start:1,utf16Length:2,text:'你 ',start:10,end:10.5},
  {utf16Start:3,utf16Length:2,text:'😀',start:10.75,end:11.25},
  {utf16Start:5,utf16Length:2,text:'e\u0301',start:11.25,end:12}]});
 assert.equal(line.role,undefined);assert.equal(validVocalTiming(line),true);
 assert.equal(result.timingSource.source,'netease:42:yrc');assert.match(result.timingSource.revision,/^[a-f0-9]{64}$/);
});
test('recognized leading metadata is ignored and all source rows are adopted without an LRC comparison',()=>{
 const result=parse('\uFEFF{"t":0,"c":[{"tx":"Synthetic credit"}]}\n[ar:Synthetic]\n'+good+'\n[13000,1000]line without words');
 assert.equal(result.lines.length,2);assert.equal(result.lines[1].text,'line without words');assert.equal(result.lines[1].vocalTiming,undefined);
});
test('signed leading credit timestamps do not discard a measured YRC edition or change its source revision',()=>{
 const credits='{"t":-1000,"c":[{"tx":"Invented credit"}]}\n{"t":-500,"c":[{"tx":"Another credit"}]}\n';
 assert.deepEqual(parse(credits+good),parse(good));
 for(const timestamp of ['-0.5','null','"-1000"','-9007199254740992'])
  assert.equal(parse(`{"t":${timestamp},"c":[{"tx":"Credit"}]}\n${good}`),null);
 assert.equal(parse('[-1000,1000](-1000,1000,0)text'),null);
});
test('invalid optional token times keep fully decoded readable rows',()=>{
 for(const raw of ['[1000,1000](0,1000,0)text','[0,1000](0,700,0)a(500,500,0)b',
  '[0,1000](0,1100,0)text','[0,1000](0,-1,0)text','[0,1000](0,x,0)text',
  '[0,1000](0,500,0)e(500,500,0)\u0301','[0,1000](0,500,0)👩(500,500,0)\u200d🚀']){
  const result=parse(raw);assert.ok(result?.lines[0].text);assert.equal(result.lines[0].vocalTiming,undefined,raw);
 }
 const zero=parse('[0,1000](0,0,0)zero');assert.equal(zero.lines[0].text,'zero');assert.equal(zero.lines[0].vocalTiming,undefined);
});
test('any undecodable/unsupported or out-of-bounds row rejects the entire YRC edition',()=>{
 for(const raw of [good+'\nunknown row',good+'\n{"unknown":"metadata"}',good+'\n[broken]',
  '[offset:100]\n'+good,'[240000,1000](240000,1000,0)late',good+'\n[0,1000](0,1000,0)decreasing',
  '[0,1000](0,500)lost text','[0,1000](0,1000,0)\ud800',
  '[0,1000](0,1000,0)'+('x'.repeat(2001)),Array(252).fill('[0,1000](0,1000,0)x').join('\n'),
  '[0,1000]'+Array(1025).fill('(0,0,0)x').join(''),'x'.repeat(524289)])assert.equal(parse(raw),null,raw.slice(0,60));
 assert.equal(parse(good,{songId:'other'}),null);assert.equal(parse(good,{duration:Infinity}),null);
});
test('cross-row overlap is independent of within-row word overlap and never infers roles',()=>{
 const result=parse('[0,1000](0,1000,4)a\n[500,1000](500,1000,7)b');
 assert.equal(result.lines.filter(l=>l.vocalTiming).length,2);assert.ok(result.lines.every(l=>!l.role));
});
test('whitespace, empty tokens and literal parentheses preserve the exact sung text',()=>{
 const result=parse('[0,1000](0,100,0) (100,0,0)(100,400,0)(plain words)(500,500,0) x');
 assert.equal(result.lines[0].text,' (plain words) x');assert.equal(result.lines[0].vocalTiming.segments[0].text,' ');
 assert.equal(parse('[0,1000](0,1000,0)literal (one,two,three)'),null);
 const a=parse(good),b=parse(good.replace(',9)',',7)'));assert.equal(a.timingSource.revision,b.timingSource.revision);
 assert.notEqual(a.timingSource.revision,parse(good.replace('10750,500','10750,450')).timingSource.revision);
});
test('normalization preserves outer-whitespace timing but drops changed sung text and validates recording bounds',()=>{
 const raw=parse('[0,1000](0,1000,0)  text  \n[1000,1000](1000,1000,0)Mira: words\n[2000,1000](2000,1000,0)unchanged');
 const cleaned=cleanLyrics(raw,{artist:'Mira',duration:240});
 assert.deepEqual(cleaned.lines.map(l=>l.text),['text','words','unchanged']);
 assert.deepEqual(cleaned.lines[0].vocalTiming.segments,[{utf16Start:0,utf16Length:4,text:'text',start:0,end:1}]);
 assert.equal(cleaned.lines[1].vocalTiming,undefined);assert.ok(cleaned.lines[2].vocalTiming);
 assert.equal(cleanLyrics(parse(good),{duration:11}).lines[0].vocalTiming,undefined);
 for(const mutate of [l=>l.vocalTiming.end=Infinity,l=>l.vocalTiming.segments[0].utf16Length=1.5,l=>l.vocalTiming.segments[0].text='wrong',l=>l.timestamp=11]){
  const line=structuredClone(parse(good).lines[0]);mutate(line);assert.equal(validVocalTiming(line),false);
 }
});
function fetcher(responses,urls,signalList=[]){return async(url,init)=>{
 urls.push(url);signalList.push(init.signal);const value=responses.shift();if(value instanceof Error)throw value;
 return {ok:true,status:200,json:async()=>value};
};}
test('new endpoint is one primary fetch with same-payload ordinary LRC fallback',async()=>{
 for(const yrc of [undefined,{lyric:''},{lyric:'malformed'}]){
  const urls=[],api=new NeteaseAPI();const lyrics=await api.getLyrics(42,{fetchFn:fetcher([{code:200,lrc:{lyric:'[00:09]LRC baseline'},yrc}],urls)});
  assert.deepEqual(lyrics.lines,[{text:'LRC baseline',timestamp:9}]);assert.equal(lyrics.timingSource,undefined);assert.equal(urls.length,1);assert.match(urls[0],/\/lyric\/new\?id=42$/);
 }
 const urls=[],value=await new NeteaseAPI().getLyrics(42,{song:{id:42,duration:240},fetchFn:fetcher([{code:200,lrc:{lyric:'[00:09]different old edition'},yrc:{lyric:good,version:99}}],urls)});
 assert.equal(value.lines[0].text,'!你 😀e\u0301');assert.equal(value.lines[0].timestamp,10);assert.ok(value.lines[0].vocalTiming);assert.equal(urls.length,1);
});
test('legacy endpoint is bounded fallback only for unavailable/invalid new payload and shares cancellation',async()=>{
 for(const broken of [new Error('unavailable'),{code:500},{code:200,unrecognized:true},
  {code:200,yrc:{lyric:'[malformed]'}},{code:200,yrc:{lyric:'[malformed]'},lrc:{lyric:''}},
  {code:200,yrc:{lyric:'[malformed]'},lrc:{lyric:'[00:99]invalid'}}]){
  const urls=[],signals=[],signal=new AbortController().signal;
  const value=await new NeteaseAPI().getLyrics(42,{signal,fetchFn:fetcher([broken,{code:200,lrc:{lyric:'[00:01]legacy'}}],urls,signals)});
  assert.equal(value.lines[0].text,'legacy');assert.equal(urls.length,2);assert.match(urls[1],/\/lyric\?id=42$/);assert.deepEqual(signals,[signal,signal]);
 }
 for(const payload of [{code:200,nolyric:true},{code:200,uncollected:true,yrc:{lyric:'[malformed]'}},
  {code:200,lrc:{lyric:''}},{code:200,yrc:{lyric:''}}]){
  const urls=[];assert.equal(await new NeteaseAPI().getLyrics(42,{fetchFn:fetcher([payload],urls)}),null);assert.equal(urls.length,1);
 }
 const urls=[],controller=new AbortController();
 await assert.rejects(new NeteaseAPI().getLyrics(42,{signal:controller.signal,fetchFn:async url=>{urls.push(url);controller.abort();throw Object.assign(new Error('cancelled'),{name:'AbortError'});}}),{name:'AbortError'});assert.equal(urls.length,1);
 await assert.rejects(new NeteaseAPI().getLyrics(42,{fetchFn:fetcher([{code:500},{code:500}],[])}),/unavailable/);
});
