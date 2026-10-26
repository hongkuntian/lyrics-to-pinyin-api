import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalCommandHash} from '../../api/utils/listening-v2/tickets.js';

test('hashing admits bounded raw JSON and preserves canonical semantic identity',()=>{
 const first='{"version":2,"payload":{"title":"千千闋歌","order":["a","b"]},"action":"queue.move"}';
 const second=' { "action":"queue.move", "payload":{"order":["a","b"],"title":"千千闋歌"},"version":2 } ';
 assert.equal(canonicalCommandHash(first),canonicalCommandHash(second));
 const canonical='{"10":"x","2":"y","accent":"é","emoji":"🦜"}';
 assert.equal(canonicalCommandHash(canonical),createHash('sha256').update(canonical).digest('hex'));
});
test('oversized raw JSON refuses before parsing, including UTF8 and escaping',()=>{
 const parse=JSON.parse;let parses=0;
 try{
  JSON.parse=(...args)=>{parses++;return parse(...args);};
  for(const raw of ['{"'+'k'.repeat(262144)+'":0}',JSON.stringify({values:Array(32).fill('\u0000'.repeat(16384))}),
   '{"name":"'+'界'.repeat(5500)+'"}',JSON.stringify(Object.fromEntries(Array.from({length:5000},(_,i)=>['k'+i,0])))]){
   assert.throws(()=>canonicalCommandHash(raw),{code:'invalid_request'});
  }
 }finally{JSON.parse=parse;}
 assert.equal(parses,0,'Unbounded raw input must never reach JSON.parse or key enumeration');
});
test('preparsed caller objects refuse before any property enumeration',()=>{
 const values=[{safe:true},Object.fromEntries(Array.from({length:5000},(_,i)=>['k'+i,0])),Buffer.from('{}')];
 const hasOwn=Object.hasOwn;let enumerated=0;
 try{
  Object.hasOwn=(...args)=>{if(values.includes(args[0]))enumerated++;return hasOwn(...args);};
  for(const value of values){
   assert.throws(()=>canonicalCommandHash(value),{code:'invalid_request'});
  }
 }finally{Object.hasOwn=hasOwn;}
 assert.equal(enumerated,0,'Parsed objects have no trustworthy pre-enumeration admission bound');
});
test('admitted raw JSON still rejects unsafe numbers, excessive depth, sparse syntax and nonobject roots',()=>{
 let deep='{}';for(let i=0;i<30;i++)deep='{"child":'+deep+'}';
 for(const raw of ['{"n":9007199254740992}','{"n":1.5}','{"n":NaN}','{"values":[,1]}','null','[]','1',deep]){
  assert.throws(()=>canonicalCommandHash(raw),{code:'invalid_request'});
 }
});
test('numeric source syntax cannot round or underflow into an admitted integer',()=>{
 for(const token of ['1.0000000000000001','1e-1000','9007199254740991.1','1.0','1e0','-1.0000000000000001']){
  assert.throws(()=>canonicalCommandHash('{"n":'+token+'}'),{code:'invalid_request'},token);
 }
 for(const token of ['0','-1','9007199254740991','-9007199254740991']){
  assert.equal(canonicalCommandHash('{"n":'+token+'}'),createHash('sha256').update('{"n":'+token+'}').digest('hex'));
 }
 assert.doesNotThrow(()=>canonicalCommandHash('{"n":"1.0000000000000001"}'));
});
test('overwritten numeric tokens still obey admission while quoted escapes remain text',()=>{
 for(const token of ['1.0000000000000001','1e-1000','9007199254740991.1']){
  assert.throws(()=>canonicalCommandHash('{"n":'+token+',"n":1}'),{code:'invalid_request'});
 }
 const raw=JSON.stringify({quote:'\\"1e-1000',slash:'\\\\',key:'"',value:'1.0000000000000001'});
 assert.doesNotThrow(()=>canonicalCommandHash(raw));
});
