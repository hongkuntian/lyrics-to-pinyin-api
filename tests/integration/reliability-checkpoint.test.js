import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeHandler,SELECTION_REVISION} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {BoundedCache} from '../../api/utils/bounded-cache.js';
const request={catalog_id:'123',artist:'Test Singer',title:'A Song',album:'An Album',duration:100,language:'en'};
const song={id:1,...request};
function make(lyrics,dependencies={}) {
 const api={name:'Fixture',searchSong:async(_,__,context)=>{assert.equal(context.catalog_id,request.catalog_id);return song;},getLyrics:async()=>lyrics};
 return createMusicRomanizeHandler({lookupOfficialTranscriptionFn:async()=>null,lookupReviewedRecordingFn:async()=>null,redis:null,getAvailableAPIsFn:()=>[api],resolveCatalogAliasesFn:async()=>[],logger:{error(){}},...dependencies});
}
async function invoke(handler){const res=createMockRes();await handler(createMockReq({body:request}),res);return res;}
test('explicit instrumental is a successful separate state, not fabricated lyrics',async()=>{
 const result=await invoke(make({lines:[],instrumental:true}));
 assert.equal(result.statusCode,200);assert.deepEqual(result.body.lines,[]);
 assert.equal(result.body.quality.instrumental,true);assert.equal(result.body.quality.synced,false);
 assert.equal(result.body.metadata.selection_revision,SELECTION_REVISION);
});
test('credit-only source is not coverage and malformed timing preserves readable words',async()=>{
 assert.equal((await invoke(make({lines:[{text:'作词：Writer',timestamp:1}]}))).statusCode,404);
 const result=await invoke(make({lines:[{text:'A phrase',timestamp:120}],instrumental:true}));
 assert.equal(result.statusCode,200);assert.equal(result.body.lines[0].timestamp,null);
 assert.equal(result.body.quality.instrumental,false);assert.equal(result.body.quality.synced,false);
});
test('old selection-policy server cache is discarded before new revision is certified',async()=>{
 let writes=0;
 const result=await invoke(make({lines:[{text:'New source',timestamp:1}]},{redis:{},getCachedFn:async()=>({metadata:{version:'2.3.0'},lines:[{original:'Old source'}]}),setCachedFn:async()=>{writes++;},waitUntilFn:()=>{}}));
 assert.equal(result.statusCode,200);assert.equal(result.body.lines[0].original,'New source');assert.equal(writes,1);
});
test('metadata equivalence carries the full original request binding',async()=>{
 const req={...request,artist:'Faye Wong'};
 const api={name:'Fixture',searchSong:async()=>({...song,artist:'Wong, Faye'}),getLyrics:async()=>({lines:[{text:'A phrase',timestamp:1}]})};
 const handler=make(null,{getAvailableAPIsFn:()=>[api]});const res=createMockRes();await handler(createMockReq({body:req}),res);
 assert.equal(res.statusCode,200);assert.deepEqual(res.body.metadata.recording_match,{method:'metadata_equivalence',catalog_id:req.catalog_id,artist:req.artist,title:req.title,album:req.album,duration:req.duration});
 assert.equal(res.body.song.artist.original,'Wong, Faye');
});

test('recording-bound correction localizations use a catalog alias proof',async()=>{
 const handler=make({lines:[{text:'A phrase',timestamp:12}]},{applyTimingCorrectionFn:async(candidate,original)=>({...candidate,song:{...song,artist:'Wong, Faye'},target:original,lyrics:{lines:[{text:'A phrase',timestamp:9}]},timingCorrection:{id:'fixture',status:'replacement'}})});
 const result=await invoke(handler);
 assert.equal(result.body.metadata.recording_match.method,'catalog_alias');
 assert.equal(result.body.metadata.recording_match.artist,request.artist);
 assert.equal(result.body.metadata.recording_match.catalog_id,request.catalog_id);
});

