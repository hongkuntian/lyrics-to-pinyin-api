import test from 'node:test';
import assert from 'node:assert/strict';
import {SessionV2Error} from '../../api/utils/listening-v2/errors.js';
import * as codec from '../../api/utils/listening-v2/privacy-codec.js';

// Auth/SQL composition and actual PG JSONB text comparisons are Root-owned.
// These tests are sealed BEFORE the behavior postimage and are unexecuted here.
const {decodePrivacyUInt,decodePersonaTuple,decodePrivacyDependency,decodePrivacyScrub,
 privacyScrubMarker,PRIVACY_CODEC_FIELDS,PRIVACY_CODEC_LIMITS}=codec;
const MAX=9007199254740991,DAY=86400000;
const ID='00000000-0000-0000-0000-000000000000';
const OTHER='ffffffff-ffff-ffff-ffff-ffffffffffff';
const THIRD='12345678-abcd-0000-0000-123456789abc';
const DIGEST='a'.repeat(64),KEY='A'.repeat(43)+'=';
const fields=['environment','persona_id','original_principal_id','original_key_id','controller_kind',
 'controller_principal_id','controller_key_id','privacy_generation','status','guest_credential_digest',
 'guest_credential_expires_at_ms','withdrawn_at_ms','scrub_due_at_ms','scrub_cursor','created_at_ms',
 'updated_at_ms','controller_privacy_epoch','private_transfer_from_generation'];
const guest=()=>['test',ID,'g','k','guest','g','k',0,'live',DIGEST,1000,null,null,null,0,0,0,null];
const apple=()=>['test',ID,'g','k','apple','a',null,1,'live',null,null,null,null,null,0,1,7,0];
const dependency=(selector={kind:'indexed-sweep'})=>({version:2,environment:'test',selector,cursor:null,
 invalidatedAtMS:selector.kind==='indexed-sweep'?null:0});
const scrub=(phase='rooms',cursor=null)=>({version:2,environment:'test',personaID:ID,
 privacyGeneration:1,withdrawnAtMS:0,scrubDueAtMS:1,phase,cursor});
const json=JSON.stringify;
const persona=(tuple,options)=>decodePersonaTuple(json(tuple),options);
const dep=value=>decodePrivacyDependency(json(value));
const job=value=>decodePrivacyScrub(json(value));
function bad(call){assert.throws(call,error=>error instanceof SessionV2Error&&error.code==='invalid_request'&&
 error.message==='invalid_request'&&error.status===400);}
function frozen(value){
 if(value!==null&&typeof value==='object'){
  assert.equal(Object.isFrozen(value),true);
  for(const child of Object.values(value))frozen(child);
 }
}
// Independent bounded reference: scan a compact JSON string and insert SQL
// whitespace only outside quoted strings. No recursive production encoder use.
function referenceText(value){
 let result='',quoted=false,escaped=false;
 for(const char of json(value)){
  result+=char;
  if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}
  else if(char==='"')quoted=true;
  else if(char===','||char===':')result+=' ';
 }
 return result;
}
const bytes=value=>Buffer.byteLength(referenceText(value));

test('seven closed exports and deeply frozen field/limit contracts',()=>{
 assert.deepEqual(Object.keys(codec).sort(),['PRIVACY_CODEC_FIELDS','PRIVACY_CODEC_LIMITS',
  'decodePersonaTuple','decodePrivacyDependency','decodePrivacyScrub','decodePrivacyUInt','privacyScrubMarker'].sort());
 assert.deepEqual(PRIVACY_CODEC_FIELDS.personaTuple,fields);
 assert.deepEqual(PRIVACY_CODEC_FIELDS.dependency,['version','environment','selector','cursor','invalidatedAtMS']);
 assert.deepEqual(PRIVACY_CODEC_FIELDS.scrub,['version','environment','personaID','privacyGeneration',
  'withdrawnAtMS','scrubDueAtMS','phase','cursor']);
 assert.equal(PRIVACY_CODEC_LIMITS.rawBytes,16384);
 assert.equal(PRIVACY_CODEC_LIMITS.personaBytes,512);
 assert.equal(PRIVACY_CODEC_LIMITS.dependencyBytes,512);
 assert.equal(PRIVACY_CODEC_LIMITS.scrubBytes,4096);
 assert.equal(PRIVACY_CODEC_LIMITS.markerBytes,41);
 frozen(PRIVACY_CODEC_FIELDS);frozen(PRIVACY_CODEC_LIMITS);
 bad(()=>decodePersonaTuple(json(guest()),{reserveFuture:'yes'}));
});

