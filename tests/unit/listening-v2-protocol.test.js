import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {SessionV2Error} from '../../api/utils/listening-v2/errors.js';
import {validateCommand,validateRecordingDescriptor,sameRecordingDescriptor,SESSION_V2_REACTION_SET} from '../../api/utils/listening-v2/protocol.js';

const sessionID='11111111-1111-4111-8111-111111111111',commandID='22222222-2222-4222-8222-222222222222';
const occurrenceID='33333333-3333-4333-8333-333333333333',visitID='44444444-4444-4444-8444-444444444444';
const targetOccurrenceID='55555555-5555-4555-8555-555555555555';
const queue=()=>({version:2,action:'queue.add',sessionID,commandID,expected:{queueRevision:12},payload:{catalogSelectionID:'selection.synthetic.1',placement:'end'}});
const expected=()=>({authorityEpoch:2,transitionRevision:7,queueRevision:12,occurrenceID,visitID});
const transport=(payload,e=expected())=>({version:2,action:'transport.request',sessionID,commandID,expected:e,payload});
const host={transportActor:'original_host'},guest={transportActor:'guest'};
const raw=JSON.stringify;
const invalid=fn=>assert.throws(fn,error=>error instanceof SessionV2Error&&error.code==='invalid_request'&&error.status===400&&error.message==='invalid_request');
const recording=()=>({provider:'appleMusic',catalogID:'1234567890',storefront:'us',versionMetadata:{title:'Exact song',artist:'Exact artist',album:'Studio version',durationMS:210000},catalogRevision:1});

