import test from 'node:test';
import assert from 'node:assert/strict';
import {KugouAPI} from '../../api/music-apis/kugou.js';
import {encodeKRC} from '../helpers/kugou-krc.js';

const request={artist:'林小雨',title:'窗前',duration:120,album:'清晨'};
const raw='[ar:林小雨]\n[ti:窗前]\n[00:00.00]窗前 - 林小雨\n[00:12.00]今天窗前有只猫\n[01:40.00]它在等清晨';
const candidate=(id='10',changes={})=>({id,singer:request.artist,song:request.title,duration:120000,product_from:'官方推荐歌词',accesskey:'public-candidate-key',...changes});
function context(candidates,lyrics={},extra={}) {
  const calls=[];
  return {calls,duration:request.duration,album:request.album,...extra,fetchFn:async(url,init)=>{
    const parsed=new URL(url);calls.push({url:parsed,init});
    return {ok:true,status:200,url:String(url),json:async()=>parsed.pathname==='/search'
      ? {status:200,candidates}
      : {fmt:'lrc',...(lyrics[parsed.searchParams.get('id')] ?? {status:200,content:Buffer.from(raw).toString('base64')})}};
  }};
}
const search=(ctx,values={})=>new KugouAPI().searchSong(values.artist ?? request.artist,values.title ?? request.title,ctx);

test('manual discovery retains alternative versions without weakening automatic matching or exposing capabilities',async()=>{
  const ctx=context([candidate('10'),candidate('11',{song:'窗前 (Live)',duration:135000,product_from:'ugc'})]);
  const values=await new KugouAPI().searchLyrics('窗前 林小雨',ctx);
  assert.deepEqual(values.map(v=>[v.id,v.title,v.duration]),[['10','窗前',120],['11','窗前 (Live)',135]]);
  assert.equal(JSON.stringify(values).includes('public-candidate-key'),false);
  assert.equal(ctx.calls.length,1);assert.equal(ctx.calls[0].url.origin,'https://lyrics.kugou.com');
});

test('manual preview re-searches and downloads only the requested source without persisted capabilities',async()=>{
  const api=new KugouAPI(),ctx=context([candidate('10'),candidate('11')]);
  const value=await api.previewLyrics('11','窗前 林小雨',ctx);
  assert.equal(value.id,'11');assert.equal(value.lyricsData.lines.length,2);
  assert.equal(ctx.calls.length,2);assert.equal(ctx.calls[1].url.searchParams.get('id'),'11');
  assert.equal(JSON.stringify(value).includes('public-candidate-key'),false);
  const absent=context([candidate('10')]);assert.equal(await api.previewLyrics('11','窗前',absent),null);
  assert.equal(absent.calls.length,1);
});

test('manual discovery rejects duplicate provider IDs with conflicting source labels or capabilities',async()=>{
  for(const change of [{singer:'另一人'},{accesskey:'another-key'}])
    await assert.rejects(new KugouAPI().searchLyrics('窗前',context([candidate(),candidate('10',change)])));
});

test('fetches only official exact recordings and returns cleaned lyrics without capability',async()=>{
  const controller=new AbortController();const ctx=context([candidate('11'),candidate('9'),candidate('99',{product_from:'ugc'}),candidate('98',{singer:'别的歌手'})],{}, {signal:controller.signal,headers:{'X-Test':'safe'}});
  const song=await search(ctx);
  assert.equal(song.id,'9');assert.equal(song.source,'kugou');assert.equal(song.album,undefined);assert.equal(song.duration,120);
  assert.equal(song.lyricsData.lines.length,2);assert.equal(song.lyricsData.lines[0].timestamp,12);
  assert.equal(JSON.stringify(song).includes('public-candidate-key'),false);
  assert.equal(ctx.calls.length,3);assert.equal(ctx.calls[0].init.signal,controller.signal);
  assert.ok(ctx.calls.every(x=>x.init.signal instanceof AbortSignal && !x.init.signal.aborted && x.init.redirect==='error' && x.init.size===524288 && x.init.headers['X-Test']==='safe'));
  const api=new KugouAPI();assert.equal(await api.getLyrics(song.id,{song}),song.lyricsData);assert.equal(await api.getLyrics('other',{song}),null);
});

test('preserves exact version and complete singer credits and needs finite duration',async()=>{
  for(const changed of [{song:'窗前 (Live)'},{song:'窗前 (重制版)'},{singer:'林小雨 & 嘉宾'},{duration:121001},{duration:120},{duration:'120000'},{language:'伴奏'}]){
    const ctx=context([candidate('10',changed)]);await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.equal(ctx.calls.length,1);
  }
  const missing=context([candidate()],{}, {duration:undefined});assert.equal(await search(missing),null);assert.equal(missing.calls.length,0);
});

