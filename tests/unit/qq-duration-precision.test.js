import test from 'node:test';
import assert from 'node:assert/strict';
import {parseQRC} from '../../api/utils/qq-qrc.js';
import {cleanLyrics} from '../../api/utils/lyric-quality.js';
import {timingQuality,hasMeasuredVocalTiming,measuredVocalCoverage} from '../../api/utils/lyric-selection.js';
import {validVocalTiming,validSourceTiming,validTimingProvenance,sourceDurationResolution,validTimingTimestamp,timingDurationLimit,attachVocalTiming} from '../../api/utils/vocal-timing.js';
import {appleTimingOrigin,appleVocalHashes} from '../../api/utils/song-library/apple-vocal-timing.js';
import {sourceCapsule,spotifyHashes,spotifyBinding} from '../../api/utils/song-library/spotify-recording.js';
import {makeDocument} from '../../api/utils/song-library/document.js';
import {publicDocument} from '../../api/utils/song-library/public-content.js';
import {findRecording} from '../../api/utils/recording-match.js';

const xml=body=>'<QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="'+body.replaceAll('&','&amp;').replaceAll('"','&quot;')+'"/></LyricInfo></QrcInfos>';
const body='[1000,1000]Synthetic opening(1000,1000)\n[225641,2493]Synthetic ending(225641,2493)';
const parse=(text=body,options={})=>parseQRC(xml(text),{songId:42,duration:228,...options});
const measured=()=>parse(body,{durationResolution:1});
const response=lyrics=>({song:{id:'42',title:{original:'Synthetic Song',romanized:'Synthetic Song'},artist:{original:'Synthetic Artist',romanized:'Synthetic Artist'},album:'Synthetic Album',duration:228,language:'en',romanization_system:'none'},
 lines:lyrics.lines.map(({text,...line})=>({original:text,romanized:text,...structuredClone(line)})),quality:{synced:true,partial:false,instrumental:false},metadata:{source:'QQMusicAPI'}});
const attach=(lyrics=measured(),provider='appleMusic')=>attachVocalTiming(response(lyrics),lyrics,{provider,recordingID:provider==='appleMusic'?'9':'A'.repeat(22),sourceID:'42'});
const candidate=lyrics=>({song:{id:'42',duration:228},lyrics});
const request={catalog_id:'9',artist:'Synthetic Artist',title:'Synthetic Song',album:'Synthetic Album',duration:229.387};

test('identical best source ties retain only source-bound QQ fractional duration authority',()=>{
 const text='[1000,500]Synthetic opening(1000,500)\n[228100,400]Synthetic ending(228100,400)';
 const songs=['42','43'].map(id=>({id,title:request.title,artist:request.artist,album:request.album,duration:228,
  lyricsData:parseQRC(xml(text),{songId:id,duration:228,durationResolution:1})}));
 assert.equal(findRecording(songs,request).id,'42');
 for(const mutate of [lyrics=>delete lyrics.durationResolution,lyrics=>lyrics.songId='999',lyrics=>{lyrics.source='kugou';lyrics.timingSource.source=`kugou:${lyrics.songId}:krc`;}]) {
  const unbound=structuredClone(songs);for(const song of unbound)mutate(song.lyricsData);
  assert.throws(()=>findRecording(unbound,request),{code:'recording_mismatch',reason:'duplicate_candidates'});
 }
 const atCeiling=structuredClone(songs);for(const song of atCeiling)song.lyricsData.lines[1].timestamp=229;
 assert.throws(()=>findRecording(atCeiling,request),{code:'recording_mismatch',reason:'duplicate_candidates'});
});

test('whole-second QQ interval admits only its explicit unreported fraction',()=>{
 assert.equal(parse(),null);
 const lyrics=measured();assert.equal(lyrics.durationResolution,1);
 assert.equal(lyrics.lines[1].timestamp,225.641);assert.equal(lyrics.lines[1].vocalTiming.end,228.134);
 assert.deepEqual(lyrics.lines[1].vocalTiming.segments,[{utf16Start:0,utf16Length:16,text:'Synthetic ending',start:225.641,end:228.134}]);
 assert.equal(validVocalTiming(lyrics.lines[1],{duration:228}),false);
 assert.equal(validVocalTiming(lyrics.lines[1],{duration:228,durationResolution:1}),true);
 for(const text of ['[228000,1000]Synthetic(228000,1000)','[229000,1]Synthetic(229000,1)','[228999,2]Synthetic(228999,2)'])assert.equal(parse(text,{durationResolution:1}),null);
 assert.ok(parse('[228000,999]Synthetic(228000,999)',{durationResolution:1}));
 assert.equal(parse('[228000,999]Synthetic(228000,1000)',{durationResolution:1}).lines[0].vocalTiming,undefined);
 assert.ok(parse('[227000,1000]Synthetic(227000,1000)'));
 assert.equal(timingDurationLimit(228,1),229);assert.equal(validTimingTimestamp(229,{duration:228,durationResolution:1}),false);
 assert.equal(validTimingTimestamp(228,{duration:228}),true);assert.equal(validTimingTimestamp(228.001,{duration:228}),false);
 for(const durationResolution of [-1,0.1,1.1,2,null,NaN,Infinity,'1'])assert.equal(parse('[1000,1000]Synthetic(1000,1000)',{durationResolution}),null);
 assert.equal(parse(body,{duration:228.5,durationResolution:1}),null);
 assert.equal(timingDurationLimit(7201,1),null);assert.equal(validTimingTimestamp(7200.1,{duration:7200,durationResolution:1}),false);
});

