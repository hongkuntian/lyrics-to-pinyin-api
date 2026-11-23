import {createRequire} from 'node:module';
import {randomInt} from 'node:crypto';
import {LibraryError} from './store.js';

// First-run starter songs. The pool is fixed, approved data; the server picks
// the order and counts what was shown and picked.
// Contract: SONG_LIBRARY.md, "Starter songs".
const require=createRequire(import.meta.url);
const pool=require('../../data/starter-songs.json');
const publicSong=song=>({id:song.id,title:song.title,artist:song.artist,year:song.year,
  recordings:song.recordings.map(r=>({catalog_id:r.catalog_id,storefront:r.storefront,artist:r.artist,title:r.title,album:r.album,duration:r.duration}))});
const songs=Object.values(pool.languages).flat();
const songIDs=new Set(songs.map(song=>song.id));
export const STARTER_LANGUAGES=Object.freeze(Object.keys(pool.languages));
export const STARTER_SONG_IDS=Object.freeze([...songIDs]);
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
      picked=starter_song_totals.picked+EXCLUDED.picked`,[event.ids,event.shown,event.picked]);
}
