import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {fetchJSON} from './fetch-json.js';
import {normalizeRecordingText,normalizedAlbum,recordingNames} from './recording-match.js';
import {parseLRC} from './lrc.js';
import {cleanLyrics} from './lyric-quality.js';

// A literal JSON require is traced by the Vercel Node bundler on Node 18+.
// The registry contains reviewed public metadata, never lyric text or timing.
const require=createRequire(import.meta.url);
const {recordings}=require('../data/reviewed-recordings.json');
const provider='https://netease-cloud-music-api-gules-mu.vercel.app';
const numericID=value=>typeof value==='string' && /^\d{1,20}$/.test(value);
const present=value=>typeof value==='string' && value.trim().length>0;
const credits=artist=>recordingNames({artist,title:''}).credits;
const closeDuration=(a,b)=>Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=0.5;
function sameSignature(actual,expected) {
  return numericID(actual.catalog_id) && actual.catalog_id===expected.catalog_id
    && ['title','artist','album'].every(key=>present(actual[key]))
    // Preserve every title word, including the complete version/description.
    && normalizeRecordingText(actual.title)===normalizeRecordingText(expected.title)
    && JSON.stringify(credits(actual.artist))===JSON.stringify(credits(expected.artist))
    && normalizedAlbum(actual.album)===normalizedAlbum(expected.album)
    && closeDuration(actual.duration,expected.duration);
}
function catalogSignature(song) {
  return {catalog_id:String(song.trackId),title:song.trackName,artist:song.artistName,
    album:song.collectionName,duration:Number.isFinite(song.trackTimeMillis)?song.trackTimeMillis/1000:null};
}
function verifiedSource(raw,expected) {
  if(!raw || String(raw.id)!==expected.id || !present(raw.name) || !present(raw.al?.name)
    || String(raw.al.id)!==expected.album_id || !Number.isFinite(raw.dt) || !closeDuration(raw.dt/1000,expected.duration)
    || normalizeRecordingText(raw.name)!==normalizeRecordingText(expected.title)
    || normalizedAlbum(raw.al.name)!==normalizedAlbum(expected.album)
    || !Array.isArray(raw.ar) || raw.ar.length!==expected.artists.length) return false;
  // Compare names paired with their entity IDs, not independent overlapping sets.
  const pairs=artists=>artists.map(a=>[String(a.id),normalizeRecordingText(a.name)])
    .sort((a,b)=>a[0].localeCompare(b[0]));
  if(raw.ar.some(a=>!numericID(String(a?.id)) || !present(a?.name))) return false;
  return JSON.stringify(pairs(raw.ar))===JSON.stringify(pairs(expected.artists));
}
function checkAbort(signal) {
  if(signal?.aborted) {const error=new Error('Lookup cancelled');error.name='AbortError';throw error;}
}

// This bounded exception repairs documented credit/title metadata only. Both
// authoritative catalog and provider signatures must still match at lookup time.
export async function lookupReviewedRecording(request,context={}) {
  checkAbort(context.signal);
  const entry=recordings.find(item=>item.acceptedRequests.some(signature=>sameSignature(request,signature)));
  if(!entry) return null;
  const get=async url=>{checkAbort(context.signal);const data=await fetchJSON(url,context);checkAbort(context.signal);return data;};
  try {
    const anchors=await Promise.all(entry.catalogAnchors.map(async anchor=>{
      const params=new URLSearchParams({id:anchor.signature.catalog_id,country:anchor.storefront,
        lang:anchor.storefront==='tw'?'zh_tw':anchor.storefront==='cn'?'zh_cn':'en_us'});
      try {
        const page=await get(`https://itunes.apple.com/lookup?${params}`);
        return (page.results || []).some(song=>song.kind==='song' && sameSignature(catalogSignature(song),anchor.signature)
          && closeDuration(song.trackTimeMillis/1000,request.duration));
      } catch(error) {if(error.name==='AbortError' || context.signal?.aborted) throw error;return false;}
    }));
    if(!anchors.some(Boolean)) return null;
    const detail=await get(`${provider}/song/detail?ids=${entry.source.id}`);
    if(detail.code!==200 || !Array.isArray(detail.songs) || detail.songs.length!==1
      || !verifiedSource(detail.songs[0],entry.source) || !closeDuration(detail.songs[0].dt/1000,request.duration)) return null;
    const raw=detail.songs[0];
    const response=await get(`${provider}/lyric?id=${entry.source.id}`);
    if(response.code!==200 || !present(response.lrc?.lyric)) return null;
    // Explicit identity tags in the lyric body must not contradict the exact
    // provider record just verified above. Parse them before LRC strips tags.
    for(const tag of response.lrc.lyric.matchAll(/^\s*\[(ar|ti):([^\]\r\n]*)\]\s*$/gim)) {
      const value=tag[2].trim();
      if(!value) continue;
      if(tag[1].toLowerCase()==='ti' && normalizeRecordingText(value)!==normalizeRecordingText(raw.name)) return null;
      if(tag[1].toLowerCase()==='ar' && JSON.stringify(credits(value))!==JSON.stringify(credits(raw.ar.map(a=>a.name).join(' & ')))) return null;
    }
    const lyrics=cleanLyrics({lines:parseLRC(response.lrc.lyric),source:'netease',songId:raw.id},{duration:raw.dt/1000});
    // These reviewed recordings contain vocals. An empty/credit-only/instrumental
    // mutation must not turn a known vocal recording into an instrumental success.
    if(!lyrics?.lines.length || lyrics.instrumental) return null;
    const song={id:raw.id,title:raw.name,artist:raw.ar.map(a=>a.name).join(' & '),album:raw.al.name,
      duration:raw.dt/1000,source:'netease',lyricsData:lyrics};
    return {song,lyrics,api:{name:'NeteaseAPI'},target:request,reviewedIdentity:{id:entry.id,
      reviewedDate:entry.reviewedDate,catalogID:request.catalog_id,source:'netease',sourceID:entry.source.id,
      metadataSha256:createHash('sha256').update(JSON.stringify(entry.source)).digest('hex'),provenance:entry.provenance}};
  } catch(error) {
    if(error.name==='AbortError' || context.signal?.aborted) {checkAbort(context.signal);throw error;}
    return null;
  }
}
