import test from 'node:test';
import assert from 'node:assert/strict';
import {createLyricSearchService} from '../../api/utils/lyric-search.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
const record={id:34750760,trackName:'父親',artistName:'筷子兄弟',albumName:'父親',duration:300,
  plainLyrics:'第一行\n第二行',syncedLyrics:'[00:26.29]第一行\n[00:42.00]第二行'};
const hints={title:'父亲',artist:'筷子兄弟',artists:['筷子兄弟'],duration:280.289,album:'父亲'};
const call=async(service,body)=>{const res=createMockRes();await service(createMockReq({body}),res);return res;};
const fixture=(overrides={})=>createLyricSearchService({searchLRCLIB:async()=>[record],searchNetEase:async()=>[],...overrides});
test('search retains readable words for a duration mismatch without recording proof',async()=>{
  const res=await call(fixture(),{action:'search_lyrics',query:'父亲 筷子兄弟',hints});
  assert.equal(res.statusCode,200);const candidate=res.body.candidates[0];
  assert.equal(candidate.namesMatch,true);assert.equal(candidate.duration,300);assert.equal(candidate.durationMatches,false);
  assert.equal(candidate.lines.length,2);assert.equal(candidate.provider,'lrclib');assert.equal(candidate.itemID,'34750760');
  assert.equal(res.body.recordingBinding,undefined);assert.equal(candidate.recordingBinding,undefined);
});
test('ranking prefers matching performer and close duration while retaining alternatives',async()=>{
  const res=await call(fixture({searchLRCLIB:async()=>[{...record,id:1,artistName:'Another performer'},record,{...record,id:2,duration:280.3}]}),
    {action:'search_lyrics',query:'父亲',hints});
  assert.deepEqual(res.body.candidates.map(c=>c.itemID),['2','34750760','1']);
  assert.equal(res.body.candidates[2].namesMatch,false);
});
test('one provider failure preserves results and reports the failed source',async()=>{
  const res=await call(fixture({searchNetEase:async()=>{throw new Error('down');}}),{action:'search_lyrics',query:'父亲',hints});
  assert.equal(res.statusCode,200);assert.equal(res.body.candidates.length,1);assert.deepEqual(res.body.unavailable,['netease']);
});
test('preview fetches an allowlisted source, preserves original labels, and cleans credit rows',async()=>{
  const service=fixture({previewLRCLIB:async()=>({...record,syncedLyrics:'[00:01.00]作词：王太利\n'+record.syncedLyrics})});
  const res=await call(service,{action:'preview_lyrics',provider:'lrclib',itemID:'34750760'});
  assert.equal(res.statusCode,200);assert.equal(res.body.candidate.title,'父親');assert.equal(res.body.candidate.lines.length,2);
});
test('invalid queries, extra fields, arbitrary providers and URL-shaped IDs fail before I/O',async()=>{
  const service=fixture({previewLRCLIB:()=>assert.fail('unexpected network'),searchLRCLIB:()=>assert.fail('unexpected network')});
  for(const body of [{action:'search_lyrics',query:''},{action:'search_lyrics',query:'x'.repeat(501)},
    {action:'search_lyrics',query:'父亲',url:'https://example.com'},
    {action:'preview_lyrics',provider:'other',itemID:'1'},
    {action:'preview_lyrics',provider:'lrclib',itemID:'https://example.com'},
    {action:'search_lyrics',query:'父亲',hints:{title:'父亲',artist:'筷子兄弟',duration:-1}}]) {
    assert.equal((await call(service,body)).statusCode,400);
  }
});
test('empty, instrumental, oversized and wrong-ID previews cannot become readable attachments',async()=>{
  for(const value of [{...record,plainLyrics:'',syncedLyrics:'',instrumental:true},
    {...record,id:999}, {...record,plainLyrics:'x'.repeat(4001),syncedLyrics:null}]) {
    const res=await call(fixture({previewLRCLIB:async()=>value}),{action:'preview_lyrics',provider:'lrclib',itemID:'34750760'});
    assert.equal(res.statusCode,404);
  }
});

test('additional providers require an explicit opt in and never change legacy search results',async()=>{
  let kugou=0;
  const service=fixture({searchKugou:async()=>{kugou++;return [{id:'7',title:'父親 (Live)',artist:'筷子兄弟',duration:310}];}});
  const old=await call(service,{action:'search_lyrics',query:'父亲',hints});
  assert.equal(kugou,0);assert.equal(old.body.candidates.every(c=>c.provider==='lrclib'),true);
  const next=await call(service,{action:'search_lyrics',query:'父亲',hints,providers:['lrclib','netease','kugou']});
  assert.equal(next.statusCode,200);assert.equal(kugou,1);
  assert.equal(next.body.candidates.some(c=>c.provider==='kugou'&&c.itemID==='7'),true);
  for(const providers of [[],['other'],['kugou','kugou'],'kugou'])
    assert.equal((await call(service,{action:'search_lyrics',query:'x',providers})).statusCode,400);
});

test('Kugou preview reacquires the exact provider item using an untrusted discovery query',async()=>{
  let captured;
  const service=fixture({previewKugou:async(id,signal,context)=>{
    captured={id,query:context.query,aborted:signal.aborted};
    return {provider:'kugou',itemID:id,title:'Provider title',artist:'Provider artist',duration:300,
      lines:[{text:'原文',timestamp:1},{text:'下一行',timestamp:2}]};
  }});
  const res=await call(service,{action:'preview_lyrics',provider:'kugou',itemID:'7',query:'edited lookup',hints});
  assert.equal(res.statusCode,200);assert.equal(res.body.candidate.title,'Provider title');
  assert.deepEqual(captured,{id:'7',query:'edited lookup',aborted:false});
  assert.equal((await call(service,{action:'preview_lyrics',provider:'kugou',itemID:'7'})).statusCode,400);
});

test('valid optional word cues survive preview while malformed cues preserve the readable row',async()=>{
  const vocalTiming={end:3,segments:[{utf16Start:0,utf16Length:2,text:'原文',start:1,end:3}]};
  for(const timing of [vocalTiming,{...vocalTiming,segments:[{...vocalTiming.segments[0],text:'不同'}]}]) {
    const service=fixture({previewNetEase:async()=>({provider:'netease',itemID:'8',title:'歌',artist:'人',duration:10,
      lines:[{text:'原文',timestamp:1,vocalTiming:timing},{text:'下一行',timestamp:4}]})});
    const res=await call(service,{action:'preview_lyrics',provider:'netease',itemID:'8'});
    assert.equal(res.statusCode,200);assert.equal(res.body.candidate.lines[0].text,'原文');
    assert.deepEqual(res.body.candidate.lines[0].vocalTiming,timing===vocalTiming?vocalTiming:undefined);
  }
});
