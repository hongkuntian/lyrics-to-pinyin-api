import test from 'node:test';
import assert from 'node:assert/strict';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
import {createArtistDiscoveryResolver} from '../../api/utils/artist-discovery.js';
import {createMusicRomanizeService,SELECTION_REVISION} from '../../api/music-romanize.js';
import {lyricLoader,createSongLibraryHandler} from '../../api/song-library.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';
import {libraryDB} from '../helpers/library-db.js';
import {buildArtistIdentityEvidence} from '../../api/utils/artist-alias-recovery.js';
import {verifySpotifyBinding,sourceCapsule,spotifyMatchEvidence} from '../../api/utils/song-library/spotify-recording.js';
import {recording,source,discoveryFixture} from '../helpers/artist-discovery.js';

function fixture({sources=[source],nativeSearchStatus=200,discoveryOptions={},resolveDiscovery,redis=null,disk=new Map(),otherAPIs=[]}={}) {
 const f=discoveryFixture(),calls=[],writes=[],api=new LRCAPI();
 const baseline={...source,id:21884097,artistName:'Kimberley Chen',syncedLyrics:null,plainLyrics:'一起听风唱歌\n慢慢走向海边\n今天依然陪着你'};
 const fetchFn=async url=>{
  const u=new URL(url);calls.push(u);
  if(u.pathname.endsWith('/search')&&u.searchParams.get('artist_name')==='陳芳語'&&nativeSearchStatus!==200)return new Response('{}',{status:nativeSearchStatus});
  const rows=u.searchParams.get('artist_name')==='陳芳語'?sources:[baseline];
  return new Response(JSON.stringify(u.pathname.endsWith('/search')?rows:rows[0]),{status:rows.length?200:404});
 };
 for(const name of ['searchSong','getRecording','getLyrics']){
  const original=api[name].bind(api);
  api[name]=(...args)=>{const at=name==='searchSong'?2:1;args[at]={...args[at],fetchFn};return original(...args);};
 }
 const service=createMusicRomanizeService({redis,getAvailableAPIsFn:()=>[api,...otherAPIs],resolveArtistIdentitiesFn:async()=>[],
  resolveArtistDiscoveryFn:resolveDiscovery??createArtistDiscoveryResolver({fetchFn:f.fetchFn,rateGate:async()=>{},appleCatalog:null,...discoveryOptions}),
  logger:{info(){},error(){}},getCachedFn:async(_,key)=>disk.get(key),setCachedFn:async(_,key,value)=>disk.set(key,structuredClone(value)),
  getContextFn:async()=>null,setContextFn:async()=>{},waitUntilFn:work=>writes.push(work)});
 return {service,calls,identityCalls:f.calls,writes,disk};
}
async function call(service,options={refresh:true,lyric_sources_version:2}) {
 const res=createMockRes();await service(createMockReq({body:{recording,options}}),res);return res;
}
test('the reported original-album Spotify recording discovers timed LRCLIB lyrics through exact artist URLs',async()=>{
 const f=fixture(),res=await call(f.service);
 assert.equal(res.statusCode,200);assert.equal(res.body.song.id,source.id);assert.equal(res.body.song.artist.original,'陳芳語');
 assert.equal(res.body.quality.synced,true);assert.equal(res.body.recordingBinding.itemID,recording.item_id);
 assert.equal(res.body.recordingBinding.source.provider,'lrclib');assert.equal(res.body.metadata.catalog_resolution,undefined);
 assert.equal(f.identityCalls.length,3);assert.ok(f.calls.some(u=>u.searchParams.get('artist_name')==='陳芳語'));
 assert.deepEqual(spotifyMatchEvidence(res.body).artistAliasEvidence.request.artists,['Kimberley Chen']);
 verifySpotifyBinding(res.body.recordingBinding,recording,sourceCapsule(res.body),SELECTION_REVISION,res.body);
});
test('source-bound aliases survive real library acquisition, immutable save and reopen',async t=>{
 const {db,store}=await libraryDB();t.after(()=>db.close());const f=fixture();
 const handler=createSongLibraryHandler({store,loadLyrics:lyricLoader(f.service),authStore:{authenticate:async()=>({id:'reader-a'}),limit:async()=>{}},logger:{info(){},error(){}}});
 const request=async body=>{const res=createMockRes();await handler(createMockReq({body,headers:{authorization:'Bearer lyra_s_fixture'}}),res);return res;};
 const first=await request({action:'lyrics',recording,refresh:true});assert.equal(first.statusCode,200);const doc=first.body.document;
 assert.equal(doc.response.song.id,source.id);assert.equal(doc.response.quality.synced,true);
 const reopened=await request({action:'lyrics',recording});assert.equal(reopened.statusCode,200);assert.equal(reopened.body.document.id,doc.id);
 assert.deepEqual(reopened.body.document.response.lines,doc.response.lines);assert.equal(Number((await store.usage()).jobs),0);
 verifySpotifyBinding(doc.recordingBinding,recording,sourceCapsule(doc.response),SELECTION_REVISION,doc.response,{durable:true});
});
test('covers, extra contributors, alternate editions, durations and conflicting sheets cannot replace the readable baseline',async()=>{
 for(const sources of [
  [{...source,artistName:'Other Singer'}],
  [{...source,artistName:'陳芳語 & Guest'}],
  [{...source,trackName:'愛你 - Ai Ni'}],
  [{...source,trackName:'愛你 (10th anniversary Version)'}],
  [{...source,albumName:'Other Album'}],
  [{...source,duration:211}],
  [source,{...source,id:9994728,syncedLyrics:source.syncedLyrics.replace('06.88','01.00')}],
 ]){
  const res=await call(fixture({sources}).service);assert.equal(res.statusCode,200);assert.equal(res.body.song.id,21884097);
  assert.equal(res.body.quality.synced,false);
 }
});
test('identity outages keep the readable independent source and never claim that word timing is absent',async()=>{
 const f=fixture({resolveDiscovery:async()=>{throw new Error('upstream unavailable');}}),res=await call(f.service);
 assert.equal(res.statusCode,200);assert.equal(res.body.song.id,21884097);assert.equal(res.body.quality.synced,false);
 assert.equal(f.calls.some(u=>u.searchParams.get('artist_name')==='陳芳語'),false);
});
test('an unavailable alias candidate list cannot let a single exact-lookup sheet conceal an unresolved duplicate',async()=>{
 const res=await call(fixture({nativeSearchStatus:429}).service);
 assert.equal(res.statusCode,200);assert.equal(res.body.song.id,21884097);assert.equal(res.body.quality.synced,false);
});
test('native-name continuation does not replace QQ or NetEase admission with unverified labels',async()=>{
 const seen=[];
 const otherAPIs=['QQMusicAPI','NeteaseAPI'].map(name=>({name,supportsVocalTiming:true,searchSong:async(artist,title,context)=>{
  seen.push({artist,title,context});return context.artistSearchNames?{id:'123',source:name==='QQMusicAPI'?'qq':'netease',title,artist:'陳芳語',album:recording.metadata.album,duration:207.84,creditedArtistNames:['陳芳語']}:null;
 },getLyrics:async()=>assert.fail('unverified contributor labels cannot authorize a lyric download')}));
 const res=await call(fixture({sources:[],otherAPIs}).service);assert.equal(res.statusCode,200);assert.equal(res.body.song.id,21884097);
 for(const s of seen.filter(s=>s.context.artistSearchNames)){
  assert.equal(s.artist,'Kimberley Chen');assert.deepEqual(s.context.creditedArtistNames,['Kimberley Chen']);assert.deepEqual(s.context.artistSearchNames,['陳芳語']);
 }
 assert.equal(seen.filter(s=>s.context.artistSearchNames).length,2);
});
test('native continuation can upgrade synthetic QQ words only with a verified entity MID and matching fresh source credits',async()=>{
 const f=discoveryFixture();f.entity.claims.P10410=[{rank:'normal',mainsnak:{snaktype:'value',datavalue:{value:'001123456789AB'}}}];
 const qq={name:'QQMusicAPI',supportsVocalTiming:true,searchSong:async(_artist,title,context)=>{
  if(!context.artistSearchNames)return null;
  const song={source:'qq',id:'123',title,artist:'陳芳語',album:context.album,duration:context.duration,creditedArtistNames:['陳芳語'],creditedArtistIDs:['8321'],creditedArtistMIDs:['001123456789AB']};
  const evidence=buildArtistIdentityEvidence(song,[{id:'8321',mid:'001123456789AB',name:'陳芳語'}],{...context,title,artist:'Kimberley Chen'},new Map([['8321',['陳芳語']]]),await context.resolveArtistIdentities());
  assert.ok(evidence);return {...song,artistAliasEvidence:evidence};
 },getLyrics:async()=>({source:'qq',songId:'123',timingSource:{source:'qq:123:qrc',revision:'a'.repeat(64)},lines:new LRCAPI().parseSyncedLyrics(source.syncedLyrics).map(l=>({...l,vocalTiming:{end:l.timestamp+1,segments:[{text:l.text,utf16Start:0,utf16Length:l.text.length,start:l.timestamp,end:l.timestamp+1}]}}))})};
 const res=await call(fixture({sources:[],otherAPIs:[qq],discoveryOptions:{fetchFn:f.fetchFn}}).service);
 assert.equal(res.statusCode,200);assert.equal(String(res.body.song.id),'123');assert.ok(res.body.lines.every(l=>l.vocalTiming));
 assert.equal(res.body.recordingBinding.source.provider,'qq');assert.equal(res.body.recordingBinding.itemID,recording.item_id);
});
test('Redis restoration validates alias evidence and rejects source or snapshot tampering',async()=>{
 const disk=new Map(),f=fixture({redis:{},disk});
 const first=await call(f.service,{lyric_sources_version:2});await Promise.all(f.writes);assert.equal(first.body.song.id,source.id);
 const restored=fixture({redis:{},disk}),hit=await call(restored.service,{lyric_sources_version:2});assert.equal(hit.body.song.id,source.id);assert.equal(restored.calls.length,0);
 const key=[...disk.keys()].find(k=>k.startsWith('spotify:lyrics:'));const saved=structuredClone(disk.get(key));
 for(const mutate of [v=>v.candidate.artistAliasEvidence.discovery.identities[0].names.push('Other Singer'),v=>v.candidate.id=999,v=>v.candidate.artist='Other Singer']){
  const corrupt=structuredClone(saved);mutate(corrupt);disk.set(key,corrupt);
  const checked=fixture({redis:{},disk}),res=await call(checked.service,{lyric_sources_version:2});assert.equal(res.body.song.id,source.id);assert.ok(checked.calls.length>0);await Promise.all(checked.writes);
 }
});
