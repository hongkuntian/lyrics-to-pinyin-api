import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {verifySpotifyBinding,sourceCapsule} from '../../api/utils/song-library/spotify-recording.js';
import {streamResponse,frames} from '../helpers/stream-http.js';
const require=createRequire(import.meta.url),fixture=require('../fixtures/reported-first-time-recording.json');
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const until=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setImmediate(r));assert.ok(predicate(),'expected source event');};

for(const rejectWordSource of [false,true])test(`reported exact Spotify recording: plain first, ${rejectWordSource?'incompatible word edition refuses':'qualified NetEase words survive the plain grace'}`,async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const gate=defer(),net=new NeteaseAPI(),queries=[];let wordStarted=false;
 const fetchFn=async url=>{
  const u=new URL(url);queries.push(u.pathname);
  const body=u.pathname==='/artist/detail'?{code:200,data:{artist:fixture.artistProfile}}
   :u.pathname==='/search'?{code:200,result:{songs:[{...fixture.providerRecord,...(rejectWordSource?{name:'第一次 (Live)'}:{})}]}}
   :{code:200,yrc:{lyric:'[12000,2000](12000,1000,0)一起(13000,1000,0)听\n[18000,2000](18000,1000,0)慢慢(19000,1000,0)唱'}};
  return new Response(JSON.stringify(body));
 };
 const search=net.searchSong.bind(net),lyrics=net.getLyrics.bind(net);
 net.searchSong=async(a,b,c)=>{wordStarted=true;await gate.promise;return search(a,b,{...c,fetchFn});};
 net.getLyrics=(id,c)=>lyrics(id,{...c,fetchFn});
 const plain={name:'LRCAPI',searchSong:async()=>({id:8998666,title:'第一次',artist:'Michael Wong',
  creditedArtistNames:['Michael Wong'],album:'十光年精選輯',duration:263,source:'lrclib'}),
  getLyrics:async()=>({source:'lrclib',songId:8998666,lines:[{text:'Invented readable words',timestamp:null},{text:'Invented second row',timestamp:null}]})};
 const service=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[net,plain],hedgeDelayMs:1,
  untimedGraceMs:20,wordTimingGraceMs:200,logger:{info(){},error(){}}});
 const res=streamResponse(),work=service({method:'POST',body:{recording:fixture.recording,options:{delivery:'progressive-v1',refresh:true}}},res);
 try {
  await until(()=>wordStarted);t.mock.timers.tick(1);await until(()=>frames(res).some(f=>f.event==='readable'));
  const first=frames(res).find(f=>f.event==='readable').response;
  assert.equal(first.quality.synced,false);assert.equal(first.song.id,8998666);
  t.mock.timers.tick(21);await new Promise(r=>setImmediate(r));
  assert.equal(res.ended,undefined,'plain grace must not close an active measured lookup');
  gate.resolve();await work;
  const final=frames(res).at(-1).response;assert.equal(frames(res).at(-1).event,'complete');
  if(rejectWordSource){assert.equal(final.song.id,8998666);assert.equal(final.quality.synced,false);assert.equal(queries.includes('/lyric/new'),false);}
  else {
   assert.equal(final.song.id,85482);assert.equal(final.quality.synced,true);
   assert.equal(final.metadata.lyric_timing.source,'netease:85482:yrc');
   assert.ok(final.lines.every(line=>line.vocalTiming?.segments.length===2));
   const doc=publicDocument(makeDocument(fixture.recording,final,SELECTION_REVISION),fixture.recording);
   verifySpotifyBinding(doc.recordingBinding,fixture.recording,sourceCapsule(final),SELECTION_REVISION,final,{durable:true});
   assert.deepEqual(doc.response.lines,final.lines);
  }
 }finally{gate.resolve();await work;}
});
