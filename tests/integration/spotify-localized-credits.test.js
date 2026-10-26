import test from 'node:test';
import assert from 'node:assert/strict';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {lyricLoader,createSongLibraryHandler} from '../../api/song-library.js';
import {libraryDB} from '../helpers/library-db.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {spotifySearchRequest,verifySpotifyBinding,sourceCapsule} from '../../api/utils/song-library/spotify-recording.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

// Request ID is synthetic. Provider IDs/names/aliases were observed live;
// performed words are original test fixtures.
const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',market:'US',metadata:{origin:'spotify',
  title:'因為愛情',artists:['Eason Chan','Faye Wong'],album:'Stranger Under My Skin',duration_ms:216893}};
const raw={id:64317,name:'因为爱情',artists:[{id:2116,name:'陈奕迅'},{id:9621,name:'王菲'}],
  album:{name:'Stranger Under My Skin'},duration:218277};
const profiles={2116:{id:2116,name:'陈奕迅',alias:['Eason Chan']},9621:{id:9621,name:'王菲',alias:['Faye Wong','Shirley Wong']}};
function fixture({song=raw,songs=[song],performerProfiles=profiles,changeProfile=p=>p,lyricPayload=null,lyricForID=()=> '[00:12]一起听这首歌\n[00:18]慢慢唱给你听'}={}) {
  const calls=[];
  const fetchFn=async url=>{
    const u=new URL(url);calls.push(u);
    if(u.pathname==='/artist/detail')return new Response(JSON.stringify({code:200,data:{artist:changeProfile(structuredClone(performerProfiles[u.searchParams.get('id')]))}}));
    if(u.pathname==='/lyric/new'&&lyricPayload)return new Response(JSON.stringify(lyricPayload));
    if(u.pathname==='/song/detail')return new Response(JSON.stringify({code:200,songs:[{id:song.id,name:song.name,ar:song.artists,al:song.album,dt:song.duration}]}));
    if(u.pathname==='/lyric')return new Response(JSON.stringify({code:200,lrc:{lyric:lyricForID(u.searchParams.get('id'))}}));
    return new Response(JSON.stringify({code:200,result:{songs}}));
  };
  const api=new NeteaseAPI(),search=api.searchSong.bind(api),lyrics=api.getLyrics.bind(api);
  api.searchSong=(a,t,c)=>search(a,t,{...c,fetchFn});
  api.getLyrics=(id,c)=>lyrics(id,{...c,fetchFn});
  return {api,calls,fetchFn};
}

test('Spotify English contributor names resolve only through each independent provider artist ID',async()=>{
  const {api,calls}=fixture(),target=spotifySearchRequest(recording),{artist,title,...context}=target;
  const song=await api.searchSong(artist,title,context);
  assert.equal(song.id,raw.id);
  assert.equal(song.artist,'陈奕迅 & 王菲');
  assert.deepEqual(song.creditedArtistNames,recording.metadata.artists);
  assert.equal(calls.filter(u=>u.pathname==='/artist/detail').length,2);
  await api.searchSong(artist,title,context);
  assert.equal(calls.filter(u=>u.pathname==='/artist/detail').length,2);
});

// Metadata observed from Spotify and NetEase on 2026-10-26. Only the lyrics
// below are invented; the two-second catalog duration discrepancy is real.
const qianLiRecording={version:2,provider:'spotify',item_id:'3Pjp7lBM20zYzTlRurI6B7',metadata:{origin:'spotify',
  title:'千里之外',artists:['Jay Chou','Fei Yu-ching'],album:'依然范特西',duration_ms:256372}};
const qianLiSong={id:185880,name:'千里之外',artists:[{id:6452,name:'周杰伦'},{id:2747,name:'费玉清'}],
  album:{name:'依然范特西'},duration:254373};
const qianLiProfiles={6452:{id:6452,name:'周杰伦',alias:['Jay Chou','周董']},
  2747:{id:2747,name:'费玉清',alias:['Yu-Ching Fei','张彦亭','小哥']}};
