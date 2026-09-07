import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {findRecording,searchTitle,recordingNames,recordingScore,normalizeRecordingText} from '../utils/recording-match.js';
import {BoundedCache} from '../utils/bounded-cache.js';
import chinese from 'chinese-conv';
export class NeteaseAPI extends BaseMusicAPI {
  constructor() { super('NeteaseAPI',['zh','yue','en']); this.baseURL='https://netease-cloud-music-api-gules-mu.vercel.app'; this.artistAliases=new BoundedCache({limit:128,ttlMs:86400000}); }
  async searchSong(artist,title,context={}) {
    const data=await fetchJSON(`${this.baseURL}/search?limit=30&keywords=${encodeURIComponent(chinese.sify(`${artist} ${searchTitle(title)}`))}`,context);
    if(data.code!==200) throw new Error('NetEase search unavailable');
    const raw=data.result?.songs || [];
    const songs=raw.map(song=>({id:song.id,title:song.name,artist:song.artists?.map(x=>x.name).join(' & ') || '',album:song.album?.name,duration:song.duration ? song.duration/1000:null,source:'netease'}));
    const request={artist,title,...context};
    try { return findRecording(songs,request); }
    catch(error) { if(error.code!=='recording_mismatch') throw error; }
    const expected=recordingNames(request),profiles=new Map();
    // Resolve aliases only for plausible recordings, at most three candidates
    // and three performers each. Never translate arbitrary names or omit a guest.
    const plausible=songs.filter(song=>recordingNames(song).title===expected.title && Number.isFinite(song.duration) && Number.isFinite(request.duration) && recordingScore({...song,title,artist},request)>=0).slice(0,3);
    for(const song of plausible) {
      const performers=raw.find(item=>item.id===song.id)?.artists || [];
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
    return findRecording(songs,request);
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
    const data=await fetchJSON(`${this.baseURL}/lyric?id=${id}`,context);
    if(data.code!==200) throw new Error('NetEase lyrics unavailable');
    return data.lrc?.lyric ? {lines:this.parseLyrics(data.lrc.lyric),source:'netease',songId:id}:null;
  }
  parseLyrics(raw) { return parseLRC(raw); }
}
