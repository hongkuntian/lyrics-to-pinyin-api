import {createHash} from 'node:crypto';
import fetch from 'node-fetch';
import {BoundedCache} from './bounded-cache.js';
import {withDeadline} from './fetch-json.js';
import {getCached,setLyricsCached,cacheUnavailable,suspendCache} from './cache.js';

export const ARTIST_IDENTITY_CAPABILITY='wikidata-artist-identities-1';
const TTL=86400000,NEGATIVE_TTL=300000,MAX_NAMES=256,MAX_BYTES=2097152;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9]{22}$/.test(value);
const entityID=value=>typeof value==='string'&&/^Q[1-9]\d{0,18}$/.test(value);
const scalar=value=>typeof value==='string'&&value.trim().length>0&&Array.from(value).length<=512&&!/[\p{C}]/u.test(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint=value=>hash([value.policy,value.spotifyArtistID,value.entityID,value.entityRevision,value.names,value.neteaseArtistIDs]);
// Cache freshness is an acquisition rule. Historical documents keep the exact
// accepted snapshot; expiration cannot invalidate their saved learning content.
export function validArtistIdentity(value,{now=Date.now(),fresh=false}={}) {
 try {
  return value?.version===1&&value.policy===ARTIST_IDENTITY_CAPABILITY&&id(value.spotifyArtistID)&&entityID(value.entityID)
   &&Number.isSafeInteger(value.entityRevision)&&value.entityRevision>0
   &&Array.isArray(value.names)&&value.names.length>0&&value.names.length<=MAX_NAMES&&value.names.every(scalar)
   &&new Set(value.names).size===value.names.length
   &&Array.isArray(value.neteaseArtistIDs)&&value.neteaseArtistIDs.length<=16&&value.neteaseArtistIDs.every(v=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v))
   &&new Set(value.neteaseArtistIDs).size===value.neteaseArtistIDs.length
   &&Number.isFinite(value.verifiedAtMS)&&Number.isFinite(value.expiresAtMS)&&value.expiresAtMS-value.verifiedAtMS===TTL
   &&value.fingerprint===fingerprint(value)
   &&(!fresh||value.verifiedAtMS<=now+5000&&value.expiresAtMS>now);
 }catch{return false;}
}
const claims=(entity,property)=>{
 const values=entity.claims?.[property]??[];
 if(!Array.isArray(values)||values.length>32)throw new Error('invalid_identity_claims');
 return [...new Set(values.filter(v=>v.rank!=='deprecated').map(v=>{
  if(!['normal','preferred',undefined].includes(v.rank)||v.mainsnak?.snaktype!=='value'||typeof v.mainsnak?.datavalue?.value!=='string')throw new Error('invalid_identity_claim');
  return v.mainsnak.datavalue.value;
 }))];
};
function snapshot(entity,spotifyArtistID,now) {
 if(entity?.type!=='item'||!entityID(entity.id)||!Number.isSafeInteger(entity.lastrevid)||entity.lastrevid<=0
   ||!claims(entity,'P1902').includes(spotifyArtistID))return null;
 const names=[...Object.values(entity.labels??{}).map(v=>v.value),...Object.values(entity.aliases??{}).flatMap(v=>{
  if(!Array.isArray(v))throw new Error('invalid_identity_aliases');return v.map(n=>n.value);
 })];
 if(!names.length||!names.every(scalar)||names.length>1024)return null;
 const distinct=[...new Set(names)].sort();if(distinct.length>MAX_NAMES)return null;
 const value={version:1,policy:ARTIST_IDENTITY_CAPABILITY,spotifyArtistID,entityID:entity.id,entityRevision:entity.lastrevid,
  names:distinct,neteaseArtistIDs:claims(entity,'P10445').sort(),verifiedAtMS:now,expiresAtMS:now+TTL};
 value.fingerprint=fingerprint(value);return validArtistIdentity(value)?value:null;
}
export function createArtistIdentityResolver({fetchFn=fetch,redis=null,getFn=getCached,setFn=setLyricsCached,now=Date.now,budgetMs=2200,cacheTimeoutMs=200}={}) {
 const cache=new BoundedCache({limit:512,ttlMs:TTL,now,maxEntryBytes:131072});let latestStart=0;
 const keyFor=artistID=>`lyrics:artist-identity:${ARTIST_IDENTITY_CAPABILITY}:${artistID}`;
 const validEntry=(v,artistID)=>v?.version===1&&v.artistID===artistID&&Number.isFinite(v.metadata?.acquisition_started_at)&&Number.isFinite(v.verifiedAtMS)&&v.verifiedAtMS<=now()+5000
  &&Number.isFinite(v.expiresAtMS)&&v.expiresAtMS>now()&&v.expiresAtMS-v.verifiedAtMS===(v.identity?TTL:NEGATIVE_TTL)
  &&(v.identity?validArtistIdentity(v.identity,{now:now(),fresh:true})&&v.identity.spotifyArtistID===artistID&&v.identity.expiresAtMS===v.expiresAtMS:v.identity===null);
 async function json(url,signal) {
  const response=await fetchFn(url,{signal,redirect:'error',size:MAX_BYTES,headers:{'Accept':'application/json','User-Agent':'Lyrica/2.3.0 (https://github.com/hongkuntian/lyrics-to-pinyin-api)'}});
  if(!response.ok||Number(response.headers?.get?.('content-length')??0)>MAX_BYTES)throw new Error('identity_lookup_unavailable');
  const body=await response.text();signal.throwIfAborted();
  if(Buffer.byteLength(body)>MAX_BYTES)throw new Error('identity_response_too_large');return JSON.parse(body);
 }
 return async function resolve(artistIDs,{signal,refresh=false}={}) {
  if(!Array.isArray(artistIDs)||!artistIDs.length||artistIDs.length>3||!artistIDs.every(id)||new Set(artistIDs).size!==artistIDs.length)return [];
  const found=new Map();
  const acquisitionStartedAt=latestStart=Math.max(now(),latestStart+0.001);
  try {await withDeadline(async child=>{
   const missing=[];
   await Promise.all(artistIDs.map(async artistID=>{
    let entry=refresh?null:cache.get(artistID);
    if(!validEntry(entry,artistID)&&!refresh&&redis&&!cacheUnavailable(redis)) {
     entry=await withDeadline(()=>getFn(redis,keyFor(artistID)),cacheTimeoutMs,child).catch(error=>{suspendCache(redis,error);return null;});
    }
    child.throwIfAborted();
    if(validEntry(entry,artistID)){cache.set(artistID,entry,{ttlMs:entry.expiresAtMS-now()});if(entry.identity)found.set(artistID,entry.identity);}
    else missing.push(artistID);
   }));
   if(!missing.length)return;
   const limit=missing.length*4+1;
   const query=`SELECT DISTINCT ?spotify ?entity WHERE { VALUES ?spotify { ${missing.map(v=>JSON.stringify(v)).join(' ')} } ?entity p:P1902 ?statement . ?statement ps:P1902 ?spotify ; wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank) } LIMIT ${limit}`;
   const mapped=await json('https://query.wikidata.org/sparql?'+new URLSearchParams({query,format:'json'}),child),rows=mapped.results?.bindings;
   if(!Array.isArray(rows)||rows.length>=limit)throw new Error('ambiguous_identity_response');
   const entitiesByID=new Map(missing.map(v=>[v,new Set()]));
   for(const row of rows) {
    const match=/^https?:\/\/www\.wikidata\.org\/entity\/(Q[1-9]\d{0,18})$/.exec(row.entity?.value??'');
    if(row.spotify?.type!=='literal'||row.entity?.type!=='uri'||!entitiesByID.has(row.spotify.value)||!match)throw new Error('invalid_identity_mapping');
    entitiesByID.get(row.spotify.value).add(match[1]);
   }
   const unique=[...new Set([...entitiesByID.values()].filter(v=>v.size===1).map(v=>[...v][0]))];
   const data=unique.length?await json('https://www.wikidata.org/w/api.php?'+new URLSearchParams({action:'wbgetentities',ids:unique.join('|'),props:'labels|aliases|claims|info',format:'json'}),child):{entities:{}};
   if(!data.entities||typeof data.entities!=='object'||Array.isArray(data.entities))throw new Error('invalid_identity_entities');
   child.throwIfAborted();
   const writes=[];
   for(const artistID of missing) {
    const matches=entitiesByID.get(artistID),qid=matches.size===1?[...matches][0]:null;
    let identity=null;
    if(qid&&data.entities[qid]?.id===qid)try{identity=snapshot(data.entities[qid],artistID,now());}catch{}
    const verifiedAtMS=now(),entry={version:1,artistID,identity,verifiedAtMS,expiresAtMS:identity?.expiresAtMS??verifiedAtMS+NEGATIVE_TTL,
     metadata:{acquisition_started_at:acquisitionStartedAt}};
    // Match the positive snapshot's clock exactly, including injected clocks.
    if(identity)entry.verifiedAtMS=identity.verifiedAtMS;
    child.throwIfAborted();
    const previous=cache.get(artistID);
    if(!previous||previous.metadata.acquisition_started_at<=acquisitionStartedAt)cache.set(artistID,structuredClone(entry),{ttlMs:entry.expiresAtMS-now()});
    if(identity)found.set(artistID,identity);
    if(redis&&!cacheUnavailable(redis))writes.push(withDeadline(()=>setFn(redis,keyFor(artistID),entry,(entry.expiresAtMS-now())/1000),cacheTimeoutMs,child).catch(error=>suspendCache(redis,error)));
   }
   await Promise.all(writes);
  },budgetMs,signal);}catch{if(signal?.aborted)return [];}
  return artistIDs.flatMap(artistID=>found.has(artistID)?[structuredClone(found.get(artistID))]:[]);
 };
}
