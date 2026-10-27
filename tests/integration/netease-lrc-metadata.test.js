import test from 'node:test';
import assert from 'node:assert/strict';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {parseLRC} from '../../api/utils/lrc.js';
import {createSpotifyLyricsService} from '../../api/utils/spotify-lyrics.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {LYRIC_SELECTION_REVISION} from '../../api/utils/lyric-annotations.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

const header=(t=0)=>JSON.stringify({t,c:[{tx:'Composer: '},{tx:'Invented Artist',li:'https://example.invalid/credit.jpg',or:'orpheus://artist/7'}]});
const vocals='[00:10.00]Invented morning\n[00:20.00]Invented evening';
const raw=Array.from({length:11},(_,i)=>header(i*1000)).join('\n')+'\n'+vocals;
test('NetEase leading structured LRC credits never become untimed vocal rows or fabricated words',async()=>{
 const api=new NeteaseAPI(),calls=[];
 const lyrics=await api.getLyrics(42,{fetchFn:async url=>{calls.push(url);return {ok:true,status:200,json:async()=>({code:200,lrc:{lyric:raw}})};}});
 assert.deepEqual(lyrics.lines,parseLRC(vocals));assert.equal(calls.length,1);
 assert.equal(lyrics.timingSource,undefined);assert.ok(lyrics.lines.every(l=>l.vocalTiming===undefined));
 assert.equal(parseLRC(raw).length,13,'the generic LRC parser remains unchanged');
});
test('bounded provider containers are excluded at every position; unknown and malformed JSON remains readable',()=>{
 const api=new NeteaseAPI();
 for(const prefix of ['{"unknown":"sung words"}',JSON.stringify({t:'0',c:[{tx:'words'}]}),
  JSON.stringify({t:0,c:[{text:'words'}]}),'{broken',JSON.stringify({t:0,c:[]}),
  JSON.stringify({t:0,c:[{tx:'words',extra:'unknown'}]}),JSON.stringify({t:0,c:[{tx:'x'.repeat(2001)}]})])
  assert.deepEqual(api.parseLyrics(prefix+'\n'+vocals),parseLRC(prefix+'\n'+vocals));
 assert.deepEqual(api.parseLyrics(vocals+'\n'+header()),parseLRC(vocals));
 assert.deepEqual(api.parseLyrics('ordinary untimed words\n'+header()+'\n'+vocals),parseLRC('ordinary untimed words\n'+vocals));
 assert.deepEqual(api.parseLyrics('\uFEFF\n[ar:Invented Artist]\n'+header(-1000)+'\n'+vocals),parseLRC(vocals));
 const excess=Array.from({length:33},()=>header()).join('\n')+'\n'+vocals;
 assert.equal(api.parseLyrics(excess).length,3,'metadata count bound fails closed rather than hiding more content');
});
test('actual Spotify service keeps line synchronization eligible without claiming measured YRC',async()=>{
 const api=new NeteaseAPI();
 const fetchFn=async url=>({ok:true,status:200,json:async()=>new URL(url).pathname==='/search'
  ?{code:200,result:{songs:[{id:42,name:'Invented Song',duration:240000,artists:[{id:7,name:'Invented Artist'}],album:{name:'Invented Album'}}]}}
  :{code:200,lrc:{lyric:raw}}});
 for(const name of ['searchSong','getLyrics']){const original=api[name].bind(api);api[name]=(...args)=>{args[args.length-1]={...args.at(-1),fetchFn};return original(...args);};}
 const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'Invented Song',artists:['Invented Artist'],album:'Invented Album',duration_ms:240000}};
 const handler=createSpotifyLyricsService({redis:null,getAvailableAPIsFn:()=>[api],detectLanguageFn:async()=> 'en',getDefaultRomanizationSystemFn:()=> 'none',logger:{info(){},error(){}}});
 const res=createMockRes();await handler(createMockReq({body:{recording,options:{refresh:true}}}),res);
 assert.equal(res.statusCode,200);assert.equal(res.body.lines.length,2);
 assert.equal(res.body.quality.synced,true);assert.equal(res.body.recordingBinding.synchronizationEligible,true);
 assert.equal(res.body.metadata.lyric_timing,undefined);assert.ok(res.body.lines.every(l=>l.vocalTiming===undefined));
 const doc=makeDocument(recording,res.body,LYRIC_SELECTION_REVISION),wire=publicDocument(doc,recording);
 assert.equal(wire.recordingBinding.synchronizationEligible,true);
 assert.deepEqual(wire.response.lines,res.body.lines);assert.ok(!JSON.stringify(doc.sourceCapsule??doc.response).includes('example.invalid'));
 const bad=structuredClone(res.body);bad.lines.push({original:'unknown untimed lyric',romanized:'unknown untimed lyric',timestamp:null});
 // Existing strict bindings are not loosened to synchronize unproven rows.
 const {synchronizationEligible}=await import('../../api/utils/song-library/spotify-recording.js');assert.equal(synchronizationEligible(bad),false);
});
test('metadata-only primary payload still falls back once and never becomes usable lyric content',async()=>{
 const calls=[];const lyrics=await new NeteaseAPI().getLyrics(42,{fetchFn:async url=>{
  calls.push(new URL(url).pathname);return {ok:true,status:200,json:async()=>({code:200,lrc:{lyric:calls.length===1?header():vocals}})};
 }});
 assert.deepEqual(calls,['/lyric/new','/lyric']);assert.deepEqual(lyrics.lines,parseLRC(vocals));
});
