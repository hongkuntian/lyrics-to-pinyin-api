import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {lyricLoader,createSongLibraryHandler} from '../../api/song-library.js';
import {makeDocument,requestKey} from '../../api/utils/song-library/document.js';
import {spotifyBinding,sourceCapsule,attachSpotifyMatchEvidence,verifySpotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {libraryDB} from '../helpers/library-db.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

// Captured recording/source metadata and promotional footer; authored vocal
// words retain the observed first two timestamps without claiming audio proof.
const recording={version:3,provider:'spotify',item_id:'0IWeil6nmTB1YjEksoOHvW',metadata:{origin:'spotify',
  observation:'app_remote',artists_complete:false,title:'丢了你',artists:['井朧'],album:'丢了你',duration_ms:277612}};
const song={source:'netease',id:1442508316,title:'丢了你',artist:'井胧',album:'丢了你',duration:277.612,
  creditedArtistNames:['井胧'],creditedArtistIDs:['31253654']};
const vocals=[{text:'一起听这首歌',timestamp:34.37},{text:'慢慢唱给你听',timestamp:38.2}];
const promotions=[{text:'本歌曲来自〖网易音乐人〗',timestamp:5940.006},{text:'10亿现金激励，千亿流量扶持！',timestamp:5940.019}];
function service() {
  return createMusicRomanizeService({redis:null,logger:{info(){},error(){}},resolveArtistDiscoveryFn:async()=>null,
    getAvailableAPIsFn:()=>[{name:'NeteaseAPI',supportsVocalTiming:true,searchSong:async()=>structuredClone(song),
      getLyrics:async()=>({source:'netease',songId:song.id,lines:structuredClone([...vocals,...promotions])})}]});
}

test('out-of-duration provider promotions cannot disable valid Spotify vocal line synchronization',async()=>{
  const res=createMockRes();await service()(createMockReq({body:{recording,options:{refresh:true}}}),res);
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body.lines.map(l=>[l.original,l.timestamp]),vocals.map(l=>[l.text,l.timestamp]));
  assert.equal(res.body.recordingBinding.synchronizationEligible,true);
  assert.ok(res.body.lines.every(l=>l.vocalTiming===undefined));
  verifySpotifyBinding(res.body.recordingBinding,recording,sourceCapsule(res.body),SELECTION_REVISION,res.body);
});

test('a cached ineligible document refreshes only its request and reopens with qualified original line times',async t=>{
  const {db,store}=await libraryDB();t.after(()=>db.close());
  const response={song:{id:song.id,title:{original:song.title},artist:{original:song.artist},album:song.album,
      duration:song.duration,language:'zh',romanization_system:'none'},
    lines:[...vocals,...promotions.map(l=>({...l,timestamp:null}))].map(l=>({original:l.text,romanized:l.text,timestamp:l.timestamp})),
    quality:{synced:true,partial:false,instrumental:false},metadata:{source:'NeteaseAPI',timestamp:new Date().toISOString(),selection_revision:SELECTION_REVISION}};
  attachSpotifyMatchEvidence(response,song);
  response.recordingBinding=spotifyBinding(recording,sourceCapsule(response),SELECTION_REVISION,response);
  assert.equal(response.recordingBinding.synchronizationEligible,false);
  const old=makeDocument(recording,response,SELECTION_REVISION),owner=await store.claimLookup(requestKey(recording),SELECTION_REVISION);
  await store.saveDocument(old,{lookupOwner:owner});
  await store.releaseLookup(requestKey(recording),SELECTION_REVISION,owner);
  const handler=createSongLibraryHandler({store,loadLyrics:lyricLoader(service()),
    authStore:{authenticate:async()=>({id:'reader-a'}),limit:async()=>{}},logger:{info(){},error(){}}});
  const call=async()=>{const res=createMockRes();await handler(createMockReq({body:{action:'lyrics',recording},
    headers:{authorization:'Bearer lyrica_s_fixture'}}),res);return res;};
  const fresh=await call();assert.equal(fresh.statusCode,200);
  const doc=fresh.body.document;assert.notEqual(doc.id,old.id);
  assert.equal(doc.recordingBinding.synchronizationEligible,true);
  assert.deepEqual(doc.response.lines.map(l=>l.timestamp),vocals.map(l=>l.timestamp));
  const reopened=await call();assert.equal(reopened.statusCode,200);
  assert.equal(reopened.body.document.id,doc.id);
  verifySpotifyBinding(reopened.body.document.recordingBinding,recording,sourceCapsule(doc.response),SELECTION_REVISION,doc.response,{durable:true});
  assert.equal((await store.document(old.id)).id,old.id);
  assert.equal(Number((await store.usage()).jobs),0);
});
