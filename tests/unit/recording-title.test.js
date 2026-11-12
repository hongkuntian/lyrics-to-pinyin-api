import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRecordingTitle} from '../../api/utils/recording-title.js';

test('shared title parsing retains raw labels and explains informational and guest extraction',()=>{
 const raw='Ｓｏｎｇ ［From Example Film］ (feat. Guest)';
 const parsed=parseRecordingTitle(raw);
 assert.equal(parsed.raw,raw);
 assert.equal(parsed.title,'Song');
 assert.equal(parsed.searchTitle,'Song');
 assert.deepEqual(parsed.guests,['Guest']);
 assert.deepEqual(parsed.descriptions,['[From Example Film]']);
 assert.deepEqual(parsed.rules,['unicode_compatibility','soundtrack_description','guest_credit']);
 assert.equal(parsed.malformedAnnotations,false);
});
test('the parser retains material and unknown annotations and fails closed on nested syntax',()=>{
 for(const raw of ['Song [From Film - Live]','Song [Unknown]','Song [From (Film)]','Song [From Film)']) {
  const parsed=parseRecordingTitle(raw);
  assert.equal(parsed.raw,raw);
  assert.equal(parsed.title,raw);
  assert.deepEqual(parsed.descriptions,[]);
 }
 assert.equal(parseRecordingTitle('Song [From (Film)]').malformedAnnotations,true);
});
test('search and recording projections preserve their different live, work and suffix semantics',()=>{
 const live=parseRecordingTitle('Song (live版)');
 assert.equal(live.searchTitle,'Song (live版)');
 assert.equal(live.title,'Song (Live)');
 assert.deepEqual(live.rules,['live_label']);
 const work=parseRecordingTitle('Song (アニメ全話OP)');
 assert.equal(work.searchTitle,'Song (アニメ全話OP)');
 assert.equal(work.title,'Song (アニメ)');
 const title='Song - 電影《作品》主題曲';
 assert.equal(parseRecordingTitle(title).title,title);
 assert.equal(parseRecordingTitle(title,{themeSuffix:true}).title,'Song');
 assert.deepEqual(parseRecordingTitle(title,{themeSuffix:true}).rules,['theme_description_suffix']);
});
