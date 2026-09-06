import {fetchJSON} from './fetch-json.js';
import {recordingScore,normalizeRecordingText} from './recording-match.js';

// Public catalog metadata supplies aliases; client-provided translations are never trusted.
// This fallback currently covers English and Traditional Chinese catalog localizations.
export async function resolveCatalogAliases(request, context={}) {
  if (!/^\d{1,20}$/.test(request.catalog_id || '') || !Number.isFinite(request.duration)) return [];
  const locales=[{country:request.storefront || 'us',lang:'en_us'},{country:'tw',lang:'zh_tw'}];
  const results=await Promise.all(locales.map(async locale=> {
    try {
      const params=new URLSearchParams({id:request.catalog_id,...locale});
      const data=await fetchJSON(`https://itunes.apple.com/lookup?${params}`,context);
      return (data.results || []).filter(song=>song.kind==='song' && String(song.trackId)===request.catalog_id).map(song=>({
        catalog_id:request.catalog_id,title:song.trackName,artist:song.artistName,
        album:song.collectionName,duration:song.trackTimeMillis/1000
      }));
    } catch { return []; }
  }));
  const songs=results.flat().filter(song=>typeof song.title==='string' && typeof song.artist==='string' && Number.isFinite(song.duration));
  // At least one authoritative localization must describe the caller's recording.
  if (!songs.some(song=>recordingScore(song,request)>=0)) return [];
  const seen=new Set();
  return songs.filter(song=> {
    if (Math.abs(song.duration-request.duration)>3) return false;
    const key=JSON.stringify([normalizeRecordingText(song.artist),normalizeRecordingText(song.title)]);
    const original=JSON.stringify([normalizeRecordingText(request.artist),normalizeRecordingText(request.title)]);
    if (key===original || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
