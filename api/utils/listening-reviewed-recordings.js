import {fetchJSON} from './fetch-json.js';
import {normalizeRecordingText,normalizedAlbum} from './recording-match.js';
import {parseLRC} from './lrc.js';
import {cleanLyrics} from './lyric-quality.js';
import {timingFingerprint} from './timing-corrections.js';

// Listening review on 2026-09-29: the owner of this exact 3:41 remaster heard
// the first vocal at ~28s, chorus at ~82s and final line at ~191s. This specific
// upstream file is consistently late; -8.5s aligns all three within 0.45s.
// The correction is not inferred from duration and never applies to other IDs,
// releases, or a changed upstream transcription. No lyric text is bundled.
export const listeningReviews=[{
  id:'fei-yu-ching-1887583861-listening-v1',reviewedDate:'2026-09-29',
  catalogID:'1887583861',title:'一剪梅 (重制版)',artists:['Fei Yu-Ching','费玉清','費玉清'],
  catalogArtist:'费玉清',album:'长江水',duration:221.412,
  source:{id:36228377,title:'一剪梅',artist:'費玉清',album:'長江水',duration:221},
  fingerprint:'2b1f3b3c4d732080160597ee93c0d89475e0b70f6ce98a6a680abceea55390f1',
  offsetSeconds:-8.5,
  checkpoints:[{source:36.68,heard:28},{source:90.94,heard:82},{source:199.45,heard:191}]
}];
const same=(a,b)=>typeof a==='string' && normalizeRecordingText(a)===normalizeRecordingText(b);
const close=(a,b)=>Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=0.5;

export async function lookupListeningReviewedRecording(request,context={}, {reviews=listeningReviews}={}) {
  const review=reviews.find(r=>request.catalog_id===r.catalogID && close(request.duration,r.duration)
    && same(request.title,r.title) && r.artists.some(a=>same(request.artist,a))
    && typeof request.album==='string' && normalizedAlbum(request.album)===normalizedAlbum(r.album));
  if(!review) return null;
  try {
    const params=new URLSearchParams({id:review.catalogID,country:'cn',lang:'zh_cn'});
    const page=await fetchJSON(`https://itunes.apple.com/lookup?${params}`,context);
    const anchor=page.results?.find(song=>song.kind==='song' && String(song.trackId)===review.catalogID
      && same(song.trackName,review.title) && same(song.artistName,review.catalogArtist)
      && typeof song.collectionName==='string' && normalizedAlbum(song.collectionName)===normalizedAlbum(review.album)
      && close(song.trackTimeMillis/1000,review.duration) && close(song.trackTimeMillis/1000,request.duration));
    if(!anchor) return null;
    const raw=await fetchJSON(`https://lrclib.net/api/get/${review.source.id}`,context),expected=review.source;
    if(raw.id!==expected.id || !same(raw.trackName,expected.title) || !same(raw.artistName,expected.artist)
      || typeof raw.albumName!=='string' || normalizedAlbum(raw.albumName)!==normalizedAlbum(expected.album)
      || !close(raw.duration,expected.duration) || !close(raw.duration,request.duration)
      || typeof raw.syncedLyrics!=='string') return null;
    for(const tag of raw.syncedLyrics.matchAll(/^\s*\[(ar|ti):([^\]\r\n]+)\]\s*$/gim)) {
      if(!same(tag[2].trim(),tag[1].toLowerCase()==='ar'?expected.artist:expected.title)) return null;
    }
    const source=cleanLyrics({lines:parseLRC(raw.syncedLyrics),source:'lrclib',songId:raw.id},
      {duration:raw.duration,title:raw.trackName,artist:raw.artistName});
    if(timingFingerprint(source)!==review.fingerprint || !source.lines.length || source.lines.some(line=>!Number.isFinite(line.timestamp))
      || !Number.isFinite(review.offsetSeconds) || review.checkpoints.length<3
      || review.checkpoints.some(p=>!source.lines.some(line=>Math.abs(line.timestamp-p.source)<0.01)
        || Math.abs(p.source+review.offsetSeconds-p.heard)>0.5)) return null;
    const lines=source.lines.map(line=>({...line,timestamp:Math.round((line.timestamp+review.offsetSeconds)*1000)/1000}));
    if(lines.some((line,i)=>!Number.isFinite(line.timestamp) || line.timestamp<0 || line.timestamp>request.duration
      || (i>0 && line.timestamp<lines[i-1].timestamp))) return null;
    // Rebuild source structure from the corrected performed rows, so every
    // timeline representation carries the same reviewed timing.
    const lyrics=cleanLyrics({lines,source:'lrclib',songId:raw.id,credits:source.credits},
      {duration:request.duration,title:raw.trackName,artist:raw.artistName});
    return {song:{id:raw.id,title:raw.trackName,artist:raw.artistName,album:raw.albumName,duration:raw.duration,source:'lrclib'},
      lyrics,api:{name:'LRCAPI'},target:request,
      reviewedIdentity:{id:review.id,reviewedDate:review.reviewedDate,catalogID:review.catalogID,source:'lrclib',sourceID:String(raw.id)},
      timingCorrection:{id:review.id,status:'replacement',basis:'recording_listening_review',
        offset_seconds:review.offsetSeconds,source_fingerprint:review.fingerprint}};
  } catch(error) {
    if(error.name==='AbortError' || context.signal?.aborted) throw error;
    return null;
  }
}
