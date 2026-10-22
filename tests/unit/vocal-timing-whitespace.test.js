import test from 'node:test';
import assert from 'node:assert/strict';
import {parseQRC} from '../../api/utils/qq-qrc.js';
import {cleanLyrics} from '../../api/utils/lyric-quality.js';
import {revalidatedVocalLine,validVocalTiming} from '../../api/utils/vocal-timing.js';
import {measuredVocalCoverage} from '../../api/utils/lyric-selection.js';

const xml=body=>`<QrcInfos><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="${body}"/></LyricInfo></QrcInfos>`;
const parse=body=>parseQRC(xml(body),{songId:97773,duration:30});

test('cleaning outer whitespace preserves measured word times and rebases only UTF16 ranges',()=>{
 const raw=parse('[1000,2000]  Alpha (1100,400)beta (1600,600)\n[5000,2000]😀(5100,400)é (5600,600)');
 const before=structuredClone(raw),song={id:97773,duration:30};
 const cleaned=cleanLyrics(raw,{duration:30});
 assert.deepEqual(cleaned.lines.map(l=>l.text),['Alpha beta','😀é']);
 assert.deepEqual(cleaned.lines.map(l=>l.vocalTiming?.segments.map(s=>[s.utf16Start,s.utf16Length,s.text,s.start,s.end])),[
  [[0,6,'Alpha ',1.1,1.5],[6,4,'beta',1.6,2.2]],
  [[0,2,'😀',5.1,5.5],[2,2,'é',5.6,6.2]]
 ]);
 assert.equal(measuredVocalCoverage({song,lyrics:cleaned}).complete,true);
 assert.deepEqual(cleanLyrics(cleaned,{duration:30}),cleaned);
 assert.deepEqual(raw,before);
 assert.equal(cleaned.timingSource.revision,raw.timingSource.revision);
});

test('standalone outer space cues can be removed without changing sung segment intervals',()=>{
 const raw=parse('[1000,2000] (1000,100)Alpha(1100,400) (1500,100)');
 const line=cleanLyrics(raw,{duration:30}).lines[0];
 assert.deepEqual(line.vocalTiming,{end:3,segments:[{utf16Start:0,utf16Length:5,text:'Alpha',start:1.1,end:1.5}]});
 assert.equal(validVocalTiming(line,{duration:30}),true);
});

test('whitespace projection never repairs malformed cues, changes words, strips speaker labels or joins internal gaps',()=>{
 const raw=parse('[1000,2000]  Alpha (1100,400)beta (1600,600)').lines[0];
 for(const text of ['Alpha  beta','Alphabeta','Alpha','Other beta'])assert.equal(revalidatedVocalLine(raw,text).vocalTiming,undefined);
 const speaker=parse('[1000,2000]Mira: Alpha(1100,400)');
 assert.equal(cleanLyrics(speaker,{artist:'Mira',duration:30}).lines[0].vocalTiming,undefined);
 for(const mutate of [l=>l.vocalTiming.segments[0].text='wrong',l=>l.vocalTiming.segments[0].start=0,l=>l.vocalTiming.segments[1].start=1.2,l=>l.vocalTiming.end=1.2]){
  const invalid=structuredClone(raw);mutate(invalid);
  assert.equal(revalidatedVocalLine(invalid,invalid.text.trim()).vocalTiming,undefined);
 }
 assert.equal(revalidatedVocalLine(raw,raw.text.trim(),{duration:1}).vocalTiming,undefined);
 const split=parse('[1000,2000] ́Alpha (1100,400)').lines[0];
 assert.ok(split.vocalTiming);
 assert.equal(revalidatedVocalLine(split,split.text.trim()).vocalTiming,undefined);
});