test('raw admission refuses preparsed and oversized input before parsing or inspecting caller objects',()=>{
 let touches=0,parses=0;
 const proxy=new Proxy({}, {get(){touches++;throw Error('caller object inspected');},ownKeys(){touches++;throw Error('caller object enumerated');}});
 const parse=JSON.parse;
 try{
  JSON.parse=(...args)=>{parses++;return parse(...args);};
  for(const value of [proxy,queue(),Buffer.from(raw(queue())),null,raw(queue())+' '.repeat(16384),'{"title":"'+'界'.repeat(5500)+'"}'])invalid(()=>validateCommand(value));
 }finally{JSON.parse=parse;}
 assert.equal(parses,0);assert.equal(touches,0);
 invalid(()=>validateRecordingDescriptor(recording()));
});
test('every raw numeric token must be decimal and safe before parsing can round or overwrite it',()=>{
 const q=raw(queue());
 for(const token of ['1.0000000000000001','1e-1000','9007199254740991.1','1.0','1e0','9007199254740992']){
  invalid(()=>validateCommand(q.replace('"queueRevision":12','"queueRevision":'+token)));
  invalid(()=>validateCommand(q.replace('"queueRevision":12','"queueRevision":'+token+',"queueRevision":12')));
 }
 assert.equal(validateCommand(raw({...queue(),expected:{queueRevision:Number.MAX_SAFE_INTEGER}})).command.expected.queueRevision,Number.MAX_SAFE_INTEGER);
});
test('duplicate properties, escaped aliases, nonobjects and malformed batches refuse',()=>{
 const q=raw(queue());
 for(const value of [q.replace('"version":2','"version":1,"version":2'),q.replace('"queueRevision":12','"queueRevision":11,"queue\\u0052evision":12'),'['+q+']','null','{}',q.slice(0,-1)])invalid(()=>validateCommand(value));
 for(const value of [{...queue(),commands:[queue()]},{...queue(),batch:[queue()]}])invalid(()=>validateCommand(raw(value)));
});
test('V1 and future actions cannot pass the strict core envelope',()=>{
 for(const action of ['add','begin','create','restart','host.capture','admission.request','execution.claim','recap.read','privacy.erase','handoff.commit','transport.toggle','queue.batch'])invalid(()=>validateCommand(raw({...queue(),action})));
 for(const patch of [{version:1},{actorID:visitID},{host:true},{revision:12},{provider:'spotify'}])invalid(()=>validateCommand(raw({...queue(),...patch})));
});
test('action-specific fields and expected revisions refuse misplaced extensions',()=>{
 for(const value of [{...queue(),expected:{queueRevision:12,settingsRevision:1}},{...queue(),payload:{...queue().payload,occurrenceID}},
  {...queue(),action:'queue.remove'},{...queue(),action:'reaction.send'},{...queue(),expected:{}},{...queue(),sessionID:'invalid'},
  {...queue(),payload:{catalogSelectionID:'bad token',placement:'end'}}])invalid(()=>validateCommand(raw(value)));
});
test('hash pins semantic room intent independently of whitespace, key order, command key and server actor',()=>{
 const value=queue(),validated=validateCommand(raw(value));
 const canonical='{"action":"queue.add","expected":{"queueRevision":12},"payload":{"catalogSelectionID":"selection.synthetic.1","placement":"end"},"sessionID":"'+sessionID+'","version":2}';
 assert.equal(validated.bodyHash,createHash('sha256').update(canonical).digest('hex'));
 assert.equal(validateCommand(' '+raw({payload:value.payload,expected:value.expected,commandID,sessionID,action:value.action,version:2})+'\n').bodyHash,validated.bodyHash);
 assert.equal(validateCommand(raw({...value,commandID:targetOccurrenceID}),guest).bodyHash,validated.bodyHash);
 for(const patch of [{sessionID:targetOccurrenceID},{expected:{queueRevision:13}},{payload:{...value.payload,placement:'next'}}])assert.notEqual(validateCommand(raw({...value,...patch})).bodyHash,validated.bodyHash);
 assert.equal(validated.command.commandID,commandID,'Future durable receipt key retains the client command UUID');
});
test('validated commands, nested payloads and result wrappers are deeply immutable',()=>{
 const value=validateCommand(raw(queue()));
 assert(Object.isFrozen(value));assert(Object.isFrozen(value.command));assert(Object.isFrozen(value.command.expected));assert(Object.isFrozen(value.command.payload));
 assert.throws(()=>{value.command.payload.placement='next';},TypeError);
 assert.throws(()=>{value.bodyHash='changed';},TypeError);
 assert.equal(validateCommand(raw(queue())).bodyHash,value.bodyHash);
});
test('host tap and guest hold are distinct shapes selected exclusively by server context',()=>{
 for(const op of ['back','pause','next']){
  const tap=transport({op}),held=transport({op,holdProofVersion:1});
  assert.equal(validateCommand(raw(tap),host).command.payload.op,op);
  assert.equal(validateCommand(raw(held),guest).command.payload.holdProofVersion,1);
  invalid(()=>validateCommand(raw(tap),guest));invalid(()=>validateCommand(raw(held),host));
  invalid(()=>validateCommand(raw(tap)));invalid(()=>validateCommand(raw(tap),{transportActor:'host'}));
  invalid(()=>validateCommand(raw(transport({op,host:true})),host));
 }
});
test('host-only start/adoption/resume/seek reject guests and operation-inappropriate fields',()=>{
 for(const payload of [{op:'start',targetOccurrenceID},{op:'adopt_current',origin:'owned',sourceReference:'capture.synthetic.1'},{op:'resume'},{op:'seek',positionMS:0}]){
  assert.doesNotThrow(()=>validateCommand(raw(transport(payload)),host));
  invalid(()=>validateCommand(raw(transport(payload)),guest));
  invalid(()=>validateCommand(raw(transport({...payload,holdProofVersion:1})),host));
 }
 for(const payload of [{op:'start'},{op:'adopt_current',origin:'automatic',sourceReference:'capture'},{op:'resume',positionMS:0},{op:'pause',positionMS:1},{op:'seek',targetOccurrenceID,positionMS:1},{op:'seek',positionMS:86400001},{op:'seek',positionMS:-1},{op:'play'},{op:'next',providerVerb:'next'}])invalid(()=>validateCommand(raw(transport(payload)),host));
});
test('nullable occurrence/visit CAS is paired and limited to initial-capable operations',()=>{
 const initial={...expected(),occurrenceID:null,visitID:null};
 for(const payload of [{op:'start',targetOccurrenceID},{op:'adopt_current',origin:'following',sourceReference:'capture.synthetic'}])assert.doesNotThrow(()=>validateCommand(raw(transport(payload,initial)),host));
 for(const payload of [{op:'resume'},{op:'seek',positionMS:0},{op:'pause'},{op:'back'},{op:'next'}])invalid(()=>validateCommand(raw(transport(payload,initial)),host));
 invalid(()=>validateCommand(raw(transport({op:'start',targetOccurrenceID},{...initial,visitID})),host));
 invalid(()=>validateCommand(raw(transport({op:'start',targetOccurrenceID},{...initial,occurrenceID})),host));
});
test('Undo binds exact nonnull effect postimage without hold/seek/queue extensions',()=>{
 const e=expected();delete e.queueRevision;
 const value={version:2,action:'transport.undo',sessionID,commandID,expected:e,payload:{controlID:targetOccurrenceID}};
 assert.doesNotThrow(()=>validateCommand(raw(value)));
 for(const changed of [{...value,expected:{...e,visitID:null}},{...value,expected:{...e,queueRevision:12}},{...value,payload:{...value.payload,holdProofVersion:1}},{...value,payload:{...value.payload,positionMS:0}}])invalid(()=>validateCommand(raw(changed)));
});
test('revision 1 reactions retain exact negotiated picker order and current visit fields',()=>{
 assert.deepEqual(SESSION_V2_REACTION_SET,{revision:1,ids:['heart','fire','clap','laugh','microphone','teary_eyed']});
 assert(Object.isFrozen(SESSION_V2_REACTION_SET.ids));
 const value={version:2,action:'reaction.send',sessionID,commandID,expected:{},payload:{occurrenceID,visitID,transitionRevision:7,reactionSetRevision:1,reactionID:'teary_eyed'}};
 assert.doesNotThrow(()=>validateCommand(raw(value)));
 for(const patch of [{reactionID:'❤️'},{reactionID:'cry'},{reactionSetRevision:2},{visitID:null},{host:true}])invalid(()=>validateCommand(raw({...value,payload:{...value.payload,...patch}})));
 for(const field of ['occurrenceID','visitID','transitionRevision']){const changed=structuredClone(value);delete changed.payload[field];invalid(()=>validateCommand(raw(changed)));}
});
test('settings enforce nonempty strict patches and both grapheme/UTF8 title bounds without normalization',()=>{
 const value={version:2,action:'settings.update',sessionID,commandID,expected:{settingsRevision:0},payload:{title:'  Tonight 今晚  '}};
 assert.equal(validateCommand(raw(value)).command.payload.title,value.payload.title);
 for(const title of ['a'.repeat(80),'👩\u200d🎤'.repeat(20)])assert.doesNotThrow(()=>validateCommand(raw({...value,payload:{title}})));
 for(const title of ['a'.repeat(81),'a'+'\u0301'.repeat(161),'  ','a\nb','a\u202eb'])invalid(()=>validateCommand(raw({...value,payload:{title}})));
 for(const payload of [{},{askBeforeJoin:1},{title:'ok',host:true}])invalid(()=>validateCommand(raw({...value,payload})));
});
test('recording descriptor enforces provider-specific exact IDs and immutable metadata',()=>{
 const value=recording(),validated=validateRecordingDescriptor(raw(value));
 assert.deepEqual(validated,value);assert(Object.isFrozen(validated.versionMetadata));
 assert.throws(()=>{validated.versionMetadata.title='different';},TypeError);
 for(const changed of [{...value,catalogID:'spotify:track:Ab12Cd34Ef56Gh78Ij90Kl'},{...value,provider:'spotify'},
  {...value,storefront:'US'},{...value,isrc:'not-authority'},{...value,catalogRevision:'1'},
  {...value,versionMetadata:{...value.versionMetadata,durationMS:86400001}},{...value,versionMetadata:{...value.versionMetadata,version:'live'}}])invalid(()=>validateRecordingDescriptor(raw(changed)));
 assert.doesNotThrow(()=>validateRecordingDescriptor(raw({...value,provider:'spotify',catalogID:'Ab12Cd34Ef56Gh78Ij90Kl'})));
});
test('exact recording matching compares the complete tuple without fuzzy or Unicode substitution',()=>{
 const value=recording();assert(sameRecordingDescriptor(raw(value),raw({...value,versionMetadata:{...value.versionMetadata}})));
 for(const patch of [{catalogID:'1234567891'},{storefront:'gb'},{catalogRevision:2},{provider:'spotify',catalogID:'Ab12Cd34Ef56Gh78Ij90Kl'}])assert.equal(sameRecordingDescriptor(raw(value),raw({...value,...patch})),false);
 for(const [field,replacement] of [['title','Exact song (Live)'],['artist','Other artist'],['album','Deluxe version'],['durationMS',210001]])assert.equal(sameRecordingDescriptor(raw(value),raw({...value,versionMetadata:{...value.versionMetadata,[field]:replacement}})),false);
 const composed={...value,versionMetadata:{...value.versionMetadata,title:'é'}};
 assert.equal(sameRecordingDescriptor(raw(composed),raw({...composed,versionMetadata:{...composed.versionMetadata,title:'e\u0301'}})),false);
 invalid(()=>sameRecordingDescriptor(raw(value),{...value}));
});

test('16 KiB UTF8 admission includes the exact boundary and refuses the next byte',()=>{
 const q=raw(queue()),atLimit=q+' '.repeat(16384-Buffer.byteLength(q));
 assert.equal(Buffer.byteLength(atLimit),16384);
 assert.equal(validateCommand(atLimit).bodyHash,validateCommand(q).bodyHash);
 invalid(()=>validateCommand(atLimit+' '));
});