test('precision authority is bound to QQ QRC and explicit invalid evidence fails closed',()=>{
 const lyrics=measured();assert.equal(validSourceTiming(lyrics),true);assert.equal(sourceDurationResolution(lyrics),1);
 const p=attach().metadata.lyric_timing;assert.equal(validTimingProvenance(p),true);
 for(const durationResolution of [0,-1,0.5,2,null,'1',NaN]){
  assert.equal(validTimingProvenance({...p,durationResolution}),false);
  assert.equal(validSourceTiming({...lyrics,durationResolution}),false);
 }
 for(const [source,format] of [['netease','yrc'],['kugou','krc'],['lrclib','lrc']]){
  const changed={...lyrics,source,timingSource:{...lyrics.timingSource,source:`${source}:42:${format}`}};
  assert.equal(validSourceTiming(changed),false);assert.equal(sourceDurationResolution(changed),0);
  assert.equal(validTimingProvenance({...p,source:`${source}:42:${format}`}),false);
 }
 const unbound={...lyrics,songId:'43'};assert.equal(validSourceTiming(unbound),false);assert.equal(sourceDurationResolution(unbound),0);
 assert.equal(validSourceTiming({...lyrics,durationResolution:undefined}),true);
});

test('cleaning, coverage and line timing share verified bounds without altering source text or timestamps',()=>{
 const lyrics=measured(),before=structuredClone(lyrics),cleaned=cleanLyrics(lyrics,{duration:228});
 assert.deepEqual(cleaned.lines,before.lines);assert.deepEqual(lyrics,before);
 assert.equal(hasMeasuredVocalTiming(candidate(cleaned)),true);
 assert.deepEqual(measuredVocalCoverage(candidate(cleaned)),{covered:31,total:31,complete:true});
 const late=parse('[1000,1000]Synthetic opening(1000,1000)\n[228001,133]Synthetic ending(228001,133)',{durationResolution:1});
 assert.equal(timingQuality(candidate(late)).usable,true);
 assert.equal(cleanLyrics(late,{duration:228}).lines[1].timestamp,228.001);
 for(const unbound of [{...late,durationResolution:undefined},{...late,songId:'99'},{...late,source:'kugou'}]){
  const result=cleanLyrics(unbound,{duration:228,durationResolution:1});
  assert.equal(result.lines[1].timestamp,null);assert.equal(result.lines[1].vocalTiming,undefined);
  assert.equal(timingQuality(candidate(unbound)).usable,false);
 }
});

test('attachment preserves authoritative source duration and precision through JSON and Apple library projection',()=>{
 const lyrics=measured(),result=attach(lyrics),serialized=JSON.parse(JSON.stringify(result));
 assert.equal(result.song.duration,228);assert.deepEqual(result.lines[1].vocalTiming,lyrics.lines[1].vocalTiming);
 assert.deepEqual(serialized.metadata.lyric_timing,{version:1,provider:'appleMusic',recordingID:'9',source:'qq:42:qrc',revision:lyrics.timingSource.revision,durationResolution:1});
 assert.deepEqual(appleTimingOrigin(serialized),{source:'qq:42:qrc',revision:lyrics.timingSource.revision,durationResolution:1});
 const document=makeDocument(request,serialized,'synthetic-selection'),projected=publicDocument(document,request);
 assert.equal(projected.response.song.duration,228);assert.equal(projected.response.metadata.lyric_timing.durationResolution,1);
 assert.equal(projected.response.lines[1].vocalTiming.end,228.134);
 const missing=structuredClone(serialized);delete missing.metadata.lyric_timing.durationResolution;
 assert.throws(()=>appleTimingOrigin(missing),/invalid_vocal_timing/);
 const unrelated=structuredClone(lyrics);unrelated.source='kugou';unrelated.timingSource.source='kugou:42:krc';
 const rejected=attach(unrelated);assert.ok(rejected.lines.every(l=>!l.vocalTiming));assert.equal(rejected.metadata.lyric_timing,undefined);
});

test('precision evidence itself participates in Apple and Spotify immutable timing identities',()=>{
 const lyrics=parse('[1000,1000]Synthetic opening(1000,1000)\n[225000,1000]Synthetic ending(225000,1000)',{durationResolution:1});
 const precise=attach(lyrics),exact=structuredClone(precise);delete exact.metadata.lyric_timing.durationResolution;
 const structure={version:'source-speakers-1',speakers:[],occurrences:[]},identity={recordingKey:'synthetic-recording',textRevision:'synthetic-text'};
 const a=appleVocalHashes(precise,structure,identity),b=appleVocalHashes(exact,structure,identity);
 assert.notEqual(a.timingRevision,b.timingRevision);assert.notEqual(a.sourceHash,b.sourceHash);
 const recording={version:2,provider:'spotify',item_id:'A'.repeat(22),metadata:{origin:'spotify',title:'Synthetic Song',artists:['Synthetic Artist'],album:'Synthetic Album',duration_ms:229387}};
 const spotify=attach(lyrics,'spotify'),capsule=sourceCapsule(spotify),clone=structuredClone(capsule);delete clone.lyricTiming.durationResolution;
 const x=spotifyHashes(recording,capsule,'synthetic-selection'),y=spotifyHashes(recording,clone,'synthetic-selection');
 assert.notEqual(x.timingRevision,y.timingRevision);assert.notEqual(x.sourceHash,y.sourceHash);
 spotify.recordingBinding=spotifyBinding(recording,capsule,'synthetic-selection',spotify);
 const projected=publicDocument(makeDocument(recording,spotify,'synthetic-selection'),recording);
 assert.equal(projected.response.metadata.lyric_timing.durationResolution,1);assert.equal(projected.response.song.duration,228);
 assert.equal(projected.response.lines[1].vocalTiming.end,226);
});
