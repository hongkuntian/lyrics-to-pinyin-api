import {createRequire} from 'node:module';
import {normalizeRecordingText,normalizedAlbum,sameRecordingVersions} from './recording-match.js';

// Independent provider evidence only. Apple catalog admission and lyric bodies
// are never transferred to a Spotify request.
const require=createRequire(import.meta.url);
const {recordings}=require('../data/spotify-reviewed-sources.json');
export const SPOTIFY_REVIEWED_SOURCE_CAPABILITY='reviewed-spotify-source-1';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=0.5;
const requestSignature=r=>({itemID:r.recordingItemID,title:r.title,artists:r.creditedArtistNames,
 artistIDs:r.creditedArtistIDs??null,album:r.album??null,duration:r.duration,isrc:r.isrc??null,explicit:r.explicit??null});
const sourceSignature=s=>({provider:s.source,id:String(s.id),title:s.title,artist:s.artist,
 album:s.album,albumID:s.providerAlbumID,duration:s.duration,artists:s.creditedArtistNames,artistIDs:s.creditedArtistIDs,
 isrc:s.isrc??null,explicit:s.explicit??null});
function reviewFor(request) {
 if(request?.recordingProvider!=='spotify')return null;
 return recordings.find(entry=>{
  const expected=entry.request,m=expected.metadata;
  return request.recordingItemID===expected.item_id
   &&request.title===m.title&&request.album===m.album&&close(request.duration,m.duration_ms/1000)
   &&same(request.creditedArtistNames,m.artists)
   &&(request.creditedArtistIDs===undefined||same(request.creditedArtistIDs,m.artist_ids))
   &&(m.isrc===undefined||request.isrc===m.isrc)&&(m.explicit===undefined||request.explicit===m.explicit);
 })??null;
}
export const reviewedSpotifySourceID=request=>reviewFor(request)?.source.id??null;
function matchesSource(song,request,entry) {
 const expected=entry.source;
 return song.source===expected.provider&&String(song.id)===expected.id&&song.providerAlbumID===expected.albumID
  &&typeof song.title==='string'&&normalizeRecordingText(song.title)===normalizeRecordingText(expected.title)
  &&typeof song.album==='string'&&normalizedAlbum(song.album)===normalizedAlbum(expected.album)
  &&song.artist===expected.artists.map(a=>a.name).join(' & ')
  &&same(song.creditedArtistNames,expected.artists.map(a=>a.name))
  &&same(song.creditedArtistIDs,expected.artists.map(a=>a.id))
  &&close(song.duration,expected.duration)&&close(song.duration,request.duration)&&sameRecordingVersions(song,request)
  &&!(song.isrc&&request.isrc&&song.isrc!==request.isrc)
  &&!(typeof song.explicit==='boolean'&&typeof request.explicit==='boolean'&&song.explicit!==request.explicit);
}
export function bindReviewedSpotifySource(song,raw,request) {
 const entry=reviewFor(request);if(!entry)return song;
 const candidate={...song,providerAlbumID:String(raw.al?.id)};
 if(!matchesSource(candidate,request,entry))return song;
 candidate.artistAliasEvidence={version:1,policy:SPOTIFY_REVIEWED_SOURCE_CAPABILITY,reviewID:entry.id,
  request:requestSignature(request),source:sourceSignature(candidate)};
 return candidate;
}
export function recoveredReviewedSpotifyNames(song,request) {
 try {
  const evidence=song.artistAliasEvidence,entry=reviewFor(request);
  if(!entry||evidence?.version!==1||evidence.policy!==SPOTIFY_REVIEWED_SOURCE_CAPABILITY||evidence.reviewID!==entry.id
   ||!same(evidence.request,requestSignature(request))||!same(evidence.source,sourceSignature(song))
   ||!matchesSource(song,request,entry))return null;
  return [...request.creditedArtistNames];
 }catch{return null;}
}
