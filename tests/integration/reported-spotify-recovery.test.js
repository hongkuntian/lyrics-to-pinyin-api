import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {lyricLoader,createSongLibraryHandler} from '../../api/song-library.js';
import {spotifySearchRequest,verifySpotifyBinding,sourceCapsule} from '../../api/utils/song-library/spotify-recording.js';
import {recordingScore} from '../../api/utils/recording-match.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {libraryDB} from '../helpers/library-db.js';

const {duet,ensemble}=createRequire(import.meta.url)('../fixtures/reported-spotify-recovery.json');
// Source metadata is observed; these performed words and measured cues are synthetic.
const lyricPayload={code:200,yrc:{lyric:'[12000,2000](12000,1000,0)一起(13000,1000,0)听\n[60000,2000](60000,1000,0)慢慢(61000,1000,0)唱'}};
function fixture(row,{source=row.source,profileDelay=0,lyricDelay=0,searchDelay=0,profileTransform=p=>p,words=lyricPayload}={}) {
 const calls=[],signals=[],api=new NeteaseAPI();
 const fetchFn=async(url,init={})=>{
  const u=new URL(url);calls.push(u.pathname);signals.push({path:u.pathname,signal:init.signal});
  let body;
  if(u.pathname==='/search') {await delay(searchDelay,undefined,{signal:init.signal});body={code:200,result:{songs:[source]}};}
  else if(u.pathname==='/song/detail')body={code:200,songs:[{id:source.id,name:source.name,ar:source.artists,al:source.album,dt:source.duration,
   ...(source.isrc?{isrc:source.isrc}:{}),...(typeof source.explicit==='boolean'?{explicit:source.explicit}:{})}]};
  else if(u.pathname==='/artist/detail') {await delay(profileDelay,undefined,{signal:init.signal});body={code:200,data:{artist:profileTransform(structuredClone(row.profiles[u.searchParams.get('id')]))}};}
  else if(u.pathname==='/lyric/new') {await delay(lyricDelay,undefined,{signal:init.signal});body=words;}
  else throw new Error('unexpected fixture route: '+u.pathname);
  return {ok:true,status:200,json:async()=>body};
 };
 for(const name of ['searchSong','getRecording','getLyrics']) {
  const original=api[name].bind(api);
  api[name]=(...args)=>{const i=name==='searchSong'?2:1;args[i]={...args[i],fetchFn};return original(...args);};
 }
 return {api,calls,signals};
}
function service(api,options={}) {
 return createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[api],resolveArtistIdentitiesFn:async()=>[],
  resolveCatalogAliasesFn:()=>assert.fail('Spotify cannot borrow Apple catalog aliases'),
  lookupReviewedRecordingFn:()=>assert.fail('Spotify cannot borrow Apple reviewed admission'),
  logger:{info(){},error(){}},...options});
}
async function acquire(handler,recording,options={refresh:true,lyric_sources_version:2}) {
 const res=createMockRes();await handler(createMockReq({body:{recording,options}}),res);return res;
}

for(const [label,row] of [['duet',duet],['ensemble',ensemble]])test(`reported Spotify ${label} preserves its exact independent timed source through save and reopen`,async t=>{
 const {api,calls}=fixture(row),{db,store}=await libraryDB();t.after(()=>db.close());
 const handler=createSongLibraryHandler({store,loadLyrics:lyricLoader(service(api)),
  authStore:{authenticate:async()=>({id:'reader-a'}),limit:async()=>{}},logger:{info(){},error(){}}});
 const call=async body=>{const res=createMockRes();await handler(createMockReq({body,headers:{authorization:'Bearer lyra_s_fixture'}}),res);return res;};
 const first=await call({action:'lyrics',recording:row.recording,refresh:true});
 assert.equal(first.statusCode,200,JSON.stringify(first.body));
 const doc=first.body.document,response=doc.response;
 assert.equal(response.song.id,row.source.id);assert.equal(response.quality.synced,true);
 assert.equal(response.lines.length,2);assert.ok(response.lines.every(line=>line.vocalTiming?.segments.length===2));
 assert.equal(response.song.artist.original,row.source.artists.map(a=>a.name).join(' & '));
 const count=calls.length,reopened=await call({action:'lyrics',recording:row.recording});
 assert.equal(reopened.statusCode,200);assert.equal(reopened.body.document.id,doc.id);assert.equal(calls.length,count);
 assert.deepEqual(reopened.body.document.response.lines,response.lines);
 verifySpotifyBinding(reopened.body.document.recordingBinding,row.recording,sourceCapsule(response),SELECTION_REVISION,response,{durable:true});
 assert.equal(Number((await store.usage()).jobs),0);
});