test('SQL uint admits canonical pg decimals, bigint and safe numbers with no rounding',()=>{
 for(const value of [0,1,MAX,'0','1','9007199254740991',0n,1n,9007199254740991n])
  assert.equal(decodePrivacyUInt(value),Number(value));
 for(const value of [-0,-1,1.1,NaN,Infinity,MAX+1,'','00','01','+1','-0','-1',' 1','1 ',
  '1.0','1e0','9007199254740992','18446744073709551615','1'.repeat(20000),
  -1n,9007199254740992n,9223372036854775807n,null,undefined,true,[],{},new Number(1)])bad(()=>decodePrivacyUInt(value));
 let traps=0;const proxy=new Proxy({}, {get(){traps++;throw Error('private');},
  ownKeys(){traps++;throw Error('private');},getPrototypeOf(){traps++;throw Error('private');}});
 bad(()=>decodePrivacyUInt(proxy));assert.equal(traps,0);
});

test('independent literal normalized-array and normalized-object golden byte vectors (PG unexecuted)',()=>{
 const guestText='["test", "00000000-0000-0000-0000-000000000000", "g", "k", "guest", "g", "k", 0, "live", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 1000, null, null, null, 0, 0, 0, null]';
 const appleText='["test", "00000000-0000-0000-0000-000000000000", "g", "k", "apple", "a", null, 1, "live", null, null, null, null, null, 0, 1, 7, 0]';
 const depText='{"version": 2, "environment": "test", "selector": {"kind": "indexed-sweep"}, "cursor": null, "invalidatedAtMS": null}';
 const scrubText='{"version": 2, "environment": "test", "personaID": "00000000-0000-0000-0000-000000000000", "privacyGeneration": 1, "withdrawnAtMS": 0, "scrubDueAtMS": 1, "phase": "rooms", "cursor": null}';
 for(const [value,text,count,decode] of [[guest(),guestText,195,persona],[apple(),appleText,131,persona],
  [dependency(),depText,117,dep],[scrub(),scrubText,187,job]]){
  assert.equal(referenceText(value),text);assert.equal(Buffer.byteLength(text),count);
  assert.equal(decode(value).normalizedBytes,count);
 }
});

test('valid live guest, direct Apple, transferred Apple, withdrawn and erased representations',()=>{
 const direct=apple();direct[17]=null;direct[7]=0;
 const withdrawn=guest();Object.assign(withdrawn,{7:1,8:'withdrawn',11:50,12:50+DAY,
  13:privacyScrubMarker(OTHER,'receipts'),15:60});
 const bridge=apple();Object.assign(bridge,{7:5,8:'withdrawn',11:2,12:2,15:3,17:0});
 const erased=bridge.slice();Object.assign(erased,{4:'erased',5:null,8:'erased'});
 for(const tuple of [guest(),direct,apple(),withdrawn,bridge,erased]){
  const result=persona(tuple);assert.deepEqual(result.tuple,tuple);
  for(let i=0;i<fields.length;i++)assert.equal(result[fields[i]],tuple[i]);
  assert.equal(result.normalizedBytes,bytes(tuple));assert.equal(result.futureNormalizedBytes,null);frozen(result);
 }
 const epochs=apple();epochs[16]=MAX;assert.equal(persona(epochs).controller_privacy_epoch,MAX);
});

