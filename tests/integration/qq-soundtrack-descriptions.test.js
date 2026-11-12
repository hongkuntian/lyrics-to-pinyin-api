import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {QQMusicAPI} from '../../api/music-apis/qq.js';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
import {summarizeResponse} from '../../scripts/benchmark-catalog-word-timing.mjs';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

const encrypted=JSON.parse(readFileSync(new URL('../fixtures/qrc-codec-fixtures.json',import.meta.url)));
const metadata={catalog_id:'123',storefront:'us',artist:'Localized Singer',title:'Synthetic [From "Example Film"]',album:'Example [From "Example Film"] - Single',duration:120};
function fixture(changes={}) {
 const calls=[],api=new QQMusicAPI();
 const source={songid:123,songmid:'00000000000123',songname:'Synthetic',albumid:2,albummid:'00000000000002',albumname:'Example',interval:120,singer:[{id:1,mid:'00000000000001',name:'Test'}],...changes};
 const fetchFn=async(url,init={})=>{
  const target=new URL(url),payload=init.body?JSON.parse(init.body):null;calls.push(target.pathname);
  let data;
  if(!payload)data=target.pathname.endsWith('smartbox_new.fcg')
   ?{code:0,data:{song:{count:1,itemlist:[{id:'123',docid:'123',mid:source.songmid,name:source.songname,singer:source.singer.map(singer=>singer.name).join('/')}]}}}
   :{code:0,data:{song:{list:[source]}}};
  else {
   data={code:0};
   for(const [key,entry] of Object.entries(payload)) {
    if(key==='comm')continue;
    data[key]=entry.method==='get_song_detail_yqq'
     ?{code:0,data:{track_info:{id:123,mid:source.songmid,name:source.songname,title:source.songname,subtitle:'',interval:source.interval,album:{id:2,mid:source.albummid,name:source.albumname},singer:source.singer}}}
     :{code:0,data:{songID:entry.param.songId,songName:'Synthetic',singerName:'Test',qrc:entry.param.qrc,crypt:1,lyric:entry.param.qrc?encrypted.providerQRC:encrypted.providerLRC}};
   }
  }
  return {ok:true,status:200,url,headers:new Map(),json:async()=>data};
 };
 for(const name of ['searchSong','getLyrics','getRecording']) {
  const original=api[name].bind(api);
  api[name]=(...args)=>{const index=args.length-1;args[index]={...args[index],fetchFn};return original(...args);};
 }
 const aliases=(request,context)=>resolveCatalogAliases(request,{...context,appleCatalog:null,fetchFn:async url=>{
  const artistName=new URL(url).searchParams.get('country')==='us'?metadata.artist:'Test';
  return {ok:true,json:async()=>({results:[{kind:'song',trackId:123,artistName,trackName:metadata.title,collectionName:metadata.album,trackTimeMillis:120000}]})};
 }});
 const service=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[api],resolveCatalogAliasesFn:aliases,speculativeDiscovery:false,
  lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  getProcessorFn:()=>({romanize:async text=>({romanized:text})}),logger:{error(){},info(){},log(){}}});
 return {calls,acquire:async()=>{
  const response=createMockRes();await service(createMockReq({body:{...metadata,options:{refresh:true,lyric_sources_version:2}}}),response);return response;
 }};
}
test('Apple same-ID localization and QQ discovery deliver measured words despite bracketed soundtrack descriptions',async()=>{
 const setup=fixture(),response=await setup.acquire();
 assert.equal(response.statusCode,200,JSON.stringify(response.body));
 const summary=summarizeResponse(response.body,metadata);
 assert.equal(summary.completeMeasured,true,JSON.stringify(summary));
 assert.equal(summary.source.itemID,'123');
 assert.equal(summary.source.timing,'qq:123:qrc');
 assert.ok(summary.cues>0);
 assert.equal(response.body.metadata.catalog_resolution.canonical_recording_id,'apple:123');
 assert.equal(response.body.metadata.catalog_resolution.accepted_request.title,metadata.title);
 assert.ok(setup.calls.some(path=>path.endsWith('smartbox_new.fcg')));
});
test('bracketed soundtrack discovery still rejects other performers, guests, versions and durations',async()=>{
 for(const change of [{singer:[{id:9,mid:'00000000000009',name:'Other Singer'}]},{singer:[{id:1,mid:'00000000000001',name:'Test'},{id:9,mid:'00000000000009',name:'Guest'}]},{songname:'Synthetic (Live)'},{interval:127}]) {
  const response=await fixture(change).acquire();
  assert.equal(response.statusCode,409,JSON.stringify({change,body:response.body}));
  assert.equal(response.body.code,'recording_mismatch');
 }
});