const qianLiLyrics={code:200,lrc:{lyric:'[00:12]一起听\n[00:18]慢慢唱'},
  yrc:{lyric:'[12000,2000](12000,1000,0)一起(13000,1000,0)听\n[18000,2000](18000,1000,0)慢慢(19000,1000,0)唱'}};
const qianLiFixture=options=>fixture({song:qianLiSong,performerProfiles:qianLiProfiles,lyricPayload:qianLiLyrics,...options});

test('reviewed Fei Yu-ching alias admits the exact duet through search and fresh source-ID lookup',async()=>{
  const {api,calls}=qianLiFixture(),target=spotifySearchRequest(qianLiRecording);
  const song=await api.searchSong(target.artist,target.title,target);
  assert.equal(song.id,185880);
  assert.deepEqual(song.creditedArtistNames,['Jay Chou','Fei Yu-ching']);
  assert.equal(song.artist,'周杰伦 & 费玉清');
  const {api:fresh,fetchFn}=qianLiFixture(),source=await fresh.getRecording(185880,{...target,fetchFn});
  assert.deepEqual(source.song.creditedArtistNames,['Jay Chou','Fei Yu-ching']);
  assert.ok(source.lyrics.lines.every(line=>line.vocalTiming));
  assert.equal(calls.filter(u=>u.pathname==='/artist/detail').length,2);
});

test('reviewed artist aliases require the fresh provider ID, name and anchor alias without weakening recording checks',async()=>{
  const target=spotifySearchRequest(qianLiRecording);
  for(const options of [
    {changeProfile:p=>p.id===2747?{...p,id:999}:p},
    {changeProfile:p=>p.id===2747?{...p,name:'Other Singer'}:p},
    {changeProfile:p=>p.id===2747?{...p,alias:['Other Singer']}:p},
    {song:{...qianLiSong,artists:[qianLiSong.artists[0],{id:999,name:'费玉清'}]},
      performerProfiles:{...qianLiProfiles,999:{...qianLiProfiles[2747],id:999}}},
    {song:{...qianLiSong,name:'千里之外 (Live)'}},
    {song:{...qianLiSong,duration:260000}},
    {song:{...qianLiSong,artists:[qianLiSong.artists[0]]}}
  ]) {
    const {api}=qianLiFixture(options);
    await assert.rejects(()=>api.searchSong(target.artist,target.title,target),{code:'recording_mismatch'});
  }
  const {api}=qianLiFixture();
  await assert.rejects(()=>api.searchSong(target.artist,target.title,{...target,creditedArtistNames:['Chou Jay','Fei Yu-ching']}),
    {code:'recording_mismatch'});
});

test('the reported Spotify duet keeps NetEase measured timing through acquisition, save and reopen',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());
  const {api}=qianLiFixture();
  const service=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[api],logger:{info(){},error(){}},
    resolveCatalogAliasesFn:()=>assert.fail('Spotify must not use Apple aliases')});
  const handler=createSongLibraryHandler({store,loadLyrics:lyricLoader(service),
    authStore:{authenticate:async()=>({id:'reader-a'}),limit:async()=>{}},logger:{info(){},error(){}}});
  const call=async body=>{
    const res=createMockRes();await handler(createMockReq({body,headers:{authorization:'Bearer lyra_s_fixture'}}),res);return res;
  };
  const first=await call({action:'lyrics',recording:qianLiRecording,refresh:true});
  assert.equal(first.statusCode,200);
  const doc=first.body.document,response=doc.response;
  assert.equal(response.song.id,185880);
  assert.equal(response.quality.synced,true);
  assert.deepEqual(response.lines.map(l=>l.timestamp),[12,18]);
  assert.ok(response.lines.every(l=>l.vocalTiming?.segments.length===2));
  assert.equal(doc.recordingBinding.source.provider,'netease');
  const reopened=await call({action:'lyrics',recording:qianLiRecording});
  assert.equal(reopened.statusCode,200);
  assert.equal(reopened.body.document.id,doc.id);
  assert.deepEqual(reopened.body.document.response.lines,response.lines);
  verifySpotifyBinding(reopened.body.document.recordingBinding,qianLiRecording,sourceCapsule(response),SELECTION_REVISION,response,{durable:true});
  assert.equal(Number((await store.usage()).jobs),0);
});

