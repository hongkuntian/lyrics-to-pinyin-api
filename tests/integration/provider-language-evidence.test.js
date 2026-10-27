import test from 'node:test';
import assert from 'node:assert/strict';
import {KugouAPI} from '../../api/music-apis/kugou.js';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {analyzeLyricLanguage} from '../../api/utils/lyric-language.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {catalogProof} from '../helpers/netease-yrc.js';
import {encodeKRC} from '../helpers/kugou-krc.js';

const request={catalog_id:'123',storefront:'us',artist:'Synthetic Singer',title:'Synthetic Song',album:'Synthetic Album',duration:120};
const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:request.title,artists:[request.artist],album:request.album,duration_ms:120000}};
const raw='[ar:Synthetic Singer]\n[ti:Synthetic Song]\n[10000,2000]<0,1000,0>These invented words describe a quiet morning, <1000,1000,0>and we repeat them only in this synthetic test.\n[20000,2000]<0,1000,0>We speak about a fictional journey together, <1000,1000,0>with no commercial song or provider text in these words.';
function fixture(language){
 const calls=[],pending=[],values=new Map(),api=new KugouAPI();
 const transport=async url=>{
  const u=new URL(url);calls.push(u.toString());
  return {ok:true,status:200,json:async()=>u.pathname==='/search'?{status:200,candidates:[{id:'42',singer:request.artist,song:request.title,duration:120000,
   product_from:'官方推荐歌词',accesskey:'private-fixture-key',...(language===undefined?{}:{language})}]}:{status:200,fmt:'krc',content:encodeKRC(raw)}};
 };
 for(const method of ['searchSong','getLyrics']){const original=api[method].bind(api);api[method]=(...args)=>{args[args.length-1]={...args.at(-1),fetchFn:transport};return original(...args);};}
 const service=createMusicRomanizeService({redis:{},getCachedFn:async(_,key)=>values.get(key),setCachedFn:async(_,key,value)=>values.set(key,structuredClone(value)),
  waitUntilFn:p=>pending.push(p),getAvailableAPIsFn:()=>[api],getMusicAPIFn:()=>api,speculativeDiscovery:false,
  lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  resolveCatalogAliasesFn:async r=>{const aliases=[];Object.defineProperty(aliases,'resolution',{value:catalogProof(r)});return aliases;},logger:{info(){},error(){}}});
 return {calls,values,async call(body){const res=createMockRes();await service(createMockReq({body}),res);let i=0;while(i<pending.length)await pending[i++];return res;}};
}
for(const provider of ['apple','spotify'])test(`${provider}: actual adapter -> HTTP -> durable response retains optional declaration and own measured cues`,async()=>{
 const f=fixture('英语'),body=provider==='apple'?request:{recording};const res=await f.call(body);
 assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(f.calls.length,2);
 const response=res.body,details=response.metadata.language_details,evidence=details.provider_evidence;
 assert.equal(evidence.source.provider,'kugou');assert.equal(evidence.source.id,'42');assert.equal(evidence.body.format,'krc');
 assert.equal(evidence.decision.status,'agreement');assert.equal(evidence.decision.candidate,'en');
 const {provider_evidence,...legacy}=details;assert.deepEqual(legacy,analyzeLyricLanguage(response.lines.map(l=>l.original),{genres:[],verified:provider==='apple'}));
 assert.ok(response.lines.every(l=>l.vocalTiming));assert.equal(response.metadata.lyric_timing.source,'kugou:42:krc');
 assert.ok(!JSON.stringify(response).includes('private-fixture-key'));
 const original=provider==='apple'?request:recording,doc=makeDocument(original,response,SELECTION_REVISION),wire=publicDocument(doc,original);
 assert.deepEqual(wire.response.metadata.language_details.provider_evidence,evidence);assert.deepEqual(wire.response.lines,response.lines);
 const first=structuredClone(evidence),warm=await f.call(body);
 assert.equal(warm.statusCode,200);assert.equal(f.calls.length,2,'warm reads do not fetch language metadata');
 assert.deepEqual(warm.body.metadata.language_details.provider_evidence,first);
});
test('metadata-only declarations do not change provider ordering, text, cues or legacy detected language',async()=>{
 const a=fixture(undefined),b=fixture('意大利语');const [before,after]=await Promise.all([a.call(request),b.call(request)]);
 assert.equal(before.statusCode,200);assert.equal(after.statusCode,200);assert.deepEqual(a.calls,b.calls);
 assert.deepEqual(before.body.song,after.body.song);assert.deepEqual(before.body.lines,after.body.lines);assert.deepEqual(before.body.metadata.lyric_timing,after.body.metadata.lyric_timing);
 assert.equal(after.body.metadata.language_details.primary,'en');assert.equal(after.body.metadata.language_details.provider_evidence.decision.status,'disagreement');
 assert.equal(after.body.metadata.language_details.provider_evidence.decision.candidate,'it');
});
test('an explicit processing override stays separate from text language and provider declaration',async()=>{
 const f=fixture('英语'),res=await f.call({...request,language:'ru',romanization_system:'none'});
 assert.equal(res.statusCode,200);assert.equal(res.body.song.language,'ru');assert.equal(res.body.song.romanization_system,'none');
 assert.equal(res.body.metadata.language_details.primary,'en');assert.equal(res.body.metadata.language_details.provider_evidence.decision.status,'agreement');
 assert.equal(f.calls.length,2);assert.ok(res.body.lines.every(l=>l.vocalTiming));
});
test('broad or malformed optional declarations cannot downgrade a complete measured source',async()=>{
 for(const label of ['印度语',{toString:'malformed optional metadata'}]){
  const f=fixture(label),res=await f.call(request);assert.equal(res.statusCode,200);assert.equal(f.calls.length,2);
  assert.ok(res.body.lines.every(l=>l.vocalTiming));assert.equal(res.body.metadata.language_details.provider_evidence.decision.candidate,null);
 }
});
