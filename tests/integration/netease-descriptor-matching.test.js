import test from 'node:test';
import assert from 'node:assert/strict';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {recordingScore,sameSpotifyRecordingNames} from '../../api/utils/recording-match.js';
import {createSpotifyLyricsService} from '../../api/utils/spotify-lyrics.js';
import {spotifySearchRequest} from '../../api/utils/song-library/spotify-recording.js';
import {makeDocument,requestKey} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {SELECTION_REVISION} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {syntheticYRC} from '../helpers/netease-yrc.js';
import {libraryDB} from '../helpers/library-db.js';

const descriptor='动画剧集《虚构世界：第二章》中文主题曲';
const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'合成之歌 - 《虛構世界：第二章》動畫劇集中文主題曲',artists:['Invented Singer'],album:'合成之歌 (《虛構世界：第二章》動畫劇集中文主題曲)',duration_ms:240000}};
const raw=()=>({id:42,name:'合成之歌',alias:[descriptor],duration:240000,artists:[{id:7,name:'合成歌手'}],album:{id:8,name:'合成之歌'}});
function fixture({source=raw(),aliases=['Invented Singer'],profileID=7,searchRows,words=syntheticYRC}={}){
 const calls=[],api=new NeteaseAPI();
 const fetchFn=async url=>{
  const u=new URL(url);calls.push(u.pathname);
  let data;
  if(u.pathname==='/search')data={code:200,result:{songs:searchRows??[source]}};
  else if(u.pathname==='/artist/detail')data={code:200,data:{artist:{id:profileID,name:'合成歌手',alias:aliases}}};
  else if(u.pathname==='/song/detail')data={code:200,songs:[{id:source.id,name:source.name,alia:source.alias,ar:source.artists,al:source.album,dt:source.duration,...(source.isrc?{isrc:source.isrc}:{}),...(typeof source.explicit==='boolean'?{explicit:source.explicit}:{})}]};
  else if(u.pathname==='/lyric/new')data={code:200,yrc:{lyric:typeof words==='function'?words(u.searchParams.get('id')):words}};
  else throw new Error('unexpected fixture route');
  return {ok:true,status:200,json:async()=>data};
 };
 for(const name of ['searchSong','getLyrics','getRecording']){const original=api[name].bind(api);api[name]=(...args)=>{const i=args.length-1;args[i]={...args[i],fetchFn};return original(...args);};}
 return {api,calls,source};
}
function service(f,values=new Map(),request=recording){
 const pending=[];
 const handler=createSpotifyLyricsService({redis:{},getAvailableAPIsFn:()=>[f.api],getCachedFn:async(_,key)=>values.get(key)??null,setCachedFn:async(_,key,value)=>values.set(key,structuredClone(value)),waitUntilFn:p=>pending.push(p),detectLanguageFn:async()=> 'en',getDefaultRomanizationSystemFn:()=> 'none',getProcessorFn:()=>null,logger:{info(){},error(){}}});
 return async(options={})=>{const res=createMockRes();await handler(createMockReq({body:{recording:request,options}}),res);let i=0;while(i<pending.length)await pending[i++];return res;};
}
test('actual NetEase discovery verifies source-owned descriptor and full artist alias before YRC',async()=>{
 const f=fixture(),target=spotifySearchRequest(recording),{artist,title,...context}=target;
 const song=await f.api.searchSong(artist,title,context);
 assert.equal(song.id,42);assert.equal(song.title,'合成之歌');assert.equal(song.artist,'合成歌手');assert.deepEqual(song.creditedArtistNames,['Invented Singer']);
 assert.equal(recordingScore(song,target)>=0,true);
 assert.deepEqual(f.calls,['/search','/artist/detail']);
 const fresh=await f.api.getRecording('42',target);
 assert.equal(recordingScore(fresh.song,target)>=0,true);assert.equal(fresh.lyrics.lines.filter(l=>l.vocalTiming).length,2);
 assert.deepEqual(f.calls.slice(2),['/song/detail','/lyric/new']);
});
test('descriptor evidence survives cold cache validation, durable reopen and fresh hints without changing source labels',async t=>{
 const values=new Map(),first=fixture(),acquire=service(first,values),initial=await acquire();
 assert.equal(initial.statusCode,200,JSON.stringify(initial.body));assert.equal(initial.body.metadata.source,'NeteaseAPI');assert.equal(initial.body.lines.filter(l=>l.vocalTiming).length,2);
 assert.equal(initial.body.song.title.original,'合成之歌');assert.equal(initial.body.song.artist.original,'合成歌手');
 const doc=makeDocument(recording,initial.body,SELECTION_REVISION);
 assert.ok(doc.requestEvidence.candidate.neteaseTitleEvidence);assert.equal(doc.modelContext.title,'合成之歌');assert.equal(doc.modelContext.artist,'合成歌手');
 const {db,store}=await libraryDB();t.after(()=>db.close());const owner=await store.claimLookup(doc.requestKey,SELECTION_REVISION);
 try{await store.saveDocument(doc,{lookupOwner:owner});}finally{await store.releaseLookup(doc.requestKey,SELECTION_REVISION,owner);}
 const loaded=await store.documentForRequest(requestKey(recording),SELECTION_REVISION),wire=publicDocument(loaded,recording);
 assert.deepEqual(loaded.requestEvidence.candidate.neteaseTitleEvidence,doc.requestEvidence.candidate.neteaseTitleEvidence);
 assert.equal(wire.sourceHash,doc.sourceHash);assert.deepEqual(wire.response.lines,initial.body.lines);
 const cachedFixture=fixture(),cached=await service(cachedFixture,values)();assert.equal(cached.statusCode,200);assert.equal(cached.headers['X-Lyrics-Cache'],'REDIS');assert.equal(cachedFixture.calls.length,0);
 const refreshedFixture=fixture(),refreshed=await service(refreshedFixture,values)({refresh:true});
 assert.equal(refreshed.statusCode,200);assert.equal(refreshedFixture.calls.includes('/search'),true);assert.ok(refreshedFixture.calls.includes('/song/detail'));
 assert.equal(refreshed.body.recordingBinding.sourceHash,initial.body.recordingBinding.sourceHash);
});
test('descriptor matching refuses unknown work, category, language, extra words and unproven provider fields',async()=>{
 const f=fixture(),target=spotifySearchRequest(recording),{artist,title,...context}=target;
 const song=await f.api.searchSong(artist,title,context);
 for(const title of ['合成之歌 - 《其他世界：第二章》動畫劇集中文主題曲','合成之歌 - 《虛構世界：第二章》電影中文主題曲','合成之歌 - 《虛構世界：第二章》動畫劇集英文主題曲','合成之歌 - 《虛構世界：第二章》動畫劇集中文主題曲 Live','合成之歌 - 《虛構世界 第二章》動畫劇集中文主題曲'])assert.equal(recordingScore(song,{...target,title})<0,true,title);
 for(const patch of [{source:'lrclib'},{id:43},{neteaseTitleEvidence:undefined},{neteaseTitleEvidence:{...song.neteaseTitleEvidence,sourceID:'43'}},{neteaseTitleEvidence:{...song.neteaseTitleEvidence,descriptors:['request invented alias']}}])assert.equal(sameSpotifyRecordingNames({...song,...patch},target),false);
 assert.equal(sameSpotifyRecordingNames({title:'合成之歌',artist:'Invented Singer',creditedArtistNames:['Invented Singer']},target),false);
 for(const emptyBase of ['', '---'])assert.equal(sameSpotifyRecordingNames({...song,title:emptyBase},{...target,title:'--- - 《虛構世界：第二章》動畫劇集中文主題曲'}),false);
});
test('artist identity, guests, version, duration, ISRC and explicitness remain strict before fetching words',async()=>{
 for(const options of [{profileID:999},{aliases:['Another Singer']},{source:{...raw(),artists:[{id:7,name:'合成歌手'},{id:9,name:'未列嘉宾'}]}},{source:{...raw(),name:'合成之歌 (Live)'}},{source:{...raw(),duration:245000}},{source:{...raw(),isrc:'USABC2600002',explicit:true}}]){
  const f=fixture(options),target=spotifySearchRequest({...recording,metadata:{...recording.metadata,isrc:'USABC2600001',explicit:false}});
  const {artist,title,...context}=target;
  await assert.rejects(()=>f.api.searchSong(artist,title,context),{code:'recording_mismatch'});assert.equal(f.calls.includes('/lyric/new'),false);
 }
});
test('fresh source metadata cannot borrow an old hint descriptor after drift',async()=>{
 const values=new Map();assert.equal((await service(fixture(),values)()).statusCode,200);
 const drift=fixture({source:{...raw(),alias:['动画剧集《不同世界：第二章》中文主题曲']}}),reply=await service(drift,values)({refresh:true});
 assert.equal(reply.statusCode,409);assert.ok(drift.calls.includes('/song/detail'));assert.equal(drift.calls.includes('/lyric/new'),false);
});
test('competing descriptor candidates are all verified or abstained, never truncated into a winner',async()=>{
 const target=spotifySearchRequest(recording),{artist,title,...context}=target;
 const rows=[raw(),{...raw(),id:43}];
 const differing=fixture({searchRows:rows,words:id=>id==='42'?syntheticYRC:syntheticYRC.replace('你 ','他 ')});
 await assert.rejects(()=>differing.api.searchSong(artist,title,context),{code:'recording_mismatch',reason:'duplicate_candidates'});
 assert.equal(differing.calls.filter(p=>p==='/lyric/new').length,2);
 const crowded=fixture({searchRows:[{...raw(),artists:[{id:7,name:'Invented Singer'}]},...Array.from({length:3},(_,i)=>({...raw(),id:43+i}))]});
 await assert.rejects(()=>crowded.api.searchSong(artist,title,context),{code:'recording_mismatch',reason:'duplicate_candidates'});
 assert.equal(crowded.calls.includes('/artist/detail'),false);assert.equal(crowded.calls.includes('/lyric/new'),false);
});
test('cold cache rejects borrowed provider or source-ID title evidence and reacquires current metadata',async()=>{
 for(const mutate of [c=>c.source='lrclib',c=>c.neteaseTitleEvidence.sourceID='43',c=>c.neteaseTitleEvidence.descriptors=['动画剧集《其他世界：第二章》中文主题曲']]){
  const values=new Map(),initial=await service(fixture(),values)();assert.equal(initial.statusCode,200);
  const saved=[...values.values()].find(v=>v.candidate&&v.response);assert.ok(saved);mutate(saved.candidate);
  const fresh=fixture(),reply=await service(fresh,values)();assert.equal(reply.statusCode,200);assert.ok(fresh.calls.length>0);
  assert.equal(reply.body.recordingBinding.sourceHash,initial.body.recordingBinding.sourceHash);
 }
});
test('ordinary exact-title refresh ignores unused alias drift and revisits sparse measured hints',async()=>{
 const request={...recording,metadata:{...recording.metadata,title:'合成之歌',album:'合成之歌'}},values=new Map();
 const initial=await service(fixture({source:{...raw(),alias:['Independent label A']}}),values,request)();
 assert.equal(initial.statusCode,200);
 assert.equal([...values.values()].find(v=>v.candidate)?.candidate.neteaseTitleEvidence,undefined);
 const fresh=fixture({source:{...raw(),alias:['Independent label B']}}),reply=await service(fresh,values,request)({refresh:true});
 assert.equal(reply.statusCode,200);assert.equal(fresh.calls.includes('/search'),true);
 assert.deepEqual(fresh.calls,['/song/detail','/artist/detail','/lyric/new','/search','/lyric/new']);
});
