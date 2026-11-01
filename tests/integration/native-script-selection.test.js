import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

const title='紅日 - 電視劇「他來自天堂」主題曲';
const romanized=[{text:'Meng wan jau shuin thin bou lau lei',timestamp:20.65},{text:'Meng wan jau shuin hung hak zhiok nei',timestamp:24.83}];
const native=[{text:'这是原文测试歌词',timestamp:null},{text:'这是另一句测试歌词',timestamp:null}];
for(const platform of ['apple','spotify'])for(const available of [true,false])test(`${platform} prefers native words over timed transliteration; native available=${available}`,async()=>{
 const searched=[];
 const providers=[{name:'LRCAPI',searchSong:async()=>{searched.push('lrclib');return {id:9217531,title,artist:'Hacken Lee',album:'紅日',duration:287};},getLyrics:async()=>({lines:romanized})},
  {name:'KugouAPI',searchSong:async()=>{searched.push('native');return available?{id:123,title,artist:'Hacken Lee',album:'紅日',duration:287}:null;},getLyrics:async()=>({lines:native})}];
 const service=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>providers,hedgeDelayMs:1,untimedGraceMs:1,providerTimeoutMs:200,
  resolveCatalogAliasesFn:async()=>[],lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  getProcessorFn:()=>({romanize:async text=>({romanized:text})}),logger:{error(){},info(){},log(){}}});
 const metadata={artist:'Hacken Lee',title,album:'紅日',duration:287};
 const body=platform==='apple'?metadata:{recording:{version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title,artists:['Hacken Lee'],album:'紅日',duration_ms:287000}}};
 const response=createMockRes();await service(createMockReq({body}),response);
 assert.equal(response.statusCode,200,JSON.stringify(response.body));
 assert.ok(searched.includes('native'));
 assert.deepEqual(response.body.lines.map(line=>line.original),(available?native:romanized).map(line=>line.text));
 assert.equal(response.body.quality.synced,!available);
});

for(const catalogID of [null,'1443394970'])test(`native bare-title discovery preserves catalog-bound screenshot identity; supplied ID=${catalogID!==null}`,async()=>{
 const metadata={artist:'Hacken Lee',title,album:'紅日',duration:287,...(catalogID?{catalog_id:catalogID}:{})};
 const catalog={kind:'song',trackId:1443394970,artistName:metadata.artist,trackName:'紅日',collectionName:metadata.album,trackTimeMillis:287173};
 const aliases=(request,context)=>resolveCatalogAliases(request,{...context,appleCatalog:null,fetchFn:async()=>({ok:true,json:async()=>({results:[catalog]})})});
 const providers=[{name:'LRCAPI',searchSong:async()=>({id:9217531,...metadata}),getLyrics:async()=>({lines:romanized})},
  {name:'KugouAPI',searchSong:async(artist,queryTitle)=>queryTitle==='紅日'?{id:123,title:'紅日',artist,album:metadata.album,duration:287}:null,getLyrics:async()=>({lines:native})}];
 const service=createMusicRomanizeService({redis:null,speculativeDiscovery:false,getAvailableAPIsFn:()=>providers,hedgeDelayMs:1,untimedGraceMs:1,providerTimeoutMs:200,
  resolveCatalogAliasesFn:aliases,lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  getProcessorFn:()=>({romanize:async text=>({romanized:text})}),logger:{error(){},info(){},log(){}}});
 const response=createMockRes();await service(createMockReq({body:metadata}),response);
 assert.equal(response.statusCode,200,JSON.stringify(response.body));
 assert.deepEqual(response.body.lines.map(line=>line.original),native.map(line=>line.text));
 assert.equal(response.body.metadata.recording_match.method,catalogID?'catalog_alias':'metadata_alias');
 assert.equal(response.body.metadata.recording_match.title,title);
 assert.equal(response.body.metadata.catalog_resolution.accepted_request.title,title);
 assert.equal(response.body.metadata.catalog_resolution.canonical_recording_id,'apple:1443394970');
});
