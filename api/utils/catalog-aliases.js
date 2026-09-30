import {createRequire} from 'node:module';
import {fetchJSON} from './fetch-json.js';
import {recordingScore,recordingNames,normalizeRecordingText,normalizedAlbum} from './recording-match.js';
import {configuredAppleCatalog,sameCatalogRecording,CATALOG_RESOLUTION_VERSION} from './apple-catalog.js';
const require=createRequire(import.meta.url);
const {recordings:reviewedAliases}=require('../data/reviewed-catalog-aliases.json');
const signature=(a,b)=>a.catalog_id===b.catalog_id&&Number.isFinite(a.duration)&&Math.abs(a.duration-b.duration)<=0.5
 &&['title','artist','album'].every(key=>typeof a[key]==='string'&&typeof b[key]==='string'&&normalizeRecordingText(a[key])===normalizeRecordingText(b[key]));
const valid=song=>typeof song.title==='string'&&typeof song.artist==='string'&&Number.isFinite(song.duration);
const item=(song,storefront)=>({catalog_id:String(song.trackId),title:song.trackName,artist:song.artistName,album:song.collectionName,duration:song.trackTimeMillis/1000,
 storefront,genres:song.primaryGenreName?[song.primaryGenreName]:[],provenance:'itunes'});
// Seven territories, three simultaneous reads, one caller-owned deadline. This
// registry covers native and international names without scanning every market.
export const CATALOG_TERRITORIES=['us','hk','tw','cn','jp','kr'];
async function mapBounded(values,work) {
 const results=Array(values.length);let next=0;
 await Promise.all(Array.from({length:Math.min(3,values.length)},async()=>{
  while(next<values.length){const index=next++;results[index]=await work(values[index]);}
 }));return results;
}
const key=song=>JSON.stringify([normalizeRecordingText(song.artist),normalizeRecordingText(song.title),normalizedAlbum(song.album??'')]);
const searchFields=song=>({catalog_id:song.catalog_id,title:song.title,artist:song.artist,album:song.album,duration:song.duration});
function finish(request,songs,catalogID,method) {
 const priority=s=>{const index=CATALOG_TERRITORIES.indexOf(s.storefront);return index<0?99:index;};
 const ordered=[...songs].sort((a,b)=>priority(a)-priority(b)||key(a).localeCompare(key(b),'en'));
 const expected=recordingNames(request),artists=ordered.filter(s=>recordingNames(s).credits.length===expected.credits.length);
 const complete=ordered.filter(s=>recordingNames(s).credits.length===expected.credits.length);
 const candidates=[...complete,...complete.flatMap(s=>artists.map(a=>({...s,artist:a.artist})))];
 const seen=new Set(),searches=candidates.filter(s=>{const k=key(s);if(seen.has(k))return false;seen.add(k);return true;}).map(searchFields).slice(0,8);
 const canonical=ordered.find(s=>s.storefront==='us')??ordered[0];
 const aliases=searches.filter(song=>key(song)!==key(request));
 const resolution={version:CATALOG_RESOLUTION_VERSION,method,requested:{catalog_id:request.catalog_id??null,storefront:request.storefront??null},
  canonical_recording_id:'apple:'+ordered.map(s=>s.catalog_id).sort((a,b)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0)[0],canonical_context:{title:canonical.title,artist:canonical.artist},
  accepted_request:{catalog_id:request.catalog_id??catalogID,artist:request.artist,title:request.title,album:request.album??null,duration:request.duration},
  catalog_items:[...new Map(ordered.map(s=>[s.storefront+':'+s.catalog_id,{catalog_id:s.catalog_id,storefront:s.storefront,provenance:s.provenance}])).values()],
  isrc:ordered.find(s=>s.isrc)?.isrc??null,genres:[...new Set(ordered.flatMap(s=>s.genres??[]))],searches};
 Object.defineProperty(aliases,'resolution',{value:resolution});return aliases;
}
export async function resolveCatalogAliases(request,context={}) {
 if(!Number.isFinite(request.duration))return [];
 if(process.env.LYRA_CATALOG_RESOLUTION_ENABLED==='0')return [];
 const appleCatalog=context.appleCatalog===undefined?configuredAppleCatalog():context.appleCatalog;
 let catalogID=request.catalog_id,discovered=[];
 if(catalogID!=null&&!/^\d{1,20}$/.test(catalogID))return [];
 const countries=[...new Set([...CATALOG_TERRITORIES,request.storefront??'us',request.account_storefront??'us'])].slice(0,8);
 if(!catalogID){
  if(!request.album)return [];
  const pages=await mapBounded([...new Set([request.storefront??'us','tw'])],async country=>{
   try{const params=new URLSearchParams({term:`${request.artist} ${request.title}`,country,entity:'song',limit:'15'});
    return ((await fetchJSON(`https://itunes.apple.com/search?${params}`,context)).results??[]).filter(s=>s.kind==='song').map(s=>item(s,country)).filter(valid);
   }catch{return [];}
  });
  const candidates=pages.flat().filter(s=>/^\d{1,20}$/.test(s.catalog_id)&&recordingScore(s,request)>=0&&s.album&&normalizedAlbum(s.album)===normalizedAlbum(request.album));
  const ids=[...new Set(candidates.map(s=>s.catalog_id))];if(ids.length!==1)return [];
  catalogID=ids[0];discovered=pages.flat().filter(s=>s.catalog_id===catalogID);
 }
 const results=await mapBounded(countries,async country=>{
  if(context.signal?.aborted)return [];
  if(appleCatalog){try{const songs=await appleCatalog.lookup(catalogID,country,context);if(songs.some(song=>Math.abs(song.duration-request.duration)<=0.5))return songs;}catch{}}
  try{
   const lang={tw:'zh_tw',cn:'zh_cn'}[country];
   const params=new URLSearchParams({id:catalogID,country,...(lang?{lang}:{})});
   return ((await fetchJSON(`https://itunes.apple.com/lookup?${params}`,context)).results??[])
    .filter(s=>s.kind==='song'&&String(s.trackId)===catalogID).map(s=>item(s,country)).filter(valid);
  }catch{return [];}
 });
 let songs=[...discovered,...results.flat()].filter(s=>s.catalog_id===catalogID&&Math.abs(s.duration-request.duration)<=0.5);
 const expected=recordingNames(request);
 const titleMatches=songs.filter(s=>recordingNames(s).title===expected.title);
 const artists=songs.filter(s=>JSON.stringify(recordingNames(s).credits)===JSON.stringify(expected.credits));
 if(!titleMatches.length||!artists.length){
  const review=reviewedAliases.find(entry=>entry.acceptedRequests.some(s=>signature(request,s)));
  const anchors=review?songs.filter(song=>review.anchors.some(anchor=>signature(song,anchor))):[];
  return anchors.length?finish(request,anchors,catalogID,'reviewed_alias'):[];
 }
 if(!titleMatches.some(s=>recordingScore({...s,artist:request.artist,title:request.title},request)>=0))return [];
 if(request.album&&!songs.some(s=>s.album&&normalizedAlbum(s.album)===normalizedAlbum(request.album)))return [];
 const anchor=songs.find(s=>s.isrc&&s.artist_ids?.length);
 if(request.isrc&&anchor?.isrc&&request.isrc!==anchor.isrc)return [];
 if(appleCatalog&&anchor&&!context.signal?.aborted&&process.env.LYRA_CATALOG_EQUIVALENTS_ENABLED!=='0'){
  const missing=countries.filter(country=>!songs.some(s=>s.storefront===country));
  const equivalents=await mapBounded(missing.slice(0,3),async country=>{
   try{
    let items=await appleCatalog.equivalents(catalogID,country,context);
    if(!items.length)items=await appleCatalog.byISRC(anchor.isrc,country,context);
    const verified=items.filter(s=>sameCatalogRecording(anchor,s));
    return new Set(verified.map(s=>s.catalog_id)).size===1?verified:[];
   }catch{return [];}
  });songs=[...songs,...equivalents.flat()];
 }
 return finish(request,songs,catalogID,songs.some(s=>s.catalog_id!==catalogID)?'catalog_equivalent':'same_catalog_id');
}
