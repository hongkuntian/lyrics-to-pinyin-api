import test from 'node:test';
import assert from 'node:assert/strict';
import {hedgedLookup} from '../../api/utils/hedged-lookup.js';
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
const tick=()=>new Promise(r=>setImmediate(r));
const plain={song:{duration:100},lyrics:{lines:[{text:'words',timestamp:null}]}},timed={song:{duration:100},lyrics:{lines:[{text:'words',timestamp:12}]}};
for(const cause of ['earlier-formatter-finishes','untimed-grace-expires'])test(`known complete timing wins while presentation is pending: ${cause}`,async()=>{
 const a=defer(),b=defer();let pending=0;
 const winner=hedgedLookup(['plain','timed'],async name=>name==='plain'?plain:timed,{delayMs:1,untimedGraceMs:5,onCandidate:async candidate=>{pending++;await(candidate===plain?a:b).promise;}});
 while(pending<2)await tick();
 if(cause==='earlier-formatter-finishes')a.resolve();else await new Promise(r=>setTimeout(r,10));
 assert.equal(await winner,timed);a.resolve();b.resolve();
});
