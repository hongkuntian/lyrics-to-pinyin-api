import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {findRecording} from '../utils/recording-match.js';
export class LRCAPI extends BaseMusicAPI {
  constructor() { super('LRCAPI',['zh','en','ja','ko']); this.baseURL='https://lrclib.net/api'; }
  async searchSong(artist,title,context={}) {
    const params=new URLSearchParams({artist_name:artist,track_name:title});
    const data=await fetchJSON(`${this.baseURL}/search?${params}`,context);
    const songs=data.map(song=>({id:song.id,title:song.trackName || song.name,artist:song.artistName,album:song.albumName,duration:song.duration,source:'lrclib',lyricsData:this.lyricsFromRecord(song)}));
    return findRecording(songs,{artist,title,...context});
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
