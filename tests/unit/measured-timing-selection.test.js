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
const untimed={...line,lyrics:{...line.lyrics,lines:line.lyrics.lines.map(l=>({...l,timestamp:null}))}};

test('plain readable text cannot cancel an active measured source inside the existing word window',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const gate=deferred(),published=[];let settled=false,sourceSignal;
 const work=hedgedLookup([plain,capable],async(api,signal)=>{
  if(api===plain)return untimed;sourceSignal=signal;return gate.promise;
 },{delayMs:1,untimedGraceMs:20,wordTimingGraceMs:200,chooseCandidate:chooseLyricCandidate,onCandidate:c=>published.push(c)})
 .then(value=>{settled=true;return value;});
 try {
  await until(()=>published.includes(untimed)&&sourceSignal);
  t.mock.timers.tick(21);await new Promise(r=>setImmediate(r));
  assert.equal(settled,false);assert.equal(sourceSignal.aborted,false);assert.deepEqual(published,[untimed]);
  gate.resolve(measured);assert.equal(await work,measured);assert.deepEqual(published,[untimed,measured]);
 }finally{gate.resolve(null);await work;}
});

test('plain text preserves the existing line-to-word window, which later line progress cannot reset',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const first=deferred(),second=deferred(),third=deferred(),published=[];
 const secondAPI={...capable},thirdAPI={...capable};
 const work=hedgedLookup([plain,capable,secondAPI,thirdAPI],async api=>api===plain?untimed:api===capable?first.promise:api===secondAPI?second.promise:third.promise,
  {untimedGraceMs:3,wordTimingGraceMs:10,chooseCandidate:chooseLyricCandidate,onCandidate:c=>published.push(c)});
 await until(()=>published.length);t.mock.timers.tick(4);first.resolve(line);
 await until(()=>published.includes(line));t.mock.timers.tick(4);second.resolve(structuredClone(line));
 await until(()=>published.length===3);t.mock.timers.tick(6);assert.equal(await work,line);
 third.resolve(measured);await new Promise(r=>setImmediate(r));assert.ok(!published.includes(measured));
});

test('unavailable words and cancellation preserve already-readable plain text without a second lookup',async t=>{
 for(const cancel of [false,true]) {
  const gate=deferred(),controller=new AbortController(),published=[];let calls=0;
  const work=hedgedLookup([plain,capable],async api=>{calls++;return api===plain?untimed:gate.promise;},
   {delayMs:1,untimedGraceMs:20,wordTimingGraceMs:1000,signal:controller.signal,chooseCandidate:chooseLyricCandidate,onCandidate:c=>published.push(c)});
  await until(()=>published.length);if(cancel)controller.abort();else gate.resolve(null);
  assert.equal(await work,untimed);gate.resolve(measured);await new Promise(r=>setImmediate(r));
  assert.equal(calls,2);assert.deepEqual(published,[untimed]);
 }
});

test('instrumental or non-capable fallback retains the ordinary untimed grace',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const gate=deferred(),published=[],instrumental={...untimed,lyrics:{instrumental:true,lines:[]}};
 const work=hedgedLookup([plain,capable],async api=>api===plain?instrumental:gate.promise,
  {untimedGraceMs:20,wordTimingGraceMs:200,onCandidate:c=>published.push(c)});
 await until(()=>published.length);t.mock.timers.tick(20);assert.equal(await work,instrumental);gate.resolve(null);
});

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

test('line-synced lyrics publish immediately while the capable lookup remains eligible to improve them',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const gate=deferred(),ready=deferred(),published=[];let settled=false;
 const work=hedgedLookup([capable,plain],async api=>api===capable?gate.promise:line,
  {delayMs:1,wordTimingGraceMs:1000,chooseCandidate:chooseLyricCandidate,onCandidate:c=>{published.push(c);ready.resolve(c);}}).then(value=>{settled=true;return value;});
 try {
  t.mock.timers.tick(1);assert.equal(await ready.promise,line);assert.equal(settled,false);
  gate.resolve(measured);assert.equal(await work,measured);assert.deepEqual(published,[line,measured]);
 }finally{gate.resolve(measured);await work;}
});

test('unavailable measured source returns the readable line candidate without waiting for grace',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 const gate=deferred(),ready=deferred(),published=[];
 const work=hedgedLookup([capable,plain],async api=>api===capable?gate.promise:line,
  {delayMs:1,wordTimingGraceMs:1000,onCandidate:c=>{published.push(c);ready.resolve(c);}});
 try{
  t.mock.timers.tick(1);assert.equal(await ready.promise,line);gate.resolve(null);assert.equal(await work,line);
 }finally{gate.resolve(null);await work;}
});

test('upgrade timeout or cancellation fences a late measured result',async t=>{
 t.mock.timers.enable({apis:['setTimeout','Date']});
 for(const cancel of [false,true]){
  const gate=deferred(),ready=deferred(),published=[],controller=new AbortController();let settled=false;
  const work=hedgedLookup([capable,plain],async api=>api===capable?gate.promise:line,
   {delayMs:1,wordTimingGraceMs:5,signal:controller.signal,onCandidate:c=>{published.push(c);ready.resolve(c);}})
   .then(value=>{settled=true;return value;});
  try{
   t.mock.timers.tick(1);assert.equal(await ready.promise,line);assert.equal(settled,false);
   if(cancel)controller.abort();
   else{
    t.mock.timers.tick(4);await Promise.resolve();assert.equal(settled,false);
    t.mock.timers.tick(1);
   }
   assert.equal(await work,line);
   gate.resolve(measured);await new Promise(r=>setImmediate(r));assert.deepEqual(published,[line]);
  }finally{controller.abort();gate.resolve(measured);await work;}
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
