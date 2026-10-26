import test from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {readFileSync} from 'node:fs';
import {validateCommand,validateRecordingDescriptor,SESSION_V2_REACTION_SET} from '../../api/utils/listening-v2/protocol.js';
import {SessionV2Error} from '../../api/utils/listening-v2/errors.js';

const load=name=>JSON.parse(readFileSync(new URL('../../contracts/'+name,import.meta.url),'utf8'));
const schema=load('sessions-v2-command.schema.json'),fixtures=load('sessions-v2-fixtures.json');
// Deliberately scoped to every keyword in this schema. Unlike the older shared
// helper, fail on unrecognized validation keywords instead of silently ignoring
// them. This is a test interpreter, not a production or general JSON Schema API.
const keywords=new Set(['$schema','$id','$defs','$ref','title','description','type','const','enum','properties','required',
 'additionalProperties','minProperties','minimum','maximum','minLength','maxLength','pattern','allOf','anyOf','oneOf',
 'items','minItems','maxItems','x-maxUTF8Bytes','x-maxGraphemes','x-transportActor','x-rawAdmission']);
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
function check(s,value,context={}){
 for(const key of Object.keys(s))assert(keywords.has(key),'Unhandled schema keyword: '+key);
 if(s.$ref){assert(s.$ref.startsWith('#/$defs/'));return check(schema.$defs[s.$ref.slice(8)],value,context);}
 if(s['x-transportActor']!==undefined&&s['x-transportActor']!==context.transportActor)return false;
 if(Object.hasOwn(s,'const')&&!isDeepStrictEqual(value,s.const))return false;
 if(s.enum&&!s.enum.some(v=>isDeepStrictEqual(v,value)))return false;
 if(s.type){
  const matches=s.type==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):
   s.type==='array'?Array.isArray(value):s.type==='integer'?Number.isSafeInteger(value):s.type==='null'?value===null:typeof value===s.type;
  if(!matches)return false;
 }
 if(s.allOf&&!s.allOf.every(b=>check(b,value,context)))return false;
 if(s.anyOf&&!s.anyOf.some(b=>check(b,value,context)))return false;
 if(s.oneOf&&s.oneOf.filter(b=>check(b,value,context)).length!==1)return false;
 if(typeof value==='number'&&((s.minimum!==undefined&&value<s.minimum)||(s.maximum!==undefined&&value>s.maximum)))return false;
 if(typeof value==='string'){
  const length=[...value].length;
  if((s.minLength!==undefined&&length<s.minLength)||(s.maxLength!==undefined&&length>s.maxLength))return false;
  if(s.pattern&&!new RegExp(s.pattern,'u').test(value))return false;
  if(s['x-maxUTF8Bytes']!==undefined&&Buffer.byteLength(value)>s['x-maxUTF8Bytes'])return false;
  if(s['x-maxGraphemes']!==undefined&&[...segmenter.segment(value)].length>s['x-maxGraphemes'])return false;
 }
 if(value!==null&&typeof value==='object'&&!Array.isArray(value)){
  if(s.required?.some(k=>!Object.hasOwn(value,k)))return false;
  if(s.minProperties!==undefined&&Object.keys(value).length<s.minProperties)return false;
  if(s.additionalProperties===false&&Object.keys(value).some(k=>!Object.hasOwn(s.properties??{},k)))return false;
  for(const [key,child] of Object.entries(s.properties??{}))if(Object.hasOwn(value,key)&&!check(child,value[key],context))return false;
 }
 if(Array.isArray(value)){
  if((s.minItems!==undefined&&value.length<s.minItems)||(s.maxItems!==undefined&&value.length>s.maxItems))return false;
  if(s.items&&!value.every(v=>check(s.items,v,context)))return false;
 }
 return true;
}
function productionDecision(fn){
 try{fn();return true;}catch(error){assert(error instanceof SessionV2Error);assert.equal(error.code,'invalid_request');return false;}
}

test('committed command fixtures pin strict schema and actual production decisions including server actor',()=>{
 assert.equal(fixtures.version,2);assert.equal(fixtures.schemaRevision,1);assert.equal(fixtures.scope,'core-room-mutations-only-disabled');
 assert.equal(new Set(fixtures.commands.map(f=>f.id)).size,fixtures.commands.length);
 assert(fixtures.commands.filter(f=>f.valid).length>=25);assert(fixtures.commands.filter(f=>!f.valid).length>=75);
 for(const f of fixtures.commands){
  const context={transportActor:f.transportActor};
  assert.equal(check(schema,f.command,context),f.valid,'schema: '+f.id);
  assert.equal(productionDecision(()=>validateCommand(JSON.stringify(f.command),context)),f.valid,'production: '+f.id);
 }
});
test('shared recording fixtures pin strict metadata and provider-specific identity constraints',()=>{
 for(const f of fixtures.recordings){
  assert.equal(check(schema.$defs.recordingDescriptor,f.recording),f.valid,'schema: '+f.id);
  assert.equal(productionDecision(()=>validateRecordingDescriptor(JSON.stringify(f.recording))),f.valid,'production: '+f.id);
 }
});
test('raw-only constraints reject ambiguous numeric sources and duplicate keys before semantic schema checks',()=>{
 assert.deepEqual(schema['x-rawAdmission'],{maxUTF8Bytes:16384,numericTokens:'decimal-safe-integers-only',duplicateProperties:'refused'});
 for(const f of fixtures.rawInvalid)assert.equal(productionDecision(()=>validateCommand(f.raw)),false,f.id);
 // JSON.parse erases these distinctions: a semantic-schema-only test would
 // incorrectly approve them. Pin the lexical refusals against production too.
 const rounded=fixtures.rawInvalid.find(f=>f.id==='numeric-1.0000000000000001');
 assert.equal(check(schema,JSON.parse(rounded.raw)),true);
 assert.equal(productionDecision(()=>validateCommand(rounded.raw)),false);
});
test('reaction revision and order are the exact six approved protocol IDs',()=>{
 const approved={revision:1,ids:['heart','fire','clap','laugh','microphone','teary_eyed']};
 assert.deepEqual(fixtures.reactionSet,approved);assert.deepEqual(SESSION_V2_REACTION_SET,approved);
 assert(check(schema.$defs.reactionSet,approved));
 for(const ids of [[...approved.ids].reverse(),approved.ids.slice(0,5),[...approved.ids,'cry'],['heart','fire','clap','laugh','microphone','cry']])assert.equal(check(schema.$defs.reactionSet,{revision:1,ids}),false);
 assert.equal(check(schema.$defs.reactionSet,{...approved,revision:2}),false);
});
test('strict schema checks actually detect unknown keys, missing required, references and upper bounds',()=>{
 const q=structuredClone(fixtures.commands.find(f=>f.id==='queue-add-end').command);
 for(const changed of [{...q,host:true},{...q,expected:{}},{...q,expected:{queueRevision:9007199254740992}},{...q,payload:{...q.payload,catalogSelectionID:'a'.repeat(4097)}}])assert.equal(check(schema,changed),false);
 assert.throws(()=>check({notARealKeyword:true},q),/Unhandled schema keyword/);
 assert.equal(check({oneOf:[{const:1},{const:1}]},1),false,'oneOf must not mean anyOf');
});
