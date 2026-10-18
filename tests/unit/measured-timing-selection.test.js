import test from 'node:test';
import assert from 'node:assert/strict';
import {parseYRC} from '../../api/utils/netease-yrc.js';
import {chooseMeasuredLyricCandidate as chooseLyricCandidate,measuredVocalCoverage} from '../../api/utils/lyric-selection.js';
import {hedgedLookup} from '../../api/utils/hedged-lookup.js';

const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
const until=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setImmediate(r));assert.ok(predicate(),'expected candidate event');};
const line={song:{id:7,duration:30},lyrics:{source:'lrclib',lines:[{text:'Synthetic first',timestamp:1},{text:'Synthetic second',timestamp:10}]}};
const measured={song:{id:42,duration:30},lyrics:parseYRC('[1000,1000](1000,500,0)Synthetic (1500,500,0)first\n[10000,1000](10000,500,0)Synthetic (10500,500,0)second',{songId:42,duration:30})};
const capable={name:'measured',supportsVocalTiming:true},plain={name:'line'};

test('validated measured cues improve complete line timing; malformed, unbound and partial cues do not',()=>{
 assert.equal(chooseLyricCandidate(line,measured),measured);
 assert.equal(chooseLyricCandidate(measured,line),measured);
 const invalid=structuredClone(measured);invalid.lyrics.lines[0].vocalTiming.segments[0].text='Wrong';invalid.lyrics.lines[1].vocalTiming.segments[0].text='Wrong';
 assert.equal(chooseLyricCandidate(line,invalid),line);
 const unbound=structuredClone(measured);unbound.lyrics.songId=99;
 assert.equal(chooseLyricCandidate(line,unbound),line);
 const partial=structuredClone(measured);partial.lyrics.partial=true;
 assert.equal(chooseLyricCandidate(line,partial),line);
 const reviewed={...line,timingCorrection:{basis:'recording_listening_review'}};
 assert.equal(chooseLyricCandidate(reviewed,measured),reviewed);
 const replacement={...line,timingCorrection:{status:'replacement',id:'reviewed-correction',source_fingerprint:'fixture'}};
 assert.equal(chooseLyricCandidate(replacement,measured),replacement);
});

test('line-synced lyrics publish immediately while the capable lookup remains eligible to improve them',async()=>{
 const gate=deferred(),published=[];let settled=false;
 const work=hedgedLookup([capable,plain],async api=>api===capable?gate.promise:line,
  {delayMs:1,wordTimingGraceMs:1000,chooseCandidate:chooseLyricCandidate,onCandidate:c=>{published.push(c);}}).then(value=>{settled=true;return value;});
 try {
  await until(()=>published.includes(line));assert.equal(settled,false);
  gate.resolve(measured);assert.equal(await work,measured);assert.deepEqual(published,[line,measured]);
 }finally{gate.resolve(measured);await work;}
});

test('unavailable measured source returns the readable line candidate without waiting for grace',async()=>{
 const gate=deferred(),published=[];
 const work=hedgedLookup([capable,plain],async api=>api===capable?gate.promise:line,
  {delayMs:1,wordTimingGraceMs:1000,onCandidate:c=>published.push(c)});
 await until(()=>published.length);gate.resolve(null);assert.equal(await work,line);
});

test('upgrade timeout or cancellation fences a late measured result',async()=>{
 for(const cancel of [false,true]){
  const gate=deferred(),published=[],controller=new AbortController();
  const work=hedgedLookup([capable,plain],async api=>api===capable?gate.promise:line,
   {delayMs:1,wordTimingGraceMs:5,signal:controller.signal,onCandidate:c=>published.push(c)});
  await until(()=>published.length);if(cancel)controller.abort();assert.equal(await work,line);
  gate.resolve(measured);await new Promise(r=>setImmediate(r));assert.deepEqual(published,[line]);
 }
});

test('no capable source preserves immediate line-timing completion',async()=>{
 const published=[];
 const result=await hedgedLookup([plain],async()=>line,{wordTimingGraceMs:1000,onCandidate:c=>published.push(c)});
 assert.equal(result,line);assert.deepEqual(published,[line]);
});

