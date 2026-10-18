// Invented complete source sheets. No provider lyrics, account data or network.
import assert from 'node:assert/strict';
import {parseKRC} from '../../api/utils/kugou-krc.js';
import {parseQRC} from '../../api/utils/qq-qrc.js';
import {yrcService,appleRequest,spotifyRequest} from './netease-yrc.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {SELECTION_REVISION} from '../../api/music-romanize.js';

export const syntheticKRC='[10000,2000]<0,0,0>!<0,500,0>你 <750,500,0>😀<1250,750,0>e\u0301\n[60000,2000]<0,1000,0>Synthetic <1000,1000,0>sky\n[120000,2000]Line without word cues';
export const syntheticQRC='<?xml version="1.0" encoding="utf-8"?><QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="[10000,2000]!(10000,0)你 (10000,500)😀(10750,500)e\u0301(11250,750)\n[60000,2000]Synthetic (60000,1000)sky(61000,1000)\n[120000,2000]Line without word cues"/></LyricInfo></QrcInfos>';
export function measuredService(source,extra={}) {
 const lyrics=(source==='kugou'?parseKRC:parseQRC)(source==='kugou'?syntheticKRC:syntheticQRC,{songId:'42',duration:240,...(source==='qq'?{durationResolution:1}:{})});
 assert.ok(lyrics);
 const api={name:source==='kugou'?'KugouAPI':'QQMusicAPI',supportsVocalTiming:true,
  searchSong:async()=>({id:'42',source,title:appleRequest.title,artist:appleRequest.artist,creditedArtistNames:[appleRequest.artist],album:appleRequest.album,duration:240}),
  getLyrics:async()=>structuredClone(lyrics)};
 return {...yrcService({getAvailableAPIsFn:()=>[api],getMusicAPIFn:()=>api,speculativeDiscovery:false,...extra}),measuredAPI:api};
}
export async function measuredContract(source,provider) {
 const request={...(provider==='spotify'?{recording:spotifyRequest}:appleRequest),options:{lyric_sources_version:2}},f=measuredService(source),r=await f.call(request);
 assert.equal(r.statusCode,200,JSON.stringify(r.body));
 const response=r.body;response.metadata.timestamp='2026-10-18T00:00:00.000Z';delete response.metadata.processing_time;
 const recording=provider==='spotify'?spotifyRequest:appleRequest,doc=makeDocument(recording,response,SELECTION_REVISION);
 return {kind:'synthetic parser -> production acquisition -> durable publicDocument pipeline',request,
  acquisitionResponse:response,libraryResponse:{version:1,state:'ready',document:publicDocument(doc,recording)}};
}
