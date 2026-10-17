import test from 'node:test';
import assert from 'node:assert/strict';
import {yrcService,appleRequest,spotifyRequest} from '../helpers/netease-yrc.js';
import {streamResponse,frames} from '../helpers/stream-http.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {SELECTION_REVISION} from '../../api/music-romanize.js';
import {createMockRes} from '../helpers/mock-http.js';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const until=async predicate=>{const end=Date.now()+2000;while(!predicate()){assert.ok(Date.now()<end,'expected readable response');await new Promise(r=>setImmediate(r));}};

for(const provider of ['apple','spotify'])test(`${provider}: fast line-only source stays readable, slower exact YRC becomes final and durable`,async()=>{
 const gate=deferred();
 const line={name:'LRCAPI',searchSong:async()=>({id:99,title:appleRequest.title,artist:appleRequest.artist,creditedArtistNames:[appleRequest.artist],album:appleRequest.album,duration:240,source:'lrclib'}),
  getLyrics:async()=>({lines:[{text:'Synthetic line edition one',timestamp:9},{text:'Synthetic line edition two',timestamp:59},{text:'Synthetic line edition three',timestamp:119}]})};
 const f=yrcService({getAvailableAPIsFn:()=>[f.api,line],speculativeDiscovery:false,hedgeDelayMs:1,wordTimingGraceMs:1000});
 const original=f.api.searchSong;f.api.searchSong=async(...args)=>{await gate.promise;return original(...args);};
 const request=provider==='apple'?appleRequest:spotifyRequest;
 const body=provider==='apple'?{...request,options:{delivery:'progressive-v1'}}:{recording:request,options:{delivery:'progressive-v1'}};
 const res=streamResponse(),work=f.service({method:'POST',body},res);
 try{
  await until(()=>frames(res).some(f=>f.event==='readable'));
  const first=frames(res)[0].response;assert.equal(first.metadata.source,'LRCAPI');assert.equal(first.quality.synced,true);
  assert.equal(first.lines.some(l=>l.vocalTiming),false);assert.equal(res.ended,undefined,'line timing must not cancel the pending word source');
  gate.resolve();await work;
  const last=frames(res).at(-1);assert.equal(last.event,'complete');const final=last.response;
  assert.equal(final.metadata.source,'NeteaseAPI');assert.equal(final.metadata.lyric_timing.source,'netease:42:yrc');
  assert.equal(final.lines.filter(l=>l.vocalTiming).length,2);assert.equal(final.lines.reduce((n,l)=>n+(l.vocalTiming?.segments.length??0),0),5);
  assert.equal(final.lines[0].original,'!你 😀e\u0301');assert.equal(final.lines.some(l=>l.original.startsWith('Synthetic line edition')),false);
  assert.equal(new Set(frames(res).map(f=>f.acquisitionID)).size,1);
  const doc=publicDocument(makeDocument(request,final,SELECTION_REVISION),request);
  assert.deepEqual(doc.response.lines,final.lines);assert.deepEqual(doc.response.metadata.lyric_timing,final.metadata.lyric_timing);
 }finally{gate.resolve();await work;}
});

for(const provider of ['apple','spotify'])test(`${provider}: cancelling after readable line lyrics cannot cache or publish a late word upgrade`,async()=>{
 const gate=deferred(),controller=new AbortController(),published=[];
 const line={name:'LRCAPI',searchSong:async()=>({id:99,title:appleRequest.title,artist:appleRequest.artist,creditedArtistNames:[appleRequest.artist],album:appleRequest.album,duration:240,source:'lrclib'}),
  getLyrics:async()=>({lines:[{text:'Synthetic one',timestamp:9},{text:'Synthetic two',timestamp:59}]})};
 const f=yrcService({getAvailableAPIsFn:()=>[f.api,line],speculativeDiscovery:false,hedgeDelayMs:1,wordTimingGraceMs:1000});
 const original=f.api.searchSong;f.api.searchSong=async(...args)=>{await gate.promise;return original(...args);};
 const body=provider==='apple'?appleRequest:{recording:spotifyRequest},res=createMockRes();
 const work=f.service({method:'POST',body,lyricDelivery:{acquisitionID:'cancel-owner',deadlineAtMS:Date.now()+2000,signal:controller.signal,publish:r=>published.push(r)}},res);
 await until(()=>published.length);controller.abort();await work;gate.resolve();await new Promise(r=>setImmediate(r));
 assert.equal(published.length,1);assert.equal(published[0].metadata.source,'LRCAPI');assert.equal(res.body?.song,undefined);
 assert.equal([...f.values.values()].some(v=>v?.song||v?.response?.song),false);
});

test('an explicit line-only provider keeps its requested first opportunity',async()=>{
 let wordCalls=0;
 const line={name:'LRCAPI',searchSong:async()=>({id:99,title:appleRequest.title,artist:appleRequest.artist,album:appleRequest.album,duration:240,source:'lrclib'}),
  getLyrics:async()=>({lines:[{text:'Synthetic one',timestamp:9},{text:'Synthetic two',timestamp:59}]})};
 const f=yrcService({getAvailableAPIsFn:()=>[f.api,line],getMusicAPIFn:()=>line,speculativeDiscovery:false});
 f.api.searchSong=async()=>{wordCalls++;return null;};
 const res=await f.call({...appleRequest,music_platform:'lrclib'});
 assert.equal(res.body.metadata.source,'LRCAPI');assert.equal(wordCalls,0);
});

test('a reviewed line-timing replacement is not discarded by a later measured provider',async()=>{
 const gate=deferred(),line={name:'LRCAPI',searchSong:async()=>({id:99,title:appleRequest.title,artist:appleRequest.artist,album:appleRequest.album,duration:240,source:'lrclib'}),
  getLyrics:async()=>({lines:[{text:'Corrected synthetic one',timestamp:9},{text:'Corrected synthetic two',timestamp:59}]})};
 const f=yrcService({getAvailableAPIsFn:()=>[f.api,line],speculativeDiscovery:false,hedgeDelayMs:1,wordTimingGraceMs:1000,
  applyTimingCorrectionFn:async candidate=>candidate.api===line?{...candidate,timingCorrection:{status:'replacement',id:'reviewed-correction',source_fingerprint:'fixture'}}:candidate});
 const original=f.api.searchSong;f.api.searchSong=async(...args)=>{await gate.promise;return original(...args);};
 const res=streamResponse(),work=f.service({method:'POST',body:{...appleRequest,options:{delivery:'progressive-v1'}}},res);
 await until(()=>frames(res).length);gate.resolve();await work;
 assert.equal(frames(res).at(-1).response.metadata.source,'LRCAPI');
 assert.equal(frames(res).at(-1).response.metadata.timing_correction.status,'replacement');
 assert.equal(frames(res).some(f=>f.response?.metadata?.source==='NeteaseAPI'),false);
});
