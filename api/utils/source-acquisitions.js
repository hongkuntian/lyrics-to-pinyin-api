import {randomUUID} from 'node:crypto';
import {verifiedCatalogProof,contextSignature} from './verified-lyric-context.js';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export function canonicalAcquisitionKey(request,resolution,options){
 if(!verifiedCatalogProof(resolution,request))return null;
 // Conservative policy-equivalence boundary. Localized labels, distinct IDs,
 // contributor evidence and normalization context cannot share first admission.
 const {storefront,account_storefront,...recording}=JSON.parse(contextSignature(request));
 return JSON.stringify(canonical({recording,canonical:resolution.canonical_recording_id,genres:resolution.genres??[],entities:resolution.artist_entities??[],searches:resolution.searches,options}));
}
export class SourceAcquisitions {
 constructor({waitUntilFn=()=>{},cleanupTimeoutMs=2000}={}){this.owners=new Map();this.waitUntilFn=waitUntilFn;this.cleanupTimeoutMs=cleanupTimeoutMs;}
 async join(key,{signal,deadlineAtMS,onSnapshot,start}){
  signal?.throwIfAborted();let owner=this.owners.get(key);const joined=Boolean(owner);
  if(!owner){
   const controller=new AbortController(),children=new Set();
   owner={id:randomUUID(),deadlineAtMS,controller,readers:new Set(),latest:null,done:false};this.owners.set(key,owner);
   const context={acquisitionID:owner.id,deadlineAtMS,signal:controller.signal,own:promise=>{children.add(promise);promise.then(()=>children.delete(promise),()=>children.delete(promise));return promise;},publish:(response,diagnostics={})=>{
    if(owner.done||controller.signal.aborted)return;
    owner.latest={response:structuredClone(response),diagnostics:structuredClone(diagnostics)};
    for(const reader of owner.readers)reader.publish(owner.latest);
   }};
   owner.operation=Promise.resolve().then(()=>start(context)).finally(async()=>{while(children.size)await Promise.allSettled([...children]);});
   let timer;
   owner.promise=Promise.race([owner.operation,new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({status:504,body:{code:'provider_timeout'}});},Math.max(0,deadlineAtMS-Date.now()));})]).finally(()=>{clearTimeout(timer);owner.done=true;if(this.owners.get(key)===owner)this.owners.delete(key);});
  }
  let released=false,abort;
  const reader={publish:snapshot=>{if(!released){try{onSnapshot?.(structuredClone(snapshot.response),structuredClone(snapshot.diagnostics));}catch{/* One closed or rejecting subscriber cannot stop another reader. */}}}};
  owner.readers.add(reader);
  const release=()=>{if(released)return;released=true;owner.readers.delete(reader);if(!owner.done&&!owner.readers.size){owner.controller.abort();if(this.owners.get(key)===owner)this.owners.delete(key);}};
  const cancelled=new Promise((_,reject)=>{abort=()=>{release();const error=new Error('Source reader cancelled');error.name='AbortError';reject(error);};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
  try {
   if(owner.latest)reader.publish(owner.latest);
   const result=await Promise.race([owner.promise,cancelled]);return {result,joined,sourceAcquisitionID:owner.id,deadlineAtMS:owner.deadlineAtMS};
  }finally{
   signal?.removeEventListener('abort',abort);release();
   if(owner.controller.signal.aborted){
    const cleanup=owner.operation.catch(()=>{});let timer;
    const done=await Promise.race([cleanup.then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),this.cleanupTimeoutMs);})]);clearTimeout(timer);if(!done)this.waitUntilFn(cleanup);
   }
  }
 }
}
