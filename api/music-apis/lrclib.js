import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {findRecording,findLyricsRecording,searchTitle} from '../utils/recording-match.js';
import chinese from 'chinese-conv';
import {cleanLyrics,hasUsableLyrics} from '../utils/lyric-quality.js';
export class LRCAPI extends BaseMusicAPI {
  constructor() { super('LRCAPI',['zh','en','ja','ko']); this.baseURL='https://lrclib.net/api'; }
  async searchSong(artist,title,context={}) {
    const request={artist,title,...context}, records=new Map();
    let failure;
    const add=song=> {
      if(!song || song.id==null) return;
      const lyricsData=this.lyricsFromRecord(song);
      records.set(song.id,{id:song.id,title:song.trackName || song.name,artist:song.artistName,album:song.albumName,duration:song.duration,source:'lrclib',instrumental:lyricsData?.instrumental===true,lyricsData});
    };
    const choose=()=>findLyricsRecording([...records.values()].filter(song=>hasUsableLyrics(song.lyricsData,{duration:song.duration})),request);
    const attempt=()=> {
      try { return choose(); }
      catch(error) { if(error.code!=='recording_mismatch') throw error;return null; }
    };
    // Exact lookup uses the full recording signature. A 404 is an ordinary
    // discovery miss; returned metadata still goes through recording validation.
    if(context.album?.trim() && Number.isFinite(context.duration) && context.duration>0) {
      const params={artist_name:artist,track_name:title,album_name:context.album,duration:String(context.duration)};
      try { add(await fetchJSON(`${this.baseURL}/get?${new URLSearchParams(params)}`,context)); }
      catch(error) { if(error.status===429) throw error;if(error.status!==404) failure=error; }
      const exact=attempt();
      if(exact && (exact.instrumental || exact.lyricsData?.lines?.some(line=>Number.isFinite(line.timestamp) && line.timestamp>=0))) return exact;
    }
    const search=async params=>{
      const data=await fetchJSON(`${this.baseURL}/search?${new URLSearchParams(params)}`,context);
      for(const song of data) add(song);
    };
    try { await search({artist_name:artist,track_name:title}); } catch(error) { if(error.status===429) throw error;failure=error; }
    const direct=attempt();if(direct) return direct;
    // Discovery may be broad; acceptance still requires verified recording
    // names and duration. LRCLIB search is script-sensitive.
    const base=searchTitle(title), variants=/\p{Script=Han}/u.test(base) ? [...new Set([chinese.sify(base),chinese.tify(base)])]:[base];
    const results=await Promise.allSettled(variants.map(track_name=>search({track_name})));
    for(const result of results) if(result.status==='rejected') failure=result.reason;
    const broad=attempt();if(broad) return broad;
    // A distinctive soundtrack movement suffix can rescue provider search
    // tokenization/typos. It is discovery only; the full names still validate.
    const parts=base.split(/\s+[-–—]\s+/),suffix=parts.length>1 ? parts.at(-1).trim():'';
    if((suffix.match(/\p{L}/gu) || []).length>=10 && !/\b(live|remaster(?:ed)?|instrumental|karaoke|remix|cover|demo)\b/i.test(suffix)) {
      try { await search({track_name:suffix}); } catch(error) { failure=error; }
    }
    const match=choose();
    if(match) return match;
    if(failure) throw failure;
    return null;
  }
  lyricsFromRecord(record) {
    const make=raw=>cleanLyrics({lines:raw ? parseLRC(raw):[],source:'lrclib',songId:record.id,instrumental:record.instrumental===true},{duration:record.duration});
    // A credit-only synced field must not hide a usable plain transcription.
    for(const raw of [record.syncedLyrics,record.plainLyrics]) {
      if(!raw) continue;
      const lyrics=make(raw);if(lyrics?.lines?.length) return lyrics;
    }
    return record.instrumental===true ? make(''):null;
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
