import {createHash} from 'node:crypto';
import fetch from 'node-fetch';
import {setTimeout as delay} from 'node:timers/promises';
import {BoundedCache} from './bounded-cache.js';
import {withDeadline} from './fetch-json.js';
import {getCached,setLyricsCached,cacheUnavailable,suspendCache} from './cache.js';
import {validArtistIdentity} from './artist-identities.js';
import {configuredAppleCatalog,sameCatalogRecording} from './apple-catalog.js';
import {normalizeRecordingText,normalizedAlbum,recordingScore,creditSegmentations,sameRecordingVersions} from './recording-match.js';

export const ARTIST_DISCOVERY_CAPABILITY='verified-artist-discovery-1';
const TTL=86400000,NEGATIVE_TTL=300000,MAX_BYTES=2097152;
const spotifyID=v=>typeof v==='string'&&/^[A-Za-z0-9]{22}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const text=v=>typeof v==='string'&&v.trim().length>0&&Array.from(v).length<=512&&!/\p{C}/u.test(v);
const names=v=>Array.isArray(v)&&v.length>0&&v.length<=256&&v.every(text)&&new Set(v).size===v.length;
const providerIDs=(v,pattern)=>Array.isArray(v)&&v.length<=16&&v.every(n=>typeof n==='string'&&pattern.test(n))&&new Set(v).size===v.length;
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const digest=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const signed=v=>({...v,fingerprint:digest(v)});
const intact=v=>{const {fingerprint,...body}=v;return fingerprint===digest(body);};
const signature=r=>({itemID:r.recordingItemID,title:r.title,album:r.album??null,duration:r.duration,artists:r.creditedArtistNames,artistIDs:r.creditedArtistIDs??null,isrc:r.isrc??null,explicit:r.explicit??null});
const source=s=>({id:String(s.id),provider:s.source,title:s.title,artist:s.artist,album:s.album,duration:s.duration,artists:s.creditedArtistNames??null,isrc:s.isrc??null,explicit:s.explicit??null});
const eligible=r=>r?.recordingProvider==='spotify'&&spotifyID(r.recordingItemID)&&text(r.title)&&text(r.album)&&Number.isFinite(r.duration)&&r.duration>0
 &&Array.isArray(r.creditedArtistNames)&&r.creditedArtistNames.length>0&&r.creditedArtistNames.length<=3&&r.creditedArtistNames.every(text)
 &&new Set(r.creditedArtistNames.map(normalizeRecordingText)).size===r.creditedArtistNames.length;
