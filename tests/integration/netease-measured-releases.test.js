import test from 'node:test';
import assert from 'node:assert/strict';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {createMockRes} from '../helpers/mock-http.js';
import {measuredVocalCoverage} from '../../api/utils/lyric-selection.js';

// Real metadata shape from the reported recording; every lyric is invented.
const target={artist:'Chyi Chin',title:'大約在冬季',album:'时光的碎片',duration:232.827,catalog_id:'1720480778',storefront:'ca'};
const lrc='[00:10]Invented first row\n[00:30]Invented second row';
const yrc='[10120,2000](10120,2000,0)Invented first row\n[30120,2000](30120,2000,0)Invented second row';
const raw=(id,changes={})=>({id,name:'大约在冬季',artists:[{id:4813,name:'齐秦'}],album:{name:'Other compilation'},duration:232826,...changes});
const primary=raw(2113005420,{album:{name:target.album}}),measured=raw(1903585770);
const answer=data=>({ok:true,status:200,json:async()=>data});
function fixture({rows=[raw(2003283442),raw(2049464925),raw(1932449394),primary,measured],sheets={},profile={id:4813,name:'齐秦',transNames:['Chyi Chin']},...extra}={}) {
 const calls=[],api=new NeteaseAPI();
 const fetchFn=async(address,init)=>{
  const url=new URL(address),id=Number(url.searchParams.get('id'));calls.push(url);
  if(url.pathname==='/search')return answer({code:200,result:{songs:rows}});
  if(url.pathname==='/artist/detail')return answer({code:200,data:{artist:profile}});
  if(url.pathname==='/lyric/new') {
   const value=sheets[id];
   if(value instanceof Error)throw value;
   if(typeof value==='function')return value(init);
   return answer({code:200,lrc:{lyric:lrc},...(id===measured.id?{yrc:{lyric:yrc}}:{}),...value});
  }
  assert.fail('unexpected provider route '+url.pathname);
 };
 return {api,calls,context:{...target,fetchFn,...extra}};
}

for(const provider of ['apple','spotify'])test(`${provider}: exact compilation gets a complete measured release after verified performer aliases`,async()=>{
 const f=fixture(provider==='spotify'?{recordingProvider:'spotify',creditedArtistNames:[target.artist]}:{});
 const song=await f.api.searchSong(target.artist,target.title,f.context);
 assert.equal(song.id,measured.id);
 assert.equal(song.album,measured.album.name);
 const lyrics=await f.api.getLyrics(song.id,{...f.context,song});
 assert.equal(lyrics.timingSource.source,`netease:${measured.id}:yrc`);
 assert.deepEqual(lyrics.lines.map(l=>l.timestamp),[10.12,30.12]);
 assert.equal(measuredVocalCoverage({song,lyrics}).complete,true);
 assert.equal(f.calls.filter(u=>u.pathname==='/artist/detail').length,1);
 assert.equal(f.calls.filter(u=>u.pathname==='/search').length,1);
 assert.equal(new Set(f.calls.filter(u=>u.pathname==='/lyric/new').map(u=>u.searchParams.get('id'))).size,4);
});

test('a complete primary YRC does not query any companion release',async()=>{
 const f=fixture({sheets:{[primary.id]:{yrc:{lyric:yrc}}}});
 const song=await f.api.searchSong(target.artist,target.title,f.context);
 assert.equal(song.id,primary.id);
 assert.deepEqual(f.calls.filter(u=>u.pathname==='/lyric/new').map(u=>Number(u.searchParams.get('id'))),[primary.id]);
});

test('missing or invalid performer IDs cannot establish companion release identity',async()=>{
 for(const id of [0,undefined,-1,'invalid']) {
  const artists=[{id,name:'齐秦'}],f=fixture({rows:[{...primary,artists},{...measured,artists}],artist:'齐秦'});
  const song=await f.api.searchSong('齐秦',target.title,f.context);
  assert.equal(song.id,primary.id);
  assert.equal(f.calls.filter(u=>u.pathname==='/lyric/new').length,0);
 }
});

test('companion source must retain performer IDs, complete text, version and near-identical duration',async()=>{
 for(const provider of ['apple','spotify'])for(const change of [
  {artists:[{id:999,name:'齐秦'}]},
  {name:'大约在冬季 (Live)'},
  {album:{name:'Other compilation (2019 Remaster)'}},
  {duration:233327},
  {duration:308706},
  {originCoverType:2},
  {explicit:true},
  {isrc:'TWAAA0000001'}
 ]) {
  const f=fixture({rows:[{...primary,isrc:'TWAAA0000002',explicit:false},raw(measured.id,change)],
   ...(provider==='spotify'?{recordingProvider:'spotify',creditedArtistNames:[target.artist]}:{})});
  const song=await f.api.searchSong(target.artist,target.title,f.context);
  assert.equal(song.id,primary.id,JSON.stringify(change));
 }
 for(const lyric of [yrc.replace('Invented second row','Different second row'),yrc.split('\n')[0],yrc.replace('(10120,2000,0)','(10120,-1,0)')]) {
  const f=fixture({rows:[primary,measured],sheets:{[measured.id]:{yrc:{lyric}}}});
  assert.equal((await f.api.searchSong(target.artist,target.title,f.context)).id,primary.id);
 }
});

test('competing measured annotation editions remain whole without mixing their cues',async()=>{
 for(const rows of [[primary,measured,raw(1903585771)],[primary,raw(1903585771),measured]]) {
  const f=fixture({rows,sheets:{[1903585771]:{yrc:{lyric:yrc.replaceAll('10120','10220').replaceAll('30120','30220')}}}});
  const song=await f.api.searchSong(target.artist,target.title,f.context);
  assert.equal(song.id,measured.id);
  assert.deepEqual(song.lyricsData.lines.map(l=>l.timestamp),[10.12,30.12]);
 }
});

