import {createHash} from 'node:crypto';
import {BoundedCache} from './bounded-cache.js';
import {getCached,setLyricsCached,cacheUnavailable,suspendCache} from './cache.js';
import {withDeadline} from './fetch-json.js';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const contextSignature=request=>JSON.stringify(canonical(Object.fromEntries(Object.entries(request).filter(([k])=>k!=='artist_entities'))));
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
export function verifiedCatalogProof(proof,request){
 const accepted=proof?.accepted_request;
 return proof?.version==='catalog-recording-1'&&/^apple:\d{1,20}$/.test(proof.canonical_recording_id??'')
  &&proof.requested?.catalog_id===(request.catalog_id??null)&&proof.requested?.storefront===(request.storefront??null)
  &&accepted?.catalog_id===(request.catalog_id??accepted?.catalog_id)&&/^\d{1,20}$/.test(accepted?.catalog_id??'')
  &&accepted.artist===request.artist&&accepted.title===request.title&&(accepted.album??null)===(request.album??null)&&accepted.duration===request.duration
  &&Number.isFinite(request.duration)&&Array.isArray(proof.catalog_items)&&proof.catalog_items.every(i=>i&&typeof i==='object'&&/^\d{1,20}$/.test(i.catalog_id??''))&&proof.catalog_items.some(i=>i.catalog_id===accepted.catalog_id)
  &&Array.isArray(proof.searches)&&proof.searches.length>0&&proof.searches.length<=8
  &&proof.searches.every(s=>s&&typeof s.artist==='string'&&s.artist&&typeof s.title==='string'&&s.title&&Number.isFinite(s.duration));
}
const songFields=['id','artist','title','album','duration','source','isrc','explicit','creditedArtistNames','neteaseTitleEvidence'];
export const sourceSignature=song=>Object.fromEntries(songFields.filter(k=>song[k]!==undefined).map(k=>[k,structuredClone(song[k])]));
const targetFields=['artist','title','album','duration','catalog_id','artist_entities','recordingProvider','recordingItemID','recordingKey','creditedArtistNames','isrc','explicit'];
export const sourceTarget=(target={})=>Object.fromEntries(targetFields.filter(k=>target[k]!==undefined).map(k=>[k,structuredClone(target[k])]));
export function createVerifiedContextCache({redis,getFn=getCached,setFn=setLyricsCached,waitUntilFn=()=>{},now=Date.now,ttlMs=21600000,cacheTimeoutMs=300,policy}={}){
 const memory=new BoundedCache({now,ttlMs,maxEntryBytes:131072}),writes=new Map(),keyFor=(request,kind)=>'lyrics:verified-context:v1:'+hash(JSON.stringify({kind,request:contextSignature(request),policy}));
 const valid=(value,request,kind)=>{try{return value?.version===1&&value.kind===kind&&value.signature===contextSignature(request)&&same(value.policy,policy)
  &&Number.isFinite(value.metadata?.acquisition_started_at)&&Number.isFinite(value.verifiedAtMS)&&value.verifiedAtMS<=now()+5000&&Number.isFinite(value.expiresAtMS)&&value.expiresAtMS>now()
  &&value.expiresAtMS-value.verifiedAtMS<=ttlMs&&Array.isArray(value.hints)&&value.hints.length<=1
  &&value.hints.every(h=>h&&['LRCAPI','NeteaseAPI','QQMusicAPI'].includes(h.provider)&&/^\d{1,20}$/.test(h.id??'')&&h.signature&&String(h.signature.id)===h.id&&h.signature.lyricsData===undefined
    &&typeof h.signature.artist==='string'&&typeof h.signature.title==='string'&&Number.isFinite(h.signature.duration)&&h.target&&typeof h.target.artist==='string'&&typeof h.target.title==='string'&&Number.isFinite(h.target.duration)&&h.target.lyricsData===undefined)
  &&(kind==='catalog'?Array.isArray(value.aliases)&&value.aliases.length<=8&&value.aliases.every(a=>a&&typeof a.artist==='string'&&typeof a.title==='string'&&Number.isFinite(a.duration))&&verifiedCatalogProof(value.resolution,request):value.proof?.version==='verified-spotify-source-1'&&/^[a-f0-9]{64}$/.test(value.proof.sourceHash??''));}catch{return false;}};
 return {
  async read(request,kind='catalog'){
   const key=keyFor(request,kind),local=memory.get(key);if(local&&valid(local,request,kind))return structuredClone(local);
   if(!redis||cacheUnavailable(redis))return null;
   const stored=await withDeadline(()=>getFn(redis,key),cacheTimeoutMs).catch(error=>{suspendCache(redis,error);return null;});
   const latest=memory.get(key);
   if(latest&&valid(latest,request,kind)&&(!valid(stored,request,kind)||(latest.metadata?.acquisition_started_at??0)>=(stored.metadata?.acquisition_started_at??0)))return structuredClone(latest);
   if(!valid(stored,request,kind))return null;memory.set(key,stored,{ttlMs:stored.expiresAtMS-now()});return structuredClone(stored);
  },
  catalog(request,aliases,acquisitionStartedAt){
   if(!verifiedCatalogProof(aliases?.resolution,request))return null;
   const verifiedAtMS=now();return {version:1,kind:'catalog',signature:contextSignature(request),request:JSON.parse(contextSignature(request)),policy:structuredClone(policy),verifiedAtMS,expiresAtMS:verifiedAtMS+ttlMs,aliases:structuredClone([...aliases]),resolution:structuredClone(aliases.resolution),hints:[],metadata:{acquisition_started_at:acquisitionStartedAt}};
  },
  spotify(request,response,acquisitionStartedAt){
   if(!response?.recordingBinding?.sourceHash)return null;
   const verifiedAtMS=now();return {version:1,kind:'spotify',signature:contextSignature(request),request:structuredClone(request),policy:structuredClone(policy),verifiedAtMS,expiresAtMS:verifiedAtMS+ttlMs,proof:{version:'verified-spotify-source-1',sourceHash:response.recordingBinding.sourceHash},hints:[],metadata:{acquisition_started_at:acquisitionStartedAt}};
  },
  hint(context,candidate,acquisitionStartedAt=context?.metadata?.acquisition_started_at){
   if(!context||!['LRCAPI','NeteaseAPI','QQMusicAPI'].includes(candidate.api?.name)||!/^\d{1,20}$/.test(String(candidate.song?.id??''))||candidate.timingCorrection?.status==='untimed_fallback')return context;
   return {...context,metadata:{acquisition_started_at:acquisitionStartedAt},hints:[{provider:candidate.api.name,id:String(candidate.song.id),signature:sourceSignature(candidate.song),target:sourceTarget(candidate.target)}]};
  },
  save(context){
   if(!context||!valid(context,context.request,context.kind))return;
   const key=keyFor(context.request,context.kind),remaining=context.expiresAtMS-now(),previous=memory.get(key);
   if(previous?.metadata?.acquisition_started_at>context.metadata?.acquisition_started_at)return;
   memory.set(key,structuredClone(context),{ttlMs:remaining});
   if(redis&&!cacheUnavailable(redis)){
    const work=(writes.get(key)??Promise.resolve()).then(()=>withDeadline(()=>setFn(redis,key,context,Math.max(0,context.expiresAtMS-now())/1000),cacheTimeoutMs)).catch(error=>suspendCache(redis,error));
    writes.set(key,work);work.finally(()=>{if(writes.get(key)===work)writes.delete(key);});waitUntilFn(work);
   }
  }
 };
}