test('temporary correction-source outages remain readable without caching the degraded selection',async()=>{
 let attempts=0;
 const handler=make({lines:[{text:'A phrase',timestamp:12}]},{redis:{},getCachedFn:async()=>({metadata:{version:'2.3.0',selection_revision:SELECTION_REVISION,timing_correction:{status:'untimed_fallback'}}}),setCachedFn:()=>assert.fail('temporary fallback must not persist'),applyTimingCorrectionFn:async(candidate)=>{attempts++;return {...candidate,lyrics:{lines:[{text:'A phrase',timestamp:null}]},timingCorrection:{id:'fixture',status:'untimed_fallback'}};}});
 for(let i=0;i<2;i++) {
  const result=await invoke(handler);assert.equal(result.statusCode,200);assert.equal(result.body.lines[0].original,'A phrase');
  assert.equal(result.body.metadata.selection_revision,undefined);assert.equal(result.body.quality.synced,false);
 }
 assert.equal(attempts,2);
});

test('plain results use a short server lifetime and can later recover timing',async()=>{
 let now=0,calls=0;const writes=[];
 const api={name:'Fixture',searchSong:async()=>{calls++;return song;},getLyrics:async()=>({lines:[{text:'A phrase',timestamp:calls>1?9:null}]})};
 const responseCache=new BoundedCache({now:()=>now});
 const handler=make(null,{responseCache,redis:{},getCachedFn:async()=>null,setCachedFn:async(_,__,body,ttl)=>writes.push(ttl),waitUntilFn:()=>{},getAvailableAPIsFn:()=>[api]});
 assert.equal((await invoke(handler)).body.quality.synced,false);assert.deepEqual(writes,[300]);
 now=299999;assert.equal((await invoke(handler)).body.quality.synced,false);assert.equal(calls,1);
 now=300001;assert.equal((await invoke(handler)).body.quality.synced,true);assert.equal(calls,2);assert.deepEqual(writes,[300,86400]);
});

test('old plain Redis payloads cannot renew their lifetime in server memory',async()=>{
 const cached={metadata:{version:'2.3.0',selection_revision:SELECTION_REVISION,timestamp:new Date(Date.now()-600000).toISOString()},quality:{synced:false,instrumental:false},lines:[{original:'Old fallback',timestamp:null}]};
 const result=await invoke(make({lines:[{text:'Fresh timing',timestamp:7}]},{redis:{},getCachedFn:async()=>cached,setCachedFn:async()=>{},waitUntilFn:()=>{}}));
 assert.equal(result.body.quality.synced,true);assert.equal(result.body.lines[0].original,'Fresh timing');
});

test('reviewed recordings preserve source labels and return full request-bound identity evidence',async()=>{
 const reviewedIdentity={id:'reviewed-fixture',catalogID:request.catalog_id,source:'netease',sourceID:'77'};
 const handler=make(null,{getAvailableAPIsFn:()=>[{name:'Fixture',searchSong:()=>assert.fail('verified timed source needs no search')}],
  lookupReviewedRecordingFn:async(original,context)=>{
   assert.equal(original.artist,request.artist);assert.ok(context.signal);
   return {song:{...song,id:77,artist:'Verified ensemble',title:'Verified localized title'},lyrics:{lines:[{text:'A phrase',timestamp:4}]},api:{name:'NeteaseAPI'},target:original,reviewedIdentity};
  }});
 const result=await invoke(handler);
 assert.equal(result.statusCode,200);assert.equal(result.body.song.artist.original,'Verified ensemble');
 assert.equal(result.body.metadata.source,'NeteaseAPI');assert.deepEqual(result.body.metadata.reviewed_recording,reviewedIdentity);
 assert.deepEqual(result.body.metadata.recording_match,{method:'metadata_equivalence',catalog_id:request.catalog_id,artist:request.artist,title:request.title,album:request.album,duration:request.duration});
});

