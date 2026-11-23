import {createRequire} from 'node:module';
import {randomInt} from 'node:crypto';
import {LibraryError} from './store.js';
import {catalogRecordingKey} from './document.js';

// First-run starter songs. The pool is fixed, approved data; the server picks
// the order, counts what was shown and picked, and keeps these songs free.
// Contract: SONG_LIBRARY.md, "Starter songs".
const require=createRequire(import.meta.url);
const pool=require('../../data/starter-songs.json');
const publicSong=song=>({id:song.id,title:song.title,artist:song.artist,year:song.year,
  recordings:song.recordings.map(r=>({catalog_id:r.catalog_id,storefront:r.storefront,artist:r.artist,title:r.title,album:r.album,duration:r.duration}))});
const songs=Object.values(pool.languages).flat();
const songIDs=new Set(songs.map(song=>song.id));
export const STARTER_LANGUAGES=Object.freeze(Object.keys(pool.languages));
export const STARTER_SONG_IDS=Object.freeze([...songIDs]);
export const STARTER_CATALOG_IDS=Object.freeze([...new Set(songs.flatMap(song=>song.recordings.map(r=>r.catalog_id)))]);
const invalid=()=>new LibraryError('invalid_request',400);

// Unbiased Fisher–Yates on a copy. randomIndex(n) returns a uniform integer in
// [0,n); tests inject it.
export function shuffled(values,randomIndex=randomInt) {
  const result=[...values];
  for(let i=result.length-1;i>0;i--) {
    const j=randomIndex(i+1);
    if(!Number.isInteger(j)||j<0||j>i)throw new Error('invalid_random_source');
    [result[i],result[j]]=[result[j],result[i]];
  }
  return result;
}
// Each requested language's whole pool, in request order, freshly shuffled.
export function starterSongs(languages,randomIndex=randomInt) {
  if(!Array.isArray(languages)||languages.length<1||languages.length>6||new Set(languages).size!==languages.length||
    languages.some(language=>typeof language!=='string'||!Object.hasOwn(pool.languages,language)))throw invalid();
  return languages.map(language=>({language,songs:shuffled(pool.languages[language],randomIndex).map(publicSong)}));
}
// Exactly one of shown (1 to 24 distinct pool song ids) or picked (one id).
export function starterEvent(input) {
  const shown=Object.hasOwn(input,'shown'),picked=Object.hasOwn(input,'picked');
  if(shown===picked)throw invalid();
  const ids=picked?[input.picked]:input.shown;
  if(!Array.isArray(ids)||ids.length<1||ids.length>24||new Set(ids).size!==ids.length||
    ids.some(id=>typeof id!=='string'||!songIDs.has(id)))throw invalid();
  return {ids:[...ids],shown:shown?1:0,picked:picked?1:0};
}
// One atomic statement adds to every listed song's total. Sorted rows keep
// concurrent reports from deadlocking. Nothing about the caller is stored.
export async function recordStarterEvent(db,event) {
  await db.query(`INSERT INTO starter_song_totals(song_id,shown,picked)
    SELECT id,$2::bigint,$3::bigint FROM unnest($1::text[]) AS id ORDER BY id
    ON CONFLICT(song_id) DO UPDATE SET shown=starter_song_totals.shown+EXCLUDED.shown,
      picked=starter_song_totals.picked+EXCLUDED.picked,updated_at=now()`,[event.ids,event.shown,event.picked]);
}

// Starter songs are free (docs/memberships.md). A starter document is the
// server's own stored Apple Music document for a pool catalog id in any
// storefront: the app asks with the listener's storefront, and it is the same
// recording. The stored recording key is a digest of the catalog id and a
// storefront that is absent or two lowercase letters (recordingRequest), so
// every key a pool id can have is known: ids × 677 storefronts, built once.
const STOREFRONTS=[null,...Array.from({length:676},(_,i)=>String.fromCharCode(97+Math.floor(i/26),97+i%26))];
let recordingKeys;
const starterRecordingKeys=()=>recordingKeys??=new Set(STARTER_CATALOG_IDS.flatMap(id=>STOREFRONTS.map(storefront=>catalogRecordingKey(id,storefront))));
// Spotify and selected-source documents are never starter documents.
export const isStarterDocumentRow=row=>Boolean(row)&&!row.source_capsule&&!row.selected_source&&starterRecordingKeys().has(row.recording_key);
export const isStarterDocument=doc=>Boolean(doc)&&!doc.sourceCapsule&&!doc.selectedSourceCapsule&&!doc.selectedSource&&starterRecordingKeys().has(doc.recordingKey);
