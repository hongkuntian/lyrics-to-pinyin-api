import {fetchJSON} from './fetch-json.js';
import {recordingScore,recordingNames,normalizeRecordingText,normalizedAlbum} from './recording-match.js';

const item=song=>({catalog_id:String(song.trackId),title:song.trackName,artist:song.artistName,album:song.collectionName,duration:song.trackTimeMillis/1000});
const valid=song=>typeof song.title==='string' && typeof song.artist==='string' && Number.isFinite(song.duration);
// Public catalog metadata supplies aliases. No translated title or artist supplied
// by the client becomes evidence. All alternate names belong to one catalog ID.
export async function resolveCatalogAliases(request, context={}) {
  if (!Number.isFinite(request.duration)) return [];
  let catalogID=request.catalog_id, discovered=[];
  if(catalogID!=null && !/^\d{1,20}$/.test(catalogID)) return [];
  if(!catalogID) {
    // Older/library-only requests may lack a catalog URL. Discovery needs the
    // full names, duration AND album and must resolve to one unambiguous ID.
    if(!request.album) return [];
    const countries=[...new Set([request.storefront || 'us','tw'])];
    const pages=await Promise.all(countries.map(async country=>{
      try {
        const params=new URLSearchParams({term:`${request.artist} ${request.title}`,country,entity:'song',limit:'15',lang:country==='tw'?'zh_tw':'en_us'});
        const data=await fetchJSON(`https://itunes.apple.com/search?${params}`,context);
        return (data.results || []).filter(s=>s.kind==='song').map(item).filter(valid);
      } catch { return []; }
    }));
    const candidates=pages.flat().filter(s=>/^\d{1,20}$/.test(s.catalog_id) && recordingScore(s,request)>=0 && s.album && normalizedAlbum(s.album)===normalizedAlbum(request.album));
    const ids=[...new Set(candidates.map(s=>s.catalog_id))];
    if(ids.length!==1) return [];
    catalogID=ids[0];discovered=pages.flat().filter(s=>s.catalog_id===catalogID);
  }
  const locales=[{country:request.storefront || 'us',lang:'en_us'},{country:'tw',lang:'zh_tw'},{country:'cn',lang:'zh_cn'}];
  const results=await Promise.all(locales.map(async locale=> {
    try {
      const params=new URLSearchParams({id:catalogID,...locale});
      const data=await fetchJSON(`https://itunes.apple.com/lookup?${params}`,context);
      return (data.results || []).filter(s=>s.kind==='song' && String(s.trackId)===catalogID).map(item).filter(valid);
    } catch { return []; }
  }));
  const songs=[...discovered,...results.flat()].filter(s=>Math.abs(s.duration-request.duration)<=3);
  // MusicKit can combine an English artist with a Chinese title. Verify those
  // components independently, but only within this single authoritative item.
  const expected=recordingNames(request);
  const titleMatches=songs.filter(s=>recordingNames(s).title===expected.title);
  const artists=songs.filter(s=>JSON.stringify(recordingNames(s).credits)===JSON.stringify(expected.credits));
  if(!titleMatches.length || !artists.length) return [];
  if(!titleMatches.some(s=>recordingScore({...s,artist:request.artist,title:request.title},request)>=0)) return [];
  const mixed=songs.flatMap(s=>artists.map(a=>({...s,artist:a.artist})));
  const seen=new Set(),original=JSON.stringify([normalizeRecordingText(request.artist),normalizeRecordingText(request.title)]);
  return [...mixed,...songs].filter(song=> {
    const key=JSON.stringify([normalizeRecordingText(song.artist),normalizeRecordingText(song.title)]);
    if(key===original || seen.has(key)) return false;
    seen.add(key);return true;
  });
}
