import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {decodeKRC,parseKRC} from '../../api/utils/kugou-krc.js';
import {validVocalTiming} from '../../api/utils/vocal-timing.js';
import {encodeKRC} from '../helpers/kugou-krc.js';

const key=Buffer.from([64,71,97,119,94,50,116,71,81,54,49,45,206,210,110,105]);
const good='[ar:Invented Singer]\n[ti:Invented Song]\n[offset:0]\n[10000,2000]<0,0,0>!<0,500,9>你 <750,500,0>😀<1250,750,0>e\u0301\n[60000,2000]<0,1000,0>Invented <1000,1000,0>sky\n[120000,1000]Line without cues';
const parse=(raw=good,extra={})=>parseKRC(raw,{songId:'42',duration:240,...extra});

test('KRC container uses bounded base64, public format codec, inflate, and strict UTF8',()=>{
 assert.equal(decodeKRC(encodeKRC(good)),good);
 for(const input of ['@@@=',Buffer.from('wrong magic').toString('base64'),Buffer.from('krc1bad deflate').toString('base64'),encodeKRC('x'.repeat(524289)),encodeKRC('\u0000')])assert.equal(decodeKRC(input),null);
 const compressed=deflateSync(Buffer.from([0xc3,0x28]));
 assert.equal(decodeKRC(Buffer.concat([Buffer.from('krc1'),Buffer.from(compressed.map((b,i)=>b^key[i%16]))]).toString('base64')),null);
});
test('KRC token offsets are relative to their source line and preserve Unicode, gaps, and zero-duration text',()=>{
 const result=parse(),line=result.lines[0];
 assert.equal(line.text,'!你 😀e\u0301');assert.equal(line.timestamp,10);
 assert.deepEqual(line.vocalTiming,{end:12,segments:[
  {utf16Start:1,utf16Length:2,text:'你 ',start:10,end:10.5},
  {utf16Start:3,utf16Length:2,text:'😀',start:10.75,end:11.25},
  {utf16Start:5,utf16Length:2,text:'e\u0301',start:11.25,end:12}]});
 assert.equal(validVocalTiming(line,{duration:240}),true);
 assert.equal(result.lines[2].vocalTiming,undefined);assert.equal(result.timingSource.source,'kugou:42:krc');
 assert.match(result.timingSource.revision,/^[a-f0-9]{64}$/);
 assert.equal(result.timingSource.revision,parse(good.replace(',9>',',7>')).timingSource.revision);
 assert.notEqual(result.timingSource.revision,parse(good.replace('750,500','750,450')).timingSource.revision);
});
test('decoded rows with invalid optional cues stay readable without manufactured durations',()=>{
 for(const body of ['<0,700,0>a<500,500,0>b','<-1,500,0>text','<0,1100,0>text','<0,-1,0>text','<0,x,0>text',
  '<0,500,0>e<500,500,0>\u0301','<0,500,0>👩<500,500,0>\u200d🚀','<0,0,0>zero']){
  const value=parse('[1000,1000]'+body);assert.ok(value?.lines[0].text,body);assert.equal(value.lines[0].vocalTiming,undefined,body);
 }
});
test('unknown rows, malformed markers, bounds, and unsupported global offsets reject the whole edition',()=>{
 for(const raw of [good+'\nunknown row',good+'\n[broken]','[offset:100]\n'+good,'[240000,1000]<0,1000,0>late',
  good+'\n[0,1000]<0,1000,0>backward','[0,1000]<0,500>lost','[0,1000]<0,1000,0>\ud800',
  '[0,1000]<0,1000,0>'+('x'.repeat(2001)),Array(251).fill('[0,1000]<0,1000,0>x').join('\n'),
  '[0,1000]'+Array(1025).fill('<0,0,0>x').join(''),'x'.repeat(524289)])assert.equal(parse(raw),null,raw.slice(0,60));
 assert.equal(parse(good,{songId:'other'}),null);assert.equal(parse(good,{duration:Infinity}),null);
});
test('source credits do not change sung-row timing revision and source IDs do',()=>{
 assert.equal(parse().timingSource.revision,parse(good.replace('Invented Singer','Another credit')).timingSource.revision);
 assert.notEqual(parse().timingSource.revision,parse(good,{songId:'43'}).timingSource.revision);
});
