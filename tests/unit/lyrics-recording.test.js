import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLRC} from '../../api/utils/lrc.js';
import {findRecording,recordingNames,sameRecordingNames} from '../../api/utils/recording-match.js';

test('reviewed band names keep internal credit words while retaining surrounding guests',()=>{
  const band='Your Woman Sleep with Others';
  const names=artist=>recordingNames({artist,title:'Teens Edge'}).credits;
  assert.deepEqual(names(band),['yourwomansleepwithothers']);
  assert.deepEqual(names('YOUR WOMAN SLEEP  WITH OTHERS'),names(band));
  for(const separator of [' & ', ', ', ' / ', '、', ' feat. ', ' featuring ', ' with ']) {
    assert.deepEqual(names(band+separator+'Guest'),['guest',...names(band)]);
    assert.deepEqual(names('Guest'+separator+band),['guest',...names(band)]);
  }
  assert.deepEqual(recordingNames({artist:'Guest',title:`Song (with ${band})`}).credits,['guest',...names(band)]);
  assert.deepEqual(names('Singer with Guest'),['guest','singer']);
  assert.deepEqual(names('Unknown Band with Others'),['others','unknownband']);
  assert.equal(sameRecordingNames({artist:band,title:'Teens Edge'},{artist:'老王樂隊',title:'我還年輕 我還年輕'}),false);
  assert.equal(sameRecordingNames({artist:band,title:'Teens Edge'},{artist:band+' with Guest',title:'Teens Edge'}),false);
});

test('LRC normalizes fractions, repeated timestamps, zero and preserves untimed text', () => {
  assert.deepEqual(parseLRC('[ar:artist]\n[00:01.50]两位\n[00:01.500]三位\n[00:00]开始\n[00:02][00:04.5]重复\n没有时间\n[00:03]他说：你好').map(x=>[x.timestamp,x.text]), [[0,'开始'],[1.5,'两位'],[1.5,'三位'],[2,'重复'],[3,'他说：你好'],[4.5,'重复'],[null,'没有时间']]);
});
test('LRC ignores malformed time and preserves plain lyrics', () => {
  assert.deepEqual(parseLRC('[00:99.00]bad\njust words'), [{timestamp:null,text:'just words'}]);
});
const original={id:1,title:'晴天',artist:'周杰伦',album:'葉惠美',duration:269};
test('match normalizes scripts and spacing and skips a cover',()=> {
  const cover={...original,id:2,artist:'RyaVocal',title:'晴天 (原唱 周杰伦)'};
  assert.equal(findRecording([cover,original],{artist:'周 杰 倫',title:'晴天',duration:269}).id,1);
});
test('match rejects wrong artists, versions, durations, and ambiguous recordings',()=> {
  for(const candidates of [[{...original,artist:'Cover Artist'}],[{...original,title:'晴天 (Live)'}],[{...original,duration:290}],[original,{...original,id:3}]]) {
    assert.throws(()=>findRecording(candidates,{artist:'周杰倫',title:'晴天',duration:269}),/recording/i);
  }
});
test('album and duration disambiguate recordings',()=> {
  assert.equal(findRecording([original,{...original,id:2,album:'Live',duration:300}],{artist:'周杰倫',title:'晴天',album:'叶惠美',duration:269}).id,1);
  assert.equal(findRecording([],{artist:'x',title:'y'}),null);
});
test('provider album wrappers normalize without losing live recording distinctions',()=> {
  const wrapped={...original,id:4,album:'Optional("叶惠美")'};
  assert.equal(findRecording([{...original,duration:266},wrapped],{artist:'周杰倫',title:'晴天',album:'葉惠美',duration:269}).id,4);
  for (const album of ['世界巡回演唱会', 'Live at Wembley']) {
    assert.throws(()=>findRecording([{...original,album}],{artist:'周杰倫',title:'晴天',album:'叶惠美',duration:269}),/recording/i);
  }
});