const fresh=(v,now)=>v.verifiedAtMS<=now+5000&&v.expiresAtMS>now;
const clock=v=>Number.isFinite(v.verifiedAtMS)&&Number.isFinite(v.expiresAtMS)&&v.expiresAtMS-v.verifiedAtMS===TTL;
function validIdentity(v) {
 try{return validArtistIdentity(v)||v?.version===1&&v.policy===ARTIST_DISCOVERY_CAPABILITY&&v.authority==='musicbrainz'
  &&spotifyID(v.spotifyArtistID)&&uuid(v.artistID)&&uuid(v.urlID)&&/^Q[1-9]\d{0,18}$/.test(v.entityID)&&Number.isSafeInteger(v.entityRevision)&&v.entityRevision>0
  &&names(v.names)&&providerIDs(v.neteaseArtistIDs,/^[1-9]\d{0,19}$/)&&providerIDs(v.qqSingerMIDs,/^\d{3}[A-Za-z0-9]{11}$/)&&clock(v)&&intact(v);}catch{return false;}
}
export const validDiscoveryIdentity=validIdentity;
function assignments(credits,groups) {
 const found=[];
 const visit=(at,used,chosen)=>{
  if(found.length>1)return;
  if(at===credits.length){found.push(chosen);return;}
  for(let i=0;i<groups.length;i++)if(!used.has(i)&&groups[i].some(n=>normalizeRecordingText(n)===normalizeRecordingText(credits[at])))
   visit(at+1,new Set([...used,i]),[...chosen,i]);
 };
 if(credits.length===groups.length)visit(0,new Set(),[]);return found;
}
const native=v=>/[^\p{Script=Latin}\p{M}\p{N}\p{P}\p{Z}\s]/u.test(v);
const scripts=['Han','Hiragana','Katakana','Hangul','Cyrillic','Arabic','Devanagari','Greek','Hebrew','Thai'].map(s=>new RegExp(`\\p{Script_Extensions=${s}}`,'u'));
function groupsFor(plan,r) {
 if(plan.apple)return plan.apple.groups;
 return r.creditedArtistIDs?.map((id,i)=>{
  const matches=plan.identities.filter(v=>validIdentity(v)&&v.spotifyArtistID===id&&v.names.some(n=>normalizeRecordingText(n)===normalizeRecordingText(r.creditedArtistNames[i])));
  return matches.length===1?matches[0].names:[];
 })??[];
}
export function artistDiscoveryNames(plan,r) {
 if(!validArtistDiscovery(plan,r))return null;
 const selected=groupsFor(plan,r).map((group,i)=>{
  const alternatives=group.filter(n=>normalizeRecordingText(n)!==normalizeRecordingText(r.creditedArtistNames[i]));
  return alternatives.find(n=>scripts.some(s=>s.test(r.title)&&s.test(n)))??alternatives.find(native)??alternatives[0]??r.creditedArtistNames[i];
 });
 return selected.length===r.creditedArtistNames.length&&new Set(selected.map(normalizeRecordingText)).size===selected.length
  &&!equal(selected,r.creditedArtistNames)?selected:null;
}
export function validArtistDiscovery(plan,r) {
 try {
  if(!eligible(r)||plan?.version!==1||plan.policy!==ARTIST_DISCOVERY_CAPABILITY||!equal(plan.request,signature(r))||!intact(plan))return false;
  if(plan.apple)return validApple(plan.apple,r);
  return Array.isArray(plan.identities)&&plan.identities.length===r.creditedArtistNames.length
   &&new Set(plan.identities.map(v=>v.spotifyArtistID)).size===plan.identities.length
   &&groupsFor(plan,r).length===r.creditedArtistNames.length&&groupsFor(plan,r).every(names);
 }catch{return false;}
}
// One process gate plus a Redis NX lease bounds the aggregate serverless rate.
// A failed shared gate abstains; it never falls through to an unthrottled call.
let nextMusicBrainz=0;
async function musicBrainzGate(signal,redis) {
 signal.throwIfAborted();
 while(Date.now()<nextMusicBrainz)await delay(nextMusicBrainz-Date.now(),undefined,{signal});
 nextMusicBrainz=Date.now()+1050;
 if(redis) {
  if(cacheUnavailable(redis)||typeof redis.set!=='function')throw new Error('artist_rate_gate_unavailable');
  while(await redis.set('lyrics:musicbrainz:request-gate','1',{nx:true,px:1050})!=='OK')await delay(1050,undefined,{signal});
 }
 signal.throwIfAborted();
}
function claimValues(entity,key) {
 const rows=entity.claims?.[key]??[];
 if(!Array.isArray(rows)||rows.length>32)throw new Error('invalid_artist_claim');
 return rows.filter(v=>v.rank!=='deprecated').map(v=>{
  if(!['normal','preferred'].includes(v.rank)||v.mainsnak?.snaktype!=='value'||typeof v.mainsnak?.datavalue?.value!=='string')throw new Error('invalid_artist_claim');
  return v.mainsnak.datavalue.value;
 });
}
function appleShape(s) {
 return s&&/^\d{1,20}$/.test(s.catalog_id)&&text(s.title)&&text(s.artist)&&text(s.album)&&Number.isFinite(s.duration)
  &&Array.isArray(s.artist_ids)&&s.artist_ids.length>0&&s.artist_ids.length<=3&&new Set(s.artist_ids).size===s.artist_ids.length
  &&s.artist_ids.every(id=>typeof id==='string'&&/^\d{1,20}$/.test(id))&&Array.isArray(s.artist_entities)&&s.artist_entities.length===s.artist_ids.length
  &&s.artist_entities.every(e=>s.artist_ids.includes(e.id)&&text(e.name))&&new Set(s.artist_entities.map(e=>e.id)).size===s.artist_ids.length;
}
function appleGroups(items,r) {
 if(!items.length||!items.every(appleShape))return null;
 const anchors=items.filter(s=>s.isrc===r.isrc&&Math.abs(s.duration-r.duration)<=0.5&&normalizedAlbum(s.album)===normalizedAlbum(r.album)
  &&normalizeRecordingText(s.title)===normalizeRecordingText(r.title)&&sameRecordingVersions(s,r)
  &&!(typeof r.explicit==='boolean'&&(s.content_rating==='explicit')!==r.explicit));
 const anchor=anchors[0];
 if(!anchor||anchor.artist_ids.length!==r.creditedArtistNames.length)return null;
 if(anchors.some(s=>!sameCatalogRecording(anchor,s)))return null;
 // A conflicting localization of the same ID cannot be silently discarded.
 if(items.some(s=>s.catalog_id===anchor.catalog_id&&!sameCatalogRecording(anchor,s)))return null;
 const localized=items.filter(s=>s.catalog_id===anchor.catalog_id&&sameCatalogRecording(anchor,s));
 const groups=anchor.artist_ids.map(id=>[...new Set(localized.flatMap(s=>s.artist_entities.filter(e=>e.id===id).map(e=>e.name)))]);
 const matches=groups.length===1?[[0]]:assignments(r.creditedArtistNames,groups);
 if(matches.length!==1)return null;
 return matches[0].map((at,i)=>[...new Set([r.creditedArtistNames[i],...groups[at]])]);
}
function validApple(v,r) {
 return !!r.isrc&&equal(v.request,signature(r))&&clock(v)&&intact(v)&&Array.isArray(v.items)&&v.items.length<=40
  &&Array.isArray(v.groups)&&v.groups.length===r.creditedArtistNames.length&&v.groups.every(names)&&equal(v.groups,appleGroups(v.items,r));
}
export function createArtistDiscoveryResolver({fetchFn=fetch,redis=null,getFn=getCached,setFn=setLyricsCached,now=Date.now,
 budgetMs=4000,cacheTimeoutMs=200,rateGate,appleCatalog=configuredAppleCatalog()}={}) {
 const cache=new BoundedCache({limit:512,ttlMs:TTL,now,maxEntryBytes:131072});let latestStart=0;
 const appleCache=new BoundedCache({limit:128,ttlMs:TTL,now});
 async function json(url,signal,{mb=false,retry=true}={}) {
  if(mb)await (rateGate?rateGate(signal):musicBrainzGate(signal,redis));
  const response=await fetchFn(url,{signal,redirect:'error',size:MAX_BYTES,headers:{Accept:'application/json','User-Agent':'Lyrica/2.3.0 (https://github.com/hongkuntian/lyrics-to-pinyin-api)'}});
  // MusicBrainz explicitly returns 503 when busy. One rate-gated retry shares
  // the same fixed deadline; failures never populate the negative cache.
  if(mb&&retry&&response.status===503){
   const header=response.headers?.get?.('retry-after');response.body?.destroy?.();
   if(header!=null) {
    const ms=/^\d+(?:\.\d+)?$/.test(header)?Number(header)*1000:Date.parse(header)-Date.now();
    if(!Number.isFinite(ms)||ms>budgetMs)throw new Error('artist_discovery_busy');
    if(ms>0)await delay(ms,undefined,{signal});
   }
   return json(url,signal,{mb:true,retry:false});
  }
  if(response.status===404&&mb)return null;
  if(!response.ok||Number(response.headers?.get?.('content-length')??0)>MAX_BYTES)throw new Error('artist_discovery_unavailable');
  const raw=await response.text();signal.throwIfAborted();if(Buffer.byteLength(raw)>MAX_BYTES)throw new Error('artist_discovery_oversize');return JSON.parse(raw);
 }
 async function musicbrainz(spotifyArtistID,signal,refresh) {
  const key=`lyrics:artist-discovery:${ARTIST_DISCOVERY_CAPABILITY}:${spotifyArtistID}`,started=latestStart=Math.max(now(),latestStart+0.001);
  const validEntry=v=>v?.artistID===spotifyArtistID&&Number.isFinite(v.metadata?.acquisition_started_at)&&v.verifiedAtMS<=now()+5000&&v.expiresAtMS>now()
   &&v.expiresAtMS-v.verifiedAtMS===(v.identity?TTL:NEGATIVE_TTL)&&(!v.identity||validIdentity(v.identity)&&v.identity.spotifyArtistID===spotifyArtistID&&fresh(v.identity,now()));
  let cached=refresh?null:cache.get(key);
  if(!refresh&&!validEntry(cached)&&redis&&!cacheUnavailable(redis))cached=await withDeadline(()=>getFn(redis,key),cacheTimeoutMs,signal).catch(e=>{suspendCache(redis,e);return null;});
  if(validEntry(cached)){cache.set(key,structuredClone(cached),{ttlMs:cached.expiresAtMS-now()});return structuredClone(cached.identity);}
  const resource='https://open.spotify.com/artist/'+spotifyArtistID;
  const reverse=await json('https://musicbrainz.org/ws/2/url/?'+new URLSearchParams({fmt:'json',resource,inc:'artist-rels'}),signal,{mb:true});
  let identity=null;
  if(reverse) {
   if(reverse.resource!==resource||!uuid(reverse.id)||!Array.isArray(reverse.relations)||reverse.relations.length>32)throw new Error('invalid_artist_url');
   const links=reverse.relations.filter(v=>v['target-type']==='artist');
   if(links.length!==1||links[0].type!=='free streaming'||links[0].direction!=='backward'||links[0].ended!==false||!uuid(links[0].artist?.id)) {
    if(links.length)throw new Error('ambiguous_artist_url');
   }else {
    const artistID=links[0].artist.id,artist=await json(`https://musicbrainz.org/ws/2/artist/${artistID}?`+new URLSearchParams({inc:'aliases+url-rels',fmt:'json'}),signal,{mb:true});
    if(artist?.id!==artistID||!text(artist.name)||!Array.isArray(artist.relations)||artist.relations.length>256||!Array.isArray(artist.aliases)||artist.aliases.length>256)throw new Error('invalid_artist');
    const reciprocal=artist.relations.filter(v=>v.type==='free streaming'&&v.url?.resource===resource);
    if(reciprocal.length!==1||reciprocal[0].ended!==false||reciprocal[0].url.id!==reverse.id)throw new Error('artist_url_changed');
    const wiki=artist.relations.filter(v=>v.type==='wikidata'&&v.ended===false);
    const qid=wiki.length===1?/^https:\/\/www\.wikidata\.org\/wiki\/(Q[1-9]\d{0,18})$/.exec(wiki[0].url?.resource??'')?.[1]:null;
    if(qid) {
     const data=await json('https://www.wikidata.org/w/api.php?'+new URLSearchParams({action:'wbgetentities',ids:qid,props:'labels|aliases|claims|info',format:'json'}),signal),entity=data.entities?.[qid];
     if(entity?.id!==qid||entity.type!=='item'||!Number.isSafeInteger(entity.lastrevid)||entity.lastrevid<=0||!equal([...new Set(claimValues(entity,'P434'))],[artistID]))throw new Error('artist_entity_changed');
     const spotify=claimValues(entity,'P1902');if(spotify.length&&!spotify.includes(spotifyArtistID))throw new Error('artist_spotify_conflict');
     const aliases=Object.values(entity.aliases??{});if(aliases.some(v=>!Array.isArray(v)))throw new Error('invalid_artist_aliases');
     const all=[artist.name,...artist.aliases.filter(v=>v.type===null||v.type==='Artist name').map(v=>v.name),...Object.values(entity.labels??{}).map(v=>v.value),...aliases.flatMap(v=>v.map(n=>n.value))];
     const distinct=[...new Set(all)];if(!names(distinct))throw new Error('invalid_artist_names');
     const neteaseArtistIDs=[...new Set(claimValues(entity,'P10445'))].sort(),qqSingerMIDs=[...new Set(claimValues(entity,'P10410'))].sort();
     if(!providerIDs(neteaseArtistIDs,/^[1-9]\d{0,19}$/)||!providerIDs(qqSingerMIDs,/^\d{3}[A-Za-z0-9]{11}$/))throw new Error('invalid_artist_provider_ids');
     const verifiedAtMS=now();identity=signed({version:1,policy:ARTIST_DISCOVERY_CAPABILITY,authority:'musicbrainz',spotifyArtistID,artistID,urlID:reverse.id,entityID:qid,entityRevision:entity.lastrevid,names:distinct,neteaseArtistIDs,qqSingerMIDs,verifiedAtMS,expiresAtMS:verifiedAtMS+TTL});
    }
   }
  }
  signal.throwIfAborted();const verifiedAtMS=identity?.verifiedAtMS??now(),entry={artistID:spotifyArtistID,identity,verifiedAtMS,expiresAtMS:verifiedAtMS+(identity?TTL:NEGATIVE_TTL),metadata:{acquisition_started_at:started}};
  const previous=cache.get(key);if(!previous||previous.metadata.acquisition_started_at<=started)cache.set(key,entry,{ttlMs:entry.expiresAtMS-now()});
  if(redis&&!cacheUnavailable(redis))await withDeadline(()=>setFn(redis,key,entry,(entry.expiresAtMS-now())/1000),cacheTimeoutMs,signal).catch(e=>suspendCache(redis,e));
  return structuredClone(identity);
 }
 return async function resolve(request,{identities=[],signal,refresh=false}={}) {
  if(!eligible(request))return null;
  try{return await withDeadline(async child=>{
   const ids=request.creditedArtistIDs,validIDs=Array.isArray(ids)&&ids.length===request.creditedArtistNames.length&&ids.every(spotifyID)&&new Set(ids).size===ids.length;
   const found=validIDs?await Promise.all(ids.map(async id=>{
    const existing=identities.filter(v=>validArtistIdentity(v,{now:now(),fresh:true})&&v.spotifyArtistID===id);
    return existing.length===1?existing[0]:musicbrainz(id,child,refresh).catch(()=>null);
   })):[];
   child.throwIfAborted();let plan=signed({version:1,policy:ARTIST_DISCOVERY_CAPABILITY,request:signature(request),identities:found.filter(Boolean)});
   if(artistDiscoveryNames(plan,request))return plan;
   if(!appleCatalog||!request.isrc)return null;
   const key=digest(signature(request));let apple=refresh?null:appleCache.get(key);
   if(!apple||!fresh(apple,now())||!validApple(apple,request)) {
    const pages=await Promise.allSettled(['us','tw'].map(country=>appleCatalog.byISRC(request.isrc,country,{signal:child})));
    child.throwIfAborted();const items=pages.flatMap(p=>p.status==='fulfilled'&&Array.isArray(p.value)?p.value:[]).map(s=>Object.fromEntries(['catalog_id','title','artist','album','duration','isrc','artist_ids','artist_entities','content_rating'].map(k=>[k,s[k]??null])));
    const groups=appleGroups(items,request);if(!groups||items.length>40)return null;
    const verifiedAtMS=now();apple=signed({request:signature(request),items,groups,verifiedAtMS,expiresAtMS:verifiedAtMS+TTL});appleCache.set(key,apple);
   }
   plan=signed({version:1,policy:ARTIST_DISCOVERY_CAPABILITY,request:signature(request),identities:[],apple});
   return artistDiscoveryNames(plan,request)?plan:null;
  },budgetMs,signal);}catch{return null;}
 };
}
export function buildArtistDiscoveryEvidence(song,request,plan) {
 try {
  if(song?.source!=='lrclib'||!/^\d{1,20}$/.test(String(song.id))||!validArtistDiscovery(plan,request)||!text(song.artist)||!text(song.album)
   ||normalizedAlbum(song.album)!==normalizedAlbum(request.album)||Math.abs(song.duration-request.duration)>0.5
   ||recordingScore({...song,artistAliasEvidence:undefined,creditedArtistNames:request.creditedArtistNames},request)<0)return null;
  const groups=groupsFor(plan,request),parsed=song.creditedArtistNames===undefined?creditSegmentations(song.artist,groups.flat()):[song.creditedArtistNames.map(normalizeRecordingText)];
  if(parsed.length!==1||parsed[0].length!==groups.length||new Set(parsed[0]).size!==parsed[0].length||assignments(parsed[0],groups).length!==1)return null;
  const printed=creditSegmentations(song.artist,groups.flat());if(printed.length!==1||!equal([...printed[0]].sort(),[...parsed[0]].sort()))return null;
  return {version:1,policy:ARTIST_DISCOVERY_CAPABILITY,source:source(song),request:signature(request),discovery:structuredClone(plan)};
 }catch{return null;}
}
export function recoveredDiscoveryNames(song,request) {
 const evidence=song?.artistAliasEvidence;
 try {
  if(evidence?.version!==1||evidence.policy!==ARTIST_DISCOVERY_CAPABILITY||!equal(evidence.source,source(song))||!equal(evidence.request,signature(request)))return null;
  return buildArtistDiscoveryEvidence({...song,artistAliasEvidence:undefined},request,evidence.discovery)?[...request.creditedArtistNames]:null;
 }catch{return null;}
}