test('reviewed source failures cannot suppress an ordinary verified result',async()=>{
 const result=await invoke(make({lines:[{text:'Ordinary verified source',timestamp:3}]},{lookupReviewedRecordingFn:async()=>{throw new Error('unavailable');}}));
 assert.equal(result.statusCode,200);assert.equal(result.body.lines[0].original,'Ordinary verified source');
 assert.equal(result.body.metadata.reviewed_recording,undefined);
});

function partialCandidate(original) {
 return {song:{...song,id:'official_123'},lyrics:{partial:true,instrumental:false,lines:[{text:'Known official phrase',timestamp:null}]},api:{name:'OfficialDescription'},target:original};
}
test('official partial lyrics remain labelled and readable through source outages',async()=>{
 const writes=[];
 const result=await invoke(make(null,{lookupOfficialTranscriptionFn:async original=>partialCandidate(original),
  getAvailableAPIsFn:()=>[{name:'Unavailable',searchSong:async()=>{throw new Error('offline');}}],
  redis:{},getCachedFn:async()=>null,setCachedFn:async(_,__,body,ttl)=>writes.push(ttl),waitUntilFn:()=>{}}));
 assert.equal(result.statusCode,200);assert.equal(result.body.song.id,'official_123');
 assert.equal(result.body.quality.partial,true);assert.equal(result.body.quality.synced,false);
 assert.equal(result.body.lines[0].original,'Known official phrase');assert.deepEqual(writes,[300]);
});
test('full plain and timed sources both supersede official partial lyrics',async()=>{
 for(const timestamp of [null,5]) {
  const result=await invoke(make({lines:[{text:'Complete provider text',timestamp}]},{lookupOfficialTranscriptionFn:async original=>partialCandidate(original)}));
  assert.equal(result.body.quality.partial,false);assert.equal(result.body.lines[0].original,'Complete provider text');
 }
});
test('instrumental fallback cannot erase known official vocal words',async()=>{
 const result=await invoke(make({lines:[],instrumental:true},{lookupOfficialTranscriptionFn:async original=>partialCandidate(original)}));
 assert.equal(result.body.quality.partial,true);assert.equal(result.body.quality.instrumental,false);
 assert.equal(result.body.lines[0].original,'Known official phrase');
});
test('official transcription failure does not suppress ordinary verified lyrics',async()=>{
 const result=await invoke(make({lines:[{text:'Verified phrase',timestamp:4}]},{lookupOfficialTranscriptionFn:async()=>{throw new Error('source changed');}}));
 assert.equal(result.body.quality.partial,false);assert.equal(result.body.lines[0].original,'Verified phrase');
});

test('partially timed transcriptions still retry on the short lifetime',async()=>{
 const writes=[];
 const result=await invoke(make({partial:true,lines:[{text:'Some timed words',timestamp:4}]},{redis:{},getCachedFn:async()=>null,setCachedFn:async(_,__,body,ttl)=>writes.push(ttl),waitUntilFn:()=>{}}));
 assert.equal(result.body.quality.partial,true);assert.deepEqual(writes,[300]);
});

test('cached numeric provider IDs keep old clients readable without renewing freshness',async()=>{
 const cached={song:{id:'103045439'},metadata:{version:'2.3.0',selection_revision:SELECTION_REVISION,timestamp:new Date().toISOString()},quality:{synced:true,partial:false,instrumental:false},lines:[{original:'Cached phrase',timestamp:4}]};
 const handler=make(null,{redis:{},getCachedFn:async()=>cached,getAvailableAPIsFn:()=>[{name:'Unused',searchSong:()=>assert.fail('valid cache should be used')}]});
 for(let i=0;i<2;i++) {
  const result=await invoke(handler);assert.equal(result.body.song.id,103045439);assert.equal(result.body.metadata.timestamp,cached.metadata.timestamp);
 }
 assert.equal(cached.song.id,'103045439');
});
