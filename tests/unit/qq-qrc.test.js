import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decryptQRC,MAX_QRC_ENCRYPTED_BYTES} from '../../api/utils/vendor/qq-qrc-codec.js';
import {parseQRC,parseEncryptedQRC,qrcBody} from '../../api/utils/qq-qrc.js';
const fixtures=JSON.parse(readFileSync(new URL('../fixtures/qrc-codec-fixtures.json',import.meta.url)));
const escaped=s=>s.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const xml=body=>`<?xml version="1.0" encoding="utf-8"?><QrcInfos><QrcHeadInfo SaveTime="1" Version="100"/><LyricInfo LyricCount="1"><Lyric_1 LyricType="1" LyricContent="${escaped(body)}"/></LyricInfo></QrcInfos>`;
const parse=body=>parseQRC(xml(body),{songId:123,duration:10});

test('codec decodes fixed synthetic interoperability vector and exact UTF8',()=>{
 assert.equal(decryptQRC(fixtures.validHex),fixtures.validRaw);
 const result=parseEncryptedQRC(fixtures.validHex,{songId:123,duration:10});
 assert.equal(result.lines[0].text,'A&😀');
 assert.deepEqual(result.lines[0].vocalTiming.segments,[{utf16Start:0,utf16Length:4,text:'A&😀',start:1.1,end:1.6}]);
});
test('word timestamps are absolute milliseconds with measured gaps',()=>{
 const r=parse('[1000,1000]Alpha (1100,200)beta(1400,300)');
 assert.deepEqual(r.lines,[{text:'Alpha beta',timestamp:1,vocalTiming:{end:2,segments:[
  {utf16Start:0,utf16Length:6,text:'Alpha ',start:1.1,end:1.3},
  {utf16Start:6,utf16Length:4,text:'beta',start:1.4,end:1.7},
 ]}}]);
 assert.equal(r.source,'qq');assert.equal(r.songId,'123');assert.equal(r.timingSource.source,'qq:123:qrc');assert.match(r.timingSource.revision,/^[a-f0-9]{64}$/);
});
test('whole graphemes retain exact UTF16 ranges and source whitespace',()=>{
 const r=parse('[0,2000]😀(100,500)e\u0301(700,300)  ');
 assert.equal(r.lines[0].text,'😀e\u0301  ');
 assert.deepEqual(r.lines[0].vocalTiming.segments.map(s=>[s.utf16Start,s.utf16Length]),[[0,2],[2,2]]);
});
test('split combining and ZWJ graphemes retain readable source with no invented timing',()=>{
 for(const body of ['[0,1000]e(0,200)\u0301(200,200)','[0,1000]👩(0,200)\u200d💻(200,500)']) {
  const line=parse(body).lines[0];assert.equal(line.vocalTiming,undefined);assert.equal(line.text,body.split(']')[1].replace(/\(\d+,\d+\)/g,''));
 }
});
test('invalid measured intervals preserve text and never clamp or interpolate',()=>{
 for(const body of [
  '[0,1000]A(0,600) B(200,400)', '[1000,1000]A(0,100)',
  '[0,1000]A(500,600)', '[0,1000]A(-1,100)',
  '[0,1000]A(0,-1)', '[0,1000]A(0,NaN)',
  '[0,1000]A(99999999999999999999,1)', '[0,1000]A(0,0)',
 ]) {const line=parse(body).lines[0];assert.ok(line.text.startsWith('A'));assert.equal(line.vocalTiming,undefined);}
 assert.equal(parse('[0,1000]Readable no markers').lines[0].vocalTiming,undefined);
});
test('undecodable rows reject the complete edition without keeping a prefix',()=>{
 for(const suffix of ['unknown row','[x,100]A(1,2)','[0,1000]A(x,1)','[0,1000]A(1,2,3)','[0,1000]A(1,2'])
  assert.equal(parse(`[0,1000]Synthetic(0,500)\n${suffix}`),null);
});
test('known sheet metadata is skipped, timed credits remain exact source rows',()=>{
 const r=parse('[ti:Synthetic]\n[ar:Test]\n[al:Example]\n[by:Test]\n[offset:0]\n[0,1000]Credits by Test(0,500)\n[1000,1000]Synthetic(1000,500)');
 assert.equal(r.lines.length,2);assert.equal(r.lines[0].text,'Credits by Test');
 for(const metadata of ['[offset:1]','[foo:unknown]','[ti:a]\n'.repeat(33)])assert.equal(parse(metadata+'\n[0,1000]A(0,500)'),null);
 assert.equal(parse('[0,1000]A(0,500)\n[ti:late]'),null);
});
test('leading bounded kana phonetic metadata cannot change sung rows or their revision',()=>{
 const rows='[0,1000]Synthetic(0,500)\n[1000,1000]ending(1000,500)';
 const plain=parse(rows),phonetic=parse('[ar:Test]\n[kana:シンセティック[0,1](0,1000)]\n'+rows);
 assert.deepEqual(phonetic,plain);
 assert.equal(parse(rows+'\n[kana:late]'),null);
 assert.equal(parse('[kana:'+'あ'.repeat(5500)+']\n'+rows),null);
 assert.equal(parse(('[kana:'+'あ'.repeat(5000)+']\n').repeat(5)+rows),null);
 assert.equal(parse('[kana:a]\n'.repeat(33)+rows),null);
 for(const header of ['[offset:-1]','[offset:1000]','[phonetic:unknown]'])assert.equal(parse(header+'\n'+rows),null);
});
test('XML envelope decodes standard/numeric entities and rejects ambiguous structures',()=>{
 const r=xml('[0,1000]A(0,500)').replace('A(0,500)','&#65;&#x1F600;&amp;(0,500)');
 assert.equal(parseQRC(r,{songId:123}).lines[0].text,'A😀&');
 const base=xml('[0,1000]A(0,500)');
 for(const raw of [base.replace('LyricCount="1"','LyricCount="2"'),base.replace('LyricType="1"','LyricType="2"'),base.replace('LyricType="1"','LyricType="1" LyricType="1"'),base.replace('</LyricInfo>','<Lyric_2/></LyricInfo>'),base.replace('A(0,500)','A&unknown;(0,500)'),base.replace('A(0,500)','&#xD800;(0,500)'),base.replace('A(0,500)','&#0;(0,500)'),base.replace('<QrcInfos>','<!DOCTYPE a SYSTEM "https://example.invalid/x"><QrcInfos>'),base+'extra'])assert.equal(parseQRC(raw,{songId:123}),null);
 assert.equal(qrcBody('[0,1000]A(0,500)'),null);
});
test('literal ampersands in QQ lyric content preserve text and measured cues without enabling entities or markup',()=>{
 const raw=xml('[1000,1000]A&B & C(1100,500)').replace('A&amp;B &amp; C','A&B & C');
 const result=parseQRC(raw,{songId:571093214,duration:260,durationResolution:1});
 assert.equal(result.lines[0].text,'A&B & C');
 assert.deepEqual(result.lines[0].vocalTiming.segments,[{utf16Start:0,utf16Length:7,text:'A&B & C',start:1.1,end:1.6}]);
 assert.deepEqual(result,parseQRC(xml('[1000,1000]A&B & C(1100,500)'),{songId:571093214,duration:260,durationResolution:1}));
 const mixed=raw.replace('A&B & C','A&B &amp; C');
 assert.equal(parseQRC(mixed,{songId:123}).lines[0].text,'A&B & C');
 for(const text of ['A&unknown;','A&#xZZ;','A&#99999999;','A&#xD800;','A&thisEntityNameIsTooLong;','A&<tag>','A\" duplicate=\"value']) {
  assert.equal(parseQRC(raw.replace('A&B & C',text),{songId:123}),null,text);
 }
 assert.equal(parseQRC(raw.replace('SaveTime="1"','SaveTime="1&"'),{songId:123}),null);
 assert.equal(parseQRC(raw.replace('version="1.0"','version="1.0&"'),{songId:123}),null);
});
test('invalid headers, Unicode, IDs, durations and source ordering fail closed',()=>{
 for(const body of ['[0,0]A(0,1)','[9999999999999999,1000]A(0,500)','[0,10001]A(0,500)','[1000,1000]A(1000,500)\n[0,1000]B(0,500)','[0,1000]\ud800(0,500)','[0,1000]A\u0000(0,500)'])assert.equal(parse(body),null);
 for(const songId of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1,'001','x','1'.repeat(21)])assert.equal(parseQRC(xml('[0,1000]A(0,500)'),{songId}),null);
 for(const duration of [0,-1,Infinity,NaN,7201])assert.equal(parseQRC(xml('[0,1000]A(0,500)'),{songId:123,duration}),null);
});
test('row, token, UTF16 and aggregate byte limits are enforced',()=>{
 assert.equal(parse('[0,1000]A(0,1)\n'.repeat(251)),null);
 assert.equal(parse('[0,1000]'+'A(0,1)'.repeat(1025)),null);
 assert.equal(parse(('[0,1000]'+'A(0,1)'.repeat(1000)+'\n').repeat(9)),null);
 assert.equal(parse('[0,1000]'+'A'.repeat(2001)),null);
 assert.equal(parse('[0,1000]'+'A'.repeat(20001)),null);
 assert.equal(parseQRC(' '.repeat(524289),{songId:123}),null);
});
test('identity and measured timing affect stable source revision',()=>{
 const a=parse('[0,1000]A(0,500)'),b=parse('[0,1000]A(0,500)'),changed=parse('[0,1000]A(0,600)');
 assert.equal(a.timingSource.revision,b.timingSource.revision);assert.notEqual(a.timingSource.revision,changed.timingSource.revision);
 assert.notEqual(a.timingSource.revision,parseQRC(xml('[0,1000]A(0,500)'),{songId:124}).timingSource.revision);
 const precise=parseQRC(xml('[0,1000]A(0,500)'),{songId:123,duration:10,durationResolution:1});
 assert.deepEqual(a.lines,precise.lines);assert.notEqual(a.timingSource.revision,precise.timingSource.revision);
 assert.equal(a.durationResolution,undefined);assert.equal(precise.durationResolution,1);
});
test('one source-millisecond container rounding uses the final supplied cue endpoint without altering word times',()=>{
 const row='[0,425]A(0,260)B(260,166)',r=parse(row);
 assert.equal(r.lines[0].vocalTiming.end,.426);
 assert.deepEqual(r.lines[0].vocalTiming.segments.map(s=>[s.start,s.end]),[[0,.26],[.26,.426]]);
 assert.notEqual(r.timingSource.revision,parse(row.replace('[0,425]','[0,426]')).timingSource.revision);
 for(const body of ['[0,425]A(0,260)B(260,167)','[0,425]A(0,300)B(260,166)','[0,425]A(0,-1)B(260,166)'])
  assert.equal(parse(body).lines[0].vocalTiming,undefined);
 const atBoundary=parseQRC(xml('[0,9999]A(0,10000)'),{songId:123,duration:9,durationResolution:1});
 assert.equal(atBoundary.lines[0].vocalTiming,undefined,'a row envelope cannot relax the source duration ceiling');
});
test('strict codec rejects malformed hex, extra payloads, bad UTF8 and inflate bombs',()=>{
 for(const hex of ['', '0', 'ff'.repeat(7), 'gg'.repeat(8), '00'.repeat(8)+' ', '00'.repeat(MAX_QRC_ENCRYPTED_BYTES+8), fixtures.invalidUTF8Hex, fixtures.expansionHex, fixtures.trailingNonzeroHex]) {
  assert.throws(()=>decryptQRC(hex));assert.equal(parseEncryptedQRC(hex,{songId:123}),null);
 }
});
