import test from 'node:test';
import assert from 'node:assert/strict';
import {qualifyLyricTiming,responseTimingNeedsRefresh} from '../../api/utils/timing-plausibility.js';
import {timingQuality,measuredVocalCoverage,needsTimingDiscovery,chooseMeasuredLyricCandidate,lyricResponseLifetimeMs} from '../../api/utils/lyric-selection.js';
import {parseKRC} from '../../api/utils/kugou-krc.js';

const candidate=(id='42',step=4)=>({song:{id,duration:215},api:{name:'KugouAPI'},lyrics:parseKRC(
 Array.from({length:8},(_,index)=>`[${Math.round((1+index*step)*1000)},20]<0,10,0>Invented first<10,10,0> invented second`).join('\n'),{songId:id,duration:215})});
test('known corrupt Kugou edition is quarantined across KRC and LRC, without discarding words',()=>{
 for(const measured of [true,false]){
  const value=candidate('468823329');if(!measured){delete value.lyrics.timingSource;for(const row of value.lyrics.lines)delete row.vocalTiming;}
  const before=structuredClone(value),result=qualifyLyricTiming(value);
  assert.equal(timingQuality(value).usable,false);assert.equal(measuredVocalCoverage(value).covered,0);
  assert.equal(needsTimingDiscovery(value),true);assert.deepEqual(value,before);
  assert.deepEqual(result.lyrics.lines.map(row=>row.text),value.lyrics.lines.map(row=>row.text));
  assert.ok(result.lyrics.lines.every(row=>row.timestamp===null&&!row.vocalTiming));assert.equal(result.lyrics.timingSource,undefined);
  assert.equal(qualifyLyricTiming(result),result);
 }
});
test('collapsed full rows and tiny meaningful cues cannot qualify as measured complete',()=>{
 const value=candidate('42',0.04),result=qualifyLyricTiming(value);
 assert.notEqual(result,value);assert.equal(timingQuality(value).usable,false);
 assert.equal(measuredVocalCoverage(value).complete,false);
 const good={song:{id:9,duration:215},lyrics:{source:'lrclib',lines:[{text:'Invented opening',timestamp:2},{text:'Invented ending',timestamp:20}]}};
 assert.equal(chooseMeasuredLyricCandidate(value,good),good);
});
test('ordinary cadence, sparse vocals and long instrumental tails remain usable',()=>{
 const value=candidate();for(const row of value.lyrics.lines){row.vocalTiming.end=row.timestamp+2;row.vocalTiming.segments.forEach((cue,index)=>{cue.start=row.timestamp+index;cue.end=cue.start+1;});}
 assert.equal(qualifyLyricTiming(value),value);assert.equal(timingQuality(value).usable,true);
 assert.equal(measuredVocalCoverage(value).complete,true);
 const tail={song:{duration:600},lyrics:{lines:[{text:'Invented first row',timestamp:1},{text:'Invented last row',timestamp:5}]}};
 assert.equal(qualifyLyricTiming(tail),tail);assert.equal(timingQuality(tail).usable,true);
});
test('cached responses reject bad timing but accept the repaired untimed source and valid neighbors',()=>{
 const value=candidate('468823329'),response={song:value.song,metadata:{source:'KugouAPI'},quality:{synced:true},lines:value.lyrics.lines.map(({text,...row})=>({...row,original:text}))};
 assert.equal(responseTimingNeedsRefresh(response),true);assert.equal(lyricResponseLifetimeMs(response),300000);
 for(const row of response.lines){row.timestamp=null;delete row.vocalTiming;}
 assert.equal(responseTimingNeedsRefresh(response),false);
 response.song.id='42';assert.equal(responseTimingNeedsRefresh(response),false);
});
