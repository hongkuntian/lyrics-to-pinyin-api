import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createInstallBinding,INSTALL_BINDING_VERSION} from '../../api/utils/listening-v2/install-binding.js';
import {SessionV2Error} from '../../api/utils/listening-v2/errors.js';

// Authored before the component. Literal frames/digests were calculated with
// Python stdlib bytes/struct.pack('>I')/SHA256, without importing application code.
const vectors=[
 {
  "name": "incremental",
  "tuple": {
   "key_id": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
   "bundle_id": "com.test.Lyrica",
   "audience": "test",
   "environment": "development"
  },
  "frameHex": "6c79726963612e73657373696f6e732e706879736963616c2d696e7374616c6c2e76310000000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f0000000f636f6d2e746573742e4c797269636100000004746573740000000b646576656c6f706d656e74",
  "frameBytes": 114,
  "scope": "765a7e146db7177aad6de946fc3c76ab817d43ecc4caf44bfb494f03b9f5a456"
 },
 {
  "name": "zero-production",
  "tuple": {
   "key_id": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
   "bundle_id": "com.test.Lyrica",
   "audience": "test",
   "environment": "production"
  },
  "frameHex": "6c79726963612e73657373696f6e732e706879736963616c2d696e7374616c6c2e7631000000002000000000000000000000000000000000000000000000000000000000000000000000000f636f6d2e746573742e4c797269636100000004746573740000000a70726f64756374696f6e",
  "frameBytes": 113,
  "scope": "c9e319cf36f7e31c316f47185e27b520635d150eb4f97da763366bd48b04ff28"
 },
 {
  "name": "all-ff",
  "tuple": {
   "key_id": "//////////////////////////////////////////8=",
   "bundle_id": "com.test.Lyrica",
   "audience": "test",
   "environment": "development"
  },
  "frameHex": "6c79726963612e73657373696f6e732e706879736963616c2d696e7374616c6c2e76310000000020ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000f636f6d2e746573742e4c797269636100000004746573740000000b646576656c6f706d656e74",
  "frameBytes": 114,
  "scope": "988b2b573bc961e070cb113c9eb3f58f558d9a5fd6514549b99f9c712052611c"
 },
 {
  "name": "guest-key3",
  "tuple": {
   "key_id": "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM=",
   "bundle_id": "com.test.Lyrica",
   "audience": "test",
   "environment": "development"
  },
  "frameHex": "6c79726963612e73657373696f6e732e706879736963616c2d696e7374616c6c2e7631000000002003030303030303030303030303030303030303030303030303030303030303030000000f636f6d2e746573742e4c797269636100000004746573740000000b646576656c6f706d656e74",
  "frameBytes": 114,
  "scope": "339527c97c31d627a521a750158bc7c7e06ff4e3b97fab36a26ac2a170e5770d"
 },
 {
  "name": "sibling-key4",
  "tuple": {
   "key_id": "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ=",
   "bundle_id": "com.test.Lyrica",
   "audience": "test",
   "environment": "development"
  },
  "frameHex": "6c79726963612e73657373696f6e732e706879736963616c2d696e7374616c6c2e7631000000002004040404040404040404040404040404040404040404040404040404040404040000000f636f6d2e746573742e4c797269636100000004746573740000000b646576656c6f706d656e74",
  "frameBytes": 114,
  "scope": "4296dc39ea889b9092c8c9fea7bc9d21e29de838b87632aa0858d16baae9fe15"
 },
 {
  "name": "concat-left",
  "tuple": {
   "key_id": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
   "bundle_id": "com.test",
   "audience": "ab",
   "environment": "development"
  },
  "frameHex": "6c79726963612e73657373696f6e732e706879736963616c2d696e7374616c6c2e76310000000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00000008636f6d2e746573740000000261620000000b646576656c6f706d656e74",
  "frameBytes": 105,
  "scope": "4f007eefa911f812a7c995fb85590148aa48ad382ca641bb2ebf4df5796da31e"
 },
 {
  "name": "concat-right",
  "tuple": {
   "key_id": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
   "bundle_id": "com.testa",
   "audience": "b",
   "environment": "development"
  },
  "frameHex": "6c79726963612e73657373696f6e732e706879736963616c2d696e7374616c6c2e76310000000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00000009636f6d2e746573746100000001620000000b646576656c6f706d656e74",
  "frameBytes": 105,
  "scope": "8a37996391cf081468c197a1e90804538a95ce1478d83039bdfb160a4300f955"
 }
];
const policy=()=>({audience:'test',environment:'development',prefix:'ABCDEFGHIJ',bundles:['com.test.Lyrica']});
const tuple=()=>({...vectors[0].tuple});
const raw=JSON.stringify;
const binding=p=>createInstallBinding({policy:p??policy()});
const error=code=>value=>value instanceof SessionV2Error&&value.code===code&&value.message===code&&
 value.status===(code==='unavailable'?503:400)&&!Object.hasOwn(value,'cause');