test('provider localization cannot drop or invent a contributor or accept wrong metadata',async()=>{
  for(const options of [
    {changeProfile:p=>({...p,id:999})},
    {changeProfile:p=>({...p,alias:['Other Artist']})},
    {changeProfile:p=>({...p,alias:['Eason Chan','Faye Wong']})},
    {song:{...raw,artists:[raw.artists[0]]}},
    {song:{...raw,artists:[...raw.artists,{id:999,name:'Guest'}]}},
    {song:{...raw,duration:240000}},
    {song:{...raw,name:raw.name+' (Live)'}},
    {song:{...raw,album:{name:'Stranger Under My Skin (Live)'}}}
  ]) {
    const {api}=fixture(options),{artist,title,...context}=spotifySearchRequest(recording);
    await assert.rejects(()=>api.searchSong(artist,title,context),{code:'recording_mismatch'});
  }
  for(const artists of [['Eason Chan'],['Eason Chan','Faye Wong','Guest'],['Eason Chan','Eason Chan']]) {
    const {api}=fixture(),{artist,title,...context}=spotifySearchRequest({...recording,metadata:{...recording.metadata,artists}});
    await assert.rejects(()=>api.searchSong(artist,title,context),{code:'recording_mismatch'});
  }
});

test('a provider-ID-bound Latin artist alias permits its unaccented catalog spelling only',async()=>{
 const target={...spotifySearchRequest(recording),artist:'Rene Liu',creditedArtistNames:['Rene Liu'],title:'後來',album:'我等你',duration:341.4};
 const song={id:254574,name:'后来',artists:[{id:8326,name:'刘若英'}],album:{name:'我等你'},duration:341400};
 for(const [alias,accepted] of [['René Liu',true],['Other Singer',false],['Ренé Liu',false]]) {
  const {api}=fixture({song,changeProfile:()=>({id:8326,name:'刘若英',alias:[alias]})});
  if(accepted)assert.equal((await api.searchSong(target.artist,target.title,target)).id,song.id);
  else await assert.rejects(()=>api.searchSong(target.artist,target.title,target),{code:'recording_mismatch'});
 }
 const {api}=fixture({song:{...song,name:'Café'},changeProfile:()=>({id:8326,name:'刘若英',alias:['René Liu']})});
 await assert.rejects(()=>api.searchSong(target.artist,'Cafe',{...target,title:'Cafe'}),{code:'recording_mismatch'});
});

test('localized Spotify acquisition remains independent through fallback, durable document and wire binding',async()=>{
  const {api}=fixture();
  const service=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[api],logger:{info(){},error(){}},
    resolveCatalogAliasesFn:()=>assert.fail('No Apple catalog lookup'),lookupReviewedRecordingFn:()=>assert.fail('No Apple reviewed recording')});
  const res=createMockRes();await service(createMockReq({body:{recording}}),res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.quality.synced,true);
  assert.equal(res.body.song.artist.original,'陈奕迅 & 王菲');
  assert.equal(res.body.metadata.catalog_resolution,undefined);
  assert.equal(res.body.metadata.recording_match,undefined);
  assert.equal(res.body.recordingBinding.match.spotifyCatalogVerified,false);
  const response=await lyricLoader(service)(recording),doc=makeDocument(recording,response,SELECTION_REVISION);
  const wire=publicDocument(doc,recording);
  assert.equal(wire.recordingBinding.documentID,doc.id);
  assert.equal(wire.sourceCapsule,undefined);
  assert.equal(doc.modelContext.artist,'陈奕迅 & 王菲');
  assert.deepEqual(doc.requestEvidence.candidate.creditedArtistNames,recording.metadata.artists);
  verifySpotifyBinding(wire.recordingBinding,recording,sourceCapsule(wire.response),SELECTION_REVISION,wire.response,{durable:true});
});

