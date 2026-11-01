import test from 'node:test';
import assert from 'node:assert/strict';
import {needsCompletenessDiscovery,qualifyLyricCompleteness} from '../../api/utils/lyric-completeness.js';
import {chooseLyricCandidate,chooseMeasuredLyricCandidate,needsTimingDiscovery,lyricResponseLifetimeMs} from '../../api/utils/lyric-selection.js';
import {completenessCandidate,fullerCandidate,opening,laterVerse} from '../helpers/lyric-completeness-fixture.js';
import {parseYRC} from '../../api/utils/netease-yrc.js';

test('an early cutoff opens discovery, but only corroborated omissions qualify as partial',()=>{
 const excerpt=completenessCandidate(),full=fullerCandidate(),before=structuredClone(excerpt);
 assert.equal(needsCompletenessDiscovery(excerpt),true);
 assert.equal(needsTimingDiscovery(excerpt,{measured:false}),true);
 assert.equal(qualifyLyricCompleteness(excerpt,null),excerpt);
 const qualified=qualifyLyricCompleteness(excerpt,full);
 assert.equal(qualified.lyrics.partial,true);
 assert.deepEqual(excerpt,before);
 assert.equal(qualified.song,excerpt.song);
 assert.equal(qualified.lyrics.lines,excerpt.lyrics.lines);
 for(const choose of [chooseLyricCandidate,chooseMeasuredLyricCandidate]) {
  assert.equal(choose(excerpt,full),full);
  assert.equal(choose(full,excerpt),full);
 }
 const fallback={song:excerpt.song,lines:excerpt.lyrics.lines.map(line=>({original:line.text,timestamp:line.timestamp})),quality:{synced:true}};
 assert.equal(lyricResponseLifetimeMs(fallback),300000);
});

test('rewrapping, punctuation and tiny transcription differences do not manufacture missing verses',()=>{
 const excerpt=completenessCandidate();
 for(const lines of [opening,opening.flatMap(row=>row.split(' and ')),opening.map(row=>row.toUpperCase()+'!'),[...opening,'Oh']]) {
  const alternative=completenessCandidate({id:'alternative',lines,timed:false});
  assert.equal(qualifyLyricCompleteness(excerpt,alternative),excerpt);
  assert.equal(chooseLyricCandidate(excerpt,alternative),excerpt);
 }
});

test('measured timing cannot restore a corroborated excerpt over complete timed text',()=>{
 const full=completenessCandidate({id:'full',lines:[...opening,...laterVerse,...opening]});
 const excerpt=completenessCandidate({id:42});
 excerpt.lyrics=parseYRC(opening.map((text,index)=>{
  const timestamp=(10+index*15)*1000;
  return `[${timestamp},1000](${timestamp},1000,0)${text}`;
 }).join('\n'),{songId:42,duration:240});
 assert.equal(qualifyLyricCompleteness(excerpt,full).lyrics.partial,true);
 assert.equal(chooseMeasuredLyricCandidate(full,excerpt),full);
 assert.equal(chooseMeasuredLyricCandidate(excerpt,full),full);
});

test('matching preserves occurrence order and repeated choruses rather than comparing sets',()=>{
 const excerpt=completenessCandidate({lines:[opening[0],opening[0],opening[0],opening[0]]});
 const insufficient=completenessCandidate({lines:[opening[0],...laterVerse,...laterVerse],timed:false});
 assert.equal(qualifyLyricCompleteness(excerpt,insufficient),excerpt);
 const repeated=completenessCandidate({lines:[...excerpt.lyrics.lines.map(line=>line.text),...laterVerse],timed:false});
 assert.equal(qualifyLyricCompleteness(excerpt,repeated).lyrics.partial,true);
 const reordered=completenessCandidate({lines:[...opening].reverse().concat(laterVerse),timed:false});
 assert.equal(qualifyLyricCompleteness(completenessCandidate(),reordered).lyrics.partial,undefined);
});

test('unknown, mismatched, partial, instrumental and unrelated sources cannot corroborate',()=>{
 const excerpt=completenessCandidate(),full=fullerCandidate();
 for(const change of [
  {song:{...full.song,title:'Other Song'}},
  {song:{...full.song,duration:90}},
  {song:{...full.song,duration:null}},
  {target:{...full.target,catalog_id:'999'},song:{...full.song,title:'Other Song'}},
  {target:null},
  {lyrics:{...full.lyrics,partial:true}},
  {lyrics:{...full.lyrics,instrumental:true}},
  {lyrics:{lines:laterVerse.concat(laterVerse).map(text=>({text,timestamp:null}))}}
 ])assert.equal(qualifyLyricCompleteness(excerpt,{...full,...change}),excerpt);
 const identified={...excerpt,target:{...excerpt.target,catalog_id:'123'}};
 assert.equal(qualifyLyricCompleteness(identified,{...full,target:{...full.target,catalog_id:'999'}}),identified);
});

test('genuine short recordings, sparse vocals and late vocals are not early-cutoff signals',()=>{
 for(const candidate of [completenessCandidate({target:{...completenessCandidate().target,duration:90}}),
  completenessCandidate({lines:['A few words','Then silence']}),
  {...completenessCandidate(),lyrics:{lines:opening.map((text,index)=>({text,timestamp:160+index*15}))}},
  completenessCandidate({timed:false})])assert.equal(needsCompletenessDiscovery(candidate),false);
 const outro=completenessCandidate();
 assert.equal(qualifyLyricCompleteness(outro,completenessCandidate({timed:false})),outro);
});

test('server-validated localizations share acquisition identity without matching display names',()=>{
 const excerpt=completenessCandidate(),full=fullerCandidate(),recordingTarget={...excerpt.target};
 const localized={...full,target:{...full.target,title:'Localized Title'},song:{...full.song,title:'Localized Title'}};
 assert.equal(qualifyLyricCompleteness(excerpt,localized),excerpt);
 assert.equal(qualifyLyricCompleteness({...excerpt,recordingTarget},{...localized,recordingTarget}).lyrics.partial,true);
 assert.equal(qualifyLyricCompleteness({...excerpt,recordingTarget},{...localized,recordingTarget:{...recordingTarget}}).lyrics.partial,undefined);
});
