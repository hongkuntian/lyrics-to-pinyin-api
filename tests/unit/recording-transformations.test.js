import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingScore,findRecording,searchTitle,stripTitleDescription,metadataEquivalence} from '../../api/utils/recording-match.js';
import {recordingTransformations,annotationBrackets,soundtrackDescriptions} from '../helpers/recording-transformations.js';

test('presentation transformations and material changes preserve both recording admission policies',()=>{
 for(const entry of recordingTransformations()) {
  assert.equal(recordingScore(entry.song,entry.request)>=0,entry.accepted,entry.label);
  if(entry.accepted)assert.equal(findRecording([entry.song],entry.request),entry.song,entry.label);
  else assert.throws(()=>findRecording([entry.song],entry.request),{code:'recording_mismatch'},entry.label);
 }
});
test('informational title transformations are idempotent and leave request and source untouched',()=>{
 for(const [open,close] of annotationBrackets)for(const description of soundtrackDescriptions) {
  const title=`Ｓｏｎｇ ${open}${description}${close}`;
  assert.equal(searchTitle(title),'Song');
  assert.equal(searchTitle(searchTitle(title)),'Song');
  assert.equal(stripTitleDescription(stripTitleDescription(title)),stripTitleDescription(title));
  const song=Object.freeze({id:'1',title,artist:'Singer',album:'Album',duration:188});
  const request=Object.freeze({title:'Song',artist:'Singer',album:'Album',duration:188});
  assert.ok(recordingScore(song,request)>=0);
  assert.equal(song.title,title);
 }
});
test('catalog-supported soft equivalence retains its tighter duration and album boundary',()=>{
 const song={id:'1',title:'Song',artist:'Last, First',album:'Album',duration:188};
 const request={catalog_id:'123',title:'Song',artist:'First Last',album:'Album',duration:188.5};
 assert.deepEqual(metadataEquivalence(song,request),{rules:['reversed_solo_artist']});
 for(const change of [{duration:188.501},{album:'Other Album'},{catalog_id:undefined},{artist:'First Last & Guest'}])
  assert.equal(metadataEquivalence(song,{...request,...change}),null,JSON.stringify(change));
});
test('search simplification never discards an unrecognized Japanese work from recording admission',()=>{
 const song={id:'1',title:'Song',artist:'Singer',duration:188};
 assert.equal(recordingScore(song,{...song,title:'Song (アニメ全話OP)'}),-1);
 assert.ok(recordingScore({...song,title:'Song (アニメ)'},{...song,title:'Song (アニメ全話OP)'})>=0);
});