test('persona shape and 030 domains/controller/status/time relations fail closed',()=>{
 for(const value of [{},[],guest().slice(0,-1),[...guest(),null]])bad(()=>persona(value));
 const cases={0:['Test','preview:','preview:_x','preview:a/b','preview:'+'a'.repeat(121)],
  1:[ID.toUpperCase().replace('00000000','ABCDEF00'),'not-a-uuid'],
  2:['','x'.repeat(161),'has\u0001control'],3:['','x'.repeat(161)],4:['unknown','Guest'],
  5:[null,'other'],6:[null,'other'],7:[-1,MAX+1,'1',null],8:['pending',null],
  9:[null,'A'.repeat(64),'b'.repeat(63)],10:[null,0,7776000001,'1000'],
  11:[0],12:[0],13:['p2:'+ID+':r'],14:[1,-1],15:[-1],16:[1,null],17:[0,1]};
 for(const [index,values] of Object.entries(cases))for(const value of values){
  const tuple=guest();tuple[Number(index)]=value;bad(()=>persona(tuple));
 }
 const edge=guest();edge[10]=7776000000;assert.equal(persona(edge).guest_credential_expires_at_ms,7776000000);
 for(const env of ['production','development','test','preview:A._-9','preview:'+'a'.repeat(120)]){
  const tuple=guest();tuple[0]=env;assert.equal(persona(tuple).environment,env);
 }
 const end=guest();Object.assign(end,{7:1,8:'withdrawn',11:1,12:DAY+2});bad(()=>persona(end));
 end[12]=0;bad(()=>persona(end));end[12]=null;bad(()=>persona(end));
 end[12]=1;end[13]='p2:'+ID+':rooms';bad(()=>persona(end));
 end[13]=null;assert.equal(persona(end).scrub_cursor,null);
});

test('new capture/bridge constraints do not invent a transfer or normalize opaque identities',()=>{
 for(const changes of [{6:'k'},{9:DIGEST},{10:1000},{17:1},{17:2},{17:-1},{17:'0'}]){
  const tuple=apple();Object.assign(tuple,changes);bad(()=>persona(tuple));
 }
 const malformed=apple();malformed[4]='erased';bad(()=>persona(malformed));
 const names=apple();names[2]=' e\u0301"\\🦜 ';names[3]='é';names[5]='target "\\';
 assert.equal(persona(names).original_principal_id,names[2]);
 assert.equal(persona(names).controller_principal_id,names[5]);
 const direct=apple();direct[17]=null;assert.equal(persona(direct).private_transfer_from_generation,null);
 // A snapshot cannot demonstrate capture/bridge immutability or initial INSERT authority.
});

test('raw decoders reject objects, Buffers, proxies and resource excess before reflection',()=>{
 const decoders=[decodePersonaTuple,decodePrivacyDependency,decodePrivacyScrub];
 let traps=0;const proxy=new Proxy({}, {get(){traps++;throw Error('secret');},
  ownKeys(){traps++;throw Error('secret');},getPrototypeOf(){traps++;throw Error('secret');}});
 const revoked=Proxy.revocable({},{});revoked.revoke();
 for(const decode of decoders)for(const value of [{},[],Buffer.from('{}'),proxy,revoked.proxy,undefined,null,1])bad(()=>decode(value));
 assert.equal(traps,0);
 const parse=JSON.parse;let calls=0;
 try{
  JSON.parse=(...args)=>{calls++;return parse(...args);};
  for(const decode of decoders)for(const raw of ['{"'+'k'.repeat(20000)+'":0}',
   '{"x":"'+'界'.repeat(6000)+'"}',' '.repeat(16385)])bad(()=>decode(raw));
 }finally{JSON.parse=parse;}
 assert.equal(calls,0);
 let depth='0';for(let i=0;i<26;i++)depth='{"x":'+depth+'}';
 const width='{"x":['+Array(4100).fill('0').join(',')+']}';
 for(const decode of decoders)for(const raw of [depth,width,'null','true','1','{"x":NaN}'])bad(()=>decode(raw));
 bad(()=>decodePersonaTuple(json(guest())+',"injected":true'));
});

