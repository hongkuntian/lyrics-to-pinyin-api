import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import dataIndex from '../../../language-data/pronunciation/index.json' with {type:'json'};
const sha=x=>createHash('sha256').update(x).digest('hex');
const HEX=/^[a-f0-9]{64}$/;
export const lexiconLimits=Object.freeze({maxShards:4,maxShardBytes:8388608,maxSerializedBytes:33554432,maxQueuedLoads:64,maxEntryBytes:131072,maxLookupBytes:512,maxBatchItems:128});
const fail=message=>{throw new Error(message);};
const defaultRoot=fileURLToPath(new URL('../../../language-data/pronunciation/',import.meta.url));
function expandEntry(dataset,key,t,m){
  if(!Array.isArray(t))fail('Invalid selected provenance tuple');
  const source=m.source;
  if(dataset==='thai'){
    if(t.length!==10)fail('Invalid Thai tuple');const [id,value,recordSHA256,soundSHA256,line,byteOffset,byteLength,soundIndex,pos,qualifiers]=t;
    const datasetID='kaikki-th-'+source.rawSHA256.slice(0,16),locator=`input:${source.rawSHA256}:record:${recordSHA256}:sound:${soundSHA256}`;
    return {id,datasetID,lookup:key,value,rawIPA:value,sourceEntryLocator:locator,sourceURL:'https://en.wiktionary.org/wiki/'+encodeURIComponent(key)+'#Thai',snapshot:source.snapshot,inputSHA256:source.rawSHA256,recordSHA256,soundSHA256,line,byteOffset,byteLength,soundIndex,column:`sounds[${soundIndex}].ipa`,pos,qualifiers,reviewStatus:'unreviewed-candidate'};
  }
  if(dataset==='hindi'){
    if(t.length!==9)fail('Invalid Hindi tuple');const [id,value,memberIndex,line,byteOffset,byteLength,recordSHA256,attestedAlias,attestationCount]=t,member=source.members[memberIndex];if(!member)fail('Invalid Hindi source member');
    return {id,datasetID:'dakshina-hi-v1.0',lookup:key,value,sourceEntryLocator:`member:${member.member}:row:${line}:columns:native,romanization,count`,sourceURL:source.sourceURL,archiveURL:member.url,member:member.member,archiveRangeStart:member.rangeStart,snapshot:source.snapshot,inputSHA256:member.sha256,recordSHA256,line,byteOffset,byteLength,columns:{native:1,romanization:2,count:3},attestedAlias,attestationCount,reviewStatus:'unreviewed-candidate'};
  }
  if(t.length!==7)fail('Invalid Vietnamese tuple');const [id,value,pos,line,byteOffset,byteLength,recordSHA256]=t;
  return {id,datasetID:'kaikki-vi-'+source.sha256.slice(0,16),lookup:key,value,pos,sourceEntryLocator:`compressed-input:${source.sha256}:line:${line}:column:word`,sourceURL:'https://vi.wiktionary.org/wiki/'+encodeURIComponent(value.replaceAll(' ','_')),snapshot:source.snapshot,inputSHA256:source.sha256,recordSHA256,line,byteOffset,byteLength,column:'word',reviewStatus:'unreviewed-candidate'};
}
// Trusted packaged index supplies every file SHA. No network and no dictionary load at import.
export class LexiconStore {
  #root;#index;#manifests=new Map();#manifestLoads=new Map();#cache=new Map();#pending=new Map();#active=new Map();#queue=[];#bytes=0;#reserved=0;#freeSlots=[];#allocatedSlots=0;#slotCapacity;
  #metrics={loads:0,hits:0,coalesced:0,selectedParses:0,peakSerializedBytes:0,peakCachedAndLoading:0,peakQueued:0};
  constructor({root=defaultRoot,index=dataIndex}={}){
    this.#root=path.resolve(root);this.#index=structuredClone(index);
    this.#slotCapacity=index.maxShardBytes;
    if(!Number.isSafeInteger(this.#slotCapacity)||this.#slotCapacity<1||this.#slotCapacity>lexiconLimits.maxShardBytes)fail('Invalid fixed pool capacity');
    if(index?.schema!=='lyrica-pronunciation-data-1'||index.publicationStatus!=='unpublished'||index.active!==false||index.datasets?.length!==3)fail('Unrecognized packaged data index');
    for(const row of index.datasets)if(!/^(thai|hindi|vietnamese)\/manifest\.json$/.test(row.path)||row.path!==row.datasetID+'/manifest.json'||!HEX.test(row.sha256))fail('Unsafe dataset descriptor');
  }
  async #readPinned(rel,pin,cap,storage=null){
    if(!Number.isSafeInteger(pin.bytes)||pin.bytes<0||pin.bytes>cap||!HEX.test(pin.sha256))fail('Invalid file bounds/pin');
    const parts=rel.split('/');if(parts.some(p=>!p||p==='.'||p==='..'))fail('Unsafe packaged path');
    let dir=this.#root;
    for(const part of parts.slice(0,-1)){dir=path.join(dir,part);const st=await fs.lstat(dir);if(!st.isDirectory()||st.isSymbolicLink())fail('Symlink/non-directory data path');}
    const handle=await fs.open(path.join(this.#root,rel),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const st=await handle.stat();if(!st.isFile()||st.size!==pin.bytes||st.size>cap)fail('Data file size/type mismatch');
      const bytes=storage?storage.subarray(0,pin.bytes+1):Buffer.alloc(pin.bytes+1);let offset=0;
      while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,null);if(!bytesRead)break;offset+=bytesRead;}
      if(offset!==pin.bytes||sha(bytes.subarray(0,offset))!==pin.sha256)fail('Data file SHA/size mismatch');return bytes.subarray(0,offset);
    }finally{await handle.close();}
  }
  async manifest(dataset){
    if(this.#manifests.has(dataset))return structuredClone(this.#manifests.get(dataset));
    if(!this.#manifestLoads.has(dataset)){
      const row=this.#index.datasets.find(d=>d.datasetID===dataset);if(!row)fail('Unsupported packaged dataset');
      this.#manifestLoads.set(dataset,(async()=>{
        const st=await fs.lstat(path.join(this.#root,row.path));if(st.size>131072)fail('Manifest cap');
        const m=JSON.parse(await this.#readPinned(row.path,{bytes:st.size,sha256:row.sha256},131072));
        if(m.schema!=='lyrica-lexicon-jsonl-1'||m.datasetID!==dataset||m.shardCount!==64||m.shards?.length!==64||m.publicationStatus!=='unpublished'||m.active!==false||m.maxEntryBytes>lexiconLimits.maxEntryBytes||m.entryEncoding!==dataset+'-provenance-tuple-1')fail('Invalid dataset manifest');
        for(const [i,p] of m.shards.entries())if(p.bucket!==i||p.path!==`${dataset}/shards/${i.toString(16).padStart(2,'0')}.jsonl`||!Number.isSafeInteger(p.bytes)||p.bytes<0||p.bytes>lexiconLimits.maxShardBytes||p.bytes>this.#slotCapacity||!HEX.test(p.sha256))fail('Invalid shard bounds/pin');
        this.#manifests.set(dataset,m);return m;
      })().finally(()=>this.#manifestLoads.delete(dataset)));
    }
    return structuredClone(await this.#manifestLoads.get(dataset));
  }
  #record(){this.#metrics.peakSerializedBytes=Math.max(this.#metrics.peakSerializedBytes,this.#bytes+this.#reserved);this.#metrics.peakCachedAndLoading=Math.max(this.#metrics.peakCachedAndLoading,this.#cache.size+this.#active.size);this.#metrics.peakQueued=Math.max(this.#metrics.peakQueued,this.#queue.length);}
  #evict(){
    for(const [key,record]of this.#cache)if(record.leases===0){this.#bytes-=record.bytes.length;this.#cache.delete(key);this.#freeSlots.push(record.storage);return true;}
    return false;
  }
  #pump(){
    while(this.#queue.length){const job=this.#queue[0];
      while((this.#cache.size+this.#active.size>=lexiconLimits.maxShards||this.#bytes+this.#reserved+job.pin.bytes>lexiconLimits.maxSerializedBytes)&&this.#evict()){}
      if(this.#cache.size+this.#active.size>=lexiconLimits.maxShards||this.#bytes+this.#reserved+job.pin.bytes>lexiconLimits.maxSerializedBytes)return;
      let storage=this.#freeSlots.pop();if(!storage){storage=Buffer.alloc(this.#slotCapacity+1);this.#allocatedSlots++;}
      this.#queue.shift();this.#active.set(job.key,job);this.#reserved+=job.pin.bytes;this.#record();
      this.#readPinned(job.pin.path,job.pin,lexiconLimits.maxShardBytes,storage).then(bytes=>{
        const record={bytes,storage,leases:job.waiters};this.#pending.delete(job.key);
        this.#active.delete(job.key);this.#reserved-=job.pin.bytes;this.#cache.set(job.key,record);this.#bytes+=bytes.length;this.#metrics.loads++;this.#record();job.resolve(record);
      },error=>{this.#pending.delete(job.key);this.#active.delete(job.key);this.#reserved-=job.pin.bytes;this.#freeSlots.push(storage);job.reject(error);}).finally(()=>{this.#pump();});
    }
  }
  #shard(pin){
    const key=pin.path;
    if(this.#cache.has(key)){const record=this.#cache.get(key);record.leases++;this.#cache.delete(key);this.#cache.set(key,record);this.#metrics.hits++;return Promise.resolve(record);}
    if(this.#pending.has(key)){const job=this.#pending.get(key);job.waiters++;this.#metrics.coalesced++;return job.promise;}
    if(this.#queue.length>=lexiconLimits.maxQueuedLoads)return Promise.reject(Error('Lexicon load queue cap'));
    let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;}),job={key,pin,resolve,reject,promise,waiters:1};this.#pending.set(key,job);this.#queue.push(job);this.#record();this.#pump();return promise;
  }
  async lookup(dataset,key){
    if(typeof key!=='string'||!key.isWellFormed()||!key||Buffer.byteLength(key)>lexiconLimits.maxLookupBytes)fail('Lookup key bound');
    const m=await this.manifest(dataset),bucket=parseInt(sha(key).slice(0,2),16)%64,record=await this.#shard(m.shards[bucket]),raw=record.bytes;
    try{
    const prefix=Buffer.from('['+JSON.stringify(key)+','),needle=Buffer.concat([Buffer.from('\n'),prefix]);
    let start=raw.subarray(0,prefix.length).equals(prefix)?0:raw.indexOf(needle);if(start<0)return [];if(start>0)start++;
    const end=raw.indexOf(10,start);if(end<0||end-start>lexiconLimits.maxEntryBytes)fail('Selected entry bound/termination');
    const [found,tuples]=JSON.parse(raw.subarray(start,end).toString('utf8'));this.#metrics.selectedParses++;
    if(found!==key||!Array.isArray(tuples)||tuples.length>512)fail('Invalid selected dictionary row');
    const entries=tuples.map(t=>expandEntry(dataset,key,t,m));
    if(entries.some(e=>!HEX.test(e.id)||e.lookup!==key||typeof e.value!=='string'||!HEX.test(e.inputSHA256)||!e.sourceEntryLocator||e.id!==sha(JSON.stringify(['entry-1',e.datasetID,e.sourceEntryLocator,e.lookup,e.value]))||e.reviewStatus!=='unreviewed-candidate'))fail('Invalid selected dictionary entry');
    // Parsing only this row provides an isolated object; callers cannot mutate the cached raw bytes.
    return entries;
    }finally{record.leases--;this.#pump();}
  }
  async lookupMany(dataset,keys){if(!Array.isArray(keys)||keys.length>lexiconLimits.maxBatchItems)fail('Lookup batch cap');return Promise.all(keys.map(k=>this.lookup(dataset,k)));}
  async thaiQualification(){
    const row=this.#index.qualifications.thai,st=await fs.lstat(path.join(this.#root,row.path));if(row.path!=='thai-qualification.json'||st.size>131072)fail('Qualification descriptor cap');
    return JSON.parse(await this.#readPinned(row.path,{bytes:st.size,sha256:row.sha256},131072));
  }
  stats(){return {...this.#metrics,cachedShards:this.#cache.size,loadingShards:this.#active.size,queuedLoads:this.#queue.length,serializedBytes:this.#bytes,reservedBytes:this.#reserved,allocatedPoolSlots:this.#allocatedSlots,poolCapacityBytes:this.#allocatedSlots*(this.#slotCapacity+1)};}
  clear(){
    // Complete the preflight before transferring any storage ownership.
    if(this.#manifestLoads.size||this.#pending.size)fail('Cannot clear active lexicon loads');
    for(const r of this.#cache.values())if(r.leases)fail('Cannot clear leased lexicon bytes');
    for(const r of this.#cache.values())this.#freeSlots.push(r.storage);
    this.#cache.clear();this.#bytes=0;
  }
}
export const packagedLexicons=new LexiconStore();
export const pronunciationDataIndex=Object.freeze(structuredClone(dataIndex));
