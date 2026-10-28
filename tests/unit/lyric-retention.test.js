import test from 'node:test';
import assert from 'node:assert/strict';
import {isMeasuredTimingDowngrade} from '../../api/utils/song-library/lyric-retention.js';
const apple={catalog_id:'123',duration:120};
const spotify={version:2,provider:'spotify',item_id:'0123456789ABCDEFGHIJKL',metadata:{origin:'spotify',title:'Fixture',artists:['Fixture'],duration_ms:120000}};
function response(recording,{coverage=[4,4],grouped=false,id='42'}={}) {
 const lines=['abcd','efgh'].map((original,index)=>{
  const timestamp=10+index*10,count=coverage[index];
  const segments=grouped?[{utf16Start:0,utf16Length:count,text:original.slice(0,count),start:timestamp,end:timestamp+.5}]:
   Array.from({length:count},(_,i)=>({utf16Start:i,utf16Length:1,text:original[i],start:timestamp+i*.1,end:timestamp+(i+1)*.1}));
  return {original,romanized:original,timestamp,...(count?{vocalTiming:{end:timestamp+1,segments}}:{})};
 });
 return {song:{id,duration:120},lines,quality:{synced:true,partial:false,instrumental:false},metadata:{source:'QQMusicAPI',lyric_timing:{version:1,
  provider:recording.provider??'appleMusic',recordingID:recording.item_id??recording.catalog_id,source:`qq:${id}:qrc`,revision:'a'.repeat(64)}}};
}
for(const [platform,recording] of [['apple',apple],['spotify',spotify]]) {
 test(`${platform}: retention compares meaningful coverage rather than segment count and allows ties`,()=>{
  const full=response(recording,{grouped:true}),less=response(recording,{coverage:[3,3]}),same=response(recording,{id:'43'});
  assert.equal(isMeasuredTimingDowngrade(full,less,recording),true);
  assert.equal(isMeasuredTimingDowngrade(less,full,recording),false);
  assert.equal(isMeasuredTimingDowngrade(full,same,recording),false);
  assert.equal(isMeasuredTimingDowngrade(full,response(recording,{coverage:[0,0]}),recording),true);
  assert.equal(isMeasuredTimingDowngrade(response(recording,{coverage:[0,0]}),less,recording),false);
 });
 test(`${platform}: wrong recording, source, provider or malformed cues grant no measured retention`,()=>{
  const next=response(recording,{coverage:[0,0]});
  const changes=[r=>r.metadata.lyric_timing.recordingID='999',r=>r.metadata.lyric_timing.source='qq:99:qrc',
   r=>r.metadata.lyric_timing.provider=platform==='apple'?'spotify':'appleMusic',r=>r.metadata.lyric_timing.revision='invalid',
   r=>r.metadata.source='LRCAPI',r=>r.lines.forEach(l=>l.vocalTiming.segments[0].text='wrong'),
   r=>r.lines.forEach(l=>l.vocalTiming.segments[0].end=l.vocalTiming.end+1)];
  for(const change of changes){const old=response(recording);change(old);assert.equal(isMeasuredTimingDowngrade(old,next,recording),false);}
 });
 test(`${platform}: complete content and reviewed corrections retain selection priority`,()=>{
  const old=response(recording,{coverage:[2,2]}),next=response(recording);
  old.quality.partial=true;assert.equal(isMeasuredTimingDowngrade(old,next,recording),false);
  old.quality.partial=false;old.metadata.timing_correction={status:'replacement',basis:'recording_listening_review'};
  assert.equal(isMeasuredTimingDowngrade(old,next,recording),true);
  const reviewed=response(recording,{coverage:[0,0]});reviewed.metadata.timing_correction={status:'replacement'};
  assert.equal(isMeasuredTimingDowngrade(next,reviewed,recording),false);
 });
 test(`${platform}: QQ whole-second duration precision is retained and cannot be borrowed`,()=>{
  const old=response(recording),next=response(recording,{coverage:[0,0]});
  old.lines=[{original:'a',romanized:'a',timestamp:119.5,vocalTiming:{end:120.5,segments:[{utf16Start:0,utf16Length:1,text:'a',start:119.5,end:120.5}]}},
   {original:'b',romanized:'b',timestamp:119.6}];
  old.metadata.lyric_timing.durationResolution=1;
  assert.equal(isMeasuredTimingDowngrade(old,next,recording),true);
  delete old.metadata.lyric_timing.durationResolution;
  assert.equal(isMeasuredTimingDowngrade(old,next,recording),false);
 });
}
