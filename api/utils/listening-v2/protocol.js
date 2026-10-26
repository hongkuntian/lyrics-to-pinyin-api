import {canonicalCommandHash} from './tickets.js';
import {SessionV2Error} from './errors.js';

const invalid=()=>{throw new SessionV2Error('invalid_request');};
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unsafeText=/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const segmenter=new Intl.Segmenter('und',{granularity:'grapheme'});
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const uuid=value=>typeof value==='string'&&uuidPattern.test(value);
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const opaque=value=>typeof value==='string'&&value.length<=4096&&/^[\x21-\x7e]+$/.test(value);
function keys(value,required,optional=[]){
 if(!object(value)||required.some(key=>!Object.hasOwn(value,key))||
  Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))invalid();
}
function freeze(value){
 if(value!==null&&typeof value==='object'){
  for(const child of Object.values(value))freeze(child);
  Object.freeze(value);
 }
 return value;
}

export const SESSION_V2_REACTION_SET=freeze({revision:1,ids:['heart','fire','clap','laugh','microphone','teary_eyed']});

// canonicalCommandHash establishes raw-byte, numeric-token and structural bounds
// before any protocol parsing. There is deliberately no preparsed-object API.
function parseRaw(rawJSON){
 canonicalCommandHash(rawJSON);
 // JSON.parse erases duplicate keys, including escaped aliases. Refuse these
 // ambiguous commands even though the foundational hasher permits them. This
 // scan only sees already syntax-checked, <=16 KiB JSON, never caller objects.
 const stack=[];
 for(let i=0;i<rawJSON.length;i++){
  const char=rawJSON[i];
  if(char==='{')stack.push(new Set());
  else if(char==='[')stack.push(null);
  else if(char==='}'||char===']')stack.pop();
  else if(char==='"'){
   const start=i;
   for(i++;i<rawJSON.length;i++){
    if(rawJSON[i]==='\\')i++;
    else if(rawJSON[i]==='"')break;
   }
   let next=i+1;while(/\s/u.test(rawJSON[next]??'')&&next<rawJSON.length)next++;
   if(rawJSON[next]===':'){
    const key=JSON.parse(rawJSON.slice(start,i+1)),seen=stack.at(-1);
    if(!seen||seen.has(key))invalid();
    seen.add(key);
   }
  }
 }
 return JSON.parse(rawJSON);
}
function text(value,maxCharacters,maxBytes,{empty=false,maxGraphemes}={}){
 if(typeof value!=='string'||unsafeText.test(value)||(!empty&&!value.trim())||
  [...value].length>maxCharacters||Buffer.byteLength(value)>maxBytes)invalid();
 if(maxGraphemes!==undefined){
  let count=0;for(const _ of segmenter.segment(value))if(++count>maxGraphemes)invalid();
 }
}
function revisionExpected(value,field){keys(value,[field]);if(!integer(value[field]))invalid();}
function transportExpected(value,{initial=false,undo=false}={}){
 keys(value,['authorityEpoch','transitionRevision',...(undo?[]:['queueRevision']),'occurrenceID','visitID']);
 for(const field of ['authorityEpoch','transitionRevision',...(undo?[]:['queueRevision'])])if(!integer(value[field]))invalid();
 if(initial&&value.occurrenceID===null&&value.visitID===null)return;
 if(!uuid(value.occurrenceID)||!uuid(value.visitID))invalid();
}
function transportPayload(payload,expected,transportActor){
 if(!['original_host','guest'].includes(transportActor)||!object(payload))invalid();
 const op=payload.op;
 if(['start','adopt_current','resume','seek'].includes(op)){
  if(transportActor!=='original_host')invalid();
  if(op==='start'){
   keys(payload,['op','targetOccurrenceID']);if(!uuid(payload.targetOccurrenceID))invalid();
  }else if(op==='adopt_current'){
   keys(payload,['op','sourceReference','origin']);
   if(!opaque(payload.sourceReference)||!['owned','following'].includes(payload.origin))invalid();
  }else if(op==='seek'){
   keys(payload,['op','positionMS']);if(!integer(payload.positionMS,0,86400000))invalid();
  }else keys(payload,['op']);
 }else if(['back','pause','next'].includes(op)){
  keys(payload,transportActor==='guest'?['op','holdProofVersion']:['op']);
  if(transportActor==='guest'&&payload.holdProofVersion!==1)invalid();
 }else invalid();
 transportExpected(expected,{initial:op==='start'||op==='adopt_current'});
}

