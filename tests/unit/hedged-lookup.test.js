import test from 'node:test';
import assert from 'node:assert/strict';
import {hedgedLookup} from '../../api/utils/hedged-lookup.js';
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const tick=()=>new Promise(r=>setImmediate(r));
const until=async predicate=>{for(let attempt=0;attempt<100&&!predicate();attempt++)await tick();assert.ok(predicate(),'expected lookup event');};
const plain={song:{duration:100},lyrics:{lines:[{text:'words',timestamp:null}]}},timed={song:{duration:100},lyrics:{lines:[{text:'words',timestamp:12}]}};
for(const cause of ['earlier-formatter-finishes','untimed-grace-expires'])test(`known complete timing wins while presentation is pending: ${cause}`,async()=>{
 const a=defer(),b=defer();let pending=0;
 const winner=hedgedLookup(['plain','timed'],async name=>name==='plain'?plain:timed,{delayMs:1,untimedGraceMs:5,onCandidate:async candidate=>{pending++;await(candidate===plain?a:b).promise;}});
 await until(()=>pending>=2);
 if(cause==='earlier-formatter-finishes')a.resolve();else await new Promise(r=>setTimeout(r,10));
 assert.equal(await winner,timed);a.resolve();b.resolve();
});
test('timed romanization cannot abort a slower native plain source or publish before fallback exhaustion',async()=>{
 const nativeReady=defer(),published=[];
 const romanized={...timed,target:{title:'紅日'},lyrics:{lines:[{text:'Meng wan jau shuin',timestamp:12}]}};
 const native={...plain,target:{title:'紅日'},lyrics:{lines:[{text:'这是测试歌词',timestamp:null}]}};
 let nativeStarted=false;
 const work=hedgedLookup(['romanized','native'],async name=>{
  if(name==='romanized')return romanized;
  nativeStarted=true;await nativeReady.promise;return native;
 },{delayMs:1,untimedGraceMs:1,scriptGraceMs:100,onCandidate:value=>published.push(value)});
 await until(()=>nativeStarted);
 assert.deepEqual(published,[]);
 nativeReady.resolve();
 assert.equal(await work,native);assert.deepEqual(published,[native]);
 assert.equal(await hedgedLookup(['only'],async()=>romanized),romanized);
});
test('script fallback window is fixed, bounded and cancels remaining work',async context=>{
 context.mock.timers.enable({apis:['setTimeout','Date']});
 const romanized={...timed,target:{title:'紅日'}},second=defer(),third=defer();
 const started=[],signals=[];let settled=false;
 const work=hedgedLookup(['first','second','third'],async(name,signal)=>{
  started.push(name);signals.push(signal);
  if(name==='first')return romanized;
  await(name==='second'?second:third).promise;return romanized;
 },{scriptGraceMs:20,onCandidate:()=>assert.fail('fallback must not publish progressively')}).then(value=>{settled=true;return value;});
 await until(()=>started.length===3);
 context.mock.timers.tick(15);second.resolve();await tick();
 assert.equal(settled,false);
 context.mock.timers.tick(5);assert.equal(await work,romanized);
 assert.equal(signals[2].aborted,true);third.resolve();
});
test('native words clear the script timer and retain the normal measured opportunity',async context=>{
 context.mock.timers.enable({apis:['setTimeout','Date']});
 const romanized={...timed,target:{title:'紅日'}},native={...plain,target:{title:'紅日'},lyrics:{lines:[{text:'原文测试歌词',timestamp:null}]}};
 const nativeReady=defer(),wordReady=defer(),published=[];
 const capable={name:'word',supportsVocalTiming:true};let wordStarted=false,settled=false;
 const work=hedgedLookup(['romanized','native',capable],async name=>{
  if(name==='romanized')return romanized;
  if(name==='native'){await nativeReady.promise;return native;}
  wordStarted=true;await wordReady.promise;return null;
 },{scriptGraceMs:20,wordTimingGraceMs:100,onCandidate:value=>published.push(value)}).then(value=>{settled=true;return value;});
 await until(()=>wordStarted);context.mock.timers.tick(10);nativeReady.resolve();
 await until(()=>published.includes(native));context.mock.timers.tick(11);await tick();
 assert.equal(settled,false);wordReady.resolve();assert.equal(await work,native);
});