test('normalizes traditional title names but never invents an English artist alias',async()=>{
  const ctx=context([candidate('1',{song:'東窗',singer:'林小雨'})],{'1':{status:200,content:Buffer.from(raw.replaceAll('窗前','東窗')).toString('base64')}});assert.equal((await search(ctx,{title:'东窗'})).artist,'林小雨');
  await assert.rejects(search(context([candidate()]),{artist:'Xiao Yu Lin'}),{code:'recording_mismatch'});
});

test('validates every duplicate lyric before accepting more than three metadata ties',async()=>{
  const ctx=context(Array.from({length:8},(_,i)=>candidate(String(i+1))));
  assert.equal((await search(ctx)).id,'1');assert.equal(ctx.calls.length,9);
  assert.deepEqual(new Set(ctx.calls.slice(1).map(c=>c.url.searchParams.get('id'))),new Set(['1','2','3','4','5','6','7','8']));
  const conflict=context(Array.from({length:8},(_,i)=>candidate(String(i+1))),{'8':{status:200,content:Buffer.from(raw.replace('00:12.00','00:13.00')).toString('base64')}});
  await assert.rejects(search(conflict),{code:'recording_mismatch'});
});

test('does not accept distinct lyric words or timing as equivalent metadata ties',async()=>{
  for(const changed of [raw.replace('00:12.00','00:13.00'),raw.replace('有只猫','有朵花')]){
    const ctx=context([candidate('1'),candidate('2')],{'2':{status:200,content:Buffer.from(changed).toString('base64')}});
    await assert.rejects(search(ctx),{code:'recording_mismatch'});
  }
});

const timed='[ar:林小雨]\n[ti:窗前]\n[12000,2000]<0,700,0>今天<700,1300,0>窗前有只猫\n[100000,2000]<0,2000,0>它在等清晨';
test('requests KRC first and keeps real relative word cues from its own complete source',async()=>{
 const ctx=context([candidate()],{'10':{status:200,fmt:'krc',content:encodeKRC(timed)}});
 const song=await search(ctx);assert.equal(ctx.calls.length,2);
 assert.equal(ctx.calls[1].url.searchParams.get('fmt'),'krc');
 assert.equal(song.lyricsData.timingSource.source,'kugou:10:krc');
 assert.equal(song.lyricsData.lines[0].vocalTiming.segments[1].start,12.7);
 assert.equal(song.lyricsData.lines[0].text,'今天窗前有只猫');
});
test('unusable KRC falls back once to readable LRC under the same deadline signal',async()=>{
 const ctx=context([candidate()]),base=ctx.fetchFn;
 ctx.fetchFn=async(url,init)=>{
  if(new URL(url).searchParams.get('fmt')==='krc'){ctx.calls.push({url:new URL(url),init});return {ok:true,json:async()=>({status:200,fmt:'krc',content:'invalid'})};}
  return base(url,init);
 };
 const song=await search(ctx);assert.equal(song.lyricsData.lines.length,2);assert.equal(song.lyricsData.timingSource,undefined);
 assert.deepEqual(ctx.calls.slice(1).map(c=>c.url.searchParams.get('fmt')),['krc','lrc']);
 assert.equal(ctx.calls[1].init.signal,ctx.calls[2].init.signal);
});
test('cue-only tie conflicts cancel locally owned peers promptly and never pick a subset',async()=>{
 const ctx=context(Array.from({length:6},(_,i)=>candidate(String(i+1))));let aborted=false;
 const base=ctx.fetchFn;
 ctx.fetchFn=async(url,init)=>{
  const u=new URL(url);if(u.pathname==='/search')return base(url,init);
  ctx.calls.push({url:u,init});
  if(Number(u.searchParams.get('id'))>=3)return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{
   aborted=true;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));
  },{once:true}));
  return {ok:true,json:async()=>({status:200,fmt:'krc',content:encodeKRC(u.searchParams.get('id')==='2'?timed.replace('700,1300','700,1200'):timed)})};
 };
 await assert.rejects(search(ctx),{code:'recording_mismatch'});assert.ok(aborted);
 assert.equal(ctx.calls.some(c=>c.url.searchParams.get('id')==='5'),false);
});

test('selects best metadata duration before hydration and ignores provider score',async()=>{
  const ctx=context([candidate('1',{duration:120900,score:100}),candidate('2',{score:1})]);assert.equal((await search(ctx)).id,'2');assert.equal(ctx.calls.length,2);
});

