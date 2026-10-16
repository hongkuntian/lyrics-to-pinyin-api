import test from 'node:test';
import assert from 'node:assert/strict';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

const request={catalog_id:'1443711905',storefront:'us',title:'因為愛情',artist:'Eason Chan & Faye Wong',album:'Stranger Under My Skin',duration:216.893};
// Captured provider metadata; words are original fixtures, not commercial lyrics.
const record={id:3029979,trackName:'因為愛情',artistName:'陳奕迅 + 王菲',albumName:request.album,duration:218,
  syncedLyrics:'[00:12]一起听这首歌\n[00:18]慢慢唱给你听'};
const english={kind:'song',trackId:1443711905,trackName:'Because of Love',artistName:request.artist,collectionName:request.album,trackTimeMillis:216893};
const native={...english,trackName:request.title,artistName:'陳奕迅 & 王菲'};
const context={catalog_id:request.catalog_id,album:request.album,duration:request.duration};
const catalog=async url=>({ok:true,json:async()=>({results:[new URL(url).searchParams.get('country')==='us'?english:native]})});
const ok=data=>({ok:true,json:async()=>data});

test('LRCLIB canonicalizes spaced plus credits only when every requested contributor matches',async()=>{
  let calls=0;
  const fetchFn=async()=>{calls++;return ok(record);};
  const song=await new LRCAPI().searchSong(native.artistName,request.title,{...context,fetchFn});
  assert.equal(song.id,record.id);
  assert.equal(song.artist,native.artistName);
  assert.equal(calls,1);
  assert.equal(song.duration,record.duration);
  assert.equal(song.lyricsData.lines.length,2);
});

test('plus credit recovery cannot remove guests, reinterpret solo names, or change recordings',async()=>{
  for(const change of [{artistName:'陳奕迅 + Other'},{artistName:'陳奕迅 + 王菲 + Guest'},
    {artistName:'陳奕迅'},{artistName:'陳奕迅+王菲'},{trackName:'因為愛情 (Live)'},{duration:230}]) {
    const fetchFn=async url=>ok(new URL(url).pathname==='/api/get'?{...record,...change}:[{...record,...change}]);
    await assert.rejects(()=>new LRCAPI().searchSong(native.artistName,request.title,{...context,fetchFn}),{code:'recording_mismatch'});
  }
  // A plus inside a complete stage/band name stays an indivisible name.
  const band={...record,artistName:'Florence + The Machine'};
  const song=await new LRCAPI().searchSong(band.artistName,band.trackName,{...context,fetchFn:async()=>ok(band)});
  assert.equal(song.artist,band.artistName);
  for(const artist of ['陳奕迅','王菲','陳奕迅 & 王菲 & Guest']) {
    await assert.rejects(()=>new LRCAPI().searchSong(artist,request.title,{...context,
      fetchFn:async url=>ok(new URL(url).pathname==='/api/get'?record:[record])}),{code:'recording_mismatch'});
  }
});

test('plus formatting cannot break a tie between conflicting provider timelines',async()=>{
  const conflicting={...record,id:30229870,syncedLyrics:'[00:14]一起听这首歌\n[00:20]慢慢唱给你听'};
  const fetchFn=async url=>new URL(url).pathname==='/api/get'?{ok:false,status:404}:ok([record,conflicting]);
  await assert.rejects(()=>new LRCAPI().searchSong(native.artistName,request.title,{...context,fetchFn}),
    {code:'recording_mismatch',reason:'duplicate_candidates'});
});

test('mixed catalog labels prioritize a complete verified localization without losing the canonical search',async()=>{
  const aliases=await resolveCatalogAliases(request,{fetchFn:catalog,appleCatalog:null});
  assert.deepEqual(aliases.resolution.searches[0],{catalog_id:request.catalog_id,title:request.title,artist:native.artistName,album:request.album,duration:request.duration});
  assert.ok(aliases.resolution.searches.slice(0,4).some(s=>s.title===english.trackName&&s.artist===english.artistName));
  for(const change of [{artist:'Eason Chan'},{artist:'Eason Chan & Guest'},{duration:230},{album:'Other'},{title:request.title+' (Live)'}]) {
    assert.deepEqual(await resolveCatalogAliases({...request,...change},{fetchFn:catalog,appleCatalog:null}),[]);
  }
});

test('reported mixed-language duet reaches timed lyrics with proof accepted by the existing native client',async()=>{
  const api=new LRCAPI(),queries=[];
  const search=api.searchSong.bind(api);
  api.searchSong=(artist,title,context)=>{
    queries.push({artist,title});
    return search(artist,title,{...context,fetchFn:async url=>ok(new URL(url).pathname==='/api/get'?record:[record])});
  };
  const handler=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[api],
    resolveCatalogAliasesFn:(r,c)=>resolveCatalogAliases(r,{...c,fetchFn:catalog,appleCatalog:null}),
    lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
    logger:{info(){},error(){}}});
  const res=createMockRes();await handler(createMockReq({body:request}),res);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.quality.synced,true);
  assert.equal(res.body.lines.length,2);
  assert.equal(res.body.song.artist.original,native.artistName);
  assert.deepEqual(queries,[{artist:native.artistName,title:request.title}]);
  assert.deepEqual(res.body.metadata.recording_match,{method:'catalog_alias',catalog_id:request.catalog_id,
    artist:request.artist,title:request.title,duration:request.duration});
});