/** Validate a core room mutation, without authentication, authorization or effects.
 * transportActor MUST be derived by the server from the verified installation
 * and current room, never copied from a request. It selects the permitted wire
 * shape only; it is not proof of membership/host rights or permission to execute.
 * The returned command and semantic hash are bound by deep immutability.
 */
export function validateCommand(rawJSON,{transportActor}={}){
 const command=parseRaw(rawJSON);
 keys(command,['version','action','sessionID','commandID','expected','payload']);
 if(command.version!==2||!uuid(command.sessionID)||!uuid(command.commandID))invalid();
 const {action,expected,payload}=command;
 switch(action){
 case 'queue.add':
  revisionExpected(expected,'queueRevision');keys(payload,['catalogSelectionID','placement']);
  if(!opaque(payload.catalogSelectionID)||!['next','end'].includes(payload.placement))invalid();
  break;
 case 'queue.move':
  revisionExpected(expected,'queueRevision');keys(payload,['occurrenceID','beforeOccurrenceID']);
  if(!uuid(payload.occurrenceID)||(payload.beforeOccurrenceID!==null&&!uuid(payload.beforeOccurrenceID)))invalid();
  break;
 case 'queue.remove':
  revisionExpected(expected,'queueRevision');keys(payload,['occurrenceID']);if(!uuid(payload.occurrenceID))invalid();
  break;
 case 'settings.update':
  revisionExpected(expected,'settingsRevision');keys(payload,[],['title','askBeforeJoin','takeTurns']);
  if(Object.keys(payload).length===0)invalid();
  if(Object.hasOwn(payload,'title'))text(payload.title,320,320,{maxGraphemes:80});
  for(const field of ['askBeforeJoin','takeTurns'])if(Object.hasOwn(payload,field)&&typeof payload[field]!=='boolean')invalid();
  break;
 case 'reaction.send':
  keys(expected,[]);keys(payload,['occurrenceID','visitID','transitionRevision','reactionSetRevision','reactionID']);
  if(!uuid(payload.occurrenceID)||!uuid(payload.visitID)||!integer(payload.transitionRevision)||
   payload.reactionSetRevision!==1||!SESSION_V2_REACTION_SET.ids.includes(payload.reactionID))invalid();
  break;
 case 'transport.request':transportPayload(payload,expected,transportActor);break;
 case 'transport.undo':
  transportExpected(expected,{undo:true});keys(payload,['controlID']);if(!uuid(payload.controlID))invalid();
  break;
 default:invalid();
 }
 // commandID belongs to the durable dedupe key, not the semantic body hash.
 // Environment/principal/verified key also belong to that server-derived key;
 // caller identity is never admitted or hashed into room mutation semantics.
 const bodyHash=canonicalCommandHash(JSON.stringify({version:command.version,action,sessionID:command.sessionID,expected,payload}));
 return freeze({command,bodyHash});
}

/** Exact shared recording tuple, not availability, a selection ticket or rights. */
export function validateRecordingDescriptor(rawJSON){
 const recording=parseRaw(rawJSON);
 keys(recording,['provider','catalogID','storefront','versionMetadata','catalogRevision']);
 const {provider,catalogID,storefront,versionMetadata,catalogRevision}=recording;
 if(!['appleMusic','spotify'].includes(provider)||typeof catalogID!=='string'||
  !(provider==='appleMusic'?/^[1-9][0-9]{0,19}$/:/^[A-Za-z0-9]{22}$/).test(catalogID)||
  typeof storefront!=='string'||!/^[a-z]{2}$/.test(storefront)||!integer(catalogRevision))invalid();
 keys(versionMetadata,['title','artist','album','durationMS']);
 text(versionMetadata.title,300,1200);text(versionMetadata.artist,500,2000);text(versionMetadata.album,300,1200,{empty:true});
 if(!integer(versionMetadata.durationMS,1000,86400000))invalid();
 return freeze(recording);
}

/** Both inputs are independently admitted raw JSON. No normalization/substitution. */
export function sameRecordingDescriptor(leftRawJSON,rightRawJSON){
 const left=validateRecordingDescriptor(leftRawJSON),right=validateRecordingDescriptor(rightRawJSON);
 return ['provider','catalogID','storefront','catalogRevision'].every(field=>left[field]===right[field])&&
  ['title','artist','album','durationMS'].every(field=>left.versionMetadata[field]===right.versionMetadata[field]);
}
