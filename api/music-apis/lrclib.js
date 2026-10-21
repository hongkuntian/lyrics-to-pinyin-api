import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {findRecording,findLyricsRecording,searchTitle,sameRecordingNames,recordingNames,RecordingMismatchError} from '../utils/recording-match.js';
import chinese from 'chinese-conv';
import {cleanLyrics,hasUsableLyrics} from '../utils/lyric-quality.js';
import {isRejectedLyrics,isRejectedRecordingLyrics} from '../utils/rejected-lyrics.js';
import {simplifyRecordingScript} from '../utils/recording-script.js';
export class LRCAPI extends BaseMusicAPI {
  constructor({rejectLyrics=isRejectedLyrics,rejectRecordingLyrics=isRejectedRecordingLyrics}={}) { super('LRCAPI',['zh','yue','en','ja','ko','ru']); this.baseURL='https://lrclib.net/api'; this.rejectLyrics=rejectLyrics; this.rejectRecordingLyrics=rejectRecordingLyrics; this.languageAgnosticDiscovery=true; }
  // Search accepts Unicode metadata independently of reading-aid coverage.
  // This is discovery capability, not a promise that a transcript exists.
  supportsLanguage(language) { return typeof language==='string' && /^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(language); }
  async searchSong(artist,title,context={}) {
    const request={artist,title,...context}, records=new Map();
    let failure;
    const add=song=> {const candidate=this.recordingFromRecord(song,request);if(candidate)records.set(song.id,candidate);};
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
    const base=searchTitle(title),simple=simplifyRecordingScript(base), variants=/\p{Script=Han}/u.test(base) ? [...new Set([simple,chinese.tify(simple)])]:[base];
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
  recordingFromRecord(record,request={}) {
    if(!record||record.id==null)return null;
    const lyricsData=this.lyricsFromRecord(record,request);
    const candidate={id:record.id,title:record.trackName||record.name,artist:record.artistName,album:record.albumName,duration:record.duration,source:'lrclib',instrumental:lyricsData?.instrumental===true,lyricsData,...(request.recordingProvider==='spotify'?{
      ...(record.creditedArtistNames!==undefined?{creditedArtistNames:record.creditedArtistNames}:{}),...(record.isrc?{isrc:record.isrc}:{}),...(typeof record.explicit==='boolean'?{explicit:record.explicit}:{})}:{})};
    // The same guarded duet-credit spelling applies to search and fresh IDs.
    if(request.recordingProvider!=='spotify'&&typeof candidate.artist==='string'&&!sameRecordingNames(candidate,request)&&recordingNames(request).credits.length>1){
      const artist=candidate.artist.normalize('NFKC').replace(/\s+\+\s+/gu,' & ');
      if(artist!==candidate.artist&&sameRecordingNames({...candidate,artist},request))candidate.artist=artist;
    }
    return candidate;
  }
  async getRecording(id,context={}) {
    if(!/^\d{1,20}$/.test(String(id)))return null;
    // An ID is a routing hint only. Fetch metadata and words together afresh;
    // never consult context.song.lyricsData or retain provider downloads.
    const record=await fetchJSON(`${this.baseURL}/get/${id}`,context);
    if(String(record?.id)!==String(id))throw new RecordingMismatchError('source_id_changed');
    const song=this.recordingFromRecord(record,context);
    return song?{song,lyrics:song.lyricsData}:null;
  }
  lyricsFromRecord(record,request={}) {
    const make=raw=>cleanLyrics({lines:raw ? parseLRC(raw):[],source:'lrclib',songId:record.id,instrumental:record.instrumental===true},{duration:record.duration});
    let rejected=false;
    // A credit-only synced field must not hide a usable plain transcription.
    for(const raw of [record.syncedLyrics,record.plainLyrics]) {
      if(!raw) continue;
      if(this.rejectLyrics('lrclib',record.id,parseLRC(raw))) {rejected=true;continue;}
      const lyrics=make(raw);
      if(this.rejectRecordingLyrics(lyrics?.lines??[],request)) {rejected=true;continue;}
      if(lyrics?.lines?.length) return lyrics;
    }
    return !rejected && record.instrumental===true ? make(''):null;
  }
  async getLyrics(id,context={}) {
    // Search results belong to the request, never mutable singleton state.
    if(context.song?.lyricsData) return this.rejectRecordingLyrics(context.song.lyricsData.lines??[],context)?null:context.song.lyricsData;
    return this.lyricsFromRecord(await fetchJSON(`${this.baseURL}/get/${id}`,context),context);
  }
  findBestMatch(songs,artist,title) {
    const normalized=songs.map(s=>({...s,title:s.trackName || s.name,artist:s.artistName,album:s.albumName}));
    return findRecording(normalized,{artist,title});
  }
  parseSyncedLyrics(raw) { return parseLRC(raw); }
  parsePlainLyrics(raw) { return parseLRC(raw); }
  parseLyrics(lines) { return lines.filter(x=>x.words?.trim()).map(x=>({text:x.words.trim(),timestamp:x.startTime/1000})); }
}
