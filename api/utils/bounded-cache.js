// Per-instance fallback, never a substitute for shared durable cache.
export class BoundedCache {
  constructor({limit=128,ttlMs=86400000,now=Date.now,maxEntryBytes=262144}={}) {
    this.entries=new Map(); this.limit=limit; this.ttlMs=ttlMs; this.now=now; this.maxEntryBytes=maxEntryBytes;
  }
  get(key) {
    const entry=this.entries.get(key);
    if(!entry) return null;
    this.entries.delete(key);
    if(entry.expires<=this.now()) return null;
    this.entries.set(key,entry);return entry.value;
  }
  set(key,value) {
    if(Buffer.byteLength(JSON.stringify(value))>this.maxEntryBytes) return;
    this.entries.delete(key);
    this.entries.set(key,{value,expires:this.now()+this.ttlMs});
    while(this.entries.size>this.limit) this.entries.delete(this.entries.keys().next().value);
  }
}