test('strict source numbers, duplicate keys and escaped aliases survive no normalization loophole',()=>{
 for(const token of ['1e0','1E0','1e-1000','1.0','1.0000000000000001','9007199254740991.1','9007199254740992','-0']){
  bad(()=>decodePersonaTuple(json(guest()).replace(',0,"live"',','+token+',"live"')));
  bad(()=>decodePrivacyScrub(json(scrub()).replace('"privacyGeneration":1','"privacyGeneration":'+token)));
 }
 const duplicate=json(dependency()).replace('"version":2','"version":2,"version":2');
 const alias=json(dependency()).replace('"version":2','"version":2,"vers\\u0069on":2');
 const nested=json(dependency({kind:'credential',value:DIGEST})).replace('"kind":"credential"','"kind":"credential","k\\u0069nd":"credential"');
 for(const raw of [duplicate,alias,nested,'{"__proto__":0}','{"constructor":0}',
  json(dependency()).replace('"version":2','"version":1e0,"version":2')])bad(()=>decodePrivacyDependency(raw));
 const s=json(scrub()).replace('"phase":"rooms"','"phase":"rooms","ph\\u0061se":"rooms"');bad(()=>decodePrivacyScrub(s));
});

test('PostgreSQL-storable Unicode, escape accounting and the exact 512-byte aggregate',()=>{
 const unicode=guest();unicode[2]=unicode[5]='é"\\🦜';
 assert.equal(persona(unicode).normalizedBytes,bytes(unicode));
 for(const value of ['\u0000','\ud800','\udfff','a\ud800z']){
  const tuple=apple();tuple[2]=value;bad(()=>persona(tuple));
  const payload=dependency({kind:'guest-user',value});bad(()=>dep(payload));
 }
 // Search is bounded and uses an independent reference, never the decoder's count.
 let atLimit=null;
 for(let size=1;size<=160;size++){
  const tuple=apple();tuple[2]='"'.repeat(size);tuple[3]='k'.repeat(159);
  if(bytes(tuple)===512)atLimit=tuple;
 }
 assert.ok(atLimit,'independent 512-byte fixture exists');
 assert.equal(persona(atLimit).normalizedBytes,512);
 const tooLarge=atLimit.slice();tooLarge[5]+='a';assert.equal(bytes(tooLarge),513);bad(()=>persona(tooLarge));
});