test('queued measured source starts within two slots even while line formatting is held',async()=>{
 const word=deferred(),other=deferred(),formatter=deferred();let active=0,maxActive=0;const calls=[];
 const a={name:'first'},b={name:'second'},c={name:'words',supportsVocalTiming:true};
 const work=hedgedLookup([a,b,c],async api=>{
  calls.push(api.name);maxActive=Math.max(maxActive,++active);
  try{return api===a?line:await(api===b?other:word).promise;}finally{active--;}
 },{wordTimingGraceMs:1000,chooseCandidate:chooseLyricCandidate,onCandidate:candidate=>candidate===line?formatter.promise:undefined});
 try{
  await until(()=>calls.includes('words'));assert.ok(maxActive<=2);
  word.resolve(measured);assert.equal(await work,measured);
 }finally{formatter.resolve();other.resolve(null);word.resolve(measured);await work;}
});

test('another line-timed result cannot reset the measured upgrade deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const first=deferred(),second=deferred(),published=[];
 const work=hedgedLookup([plain,capable,{...capable}],async api=>api===plain?line:api===capable?first.promise:second.promise,
  {wordTimingGraceMs:10,chooseCandidate:chooseLyricCandidate,onCandidate:c=>published.push(c)});
 await until(()=>published.length);t.mock.timers.tick(4);first.resolve(structuredClone(line));
 await new Promise(r=>setImmediate(r));t.mock.timers.tick(6);assert.equal(await work,line);
 second.resolve(measured);await new Promise(r=>setImmediate(r));assert.ok(!published.includes(measured));
});

test('measured selection compares exact meaningful grapheme coverage, including line-only rows',()=>{
 const sparse=structuredClone(measured);delete sparse.lyrics.lines[1].vocalTiming;
 assert.equal(chooseLyricCandidate(sparse,measured),measured);
 assert.equal(chooseLyricCandidate(measured,sparse),measured);
 assert.equal(chooseLyricCandidate(line,sparse),sparse);
 const unicode={song:{id:42,duration:30},lyrics:parseYRC('[1000,1000](1000,0,0)! (1000,1000,0)你😀e\u0301 2\n[10000,1000]---',{songId:42,duration:30})};
 assert.deepEqual(measuredVocalCoverage(unicode),{covered:3,total:3,complete:true});
 const bad=structuredClone(unicode);bad.lyrics.lines[0].vocalTiming.segments[0].utf16Length=1;
 assert.deepEqual(measuredVocalCoverage(bad),{covered:0,total:3,complete:false});
 const punctuation=structuredClone(unicode);punctuation.lyrics.lines=punctuation.lyrics.lines.slice(1);
 assert.deepEqual(measuredVocalCoverage(punctuation),{covered:0,total:0,complete:false});
 const unbound=structuredClone(measured);unbound.lyrics.timingSource.source='qq:42:qrc';
 assert.equal(measuredVocalCoverage(unbound).covered,0);
});

test('a sparse measured result stays readable while a fuller capable source is pending',async()=>{
 const sparse=structuredClone(measured);delete sparse.lyrics.lines[1].vocalTiming;
 const gate=deferred(),published=[];let settled=false;
 const work=hedgedLookup([capable,{...capable}],async api=>api===capable?sparse:gate.promise,
  {wordTimingGraceMs:1000,chooseCandidate:chooseLyricCandidate,onCandidate:c=>published.push(c)}).then(v=>{settled=true;return v;});
 try{await until(()=>published.includes(sparse));assert.equal(settled,false);gate.resolve(measured);assert.equal(await work,measured);}
 finally{gate.resolve(measured);await work;}
});

test('partial measured coverage survives deadline without resetting it or inventing cues',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const sparse=structuredClone(measured);delete sparse.lyrics.lines[1].vocalTiming;
 const gate=deferred(),published=[];
 const work=hedgedLookup([capable,{...capable}],async api=>api===capable?sparse:gate.promise,
  {wordTimingGraceMs:10,chooseCandidate:chooseLyricCandidate,onCandidate:c=>published.push(c)});
 await until(()=>published.length);t.mock.timers.tick(10);assert.equal(await work,sparse);
 gate.resolve(measured);await new Promise(r=>setImmediate(r));assert.deepEqual(published,[sparse]);
});
