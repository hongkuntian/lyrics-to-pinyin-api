import test from 'node:test';
import assert from 'node:assert/strict';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
import {recordingScore} from '../../api/utils/recording-match.js';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

// Reported provider metadata; the words below are original regression fixtures.
const recording={artist:'Sho Oosawa',title:'Butter-Fly (デジモンアドベンチャー)',
 album:'JAPAN ANIMESONG COLLECTION VOL.7 [アニソン・ジャパン]',duration:257.95};
const source={id:9684459,title:'Butter-Fly (デジモンアドベンチャー全話OP)',artist:recording.artist,
 album:'熱烈!アニソン魂 THE BEST カバー楽曲集 TVアニメシリーズ「デジモンシリーズ」 vol.1',duration:257};
const plain={id:10923290,trackName:recording.title,artistName:recording.artist,albumName:recording.album,duration:258,
 plainLyrics:'Koko wa tesuto no uta\nAshita mo issho ni utaou'};
const native={id:source.id,trackName:source.title,artistName:source.artist,albumName:source.album,duration:source.duration,
 syncedLyrics:'[00:17.03]ここはテストの歌\n[03:45.00]明日も一緒に歌おう'};
const spotify={...recording,recordingProvider:'spotify',creditedArtistNames:[recording.artist]};

for(const target of [recording,spotify])test(`${target.recordingProvider??'apple'} matches the same Japanese work with a full-series opening label`,()=>{
 assert.ok(recordingScore(source,target)>=0);
 for(const changed of [
  {title:'Butter-Fly (デジモンアドベンチャー02全話OP)'},
  {title:'Butter-Fly (デジモンアドベンチャー全話ED)'},
  {title:'Butter-Fly (デジモンアドベンチャーOP2)'},
  {title:'Butter-Fly (デジモンアドベンチャー全話OP TVサイズ)'},
  {title:'Butter-Fly (デジモンアドベンチャー全話OP) (Live)'},
  {title:'Butter-Fly (デジモンアドベンチャー全話OP) (feat. Guest)'},
  {title:'Butter-Fly'}, {artist:'Other singer'}, {duration:90},
  {album:'Collection (Live)'}
 ])assert.equal(recordingScore({...source,...changed},target),-1,JSON.stringify(changed));
});

for(const platform of ['apple','spotify'])for(const available of [true,false])test(`${platform} discovers Japanese theme words behind a romanized exact match; available=${available}`,async()=>{
 const urls=[],api=new LRCAPI(),search=api.searchSong.bind(api);
 api.searchSong=(artist,title,context)=>search(artist,title,{...context,fetchFn:async url=>{
  const parsed=new URL(url);urls.push(parsed);
  if(parsed.pathname.endsWith('/get'))return {ok:true,json:async()=>plain};
  if(parsed.searchParams.get('artist_name')===recording.artist&&parsed.searchParams.get('track_name')==='Butter-Fly') {
   if(!available)throw new Error('offline');
   return {ok:true,json:async()=>[plain,native]};
  }
  return {ok:true,json:async()=>[plain]};
 }});
 const service=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[api],speculativeDiscovery:false,
  resolveCatalogAliasesFn:async()=>[],lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  getProcessorFn:()=>({romanize:async text=>({romanized:text})}),logger:{info(){},error(){}}});
 const body=platform==='apple'?recording:{recording:{version:2,provider:'spotify',item_id:'7dIi9GxNOaCJ75ZDLIQo70',
  metadata:{origin:'spotify',title:recording.title,artists:[recording.artist],album:recording.album,duration_ms:257950}}};
 const response=createMockRes();await service(createMockReq({body}),response);
 assert.equal(response.statusCode,200,JSON.stringify(response.body));
 assert.ok(urls.some(url=>url.searchParams.get('artist_name')===recording.artist&&url.searchParams.get('track_name')==='Butter-Fly'));
 assert.equal(String(response.body.song.id),String(available?native.id:plain.id));
 assert.equal(response.body.lines[0].original,available?'ここはテストの歌':'Koko wa tesuto no uta');
 assert.equal(response.body.quality.synced,available);
 assert.equal(response.body.song.title.original,available?source.title:recording.title);
 if(platform==='spotify') {
  assert.equal(response.body.recordingBinding.itemID,'7dIi9GxNOaCJ75ZDLIQo70');
  const doc=makeDocument(body.recording,response.body,SELECTION_REVISION);
  const reopened=publicDocument(JSON.parse(JSON.stringify(doc)),body.recording);
  assert.equal(reopened.recordingBinding.itemID,body.recording.item_id);
  assert.equal(reopened.recordingBinding.source.itemID,String(available?native.id:plain.id));
  assert.deepEqual(reopened.response.lines,response.body.lines);
 }
});

test('Japanese theme expansion stops on rate limiting and preserves its admitted words',async()=>{
 const urls=[],api=new LRCAPI();
 const song=await api.searchSong(recording.artist,recording.title,{...recording,fetchFn:async url=>{
  const u=new URL(url);urls.push(u);
  if(u.searchParams.get('track_name')==='Butter-Fly')return {ok:false,status:429,headers:new Headers({'retry-after':'30'})};
  return {ok:true,json:async()=>u.pathname.endsWith('/get')?plain:[plain]};
 }});
 assert.equal(song.id,plain.id);assert.equal(urls.length,3);
});