test('future reserve covers exact-controller mandatory withdrawal; transfer preflights its actual target separately',()=>{
 const tuple=apple(),result=persona(tuple,{reserveFuture:true});
 const future=tuple.slice();Object.assign(future,{7:tuple[7]+1,8:'withdrawn',11:MAX,12:MAX,
  13:privacyScrubMarker(OTHER,'grants-approver'),15:MAX});
 assert.equal(result.futureNormalizedBytes,bytes(future));
 assert.equal(persona(future).normalizedBytes,bytes(future));
 // Initial guest retention reserves the exact current controller, not an
 // invented future Apple identity. Complete original identity stays exact.
 const normal=guest();normal[2]=normal[5]='guest:'+ID;normal[3]=normal[6]=KEY;
 const normalTerminal=normal.slice();Object.assign(normalTerminal,{7:1,8:'withdrawn',11:MAX,12:MAX,
  13:privacyScrubMarker(OTHER,'rooms'),15:MAX});
 const initial=persona(normal,{reserveFuture:true});
 assert.equal(initial.futureNormalizedBytes,bytes(normalTerminal));assert.ok(initial.futureNormalizedBytes<=512);
 assert.equal(initial.controller_principal_id,normal[5]);assert.equal(initial.original_key_id,KEY);
 // Root must derive this actual target under its source/target transaction
 // anchors and preflight it BEFORE any source-auth change. This is only shape.
 const target=apple();target[2]=normal[2];target[3]=KEY;target[5]='A'.repeat(42);target[16]=MAX;
 const transferred=persona(target,{reserveFuture:true});assert.ok(transferred.futureNormalizedBytes<=512);
 assert.equal(transferred.controller_principal_id,'A'.repeat(42));
 const largeTarget=apple();largeTarget[5]='"'.repeat(160);
 assert.ok(bytes(largeTarget)<=512);bad(()=>persona(largeTarget,{reserveFuture:true}));
 // The current guest reservation is unchanged by an unrelated oversized target.
 assert.equal(persona(normal,{reserveFuture:true}).futureNormalizedBytes,initial.futureNormalizedBytes);
 const exhausted=apple();exhausted[7]=MAX;exhausted[17]=null;bad(()=>persona(exhausted,{reserveFuture:true}));
 const oneLeft=guest();oneLeft[7]=MAX-1;assert.ok(persona(oneLeft,{reserveFuture:true}).futureNormalizedBytes<=512);
 oneLeft[7]=MAX;bad(()=>persona(oneLeft,{reserveFuture:true}));
 const rollover=apple();rollover[7]=9;rollover[17]=8;
 const rolloverTerminal=rollover.slice();Object.assign(rolloverTerminal,{7:10,8:'withdrawn',11:MAX,12:MAX,
  13:privacyScrubMarker(OTHER,'rooms'),15:MAX});
 assert.equal(persona(rollover,{reserveFuture:true}).futureNormalizedBytes,bytes(rolloverTerminal));
 const reserveEdge=apple();reserveEdge[2]='x'.repeat(160);reserveEdge[3]='x'.repeat(141);
 assert.ok(bytes(reserveEdge)<=512);bad(()=>persona(reserveEdge,{reserveFuture:true}));
 const input=apple();const before=json(input);persona(input,{reserveFuture:true});assert.equal(json(input),before);
 const terminal=future.slice();const later=terminal.slice();later[15]=MAX;later[13]=privacyScrubMarker(OTHER,'complete');
 assert.equal(persona(terminal,{reserveFuture:true}).futureNormalizedBytes,Math.max(bytes(terminal),bytes(later)));
});

test('EXACT031 dependency envelopes, complete cursor and selector domains',()=>{
 for(const selector of [{kind:'credential',value:DIGEST},{kind:'guest-key',value:KEY},
  {kind:'guest-user',value:'guest_é'},{kind:'apple-controller',value:'apple:a'},{kind:'indexed-sweep'}]){
  const payload=dependency(selector),result=dep(payload);assert.deepEqual(result.payload,payload);
  assert.equal(result.normalizedBytes,bytes(payload));assert.ok(result.futureNormalizedBytes<=512);frozen(result);
  payload.cursor=['production',OTHER];assert.deepEqual(dep(payload).payload.cursor,payload.cursor);
 }
 for(const selector of [{kind:'credential',value:DIGEST.toUpperCase()},{kind:'guest-key',value:'A'.repeat(42)+'B='},
  {kind:'guest-user',value:'a b'},{kind:'guest-user',value:''},{kind:'guest-user',value:'x'.repeat(161)},
  {kind:'apple-controller',value:'\t'},{kind:'unknown',value:'x'},{kind:'indexed-sweep',value:'x'},
  {kind:'credential'},{kind:'credential',value:DIGEST,claim:'secret'}])bad(()=>dep(dependency(selector)));
 for(const cursor of [[],[ID],['test',ID,'extra'],[null,ID],['test',OTHER.toUpperCase()],
  ['preview:_',ID],['test','uuid'],{environment:'test',personaID:ID}])bad(()=>dep({...dependency(),cursor}));
 bad(()=>dep({...dependency(),invalidatedAtMS:0}));
 for(const invalidatedAtMS of [null,-1,'0',MAX+1])bad(()=>dep({...dependency({kind:'credential',value:DIGEST}),invalidatedAtMS}));
 // A decoder knows no row creation time: chronology/equality must be checked in SQL.
 assert.equal(dep({...dependency({kind:'credential',value:DIGEST}),invalidatedAtMS:MAX}).payload.invalidatedAtMS,MAX);
});

