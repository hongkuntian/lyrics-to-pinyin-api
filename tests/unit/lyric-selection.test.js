import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseLyricCandidate,timingQuality} from '../../api/utils/lyric-selection.js';
const candidate=(partial,times)=>({song:{duration:220},lyrics:{partial,lines:times.map((timestamp,i)=>({text:'verse '+i,timestamp}))}});
test('complete text outranks partial timestamped text; useful timing improves complete text',()=>{
 const plain=candidate(false,[null,null,null]),partial=candidate(true,[1,20,40]),timed=candidate(false,[1,20,40]);
 assert.equal(chooseLyricCandidate(plain,partial),plain);
 assert.equal(chooseLyricCandidate(partial,plain),plain);
 assert.equal(chooseLyricCandidate(plain,timed),timed);
});
test('invalid or token timestamps do not claim a usable timeline or listening review',()=>{
 for(const times of [[0,null,null],[10,5,20],[1,20,300],[0,0,0]]) assert.equal(timingQuality(candidate(false,times)).usable,false);
 const quality=timingQuality(candidate(false,[1,20,40]));
 assert.equal(quality.usable,true);assert.equal(quality.alignment,'provider');
});
