import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseQRC} from '../../api/utils/qq-qrc.js';
import {attachVocalTiming} from '../../api/utils/vocal-timing.js';
import {qqLanguageObservations,bindProviderLanguageObservations,resolveProviderLanguageEvidence} from '../../api/utils/provider-language-evidence.js';
import {analyzeLyricLanguage} from '../../api/utils/lyric-language.js';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/qrc-codec-fixtures.json',import.meta.url)));
const observedAt='2026-10-27T00:00:00.000Z',source={provider:'qq',id:'123'};
const capture=labels=>qqLanguageObservations(123,{track_info:{id:123,language:3},info:{lan:{title:'歌曲语种',content:labels.map(value=>({id:5,value}))}}},{observedAt});
const bind=record=>bindProviderLanguageObservations({lines:[]},{source:'qq',id:'123'},record,{field:'/data/lyric',format:'qrc'}).providerLanguageEvidence;
test('optional language evidence remains at most 4096 wire bytes, including unknown metadata',()=>{
 const lines=['Synthetic words'],analysis=analyzeLyricLanguage(lines);
 for(const count of [1,3,5,7])for(const length of [1,128,256]){
  const record=capture(Array.from({length:count},(_,i)=>String(i)+'字'.repeat(length-1)));
  const result=resolveProviderLanguageEvidence(lines,analysis,bind(record),source);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=4096);
 }
});
test('optional language evidence gives way before valid measured word timing at the durable response limit',()=>{
 const lyrics=parseQRC(fixture.validRaw,{songId:'123',duration:10});assert.ok(lyrics);
 const make=()=>({song:{id:123,duration:10},lines:lyrics.lines.map(l=>({original:l.text,timestamp:l.timestamp,vocalTiming:l.vocalTiming})),metadata:{}});
 const options={provider:'appleMusic',recordingID:'42',sourceID:'123'},baseline=attachVocalTiming(make(),lyrics,options);
 baseline.metadata.padding='x'.repeat(159800-Buffer.byteLength(JSON.stringify(baseline)));
 assert.ok(Buffer.byteLength(JSON.stringify(baseline))<160000);
 const evidence=resolveProviderLanguageEvidence(lyrics.lines.map(l=>l.text),analyzeLyricLanguage(lyrics.lines.map(l=>l.text)),bind(capture(['日语'])),source);
 const response=structuredClone(baseline);response.metadata.language_details={provider_evidence:evidence};
 assert.ok(Buffer.byteLength(JSON.stringify(response))>160000);
 attachVocalTiming(response,lyrics,options);
 assert.ok(response.lines.some(l=>l.vocalTiming));assert.ok(response.metadata.lyric_timing);
 assert.equal(response.metadata.language_details.provider_evidence,undefined);
 assert.ok(Buffer.byteLength(JSON.stringify(response))<=160000);
});