const invalid=fn=>assert.throws(fn,error('invalid_request'));
const unavailable=fn=>assert.throws(fn,error('unavailable'));
const forTuple=value=>binding({...policy(),audience:value.audience,environment:value.environment,bundles:[value.bundle_id]});

test('version1 returns only a lowercase digest using independent exact binary frames',()=>{
 assert.equal(INSTALL_BINDING_VERSION,1);
 for(const vector of vectors){
  const frame=Buffer.from(vector.frameHex,'hex');
  assert.equal(frame.length,vector.frameBytes);
  assert.equal(createHash('sha256').update(frame).digest('hex'),vector.scope);
  const scope=forTuple(vector.tuple).deriveScope(raw(vector.tuple));
  assert.equal(typeof scope,'string');assert.match(scope,/^[a-f0-9]{64}$/);assert.equal(scope,vector.scope);
 }
 const value=binding();assert(Object.isFrozen(value));assert.deepEqual(Object.keys(value),['deriveScope']);
 assert.throws(()=>{value.deriveScope=()=>true;},TypeError);
});
test('the domain has exactly one NUL and lengths count decoded K and exact field bytes',()=>{
 const v=vectors[0],frame=Buffer.from(v.frameHex,'hex'),domain=Buffer.from('lyrica.sessions.physical-install.v1');
 assert.deepEqual(frame.subarray(0,domain.length),domain);assert.equal(frame[domain.length],0);
 let at=domain.length+1;
 for(const bytes of [Buffer.from(v.tuple.key_id,'base64'),Buffer.from(v.tuple.bundle_id),Buffer.from(v.tuple.audience),Buffer.from(v.tuple.environment)]){
  assert.equal(frame.readUInt32BE(at),bytes.length);at+=4;
  assert.deepEqual(frame.subarray(at,at+bytes.length),bytes);at+=bytes.length;
 }
 assert.equal(at,frame.length);
 for(const wrong of [Buffer.from(raw(v.tuple)),Buffer.from(v.tuple.key_id),
  Buffer.concat([domain,frame.subarray(domain.length+1)]),
  Buffer.concat([domain,Buffer.alloc(2),frame.subarray(domain.length+1)]),
  Buffer.concat([Buffer.from('lyrica.sessions.physical-install.v2\0'),frame.subarray(domain.length+1)])])
  assert.notEqual(binding().deriveScope(raw(v.tuple)),createHash('sha256').update(wrong).digest('hex'));
});
test('length prefixes distinguish otherwise identical concatenated metadata',()=>{
 const left=vectors.find(v=>v.name==='concat-left'),right=vectors.find(v=>v.name==='concat-right');
 assert.equal(left.tuple.bundle_id+left.tuple.audience,right.tuple.bundle_id+right.tuple.audience);
 assert.notEqual(left.frameHex,right.frameHex);assert.notEqual(left.scope,right.scope);
 assert.equal(forTuple(left.tuple).deriveScope(raw(left.tuple)),left.scope);
 assert.equal(forTuple(right.tuple).deriveScope(raw(right.tuple)),right.scope);
});
test('JSON field order, valid escaped values and whitespace do not alter exact tuple bytes',()=>{
 const t=tuple(),derive=binding().deriveScope,expected=vectors[0].scope;
 const reordered=raw({environment:t.environment,audience:t.audience,bundle_id:t.bundle_id,key_id:t.key_id});
 const escaped=raw(t).replace('com.test.Lyrica',String.raw`com\u002etest.Lyrica`).replace('development',String.raw`\u0064evelopment`)
  .replace('test"',String.raw`\u0074est"`).replace('AAECA',String.raw`\u0041AECA`);
 assert(escaped.includes(String.raw`\u002e`));
 for(const text of [raw(t),reordered,' \n\t'+reordered+'\r\n',escaped,raw(t).replace('"key_id"',String.raw`"key\u005fid"`)])
  assert.equal(derive(text),expected);
});
test('each admitted tuple field affects the scope, preserving case and exact spelling',()=>{
 const t=tuple(),original=binding().deriveScope(raw(t));
 for(const changed of [{...t,key_id:vectors[2].tuple.key_id},{...t,bundle_id:'com.test.lyrica'},
  {...t,audience:'Test'},{...t,environment:'production'}])
  assert.notEqual(forTuple(changed).deriveScope(raw(changed)),original);
});
test('App ID prefix is validated but never inserted, hashed or reconstructed',()=>{
 const t=tuple();assert.equal(binding({...policy(),prefix:'0123456789'}).deriveScope(raw(t)),vectors[0].scope);
 const frame=Buffer.from(vectors[0].frameHex,'hex');
 assert.notEqual(createHash('sha256').update(Buffer.concat([Buffer.from(policy().prefix),frame])).digest('hex'),vectors[0].scope);
 for(const prefix of ['',null,1234567890,'abcdef1234','ABCDEFGHIJK','ABCDEFGHI\n'])unavailable(()=>binding({...policy(),prefix}));
});
test('constructor snapshots config without freezing or mutating caller-owned policy',()=>{
 const p=policy(),before=raw(p),b=binding(p),t=tuple();assert.equal(raw(p),before);
 assert.equal(Object.isFrozen(p),false);assert.equal(Object.isFrozen(p.bundles),false);
 p.audience='other';p.environment='production';p.prefix='0123456789';p.bundles[0]='other.app';p.bundles.push('new.app');
 assert.equal(b.deriveScope(raw(t)),vectors[0].scope);
 invalid(()=>b.deriveScope(raw({...t,bundle_id:'other.app'})));
 const frozen=Object.freeze({...policy(),bundles:Object.freeze(['com.test.Lyrica'])});
 assert.equal(binding(frozen).deriveScope(raw(t)),vectors[0].scope);
});
test('caller raw input remains byte-identical and results carry no authority fields',()=>{
 const t=Object.freeze(tuple()),text=raw(t),b=binding(),scope=b.deriveScope(text);
 assert.equal(text,raw(t));assert.deepEqual(t,vectors[0].tuple);assert.equal(scope,vectors[0].scope);
 for(const key of ['user_id','principalID','credentialDigest','bearer','connectionID','provider','device','mode',
  'sessions_install_binding_version','known','authorized','generation','receipt','prefix'])invalid(()=>b.deriveScope(raw({...t,[key]:'forged'})));
});
test('malformed explicit server policy is unavailable; no env/default policy is consulted',()=>{
 for(const input of [undefined,null,{},[],{policy:null},{policy:'test'}])unavailable(()=>createInstallBinding(input));
 for(const patch of [{audience:''},{audience:'x'.repeat(65)},{audience:'test\n'},{audience:'tést'},
  {audience:'test audience'},{audience:1},{environment:'test'},{environment:'preview:x'},{environment:'Production'},
  {bundles:[]},{bundles:'com.test.Lyrica'},{bundles:[null]},{bundles:['']},{bundles:['a'.repeat(129)]},
  {bundles:['com.test/lyrica']},{bundles:['com.test.Lyrica\n']},{bundles:['界']}])unavailable(()=>binding({...policy(),...patch}));
 const p={audience:'a'.repeat(64),environment:'production',prefix:'A0B1C2D3E4',bundles:['b'.repeat(128)]};
 const t={...tuple(),audience:p.audience,environment:p.environment,bundle_id:p.bundles[0]};
 assert.match(binding(p).deriveScope(raw(t)),/^[a-f0-9]{64}$/);
});
test('constructor bounds bundles before indexing and refuses proxy/accessor configuration',()=>{
 const p={...policy(),bundles:Array.from({length:64},(_,i)=>'bundle.'+i)};
 assert.match(binding(p).deriveScope(raw({...tuple(),bundle_id:'bundle.63'})),/^[a-f0-9]{64}$/);
 let touched=0;const tooMany=Array(65);Object.defineProperty(tooMany,'0',{get(){touched++;throw Error('read');}});
 unavailable(()=>binding({...policy(),bundles:tooMany}));assert.equal(touched,0);
 const accessor={...policy()};Object.defineProperty(accessor,'audience',{get(){touched++;throw Error('read');}});
 unavailable(()=>binding(accessor));assert.equal(touched,0);
 const proxy=new Proxy(policy(),{get(){touched++;throw Error('read');},ownKeys(){touched++;throw Error('keys');},getPrototypeOf(){touched++;throw Error('prototype');}});
 unavailable(()=>binding(proxy));unavailable(()=>binding({...policy(),bundles:new Proxy([], {get(){touched++;throw Error('read');}})}));
 const sparse=Array(1);unavailable(()=>binding({...policy(),bundles:sparse}));assert.equal(touched,0);
});
test('preparsed objects and proxies refuse before property reads, enumeration or JSON parsing',()=>{
 let touches=0,parses=0;const traps={get(){touches++;throw Error('get');},ownKeys(){touches++;throw Error('keys');},
  getPrototypeOf(){touches++;throw Error('prototype');},getOwnPropertyDescriptor(){touches++;throw Error('descriptor');}};
 const revoked=Proxy.revocable({},traps);revoked.revoke();
 const values=[tuple(),new Proxy({},traps),revoked.proxy,new Proxy(new String(raw(tuple())),traps),
  new String(raw(tuple())),Buffer.from(raw(tuple())),new Uint8Array(1),[],null,undefined,12,true,1n,()=>{}];
 const b=binding(),parse=JSON.parse;
 try{JSON.parse=(...args)=>{parses++;return parse(...args);};for(const value of values)invalid(()=>b.deriveScope(value));}
 finally{JSON.parse=parse;}
 assert.equal(touches,0);assert.equal(parses,0);
});
test('own 2048 UTF8-byte cap runs before parsing and preserves valid exact boundary input',()=>{
 const b=binding(),text=raw(tuple()),padded=text+' '.repeat(2048-Buffer.byteLength(text));
 assert.equal(Buffer.byteLength(padded),2048);assert.equal(b.deriveScope(padded),vectors[0].scope);
 const multibyte='{"unexpected":"'+'界'.repeat(700)+'"}';assert(multibyte.length<2048);assert(Buffer.byteLength(multibyte)>2048);
 let parses=0;const parse=JSON.parse;
 try{JSON.parse=(...args)=>{parses++;return parse(...args);};
  for(const value of [padded+' ',multibyte,' '.repeat(2049)])invalid(()=>b.deriveScope(value));}
 finally{JSON.parse=parse;}
 assert.equal(parses,0);
});
test('K must be canonical standard base64, decode to32 bytes, then reencode exactly',()=>{
 const b=binding(),t=tuple(),allFF=vectors[2].tuple.key_id;
 for(const key_id of ['',null,32,{},[],t.key_id.slice(0,-1),t.key_id+'=',t.key_id+'\n',' '+t.key_id,
  t.key_id.slice(0,-2)+'9=',allFF.replaceAll('/','_'),allFF.replaceAll('/','-'),
  Buffer.alloc(31).toString('base64'),Buffer.alloc(33).toString('base64'),'!'.repeat(43)+'='])
  invalid(()=>b.deriveScope(raw({...t,key_id})));
 assert.equal(b.deriveScope(raw({...t,key_id:allFF})),vectors[2].scope);
});
test('tuple metadata must exactly match captured AppAuth policy without normalization/defaults',()=>{
 const b=binding(),t=tuple();
 for(const patch of [{audience:'Test'},{audience:'test '},{audience:''},{environment:'production'},{environment:'test'},
  {environment:'development\n'},{bundle_id:'com.test.lyrica'},{bundle_id:'com.test.Lyrica.'},{bundle_id:'com.test.Lyrica\n'},
  {bundle_id:null},{audience:[]},{environment:1}])invalid(()=>b.deriveScope(raw({...t,...patch})));
 for(const field of Object.keys(t)){const missing={...t};delete missing[field];invalid(()=>b.deriveScope(raw(missing)));}
});
test('raw JSON rejects duplicate/escaped aliases, unknown members and malformed shapes',()=>{
 const b=binding(),text=raw(tuple());
 for(const value of ['','null','[]','true','123','"tuple"','{}',text.slice(0,-1),text+'{}',
  text.replace('"audience":"test"','"audience":"other","audience":"test"'),
  text.replace('"key_id":','"key\\u005fid":"ignored","key_id":'),
  text.replace('"audience":','"aud\\u0069ence":"test","audience":'),
  text.replace('"audience":','"audience":"test","audience":'),
  text.replace('"audience":','"constructor":{},"audience":'),raw({...tuple(),unexpected:true})])invalid(()=>b.deriveScope(value));
});
test('fractional, exponent and unsafe numeric tokens refuse even when later overwritten',()=>{
 const b=binding(),text=raw(tuple());
 for(const token of ['1.0','1e0','1e-1000','9007199254740991.1','9007199254740992','-1','0']){
  invalid(()=>b.deriveScope(text.replace('"audience":"test"','"audience":'+token)));
  invalid(()=>b.deriveScope(text.replace('"audience":"test"','"audience":'+token+',"audience":"test"')));
 }
});
test('reused structural admission refuses deep/wide input and nonstring tuple fields',()=>{
 const b=binding();
 const deep='{"x":'.repeat(26)+'0'+'}'.repeat(26);assert(Buffer.byteLength(deep)<2048);invalid(()=>b.deriveScope(deep));
 // The stricter2KiB raw limit dominates the reused4096-node limit; no claim of
 // reaching that node ceiling under this API. Wide inputs cannot bypass bytes.
 invalid(()=>b.deriveScope('{"x":['+'0,'.repeat(4096)+'0]}'));
 for(const field of Object.keys(tuple()))for(const value of [null,true,0,[],{}])invalid(()=>b.deriveScope(raw({...tuple(),[field]:value})));
});