test('a verified Spotify source gets its lyric-download budget after slow metadata, inside the unchanged request deadline',async()=>{
 const {api}=fixture(duet,{searchDelay:100,lyricDelay:100});
 const plain={name:'LRCAPI',supportsLanguage:()=>true,searchSong:async()=>({id:37355964,source:'lrclib',
  title:duet.recording.metadata.title,artist:duet.recording.metadata.artists.join(' & '),
  creditedArtistNames:duet.recording.metadata.artists,album:duet.recording.metadata.album,duration:232.896}),
  getLyrics:async()=>({source:'lrclib',songId:37355964,lines:[{text:'一起听',timestamp:null},{text:'慢慢唱',timestamp:null}]})};
 const handler=service(api,{getAvailableAPIsFn:()=>[api,plain],providerTimeoutMs:150,hedgeDelayMs:1});
 const result=await acquire(handler,duet.recording);
 assert.equal(result.statusCode,200);assert.equal(result.body.song.id,327736);
 assert.equal(result.body.quality.synced,true);assert.ok(result.body.lines.every(line=>line.vocalTiming));
});

test('reviewed Spotify ensemble recovery never authorizes a changed item, roster or source signature',async()=>{
 const target=spotifySearchRequest(ensemble.recording),{api}=fixture(ensemble);
 const accepted=await api.searchSong(target.artist,target.title,target);
 assert.ok(accepted);assert.equal(recordingScore(accepted,target)>=0,true);
 for(const patch of [{id:5276926},{source:'qq'},{album:'Other release'},{providerAlbumID:'513370'},
  {title:accepted.title+' (Live)'},{duration:325},{creditedArtistNames:['Different choir']},{creditedArtistIDs:['122456']}])
  assert.equal(recordingScore({...accepted,...patch},target),-1,JSON.stringify(patch));
 for(const changed of [
  {...ensemble.recording,item_id:'0123456789ABCDEFGHIJKL'},
  {...ensemble.recording,metadata:{...ensemble.recording.metadata,artists:[...ensemble.recording.metadata.artists.slice(1),'Uncredited Guest']}},
  {...ensemble.recording,metadata:{...ensemble.recording.metadata,artist_ids:[...ensemble.recording.metadata.artist_ids.slice(1),'0123456789ABCDEFGHIJKL']}},
  {...ensemble.recording,metadata:{...ensemble.recording.metadata,title:ensemble.recording.metadata.title+' (Live)'}},
  {...ensemble.recording,metadata:{...ensemble.recording.metadata,album:'Other release'}},
  {...ensemble.recording,metadata:{...ensemble.recording.metadata,duration_ms:325000}}
 ])assert.equal(recordingScore(accepted,spotifySearchRequest(changed)),-1);
 for(const source of [
  {...ensemble.source,id:5276926},
  {...ensemble.source,album:{...ensemble.source.album,id:513370}},
  {...ensemble.source,artists:[{id:122456,name:'群星'}]},
  {...ensemble.source,artists:[{id:122455,name:'Different choir'}]},
  {...ensemble.source,name:ensemble.source.name+' (Live)'},
  {...ensemble.source,duration:325000}
 ]){
  const bad=fixture(ensemble,{source});
  await assert.rejects(()=>bad.api.getRecording('5276925',target),{code:'recording_mismatch'});
  assert.equal(bad.calls.includes('/lyric/new'),false);
 }
});

