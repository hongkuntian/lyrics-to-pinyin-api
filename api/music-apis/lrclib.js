import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {findRecording,findLyricsRecording,searchTitle} from '../utils/recording-match.js';
import chinese from 'chinese-conv';
export class LRCAPI extends BaseMusicAPI {
  constructor() { super('LRCAPI',['zh','en','ja','ko']); this.baseURL='https://lrclib.net/api'; }
  async searchSong(artist,title,context={}) {
    const request={artist,title,...context}, records=new Map();
    let failure;
    const search=async params=>{
      const data=await fetchJSON(`${this.baseURL}/search?${new URLSearchParams(params)}`,context);
      for(const song of data) records.set(song.id,{id:song.id,title:song.trackName || song.name,artist:song.artistName,album:song.albumName,duration:song.duration,source:'lrclib',lyricsData:this.lyricsFromRecord(song)});
    };
    try { await search({artist_name:artist,track_name:title}); } catch(error) { failure=error; }
    try { const match=findLyricsRecording([...records.values()],request);if(match) return match; }
    catch(error) { if(error.code!=='recording_mismatch') throw error; }
    // Discovery may be broad; acceptance still requires the full title, complete
    // artist credit and recording duration. LRCLIB search is script-sensitive.
    const base=searchTitle(title), variants=[...new Set([chinese.sify(base),chinese.tify(base)])];
    const results=await Promise.allSettled(variants.map(track_name=>search({track_name})));
    for(const result of results) if(result.status==='rejected') failure=result.reason;
    const match=findLyricsRecording([...records.values()],request);
    if(match) return match;
    if(failure) throw failure;
    return null;
  }
  lyricsFromRecord(record) {
    const raw=record.syncedLyrics || record.plainLyrics;
    return raw ? {lines:parseLRC(raw),source:'lrclib',songId:record.id}:null;
  }
  async getLyrics(id,context={}) {
    // Search results belong to the request, never mutable singleton state.
    if(context.song?.lyricsData) return context.song.lyricsData;
    return this.lyricsFromRecord(await fetchJSON(`${this.baseURL}/get/${id}`,context));
  }
  findBestMatch(songs,artist,title) {
    const normalized=songs.map(s=>({...s,title:s.trackName || s.name,artist:s.artistName,album:s.albumName}));
    return findRecording(normalized,{artist,title});
  }
  parseSyncedLyrics(raw) { return parseLRC(raw); }
  parsePlainLyrics(raw) { return parseLRC(raw); }
  parseLyrics(lines) { return lines.filter(x=>x.words?.trim()).map(x=>({text:x.words.trim(),timestamp:x.startTime/1000})); }
}
