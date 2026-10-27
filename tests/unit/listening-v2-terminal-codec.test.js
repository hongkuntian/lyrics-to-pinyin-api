import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTerminalPayload,TERMINAL_PAYLOAD_VERSION,TERMINAL_PAYLOAD_MAX_BYTES}
 from '../../api/utils/listening-v2/terminal-codec.js';

// AUTHORED SOURCE ONLY. Root runs actual red/green after applying the patch.
const M=9007199254740991,U='ffffffff-ffff-ffff-ffff-ffffffffffff';
const env='preview:'+'z'.repeat(120),digest='a'.repeat(64);
const selectors=[{kind:'credential',value:digest},
 {kind:'installation',value:digest,bindingVersion:1,throughGeneration:0},
 {kind:'private-transfer',targetEnvironment:'preview:other',personaID:U,fromGeneration:0,toGeneration:1}];
const payload=(selector=selectors[0],extra={})=>({version:2,environment:'test',selector,
 invalidatedAtMS:0,phase:'rooms',cursor:null,...extra});
const repair={rootJobID:U,predecessorJobID:U,originalCreatedAtMS:0,originalRetryUntilMS:86400000,repairOrdinal:1};
const invalid=raw=>assert.throws(()=>parseTerminalPayload(raw),{code:'invalid_request'});
const reject=value=>invalid(JSON.stringify(value));
function frozen(value){
 if(value&&typeof value==='object'){assert.ok(Object.isFrozen(value));for(const child of Object.values(value))frozen(child);}
}

test('frozen API constants and all closed selector/phase/repair representations',()=>{
 assert.equal(TERMINAL_PAYLOAD_VERSION,2);assert.equal(TERMINAL_PAYLOAD_MAX_BYTES,4096);
 for(const selector of selectors)for(const extra of [{},{cursor:['preview:other',U]},
  {phase:'complete'},{repair},{repair,cursor:[env,U]}]){
  const value=payload(selector,extra),raw=JSON.stringify(value),before=structuredClone(value);
  const result=parseTerminalPayload(raw);assert.deepEqual(result,value);frozen(result);
  assert.deepEqual(value,before);assert.equal(raw,JSON.stringify(value));
 }
 const max=payload({kind:'installation',value:digest,bindingVersion:1,throughGeneration:M},
  {environment:env,invalidatedAtMS:M,cursor:[env,U],repair:{...repair,originalCreatedAtMS:M,
   originalRetryUntilMS:M,repairOrdinal:M}});
 assert.deepEqual(parseTerminalPayload(JSON.stringify(max)),max);
 const transfer=payload({...selectors[2],targetEnvironment:env,fromGeneration:M-1,toGeneration:M});
 assert.deepEqual(parseTerminalPayload(JSON.stringify(transfer)),transfer);
});

test('no unknown, discarded, defaulted or misplaced fields at any level',()=>{
 for(const field of Object.keys(payload())){const p=payload();delete p[field];reject(p);}
 for(const field of ['repair','bearer','principalID','provider','sql','permission','endSuccess','versionAlias','__proto__']){
  if(field==='repair')reject({...payload(),repair:null});
  else invalid(JSON.stringify(payload()).replace(/}$/,','+JSON.stringify(field)+':true}'));
 }
 for(const selector of selectors){
  for(const field of Object.keys(selector)){const s={...selector};delete s[field];reject(payload(s));}
  reject(payload({...selector,extra:true}));
 }
 for(const field of Object.keys(repair)){const r={...repair};delete r[field];reject(payload(selectors[0],{repair:r}));}
 reject(payload(selectors[0],{repair:{...repair,extra:1}}));
 for(const selector of [{kind:'guest-key',value:digest},{kind:'credential',value:digest.toUpperCase()},
  {...selectors[1],bindingVersion:2},{...selectors[1],throughGeneration:-1},
  {...selectors[2],fromGeneration:1,toGeneration:1},{...selectors[2],fromGeneration:M,toGeneration:M},
  {...selectors[2],personaID:U.toUpperCase()},{...selectors[2],targetEnvironment:'preview'}])reject(payload(selector));
 for(const cursor of [[],['test'],['test',U,0],['preview',U],['test',U.toUpperCase()],{},0])reject(payload(selectors[0],{cursor}));
 for(const phase of ['other',null,0])reject(payload(selectors[0],{phase}));
 reject(payload(selectors[0],{phase:'complete',cursor:['test',U]}));
 for(const environment of ['preview','preview:','preview:-a','preview:'+'a'.repeat(121),'TEST','test\u0000','é'])reject(payload(selectors[0],{environment}));
 for(const r of [{...repair,repairOrdinal:0},{...repair,originalRetryUntilMS:-1},
  {...repair,originalRetryUntilMS:86400001},{...repair,originalCreatedAtMS:1,originalRetryUntilMS:0}])reject(payload(selectors[0],{repair:r}));
 reject(payload(selectors[0],{invalidatedAtMS:1,repair}));
});

test('raw string only, before reflection/coercion or JSON serialization',()=>{
 let touched=0;
 const trap=new Proxy({},{get(){touched++;throw Error('trap');},ownKeys(){touched++;throw Error('trap');},
  getPrototypeOf(){touched++;throw Error('trap');},getOwnPropertyDescriptor(){touched++;throw Error('trap');}});
 for(const value of [trap,{toJSON(){touched++;}},new String('{}'),null,[],1,1n,undefined,()=>{}])invalid(value);
 assert.equal(touched,0);
});

test('reuses bounded parser: duplicates, escaped aliases and raw numeric tokens refuse',()=>{
 const raw=JSON.stringify(payload());
 for(const addition of ['"version":2','"\\u0076ersion":2','"extra":9007199254740993','"extra":1e0'])
  invalid(raw.replace(/}$/,','+addition+'}'));
 invalid(raw.replace('"kind":"credential"','"kind":"credential","\\u006bind":"credential"'));
 for(const token of ['-0','-1','0.5','0.0','1e0','9007199254740992','9007199254740993','NaN','Infinity','null','"0"'])
  invalid(raw.replace('"invalidatedAtMS":0','"invalidatedAtMS":'+token));
 invalid(raw.replace('"version":2','"version":2.0'));
 for(const root of ['null','[]','true','{}','{',''])invalid(root);
 invalid('{"x":'+ '['.repeat(25)+'0'+']'.repeat(25)+'}');
 invalid('{"x":['+'0,'.repeat(1800)+'0]}');
});

test('UTF-8 raw byte cap applies before parse; boundary whitespace is preserved',()=>{
 const raw=JSON.stringify(payload()),at=raw+' '.repeat(4096-Buffer.byteLength(raw));
 assert.equal(Buffer.byteLength(at),4096);assert.deepEqual(parseTerminalPayload(at),payload());
 invalid(at+' ');invalid('é'.repeat(2049));invalid(' '.repeat(4097));
 for(const value of ['\u0000','\ud800','\udfff'])reject(payload(selectors[0],{environment:value}));
 // Every permitted string is ASCII-bounded. A complete maximal future repair,
 // numeric-width and 128-byte cursor representation is <4096, checked against
 // actual SQL independently in the integration suite, not by this test's math.
});
