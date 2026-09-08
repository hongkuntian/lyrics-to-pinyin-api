import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {findRecording,searchTitle,recordingNames,recordingScore,normalizeRecordingText} from '../utils/recording-match.js';
import {BoundedCache} from '../utils/bounded-cache.js';
import chinese from 'chinese-conv';
export class NeteaseAPI extends BaseMusicAPI {
  constructor() { super('NeteaseAPI',['zh','yue','en']); this.baseURL='https://netease-cloud-music-api-gules-mu.vercel.app'; this.artistAliases=new BoundedCache({limit:128,ttlMs:86400000}); }
  async searchSong(artist,title,context={}) {
    const request={artist,title,...context},records=new Map(),profiles=new Map(),hydrated=new Set();
    let lastMismatch;
    const select=async()=> {
      const songs=[...records.values()].map(entry=>entry.song);
      try { return findRecording(songs,request); }
      catch(error) { if(error.code!=='recording_mismatch') throw error;lastMismatch=error; }
      const expected=recordingNames(request);
      // Resolve authoritative artist aliases only for plausible recordings.
      // The profile promises are shared between the shallow and deeper pages.
      const plausible=songs.filter(song=>recordingNames(song).title===expected.title && Number.isFinite(song.duration) && Number.isFinite(request.duration) && recordingScore({...song,title,artist},request)>=0).slice(0,3);
      for(const song of plausible) {
        const performers=records.get(song.id).raw.artists || [];
        if(!performers.length || performers.length>3 || performers.length!==expected.credits.length) continue;
        const aliases=await Promise.all(performers.map(async performer=>{
          const direct=[performer.name].filter(name=>expected.credits.includes(normalizeRecordingText(name)));
          if(direct.length) return direct[0];
          if(!/^\d{1,20}$/.test(String(performer.id))) return null;
          const id=String(performer.id);
          if(!profiles.has(id)) profiles.set(id,this.namesForArtist(id,context));
          const names=await profiles.get(id);
          const matching=names.filter(name=>expected.credits.includes(normalizeRecordingText(name)));
          return new Set(matching.map(normalizeRecordingText)).size===1 ? matching[0]:null;
        }));
        if(aliases.every(Boolean) && new Set(aliases.map(normalizeRecordingText)).size===expected.credits.length) song.artist=aliases.join(' & ');
      }
      try { return findRecording(songs,request); }
      catch(error) { if(error.code!=='recording_mismatch') throw error;lastMismatch=error; }
      const ranked=songs.map(song=>({song,score:recordingScore(song,request)})).filter(item=>item.score>=0).sort((a,b)=>b.score-a.score);
      const tied=ranked.filter(item=>Math.abs(item.score-ranked[0]?.score)<1e-9).map(item=>item.song);
      // Metadata ties are the only reason to fetch lyrics during discovery.
      // Never arbitrarily truncate a larger tie and call the subset verified.
      if(tied.length>1 && tied.length<=3 && hydrated.size+tied.filter(song=>!hydrated.has(song.id)).length<=3) {
        await Promise.all(tied.map(async song=>{
          if(hydrated.has(song.id)) return;
          hydrated.add(song.id);
          song.lyricsData=await this.getLyrics(song.id,context);
        }));
        try { return findRecording(songs,request); }
        catch(error) { if(error.code!=='recording_mismatch') throw error;lastMismatch=error; }
      }
      return null;
    };
    for(const limit of [30,100]) {
      const data=await fetchJSON(`${this.baseURL}/search?limit=${limit}&keywords=${encodeURIComponent(chinese.sify(`${artist} ${searchTitle(title)}`))}`,context);
      if(data.code!==200) throw new Error('NetEase search unavailable');
      for(const raw of data.result?.songs || []) if(!records.has(raw.id)) records.set(raw.id,{raw,song:{id:raw.id,title:raw.name,artist:raw.artists?.map(x=>x.name).join(' & ') || '',album:raw.album?.name,duration:raw.duration ? raw.duration/1000:null,source:'netease'}});
      const song=await select();if(song) return song;
      if(context.signal?.aborted) throw Object.assign(new Error('Lookup cancelled'),{name:'AbortError'});
    }
    if(lastMismatch) throw lastMismatch;
    return null;
  }
  async namesForArtist(id,context) {
    const cached=this.artistAliases.get(id);if(cached) return cached;
    try {
      const data=await fetchJSON(`${this.baseURL}/artist/detail?id=${id}`,context),artist=data.data?.artist;
      if(data.code!==200 || String(artist?.id)!==id) return [];
      const names=[artist.name,...(artist.alias || []),...(artist.transNames || [])].filter(name=>typeof name==='string' && name.trim());
      this.artistAliases.set(id,names);return names;
    } catch { return []; }
  }
  async getLyrics(id,context={}) {
    if(context.song?.lyricsData) return context.song.lyricsData;
    const data=await fetchJSON(`${this.baseURL}/lyric?id=${id}`,context);
    if(data.code!==200) throw new Error('NetEase lyrics unavailable');
    return data.lrc?.lyric ? {lines:this.parseLyrics(data.lrc.lyric),source:'netease',songId:id}:null;
  }
  parseLyrics(raw) { return parseLRC(raw); }
}
