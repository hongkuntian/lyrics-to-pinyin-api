import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeHandler,SELECTION_REVISION} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
const request={catalog_id:'123',artist:'Test Singer',title:'A Song',album:'An Album',duration:100,language:'en'};
const song={id:1,...request};
function make(lyrics,dependencies={}) {
 const api={name:'Fixture',searchSong:async(_,__,context)=>{assert.equal(context.catalog_id,request.catalog_id);return song;},getLyrics:async()=>lyrics};
 return createMusicRomanizeHandler({redis:null,getAvailableAPIsFn:()=>[api],resolveCatalogAliasesFn:async()=>[],logger:{error(){}},...dependencies});
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
