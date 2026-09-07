import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingScore,findRecording} from '../../api/utils/recording-match.js';
const request={title:'说好不哭',artist:'Jay Chou & Ashin Chen',album:'说好不哭 - Single',duration:222.333};
test('collaborator separators and ordering represent the same full credit',()=>{
 for(const artist of ['Jay Chou feat. Ashin Chen','Jay Chou, Ashin Chen','Ashin Chen / Jay Chou'])
  assert.ok(recordingScore({...request,title:'說好不哭',artist},request)>=0,artist);
 for(const artist of ['Jay Chou','Ashin Chen','Jay Chou & Cover Singer','Jay Chou & Ashin Chen & Guest'])
  assert.equal(recordingScore({...request,artist},request),-1,artist);
});
test('explicit featured credit can move between title and artist without losing contributors',()=>{
 assert.ok(recordingScore({...request,title:'说好不哭 (with Ashin Chen)',artist:'Jay Chou'},request)>=0);
 assert.equal(recordingScore({...request,title:'说好不哭 (with Cover Singer)',artist:'Jay Chou'},request),-1);
 assert.equal(recordingScore({...request,title:'说好不哭 (Live)'},request),-1);
 assert.equal(recordingScore({...request,title:'说好不哭 (Instrumental)'},request),-1);
 assert.equal(recordingScore({...request,duration:231},request),-1);
});
test('album release suffix helps select the single while version safety and conflicts remain',()=>{
 const single={...request,id:1,title:'說好不哭',artist:'Jay Chou feat. Ashin Chen',album:'說好不哭',duration:222};
 const other={...single,id:2,album:'最偉大的作品'};
 assert.equal(findRecording([other,single],request).id,1);
 assert.throws(()=>findRecording([single,{...single,id:3}],request),/recording/i);
 assert.equal(recordingScore({...single,album:'Live'},request),-1);
});
test('exact album remains stronger than a release-suffix fallback when lyrics conflict',()=>{
 const request={artist:'Artist',title:'Song',album:'Song - Single',duration:185};
 const exact={...request,id:1,lyricsData:{lines:[{text:'one original line',timestamp:null}]}};
 const alternate={...exact,id:2,album:'Song',lyricsData:{lines:[{text:'different lyric',timestamp:0}]}};
 assert.equal(findRecording([alternate,exact],request).id,1);
});
test('soundtrack descriptions are not recording versions',()=>{
 const base={title:'小幸运',artist:'田馥甄',duration:265.5};
 assert.ok(recordingScore({...base,title:'小幸運 (電影《我的少女時代》主題曲)'},base)>=0);
 assert.ok(recordingScore({...base,title:'小幸运 (抖音热歌)'},base)>=0);
 const english={title:'A Little Happiness',artist:'Hebe Tien',duration:265.5};
 assert.ok(recordingScore({...english,title:'A Little Happiness (From "Our Times")'},english)>=0);
 for(const suffix of ['Live','Remastered','Instrumental','Acapella','Cover','主題曲 Live','From Our Times - Remastered']) assert.equal(recordingScore({...english,title:`A Little Happiness (${suffix})`},english),-1);
 assert.equal(recordingScore({...base,title:'小幸運 (電影《我的少女時代》主題曲)',duration:300},base),-1);
});
