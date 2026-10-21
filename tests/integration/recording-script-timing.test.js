import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {resolveCatalogAliases} from '../../api/utils/catalog-aliases.js';
import {parseYRC} from '../../api/utils/netease-yrc.js';
import {spotifyRequestHash,verifySpotifyBinding,sourceCapsule} from '../../api/utils/song-library/spotify-recording.js';
import {SELECTION_REVISION} from '../../api/music-romanize.js';
import {createMockRes} from '../helpers/mock-http.js';

// Real reported metadata, original invented vocal content, no network.
const title='沒那麽簡單',artist='黃小琥',album='簡單不簡單';
const recording={version:2,provider:'spotify',item_id:'4xZIMRwaaBx7CZMmM6KLuh',market:'US',metadata:{origin:'spotify',title,artists:[artist],album,duration_ms:310133}};
const yrc='[10000,2000](10000,2000,0)Invented first row\n[30000,2000](30000,2000,0)Invented second row';
for(const platform of ['apple','spotify'])test(`${platform}: dictionary title variant reaches measured provider without rewriting request or source timing`,async()=>{
 const api=new NeteaseAPI(),queries=[];
 const fetchFn=async url=>{
  const u=new URL(url);
  if(u.pathname==='/search'){
   queries.push(u.searchParams.get('keywords'));
   return {ok:true,json:async()=>({code:200,result:{songs:[{id:239188,name:'没那么简单',artists:[{id:7896,name:'黄小琥'}],album:{name:'简单/不简单'},duration:310133}]}})};
  }
  assert.equal(u.pathname,'/lyric/new');assert.equal(u.searchParams.get('id'),'239188');
  return {ok:true,json:async()=>({code:200,yrc:{lyric:yrc}})};
 };
 const search=api.searchSong.bind(api),lyrics=api.getLyrics.bind(api);
 api.searchSong=(a,t,c)=>search(a,t,{...c,fetchFn});api.getLyrics=(id,c)=>lyrics(id,{...c,fetchFn});
 const service=createMusicRomanizeService({redis:null,speculativeDiscovery:false,getAvailableAPIsFn:()=>[api],
  resolveCatalogAliasesFn:(request,context)=>resolveCatalogAliases(request,{...context,appleCatalog:null,fetchFn:async()=>({ok:true,json:async()=>({results:[{kind:'song',trackId:540287928,trackName:'沒那麼簡單',artistName:artist,collectionName:album,trackTimeMillis:310133}]})})}),
  lookupListeningReviewedRecordingFn:async()=>null,lookupReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,logger:{info(){},error(){}}});
 const request=platform==='apple'?{catalog_id:'540287928',title,artist,album,duration:310.133,storefront:'tw'}:{recording};
 const before=structuredClone(request),res=createMockRes();
 await service({method:'POST',body:{...request,options:{lyric_sources_version:2}}},res);
 assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.deepEqual(request,before);
 assert.deepEqual(queries,['黄小琥 没那么简单']);
 assert.equal(res.body.metadata.lyric_timing.source,'netease:239188:yrc');
 assert.equal(res.body.metadata.lyric_timing.revision,parseYRC(yrc,{songId:239188,duration:310.133}).timingSource.revision);
 assert.deepEqual(res.body.lines.map(l=>l.original),['Invented first row','Invented second row']);
 assert.ok(res.body.lines.every(l=>l.vocalTiming));
 if(platform==='spotify'){
  assert.equal(res.body.recordingBinding.itemID,recording.item_id);
  assert.equal(res.body.recordingBinding.requestHash,spotifyRequestHash(recording));
  verifySpotifyBinding(res.body.recordingBinding,recording,sourceCapsule(res.body),SELECTION_REVISION,res.body);
 }else assert.equal(res.body.metadata.lyric_timing.recordingID,'540287928');
});
