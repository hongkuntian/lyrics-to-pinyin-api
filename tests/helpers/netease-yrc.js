// Invented source only; no provider lyrics or network calls.
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import assert from 'node:assert/strict';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {createMockReq,createMockRes} from './mock-http.js';
export const appleRequest={catalog_id:'123',artist:'Synthetic Singer',title:'Synthetic Song',album:'Synthetic Album',duration:240,storefront:'us'};
export const spotifyRequest={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:appleRequest.title,artists:[appleRequest.artist],album:appleRequest.album,duration_ms:240000}};
export const syntheticYRC='{"t":0,"c":[{"tx":"Synthetic credit"}]}\n[10000,2000](10000,0,0)!(10000,500,9)你 (10750,500,0)😀(11250,750,0)e\u0301\n[60000,2000](60000,1000,0)Synthetic (61000,1000,0)sky\n[120000,2000]Line without word cues';
export function catalogProof(request){return {version:'catalog-recording-1',method:'same_catalog_id',requested:{catalog_id:request.catalog_id,storefront:request.storefront??null},canonical_recording_id:'apple:123',canonical_context:{title:request.title,artist:request.artist},accepted_request:{catalog_id:request.catalog_id,artist:request.artist,title:request.title,album:request.album??null,duration:request.duration},catalog_items:[{catalog_id:'123',storefront:'us',provenance:'apple_music'},{catalog_id:'123',storefront:'ca',provenance:'apple_music'},{catalog_id:'456',storefront:'ca',provenance:'apple_music'}],searches:[{artist:request.artist,title:request.title,album:request.album,duration:request.duration}]};}
export function yrcService({yrc=syntheticYRC,resolution=true,...extra}={}){
 const urls=[],queries=[],values=new Map(),pending=[],api=new NeteaseAPI();
 api.searchSong=async(artist,title,context)=>{queries.push({artist,title,context});return {id:42,title:appleRequest.title,artist:appleRequest.artist,album:appleRequest.album,duration:240,source:'netease',creditedArtistNames:[appleRequest.artist]};};
 const getLyrics=api.getLyrics.bind(api);
 api.getLyrics=(id,context)=>getLyrics(id,{...context,fetchFn:async url=>{urls.push(url);return {ok:true,status:200,json:async()=>({code:200,lrc:{lyric:'[00:09]Old synthetic LRC\n[00:59]Different older row'},yrc:{version:17,lyric:yrc}})};}});
 const deps={redis:{},getCachedFn:async(_,key)=>values.get(key)??null,setCachedFn:async(_,key,value)=>values.set(key,structuredClone(value)),waitUntilFn:p=>pending.push(p),
  getAvailableAPIsFn:()=>[api],getMusicAPIFn:()=>api,detectLanguageFn:async()=> 'en',getDefaultRomanizationSystemFn:()=> 'none',getProcessorFn:()=>assert.fail('no processor for synthetic none'),
  lookupListeningReviewedRecordingFn:async()=>null,lookupReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  resolveCatalogAliasesFn:async request=>{const aliases=[];if(resolution)Object.defineProperty(aliases,'resolution',{value:catalogProof(request)});return aliases;},logger:{info(){},error(){}},...extra};
 const service=createMusicRomanizeService(deps);
 return {service,api,urls,queries,values,async call(body=appleRequest){const res=createMockRes();await service(createMockReq({body}),res);let i=0;while(i<pending.length)await pending[i++];return res;}};
}