test('matching version categories cannot equate named mixes, remaster years, channels or opaque release qualifiers',async()=>{
 for(const provider of ['apple','spotify'])for(const [left,right] of [
  ['Original Mix','Extended Mix'],['Original Version','Re-recorded Version'],
  ['2011 Remaster','2015 Remaster'],['Mono','Stereo'],['Red Opaque Qualifier','Blue Opaque Qualifier'],
  ['A Cappella','Acapella'],['Speed Up','Sped Up'],['Unplugged','Acoustic']
 ])for(const delimited of [true,false]) {
  const album=delimited?`Primary (${left})`:`Primary ${left}`,other=delimited?`Other (${right})`:`Other ${right}`;
  // Bare unknown prose remains an ordinary album name; bracketed unknown
  // qualifiers and all recognized named editions require exact release text.
  if(!delimited&&left==='Red Opaque Qualifier')continue;
  const f=fixture({rows:[{...primary,album:{name:album}},{...measured,album:{name:other}}],album,
   ...(provider==='spotify'?{recordingProvider:'spotify',creditedArtistNames:[target.artist]}:{})});
  const song=await f.api.searchSong(target.artist,target.title,f.context);
  assert.equal(song.id,primary.id,`${provider}: ${album} / ${other}`);
  assert.equal(f.calls.filter(u=>u.pathname==='/lyric/new').length,0);
 }
});

test('an unavailable companion cannot discard a complete independently verified edition',async()=>{
 const f=fixture({rows:[primary,measured,raw(1903585771)],sheets:{[1903585771]:new Error('provider unavailable')}});
 const song=await f.api.searchSong(target.artist,target.title,f.context);
 assert.equal(song.id,measured.id);
});

test('a slow peer is cancelled after a complete edition arrives',async()=>{
 let aborted=false;
 const f=fixture({rows:[primary,measured,raw(1903585771)],sheets:{[1903585771]:({signal})=>new Promise((_,reject)=>{
  signal.addEventListener('abort',()=>{aborted=true;reject(Object.assign(new Error('cancelled'),{name:'AbortError'}));},{once:true});
 })}});
 assert.equal((await f.api.searchSong(target.artist,target.title,f.context)).id,measured.id);
 assert.equal(aborted,true);
});

test('unavailable measured editions preserve the exact readable source',async()=>{
 const f=fixture({rows:[primary,measured],sheets:{[measured.id]:new Error('provider unavailable')}});
 const song=await f.api.searchSong(target.artist,target.title,f.context);
 assert.equal(song.id,primary.id);
 assert.ok(song.lyricsData.lines.length);
});

test('caller cancellation during companion acquisition propagates cancellation',async()=>{
 const controller=new AbortController();let started;
 const ready=new Promise(resolve=>{started=resolve;});
 const f=fixture({rows:[primary,measured],signal:controller.signal,sheets:{[measured.id]:({signal})=>new Promise((_,reject)=>{
  signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true});started();
 })}});
 const work=f.api.searchSong(target.artist,target.title,f.context);
 await ready;controller.abort();
 await assert.rejects(work,{name:'AbortError'});
});

test('oversized companion sets are not truncated into an apparent unique measured winner',async()=>{
 const f=fixture({rows:[primary,measured,...Array.from({length:16},(_,i)=>raw(2000000000+i))]});
 const song=await f.api.searchSong(target.artist,target.title,f.context);
 assert.equal(song.id,primary.id);
 assert.equal(f.calls.filter(u=>u.pathname==='/lyric/new').length,0);
});

test('companion timeout keeps readable lyrics and parent cancellation starts no more work',async()=>{
 const f=fixture({rows:[primary,measured],sheets:{[measured.id]:({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true}))}});
 const start=Date.now(),song=await f.api.searchSong(target.artist,target.title,f.context);
 assert.equal(song.id,primary.id);
 assert.ok(Date.now()-start<3000);
 assert.ok(song.lyricsData.lines.length);
 const controller=new AbortController();controller.abort();
 const cancelled=fixture({signal:controller.signal});
 await assert.rejects(cancelled.api.searchSong(target.artist,target.title,cancelled.context),{name:'AbortError'});
 assert.equal(cancelled.calls.length,0);
});

for(const provider of ['apple','spotify'])test(`${provider}: handler publishes source-owned measured cues bound to the requested item`,async()=>{
 const f=fixture(),api=f.api,original=api.searchSong.bind(api);
 api.searchSong=(a,t,c)=>original(a,t,{...c,fetchFn:f.context.fetchFn});
 const service=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[api],speculativeDiscovery:false,
  resolveCatalogAliasesFn:async()=>[],lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  getDefaultRomanizationSystemFn:()=> 'none',logger:{info(){},error(){}}});
 const itemID='0123456789ABCDEFGHIJKL';
 const body=provider==='apple'?target:{recording:{version:2,provider:'spotify',item_id:itemID,metadata:{origin:'spotify',title:target.title,artists:[target.artist],album:target.album,duration_ms:232827}}};
 const res=createMockRes();await service({method:'POST',body},res);
 assert.equal(res.statusCode,200);
 assert.equal(String(res.body.song.id),String(measured.id));
 assert.equal(res.body.metadata.lyric_timing.source,`netease:${measured.id}:yrc`);
 assert.equal(res.body.metadata.lyric_timing.recordingID,provider==='apple'?target.catalog_id:itemID);
 assert.deepEqual(res.body.lines.map(l=>l.timestamp),[10.12,30.12]);
 assert.equal(res.body.lines.reduce((n,l)=>n+(l.vocalTiming?.segments.length??0),0),2);
});
