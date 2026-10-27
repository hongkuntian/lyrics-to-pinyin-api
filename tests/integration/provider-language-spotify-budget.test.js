import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpotifyLyricsService} from '../../api/utils/spotify-lyrics.js';
import {parseKRC} from '../../api/utils/kugou-krc.js';
import {kugouLanguageObservations,bindProviderLanguageObservations} from '../../api/utils/provider-language-evidence.js';
import {formatMusicResponse} from '../../api/utils/response-formatter.js';
import {sourceCapsule,verifySpotifyBinding,spotifyRecording} from '../../api/utils/song-library/spotify-recording.js';
import {LYRIC_SELECTION_REVISION} from '../../api/utils/lyric-annotations.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

const recording={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'Synthetic Song',artists:['Synthetic Artist'],album:'Synthetic Album',duration_ms:1000000}};
const song={source:'kugou',id:'42',title:recording.metadata.title,artist:recording.metadata.artists[0],album:recording.metadata.album,duration:1000};
const sheet=Array.from({length:190},(_,i)=>`[${(i*4+1)*1000},1000]<0,1000,0>Invented synthetic row ${i}`).join('\n');
const parsed=parseKRC(sheet,{songId:'42',duration:1000});assert.ok(parsed);
const observations=kugouLanguageObservations('42',{id:'42',language:'英语'},0,{observedAt:'2026-10-27T00:00:00.000Z'});
const lyrics=bindProviderLanguageObservations(parsed,song,observations,{field:'/content',format:'krc'});
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
async function acquire(padding){
 const api={name:'KugouAPI',supportsVocalTiming:true,searchSong:async()=>({...song}),getLyrics:async()=>structuredClone(lyrics)};
 const service=createSpotifyLyricsService({redis:null,getAvailableAPIsFn:()=>[api],detectLanguageFn:async()=> 'en',getDefaultRomanizationSystemFn:()=> 'none',
  formatMusicResponseFn:(...args)=>{const response=formatMusicResponse(...args);response.metadata.padding='x'.repeat(padding);return response;},logger:{info(){},error(){}}});
 const res=createMockRes();await service(createMockReq({body:{recording}}),res);assert.equal(res.statusCode,200,JSON.stringify(res.body));return res.body;
}
async function boundary(){
 const baseline=await acquire(0);assert.equal(baseline.lines.filter(l=>l.vocalTiming).length,190);
 const noEvidence=structuredClone(baseline);delete noEvidence.metadata.language_details.provider_evidence;
 const diagnosticBytes=bytes(baseline)-bytes(noEvidence),bindingBytes=bytes(baseline.recordingBinding)+20;
 const target=160000+Math.floor(diagnosticBytes/2),padding=target-bytes(baseline);
 assert.ok(padding>0);assert.ok(diagnosticBytes/2<bindingBytes,'fixture fits before binding is added');
 return {baseline,padding};
}
test('final Spotify binding cannot make optional language diagnostics evict all 190 measured rows',async()=>{
 const {baseline,padding}=await boundary(),response=await acquire(padding);
 assert.equal(response.lines.filter(l=>l.vocalTiming).length,190);
 assert.deepEqual(response.lines,baseline.lines);assert.deepEqual(response.recordingBinding,baseline.recordingBinding);
 assert.equal(response.metadata.language_details.provider_evidence,undefined);assert.ok(bytes(response)<=160000);
 assert.doesNotThrow(()=>verifySpotifyBinding(response.recordingBinding,spotifyRecording(recording),sourceCapsule(response),LYRIC_SELECTION_REVISION,response));
});
test('a genuinely oversized bound source still uses the existing readable fallback and rebuilt binding',async()=>{
 const {padding}=await boundary(),response=await acquire(padding+8192);
 assert.equal(response.lines.length,190);assert.ok(response.lines.every(l=>!l.vocalTiming));
 assert.equal(response.metadata.language_details.provider_evidence,undefined);assert.equal(response.metadata.lyric_timing,undefined);
 assert.ok(bytes(response)<=160000);
 assert.doesNotThrow(()=>verifySpotifyBinding(response.recordingBinding,spotifyRecording(recording),sourceCapsule(response),LYRIC_SELECTION_REVISION,response));
});