test('separate Spotify download budget cannot extend the acquisition deadline or start words after metadata timeout',async()=>{
 const slow=fixture(duet,{searchDelay:100});
 const stopped=await acquire(service(slow.api,{providerTimeoutMs:40}),duet.recording);
 assert.equal(stopped.statusCode,504);assert.equal(slow.calls.includes('/lyric/new'),false);
 assert.equal(slow.signals.find(call=>call.path==='/search').signal.aborted,true);
 const bounded=fixture(duet,{lyricDelay:150}),handler=service(bounded.api,{providerTimeoutMs:200});
 const res=createMockRes(),controller=new AbortController();
 await handler({...createMockReq({body:{recording:duet.recording,options:{refresh:true,lyric_sources_version:2}}}),
  lyricDelivery:{signal:controller.signal,deadlineAtMS:Date.now()+60,acquisitionID:'bounded-fixture',own:p=>p,publish(){}}},res);
 assert.equal(res.statusCode,504);assert.equal(bounded.calls.filter(path=>path==='/lyric/new').length,1);
 assert.equal(bounded.signals.find(call=>call.path==='/lyric/new').signal.aborted,true);
});

test('reviewed Spotify ensemble refuses contradictory lyric headers without trying another sheet',async()=>{
 const target=spotifySearchRequest(ensemble.recording);
 for(const tag of ['[ar:Different Choir]','[ti:明天会更好 (Live)]']) {
  const f=fixture(ensemble,{words:{...lyricPayload,lrc:{lyric:tag+'\n[00:12]一起听'}}});
  await assert.rejects(()=>f.api.getRecording('5276925',target),{code:'recording_mismatch',reason:'lyric_header_conflict'});
  assert.equal(f.calls.includes('/lyric'),false);
 }
});

test('reviewed Spotify ensemble evidence survives a cold cache and fresh source-ID refresh',async()=>{
 const values=new Map(),pending=[];
 const make=()=>{
  const f=fixture(ensemble);
  return {...f,handler:service(f.api,{redis:{},getCachedFn:async(_,key)=>values.get(key),
   setCachedFn:async(_,key,value)=>values.set(key,structuredClone(value)),waitUntilFn:p=>pending.push(p)})};
 };
 const first=make(),initial=await acquire(first.handler,ensemble.recording);assert.equal(initial.statusCode,200);
 await Promise.all(pending);
 const stored=[...values.values()].find(value=>value.response&&value.candidate);
 assert.ok(stored);assert.equal(recordingScore(stored.candidate,spotifySearchRequest(ensemble.recording))>=0,true,JSON.stringify(stored.candidate));
 verifySpotifyBinding(stored.response.recordingBinding,ensemble.recording,sourceCapsule(stored.response),SELECTION_REVISION,stored.response);
 const cold=make(),cached=await acquire(cold.handler,ensemble.recording,{lyric_sources_version:2});
 assert.equal(cached.statusCode,200);assert.equal(cached.headers['X-Lyrics-Cache'],'REDIS');assert.equal(cold.calls.length,0);
 const refreshed=make(),fresh=await acquire(refreshed.handler,ensemble.recording);
 assert.equal(fresh.statusCode,200);assert.ok(refreshed.calls.includes('/song/detail'));
 assert.equal(refreshed.calls.includes('/search'),false);assert.equal(fresh.body.recordingBinding.sourceHash,initial.body.recordingBinding.sourceHash);
 const saved=[...values.values()].find(value=>value.response&&value.candidate);
 assert.equal(saved.candidate.providerAlbumID,'513369');
 saved.candidate.artistAliasEvidence.source.artistIDs=['122456'];
 const drift=make(),recovered=await acquire(drift.handler,ensemble.recording,{lyric_sources_version:2});
 assert.equal(recovered.statusCode,200);assert.ok(drift.calls.length>0);
 await Promise.all(pending);
});
