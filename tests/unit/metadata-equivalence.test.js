import test from 'node:test';
import assert from 'node:assert/strict';
import {metadataEquivalence,recordingScore,findRecording} from '../../api/utils/recording-match.js';
const request={catalog_id:'966805806',title:'匆匆那年',artist:'Faye Wong',album:'匆匆那年 - Single',duration:241};
const candidate={...request,id:1,album:'匆匆那年',duration:240.99};

test('reversed two-word solo names require corroborating catalog, album and duration',()=>{
 const song={...candidate,artist:'Wong, Faye'};
 assert.deepEqual(metadataEquivalence(song,request),{rules:['reversed_solo_artist']});
 assert.ok(recordingScore(song,request)>=0);
 for(const patch of [{catalog_id:undefined},{catalog_id:'library-song'},{album:''},{album:'Other Album'},{duration:242}]) {
  assert.equal(metadataEquivalence(song,{...request,...patch}),null);
  assert.equal(recordingScore(song,{...request,...patch}),-1);
 }
 assert.equal(metadataEquivalence({...song,duration:null},request),null);
 assert.equal(metadataEquivalence({...song,album:null},request),null);
 for(const artist of ['Wong, Faye & Guest','Wong, Guest','Faye Guest Wong','Wong Faye','Wong, Faye (feat. Guest)'])
  assert.equal(recordingScore({...candidate,artist},request),-1,artist);
});
test('only the same known artist can be removed from a provider title prefix',()=>{
 const target={...request,artist:'王菲'},song={...candidate,artist:'王菲',title:'王菲 - 匆匆那年'};
 assert.deepEqual(metadataEquivalence(song,target),{rules:['artist_prefixed_title']});
 assert.ok(recordingScore(song,target)>=0);
 for(const title of ['Cover Singer - 匆匆那年','王菲 - 匆匆那年 (Live)','王菲 - 匆匆那年 (feat. Guest)','王菲 - 匆匆那年 (Remastered)'])
  assert.equal(recordingScore({...song,title},target),-1,title);
 // A catalog ID is not evidence for an unprovided artist translation.
 assert.equal(recordingScore({...song,artist:'Faye Wong'},request),-1);
});
test('long ASCII title typos allow one letter edit only with the same full credits',()=>{
 for(const [title,other] of [
  ['Forgotten Battlefied - Cemetery’s Boat','Forgotten Battlefield - Cemetery’s Boat'],
  ['Forgotten Viillage - The Woodland Path','Forgotten Village - The Woodland Path']
 ]) {
  const target={...request,title,artist:'Composer',album:'Soundtrack'};
  const song={...target,id:1,title:other};
  assert.deepEqual(metadataEquivalence(song,target),{rules:['long_title_typo']});
  assert.ok(recordingScore(song,target)>=0);
  for(const patch of [{artist:'Other Composer'},{album:'Other Soundtrack'},{duration:242},{title:other+' (Live)'},{title:other+' (Cover)'}])
   assert.equal(recordingScore({...song,...patch},target),-1);
 }
 const target={...request,title:'Very Long Soundtrack Movement 1',artist:'Composer',album:'Soundtrack'};
 assert.equal(recordingScore({...target,title:'Very Long Soundtrack Movement 2'},target),-1);
 assert.equal(recordingScore({...request,title:'匆匆那天'},request),-1);
 assert.equal(recordingScore({...request,title:'Sung'},{...request,title:'Song'}),-1);
 assert.equal(recordingScore({...target,title:'Very Wrong Soundtracc Movement 1'},target),-1);
});
test('compound stage names preserve the full credit and cannot bypass recording evidence',()=>{
 const target={...request,title:'赤伶',artist:'等什么君',album:'赤伶',duration:268.5};
 const song={...target,id:1,artist:'邓寓君（等什麼君）'};
 assert.deepEqual(metadataEquivalence(song,target),{rules:['compound_stage_name']});
 assert.ok(recordingScore(song,target)>=0);
 for(const artist of ['邓寓君 & 等什么君','邓寓君（等什么君） & Guest','邓寓君（feat. 等什么君）','邓寓君（原唱等什么君）','邓寓君（等什么君/Guest）','邓寓君（其他人）','等什么君翻唱'])
  assert.equal(recordingScore({...song,artist},target),-1,artist);
 for(const patch of [{catalog_id:undefined},{album:'Another Album'},{duration:270}]) assert.equal(recordingScore(song,{...target,...patch}),-1);
});
test('strict names remain stronger than soft equivalence with otherwise equal metadata',()=>{
 const exact={...candidate,artist:'Faye Wong'},soft={...candidate,id:2,artist:'Wong, Faye'};
 assert.equal(metadataEquivalence(exact,request),null);
 assert.ok(recordingScore(exact,request)>recordingScore(soft,request));
 assert.equal(findRecording([soft,exact],request).id,1);
});
test('duplicate lyrics normalize scripts, punctuation and credits only with identical timing',()=>{
 const first={...candidate,id:1,lyricsData:{lines:[{text:'作词: Writer',timestamp:0},{text:'一起聽，慢慢唱。',timestamp:10},{text:'我們再唱一遍',timestamp:20}]}};
 const second={...candidate,id:2,lyricsData:{lines:[{text:'一起听慢慢唱',timestamp:10},{text:'我们再唱一遍',timestamp:20}]}};
 assert.equal(findRecording([second,first],request).id,1);
 for(const patch of [
  {lines:[{text:'一起听慢慢唱',timestamp:10.01},{text:'我们再唱一遍',timestamp:20}]},
  {lines:[{text:'一起听',timestamp:10},{text:'慢慢唱我们再唱一遍',timestamp:20}]},
  {lines:[{text:'一起听慢慢唱',timestamp:null},{text:'我们再唱一遍',timestamp:20}]},
  {lines:[{text:'作词: Writer',timestamp:0}]}
 ]) assert.throws(()=>findRecording([first,{...second,lyricsData:patch}],request),{code:'recording_mismatch'});
 const plain={...first,lyricsData:{lines:[{text:'original text',timestamp:null}]}};
 assert.throws(()=>findRecording([plain,{...second,lyricsData:{lines:[{text:'original text',timestamp:999}]}}],request),{code:'recording_mismatch'});
});

test('a long ASCII typo may coexist with unchanged Latin diacritics, but never edits accents',()=>{
 const target={...request,title:'Forgotten Battlefied - Lueur Déclinante',artist:'Lorien Testard',album:'Soundtrack',duration:196};
 const song={...target,title:'Forgotten Battlefield - Lueur Déclinante'};
 assert.deepEqual(metadataEquivalence(song,target),{rules:['long_title_typo']});
 assert.ok(recordingScore(song,target)>=0);
 assert.equal(recordingScore({...song,title:'Forgotten Battlefied - Lueur Declinante'},target),-1);
 assert.equal(recordingScore({...song,title:'Forgotten Battlefied - Lueur Dèclinante'},target),-1);
 assert.equal(recordingScore({...song,title:'Forgotten Battlefied - Lueur Déclinanté'},target),-1);
});
