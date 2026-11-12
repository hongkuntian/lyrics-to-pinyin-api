import test from 'node:test';
import assert from 'node:assert/strict';
import {createMusicRomanizeService} from '../../api/music-romanize.js';
import {findRecording} from '../../api/utils/recording-match.js';
import {createMockReq,createMockRes} from '../helpers/mock-http.js';

for(const policy of ['legacy','spotify'])test(`${policy} lookup logs bounded match explanations without changing its public error`,async()=>{
 const events=[],sources=[{id:'42',title:'Private Different Song',artist:'Singer',album:'Album',duration:188,lyricsData:{lines:[{text:'Private lyric'}]}}];
 const api={name:'LRCAPI',searchSong:async(artist,title,context)=>findRecording(sources,{...context,artist,title})};
 const service=createMusicRomanizeService({redis:null,getAvailableAPIsFn:()=>[api],detectLanguageFn:async()=> 'en',speculativeDiscovery:false,
  resolveCatalogAliasesFn:async()=>[],lookupReviewedRecordingFn:async()=>null,lookupListeningReviewedRecordingFn:async()=>null,lookupOfficialTranscriptionFn:async()=>null,
  logger:{info:(event,details)=>events.push({event,details}),error(){}}});
 const body=policy==='legacy'?{artist:'Singer',title:'Song',duration:188}:{recording:{version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'Song',artists:['Singer'],duration_ms:188000}}};
 const response=createMockRes();await service(createMockReq({body}),response);
 assert.equal(response.statusCode,409);
 assert.equal(response.body.code,'recording_mismatch');
 assert.doesNotMatch(JSON.stringify(response.body),/matchDiagnostics|totalCandidates|title_conflict|Private/);
 const lookup=events.find(entry=>entry.event===(policy==='legacy'?'lyrics_lookup':'spotify_lyrics_lookup')&&entry.details.match);
 assert.ok(lookup,JSON.stringify(events));
 assert.match(lookup.details.requestID,/^[a-f0-9-]{36}$/);
 assert.equal(lookup.details.match.version,1);
 assert.equal(lookup.details.match.candidates[0].sourceID,'42');
 assert.equal(lookup.details.match.candidates[0].reason,'title_conflict');
 assert.doesNotMatch(JSON.stringify(lookup),/Private|"(?:artist|title|lyricsData)"/);
});