test('dependency reserves the SQL worst 128-byte environment plus UUID even for null cursor',()=>{
 const small=dependency({kind:'guest-user',value:'x'}),decoded=dep(small);
 const future={...small,cursor:['x'.repeat(128),OTHER]};assert.equal(decoded.futureNormalizedBytes,bytes(future));
 let accepted=0,rejected=0;
 for(let size=1;size<=160;size++){
  const payload=dependency({kind:'guest-user',value:'"'.repeat(size)});
  const required=bytes({...payload,cursor:['x'.repeat(128),OTHER]});
  if(required<=512){assert.equal(dep(payload).futureNormalizedBytes,required);accepted++;}
  else{assert.ok(bytes(payload)<=512);bad(()=>dep(payload));rejected++;}
 }
 assert.ok(accepted&&rejected);
});

test('all scrub phases have closed exact cursors; complete accepts null only',()=>{
 const cursors={rooms:ID,'grants-host':ID,'grants-guest':ID,'grants-approver':ID,
  events:[ID,30001],receipts:[ID,DIGEST,'b'.repeat(64),OTHER],assets:[ID,1,MAX,OTHER],complete:null};
 for(const [phase,cursor] of Object.entries(cursors)){
  for(const value of [null,cursor]){
   const payload=scrub(phase,value),decoded=job(payload);assert.deepEqual(decoded.payload,payload);
   assert.equal(decoded.normalizedBytes,bytes(payload));frozen(decoded);
  }
  if(phase==='complete')bad(()=>job(scrub(phase,ID)));
  else bad(()=>job(scrub(phase,{})));
 }
 for(const cursor of [[ID,0],[ID,30002],[ID,'1'],[ID,1,2]])bad(()=>job(scrub('events',cursor)));
 for(const cursor of [[OTHER,1,1,OTHER],[ID,2,1,OTHER],[ID,1,-1,OTHER],[ID,1,1],
  [ID,1,1,OTHER,'extra']])bad(()=>job(scrub('assets',cursor)));
 for(const phase of ['done','room','grants','Rooms',''])bad(()=>job(scrub(phase)));
 for(const value of [ID.toUpperCase().replace('00000000','ABCDEF00'),'invalid'])bad(()=>job({...scrub(),personaID:value}));
});

test('receipt binding collisions preserve all four suffix fields',()=>{
 const seen=new Set();
 for(const principal of [DIGEST,'b'.repeat(64)])for(const key of [DIGEST,'c'.repeat(64)]){
  const cursor=[ID,principal,key,OTHER],result=job(scrub('receipts',cursor));
  assert.deepEqual(result.payload.cursor,cursor);seen.add(json(result.payload.cursor));
 }
 assert.equal(seen.size,4,'same session/command under different bindings is four distinct cursors');
 for(const cursor of [[ID,DIGEST,OTHER],[ID,DIGEST,DIGEST],
  [ID,DIGEST.toUpperCase(),DIGEST,OTHER],[ID,DIGEST,'secret',OTHER],[ID,DIGEST,DIGEST,OTHER,1]])bad(()=>job(scrub('receipts',cursor)));
});

test('scrub deadline arithmetic, resource cap and closed payload exclude PII/claims/provider data',()=>{
 assert.equal(job({...scrub(),withdrawnAtMS:MAX,scrubDueAtMS:MAX}).payload.scrubDueAtMS,MAX);
 assert.equal(job({...scrub(),withdrawnAtMS:1,scrubDueAtMS:DAY+1}).payload.scrubDueAtMS,DAY+1);
 for(const changes of [{scrubDueAtMS:DAY+1},{withdrawnAtMS:2,scrubDueAtMS:1},
  {privacyGeneration:'1'},{withdrawnAtMS:'0'},{scrubDueAtMS:MAX+1},{version:1}])bad(()=>job({...scrub(),...changes}));
 const maximal=scrub('receipts',[OTHER,DIGEST,'b'.repeat(64),OTHER]);
 Object.assign(maximal,{environment:'preview:'+'a'.repeat(120),personaID:OTHER,
  privacyGeneration:MAX,withdrawnAtMS:MAX,scrubDueAtMS:MAX});
 assert.ok(bytes(maximal)<4096);assert.equal(job(maximal).normalizedBytes,bytes(maximal));
 // Closed shapes cannot legally approach 4096. Padding is always an extra-key
 // refusal, including the boundary, rather than a fictitious valid huge cursor.
 for(const size of [4095,4096,4097])bad(()=>job({...scrub(),padding:'x'.repeat(size)}));
 for(const decode of [dep,job])for(const field of ['displayName','bearer','claim','provider','payload','__proto__']){
  const payload=decode===dep?dependency():scrub();Object.defineProperty(payload,field,{value:'PRIVATE_SENTINEL',enumerable:true});
  bad(()=>decode(payload));
 }
 for(const decode of [dep,job]){
  const template=decode===dep?dependency():scrub();
  for(const field of Object.keys(template)){const payload={...template};delete payload[field];bad(()=>decode(payload));}
 }
});

