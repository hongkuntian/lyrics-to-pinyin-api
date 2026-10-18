import test from 'node:test';
import assert from 'node:assert/strict';
import {measuredContract,measuredService} from '../helpers/measured-sources.js';
import {appleRequest,spotifyRequest} from '../helpers/netease-yrc.js';
import {makeDocument,requestKey} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {SELECTION_REVISION} from '../../api/music-romanize.js';
import {libraryDB} from '../helpers/library-db.js';
import {getAvailableAPIs,getSupportedCombinations} from '../../api/music-apis/index.js';
import {measuredVocalCoverage} from '../../api/utils/lyric-selection.js';
import {sourceCapsule,spotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {QQMusicAPI} from '../../api/music-apis/qq.js';
import {yrcService} from '../helpers/netease-yrc.js';
import {readFileSync} from 'node:fs';

test('Spotify cold QQ acquisition retains the exact target needed to revalidate an explicit sheet',async()=>{
 const hex=JSON.parse(readFileSync(new URL('../fixtures/qrc-codec-fixtures.json',import.meta.url))).providerExplicitQRC;
 const recording={version:2,provider:'spotify',item_id:spotifyRequest.item_id,
  metadata:{origin:'spotify',title:'Synthetic',artists:['Test'],album:'Example',duration_ms:120000,explicit:true}};
 const detail={id:123,mid:'00000000000123',name:'Synthetic',title:'Synthetic',subtitle:'',interval:120,
  album:{id:2,mid:'00000000000002',name:'Example'},singer:[{id:1,mid:'00000000000001',name:'Test'}]};
 const answer=(data,url)=>({ok:true,status:200,url,headers:new Map(),json:async()=>data});
 const fetchFn=async(url,init)=>{
  if(!init.body) {
   if(new URL(url).pathname.endsWith('smartbox_new.fcg'))return answer({code:0,data:{song:{count:1,itemlist:[{id:'123',docid:'123',mid:detail.mid,name:'Synthetic',singer:'Test'}]}}},url);
   return answer({code:0,data:{song:{list:[{songid:123,songmid:detail.mid,songname:'Synthetic',interval:120,
    albumid:2,albummid:detail.album.mid,albumname:'Example',singer:detail.singer}]}}},url);
  }
  const result={code:0};for(const [key,entry] of Object.entries(JSON.parse(init.body))) {
   if(key==='comm')continue;
   result[key]=entry.method==='get_song_detail_yqq'?{code:0,data:{track_info:detail}}:
    {code:0,data:{songID:123,songName:'Synthetic',singerName:'Test',qrc:1,crypt:1,lyric:hex}};
  }return answer(result,url);
 };
 const api=new QQMusicAPI();
 for(const method of ['searchSong','getLyrics','getRecording']) {
  const original=api[method].bind(api);
  api[method]=(...args)=>{const context=args.pop()??{};return original(...args,{...context,fetchFn});};
 }
 const f=yrcService({resolution:false,speculativeDiscovery:false,getAvailableAPIsFn:()=>[api],getContextFn:async()=>null});
 const good=await f.call({recording,options:{lyric_sources_version:2}});
 assert.equal(good.statusCode,200,JSON.stringify(good.body));assert.equal(good.body.metadata.source,'QQMusicAPI');
 assert.equal(good.body.recordingBinding.itemID,recording.item_id);assert.equal(good.body.metadata.lyric_timing.source,'qq:123:qrc');
 assert.ok(good.body.lines.every(l=>l.vocalTiming));
 for(const explicit of [false,undefined]) {
  const metadata={...recording.metadata,explicit};if(explicit===undefined)delete metadata.explicit;
  const guarded=await f.call({recording:{...recording,metadata},options:{lyric_sources_version:2}});
  assert.equal(guarded.statusCode,409);assert.equal(guarded.body.code,'recording_mismatch');
 }
});

for(const source of ['kugou','qq'])for(const provider of ['apple','spotify'])test(`${source}/${provider}: own measured source survives acquisition, immutable hashes and public projection`,async()=>{
 const fixture=await measuredContract(source,provider),r=fixture.acquisitionResponse,d=fixture.libraryResponse.document;
 const format=source==='kugou'?'krc':'qrc';
 assert.equal(r.metadata.lyric_timing.source,`${source}:42:${format}`);
 assert.equal(r.metadata.lyric_timing.recordingID,provider==='spotify'?spotifyRequest.item_id:appleRequest.catalog_id);
 assert.deepEqual(r.lines.map(l=>l.original),['!你 😀e\u0301','Synthetic sky','Line without word cues']);
 assert.deepEqual(r.lines[0].vocalTiming.segments.map(s=>[s.utf16Start,s.utf16Length,s.start,s.end]),[[1,2,10,10.5],[3,2,10.75,11.25],[5,2,11.25,12]]);
 assert.equal(r.lines[2].vocalTiming,undefined);assert.equal(r.metadata.word_timing_upgrade_version,2);
 assert.deepEqual(d.response.lines,r.lines);assert.deepEqual(d.response.metadata.lyric_timing,r.metadata.lyric_timing);
 if(provider==='spotify')assert.equal(d.recordingBinding.source.provider,source);
 const request=provider==='spotify'?spotifyRequest:appleRequest;
 const a=makeDocument(request,r,SELECTION_REVISION),changed=structuredClone(r);changed.lines[0].vocalTiming.segments[0].end-=.1;
 if(provider==='spotify')changed.recordingBinding=spotifyBinding(request,sourceCapsule(changed),SELECTION_REVISION,changed);
 const b=makeDocument(request,changed,SELECTION_REVISION);
 assert.notEqual(a.timingRevision,b.timingRevision);assert.notEqual(a.sourceHash,b.sourceHash);assert.equal(a.textRevision,b.textRevision);
 const stale=structuredClone(a);stale.response.metadata.lyric_timing.recordingID='wrong';assert.throws(()=>publicDocument(stale,request),{code:'recording_mismatch'});
});

test('QQ independent source is accepted after JSONB persistence without changing Spotify identity',async t=>{
 const {db,store}=await libraryDB();t.after(()=>db.close());const f=await measuredContract('qq','spotify');
 const doc=makeDocument(spotifyRequest,f.acquisitionResponse,SELECTION_REVISION),owner=await store.claimLookup(doc.requestKey,SELECTION_REVISION);
 assert.ok(owner);try{await store.saveDocument(doc,{lookupOwner:owner});}finally{await store.releaseLookup(doc.requestKey,SELECTION_REVISION,owner);}
 const loaded=await store.documentForRequest(requestKey(spotifyRequest),SELECTION_REVISION),wire=publicDocument(loaded,spotifyRequest);
 assert.equal(wire.recordingBinding.itemID,spotifyRequest.item_id);assert.equal(wire.recordingBinding.source.provider,'qq');
 assert.deepEqual(wire.response.metadata.lyric_timing,f.acquisitionResponse.metadata.lyric_timing);
 assert.deepEqual(wire.response.lines,f.acquisitionResponse.lines);
});

test('every registered language and language-agnostic discovery has measured source opportunities',()=>{
 for(const {script} of getSupportedCombinations())assert.ok(getAvailableAPIs(script).filter(a=>a.supportsVocalTiming).length>=3,script);
 for(const language of ['es','fr','de','pt','it']) {
  const sources=getAvailableAPIs(language);assert.ok(sources.some(a=>a.name==='KugouAPI'));assert.ok(sources.some(a=>a.name==='QQMusicAPI'));
 }
});

test('QQ/KRC measured coverage includes source line-only text in its denominator',async()=>{
 for(const source of ['kugou','qq']) {
  const f=measuredService(source),song=await f.measuredAPI.searchSong(),lyrics=await f.measuredAPI.getLyrics();
  const coverage=measuredVocalCoverage({song,lyrics});assert.ok(coverage.covered>0);assert.ok(coverage.covered<coverage.total);assert.equal(coverage.complete,false);
 }
});

test('legacy Spotify bindings retain supported sources and cannot reuse a QQ acquisition cache',async()=>{
 let qqCalls=0;
 const plain={name:'LRCAPI',searchSong:async()=>({id:7,source:'lrclib',artist:appleRequest.artist,title:appleRequest.title,album:appleRequest.album,duration:240}),
  getLyrics:async()=>({source:'lrclib',songId:7,lines:[{text:'Invented readable one',timestamp:10},{text:'Invented readable two',timestamp:60}]})};
 const f=measuredService('qq',{getAvailableAPIsFn:()=>[f.measuredAPI,plain]});
 const original=f.measuredAPI.searchSong;f.measuredAPI.searchSong=async(...args)=>{qqCalls++;return original(...args);};
 const legacy=await f.call({recording:spotifyRequest});assert.equal(legacy.statusCode,200);assert.equal(legacy.body.metadata.source,'LRCAPI');assert.equal(qqCalls,0);
 const expanded=await f.call({recording:spotifyRequest,options:{lyric_sources_version:2}});
 assert.equal(expanded.statusCode,200);assert.equal(expanded.body.recordingBinding.source.provider,'qq');assert.equal(qqCalls,1);
 const oldAgain=await f.call({recording:spotifyRequest});assert.equal(oldAgain.body.metadata.source,'LRCAPI');assert.equal(qqCalls,1);
 for(const value of [null,0,3,'2',true])assert.equal((await f.call({recording:spotifyRequest,options:{lyric_sources_version:value}})).statusCode,400);
});