test('strips exact provider headers including formal annotation but preserves vocal prose',async()=>{
  const text='[00:00.00]林小雨 - 窗前 (正式版)\n[00:01.00]词：某甲\n[00:02.00]曲：某乙\n[00:12.00]今天窗前有只猫\n[00:40.00]窗前有你 - 我就安心';
  const ctx=context([candidate()],{'10':{status:200,content:Buffer.from(text).toString('base64')}});const song=await search(ctx);
  assert.deepEqual(song.lyricsData.lines.map(x=>x.text),['今天窗前有只猫','窗前有你 - 我就安心']);
});

test('rejects invalid capabilities, IDs, candidate shapes, and oversized candidate lists',async()=>{
  for(const candidates of [[candidate('../x')],[candidate('1',{accesskey:''})],[candidate('1',{accesskey:'a\n'})],null,Array.from({length:101},(_,i)=>candidate(String(i)))]){
    const ctx=context(candidates);await assert.rejects(search(ctx));assert.equal(ctx.calls.length,1);
  }
});

test('rejects malformed base64, invalid UTF8, oversized and empty lyric content',async()=>{
  for(const content of ['@@@=',Buffer.from([0xc3,0x28]).toString('base64'),'a'.repeat(800000),Buffer.from('[ar:林小雨]\n[ti:窗前]').toString('base64')]){
    await assert.rejects(search(context([candidate()],{'10':{status:200,content}})));
  }
});

test('rejects unsuccessful provider bodies and unexpected redirect destinations',async()=>{
  const failed=context([candidate()],{'10':{status:500,content:Buffer.from(raw).toString('base64')}});await assert.rejects(search(failed));
  const redirect=context([candidate()]);redirect.fetchFn=async()=>({ok:true,status:200,url:'https://other.example/search',json:async()=>({status:200,candidates:[candidate()]})});await assert.rejects(search(redirect));
});

test('shares cancellation and sanitizes capability-bearing transport errors',async()=>{
  const ctl=new AbortController();ctl.abort();const cancelled=context([candidate()],{}, {signal:ctl.signal});await assert.rejects(search(cancelled),{name:'AbortError'});assert.equal(cancelled.calls.length,0);
  const ctx=context([candidate()]);const base=ctx.fetchFn;ctx.fetchFn=async(u,init)=>{if(new URL(u).pathname==='/download')throw new Error('network failed '+u);return base(u,init);};
  await assert.rejects(search(ctx),error=>!error.message.includes('public-candidate-key') && !error.message.includes('accesskey'));
});

test('rejects lyric bodies whose explicit recording metadata contradicts selected candidate',async()=>{
  for(const changed of [raw.replace('[ar:林小雨]','[ar:别的歌手]'),raw.replace('[ti:窗前]','[ti:窗前 (Live)]')]){
    await assert.rejects(search(context([candidate()],{'10':{status:200,content:Buffer.from(changed).toString('base64')}})),{code:'recording_mismatch'});
  }
});

test('does not erase album-only recording versions when lyric candidates have no album',async()=>{
  for(const album of ['Live Concert','现场精选','演唱会录音','Remastered','重制版','Instrumental','Karaoke','Remix','Demo','Acoustic','A cappella','Radio Edit','Extended Mix','Cover Collection','Reprise','Alternate Version']) {
    const ctx=context([candidate()],{}, {album});
    await assert.rejects(search(ctx),{code:'recording_mismatch'});
    assert.ok(ctx.calls.length<=1,'Unestablished album version must never download lyrics');
  }
});

test('allows an album version only when matching candidate title also establishes that version',async()=>{
  for(const [album,suffix] of [['Live Concert','Live'],['Remastered','Remastered'],['现场精选','现场'],['Acoustic Sessions','Acoustic']]) {
    const title=`窗前 (${suffix})`;
    const ctx=context([candidate('10',{song:title})],{'10':{status:200,content:Buffer.from(raw.replaceAll('窗前',title)).toString('base64')}},{album});
    assert.equal((await search(ctx,{title})).id,'10');
  }
  const title='窗前 (Live)';
  const ctx=context([candidate('10',{song:title})],{}, {album:'Live Acoustic'});
  await assert.rejects(search(ctx,{title}),{code:'recording_mismatch'});
});

test('original soundtrack and normal album descriptors do not imply another recording version',async()=>{
  for(const album of ['Original Soundtrack','电影原声带','对你太在乎','春泥','放你在心里']) {
    assert.equal((await search(context([candidate()],{}, {album}))).id,'10');
  }
});