test('compact canonical marker is exactly 41 ASCII bytes and grants no completion authority',()=>{
 const codes={rooms:'r','grants-host':'h','grants-guest':'g','grants-approver':'a',events:'e',receipts:'c',assets:'o',complete:'x'};
 for(const [phase,code] of Object.entries(codes)){
  const marker=privacyScrubMarker(OTHER,phase);assert.equal(marker,'p2:'+OTHER+':'+code);assert.equal(Buffer.byteLength(marker),41);
  const tuple=guest();Object.assign(tuple,{7:1,8:'withdrawn',11:1,12:1,13:marker,15:1});assert.equal(persona(tuple).scrub_cursor,marker);
 }
 for(const args of [[OTHER.toUpperCase(),'rooms'],[ID,'r'],[ID,'complete:secret'],[{},'rooms'],[ID,null]])bad(()=>privacyScrubMarker(...args));
 const tuple=guest();Object.assign(tuple,{7:1,8:'withdrawn',11:1,12:1,15:1});
 for(const marker of ['p2:'+ID+':rooms','p2:'+ID+':z','p2:'+ID+':r:extra','x'.repeat(97)]){
  tuple[13]=marker;bad(()=>persona(tuple));
 }
});

test('deep immutability detaches raw data and errors remain redacted',()=>{
 const input=apple(),p=persona(input);input[2]='changed';assert.equal(p.original_principal_id,'g');
 assert.throws(()=>{p.tuple[2]='changed';},TypeError);assert.throws(()=>{p.original_principal_id='changed';},TypeError);
 const payload=scrub('receipts',[ID,DIGEST,DIGEST,OTHER]),s=job(payload);payload.cursor[0]=OTHER;
 assert.equal(s.payload.cursor[0],ID);assert.throws(()=>{s.payload.cursor.push('x');},TypeError);
 const d=dep(dependency({kind:'credential',value:DIGEST}));assert.throws(()=>{d.payload.selector.value='changed';},TypeError);
 for(const decode of [decodePersonaTuple,decodePrivacyDependency,decodePrivacyScrub]){
  try{decode('{"private":"PRIVATE_SENTINEL","secret":"not allowed"}');assert.fail('must refuse');}
  catch(error){assert.ok(error instanceof SessionV2Error);assert.equal(error.message,'invalid_request');
   assert.equal(json(error).includes('PRIVATE_SENTINEL'),false);assert.equal('cause' in error,false);}
 }
 frozen(p);frozen(s);frozen(d);
});

test('bounded independent normalized reference comparisons cover escaping, Unicode and key order',()=>{
 const samples=['é','🦜','"','\\','e\u0301','千','a b','\u2028'];
 for(const sample of samples){
  const tuple=apple();tuple[2]=sample.repeat(2);tuple[5]=sample;
  assert.equal(persona(tuple).normalizedBytes,bytes(tuple));
 }
 for(const selector of [{kind:'credential',value:DIGEST},{kind:'guest-user',value:'é"\\🦜'}]){
  const payload=dependency(selector),reverse=Object.fromEntries(Object.entries(payload).reverse());
  assert.equal(dep(payload).normalizedBytes,bytes(payload));assert.equal(dep(reverse).normalizedBytes,bytes(payload));
 }
});
