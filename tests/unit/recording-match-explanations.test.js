import test from 'node:test';
import assert from 'node:assert/strict';
import {explainRecordingMatch,recordingScore,findRecording} from '../../api/utils/recording-match.js';
import {recordingTransformations} from '../helpers/recording-transformations.js';

const song={id:'1',title:'Song',artist:'Singer',album:'Album',duration:188};
test('explanations use the same admission decision and score as ordinary matching',()=>{
 for(const entry of recordingTransformations()) {
  const explanation=explainRecordingMatch(entry.song,entry.request);
  assert.equal(explanation.version,1);
  assert.equal(explanation.accepted,entry.accepted,entry.label);
  assert.equal(explanation.score,recordingScore(entry.song,entry.request),entry.label);
  assert.equal(explanation.reason===null,entry.accepted,entry.label);
 }
});
test('explanations distinguish title, contributor, version, duration and protocol conflicts',()=>{
 const request={...song,recordingProvider:'spotify',creditedArtistNames:['Singer'],isrc:'USAAA2600001',explicit:false};
 for(const [change,reason] of [[{title:'Different Song'},'title_conflict'],[{artist:'Other Singer'},'contributor_conflict'],[{title:'Song (Live)'},'version_conflict'],[{duration:192},'duration_conflict'],[{isrc:'USAAA2600002'},'isrc_conflict'],[{explicit:true},'explicit_conflict']])
  assert.equal(explainRecordingMatch({...song,...change},request).reason,reason,JSON.stringify(change));
 const explained=explainRecordingMatch(song,{...request,title:'Song [From Example Film]'});
 assert.equal(explained.policy,'spotify');
 assert.equal(explained.accepted,true);
 assert.ok(explained.rules.includes('soundtrack_description'));
});
test('explanations retain catalog-bound soft equivalence without changing its score',()=>{
 const explanation=explainRecordingMatch({...song,artist:'Last, First'},{...song,catalog_id:'123',artist:'First Last'});
 assert.equal(explanation.accepted,true);
 assert.equal(explanation.score,5.75);
 assert.ok(explanation.rules.includes('reversed_solo_artist'));
});
test('mismatch diagnostics are bounded, source identified and exclude source text and lyrics',()=>{
 const candidates=Array.from({length:20},(_,index)=>({...song,id:String(index+1),title:'Private unmatched title',lyricsData:{lines:[{text:'Private lyric'}]}}));
 assert.throws(()=>findRecording(candidates,song),error=>{
  assert.equal(error.reason,'recording_mismatch');
  assert.equal(error.matchDiagnostics.version,1);
  assert.equal(error.matchDiagnostics.totalCandidates,20);
  assert.equal(error.matchDiagnostics.candidates.length,8);
  assert.equal(error.matchDiagnostics.candidates[0].sourceID,'1');
  assert.equal(error.matchDiagnostics.candidates[0].reason,'title_conflict');
  assert.doesNotMatch(JSON.stringify(error.matchDiagnostics),/Private|"(?:lyricsData|artist|title)"/);
  return true;
 });
});
test('legacy error reasons and ambiguity rejection remain unchanged while carrying explanations',()=>{
 assert.throws(()=>findRecording([{...song,duration:192}],song),error=>error.reason==='recording_mismatch'&&error.matchDiagnostics.candidates[0].reason==='duration_conflict');
 assert.throws(()=>findRecording([{...song,title:'Song (Live)'}],song),{reason:'version_conflict'});
 assert.throws(()=>findRecording([song,{...song,id:'2'}],song),error=>error.reason==='duplicate_candidates'&&error.matchDiagnostics.candidates.every(candidate=>candidate.accepted));
});
test('ambiguity diagnostics include the actual tied candidates even after many unrelated results',()=>{
 const unrelated=Array.from({length:20},(_,index)=>({...song,id:String(index+10),title:'Different Song'}));
 assert.throws(()=>findRecording([...unrelated,song,{...song,id:'2'}],song),error=>{
  assert.equal(error.reason,'duplicate_candidates');
  assert.equal(error.matchDiagnostics.totalCandidates,22);
  assert.deepEqual(error.matchDiagnostics.candidates.map(candidate=>candidate.sourceID),['1','2']);
  assert.ok(error.matchDiagnostics.candidates.every(candidate=>candidate.accepted));
  return true;
 });
});
test('diagnostics omit malformed and oversized provider IDs',()=>{
 for(const id of ['Private/Source/Path','x'.repeat(81)])assert.throws(()=>findRecording([{...song,id,title:'Different Song'}],song),error=>{
  assert.equal(error.matchDiagnostics.candidates[0].sourceID,null);
  assert.ok(!JSON.stringify(error.matchDiagnostics).includes(id));
  return true;
 });
});