test('ambiguous NetEase timing can discover native artist names but only LRCLIB supplies the accepted text and timing',async()=>{
  const {api:netease}=fixture({songs:[raw,{...raw,id:2716607408}],
    lyricForID:id=>`[00:${id==='64317'?'12':'14'}]一起听这首歌\n[00:18]慢慢唱给你听`});
  const lrcRecord={id:35270900,trackName:'因为爱情',artistName:'陈奕迅、王菲',albumName:raw.album.name,duration:217,
    syncedLyrics:'[00:15]这是另一个来源\n[00:24]保留自己的时间'};
  const lrc=new LRCAPI(),search=lrc.searchSong.bind(lrc),queries=[];
  lrc.searchSong=(artist,title,context)=>{
    assert.equal(context.onVerifiedArtistCredits,undefined);
    queries.push(context.creditedArtistNames);
    return search(artist,title,{...context,fetchFn:async url=>new Response(JSON.stringify(
      new URL(url).pathname==='/api/get'?lrcRecord:[lrcRecord]))});
  };
  const service=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[netease,lrc],hedgeDelayMs:0,logger:{info(){},error(){}},
    resolveCatalogAliasesFn:()=>assert.fail('No Apple catalog lookup')});
  const res=createMockRes();await service(createMockReq({body:{recording}}),res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.metadata.source,'LRCAPI');
  assert.equal(res.body.song.id,35270900);
  assert.equal(res.body.song.artist.original,lrcRecord.artistName);
  assert.deepEqual(res.body.lines.map(l=>[l.original,l.timestamp]),[['这是另一个来源',15],['保留自己的时间',24]]);
  assert.deepEqual(queries,[['Eason Chan','Faye Wong'],['陈奕迅','王菲']]);
  const doc=makeDocument(recording,res.body,SELECTION_REVISION);
  assert.equal(doc.modelContext.artist,lrcRecord.artistName);
  assert.equal(doc.sourceCapsule.provider,'lrclib');
  assert.deepEqual(doc.requestEvidence.candidate.creditedArtistNames,recording.metadata.artists);
  const hit=createMockRes();await service(createMockReq({body:{recording}}),hit);
  assert.equal(hit.statusCode,200);assert.equal(queries.length,2);
});

test('authenticated library route stores and reopens localized Spotify lyrics under the original request',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());
  const {api}=fixture();
  const acquisition=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[api],logger:{info(){},error(){}}});
  const handler=createSongLibraryHandler({store,loadLyrics:lyricLoader(acquisition),
    authStore:{authenticate:async()=>({id:'reader-a'}),limit:async()=>{}},logger:{info(){},error(){}}});
  const call=async(body)=>{
    const res=createMockRes();await handler(createMockReq({body,headers:{authorization:'Bearer lyra_s_fixture'}}),res);return res;
  };
  const first=await call({action:'lyrics',recording,refresh:true});
  assert.equal(first.statusCode,200);assert.equal(first.body.state,'ready');
  assert.equal(first.body.document.response.quality.synced,true);
  assert.equal(first.body.document.response.song.artist.original,'陈奕迅 & 王菲');
  const reopened=await call({action:'lyrics',recording});
  assert.equal(reopened.statusCode,200);assert.equal(reopened.body.document.id,first.body.document.id);
  assert.equal(reopened.body.document.recordingBinding.documentID,first.body.document.id);
  assert.equal(reopened.body.document.recordingBinding.requestHash,first.body.document.recordingBinding.requestHash);
  const wrong=await call({action:'lyrics',recording:{...recording,metadata:{...recording.metadata,artists:['Eason Chan','Guest']}}});
  assert.equal(wrong.statusCode,409);assert.equal(wrong.body.code,'recording_mismatch');
  assert.equal(Number((await store.usage()).jobs),0);
});
