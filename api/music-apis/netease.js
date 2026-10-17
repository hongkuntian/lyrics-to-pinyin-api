import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {parseYRC} from '../utils/netease-yrc.js';
import {findRecording,searchTitle,recordingNames,recordingScore,normalizeRecordingText} from '../utils/recording-match.js';
import {BoundedCache} from '../utils/bounded-cache.js';
import chinese from 'chinese-conv';
export class NeteaseAPI extends BaseMusicAPI {
  constructor() { super('NeteaseAPI',['zh','yue','en']); this.supportsVocalTiming=true; this.baseURL='https://netease-cloud-music-api-gules-mu.vercel.app'; this.artistAliases=new BoundedCache({limit:128,ttlMs:86400000}); }
  async searchSong(artist,title,context={}) {
    const request={artist,title,...context},records=new Map(),profiles=new Map(),hydrated=new Set();
    let lastMismatch;
    const select=async()=> {
      const songs=[...records.values()].map(entry=>entry.song);
      try { return findRecording(songs,request); }
      catch(error) { if(error.code!=='recording_mismatch') throw error;lastMismatch=error; }
      const expected=recordingNames(request);
      const spotify=context.recordingProvider==='spotify';
      // Resolve authoritative artist aliases only for plausible recordings.
      // The profile promises are shared between the shallow and deeper pages.
      const plausible=songs.filter(song=>recordingNames(song).title===expected.title && Number.isFinite(song.duration) && Number.isFinite(request.duration)
        && recordingScore({...song,title,artist,...(spotify?{creditedArtistNames:request.creditedArtistNames}:{})},request)>=0).slice(0,3);
      for(const song of plausible)
        await this.resolveArtistAliases(song,records.get(song.id).raw.artists||[],request,context,profiles);
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
          song.lyricsData=await this.getLyrics(song.id,{...context,song});
        }));
        try { return findRecording(songs,request); }
        catch(error) { if(error.code!=='recording_mismatch') throw error;lastMismatch=error; }
      }
      return null;
    };
    for(const limit of [30,100]) {
      const data=await fetchJSON(`${this.baseURL}/search?limit=${limit}&keywords=${encodeURIComponent(chinese.sify(`${artist} ${searchTitle(title)}`))}`,context);
      if(data.code!==200) throw new Error('NetEase search unavailable');
      for(const raw of data.result?.songs || []) if(!records.has(raw.id)) records.set(raw.id,{raw,song:{id:raw.id,title:raw.name,artist:raw.artists?.map(x=>x.name).join(' & ') || '',album:raw.album?.name,duration:raw.duration ? raw.duration/1000:null,source:'netease',...(context.recordingProvider==='spotify'?{creditedArtistNames:raw.artists?.map(x=>x.name),...(raw.isrc?{isrc:raw.isrc}:{}),...(typeof raw.explicit==='boolean'?{explicit:raw.explicit}:{})}:{})}});
      const song=await select();if(song) return song;
      if(context.signal?.aborted) throw Object.assign(new Error('Lookup cancelled'),{name:'AbortError'});
    }
    if(lastMismatch) throw lastMismatch;
    return null;
  }
  async resolveArtistAliases(song,performers,request,context,profiles=new Map()) {
    const spotify=context.recordingProvider==='spotify',expected=recordingNames(request);
    const expectedCredits=spotify?(request.creditedArtistNames??[]).map(normalizeRecordingText).sort():expected.credits;
    if(!performers.length || performers.length>3 || performers.length!==expectedCredits.length)return;
    const aliases=await Promise.all(performers.map(async performer=>{
      const direct=[performer.name].filter(name=>expectedCredits.includes(normalizeRecordingText(name)));
      if(direct.length)return direct[0];
      if(!/^\d{1,20}$/.test(String(performer.id)))return null;
      const id=String(performer.id);
      if(!profiles.has(id))profiles.set(id,this.namesForArtist(id,context));
      const names=await profiles.get(id),matching=names.filter(name=>expectedCredits.includes(normalizeRecordingText(name)));
      return new Set(matching.map(normalizeRecordingText)).size===1?matching[0]:null;
    }));
    if(aliases.every(Boolean)&&JSON.stringify(aliases.map(normalizeRecordingText).sort())===JSON.stringify(expectedCredits)) {
      if(spotify) {
        song.creditedArtistNames=aliases;
        if(recordingScore(song,request)>=0&&performers.every(p=>/^\d{1,20}$/.test(String(p.id))&&typeof p.name==='string'&&p.name.trim()))
          context.onVerifiedArtistCredits?.({names:performers.map(p=>p.name),aliases:[...aliases]});
      } else song.artist=aliases.join(' & ');
    }
  }
  async getRecording(id,context={}) {
    if(!/^[1-9]\d{0,19}$/.test(String(id)))return null;
    context.signal?.throwIfAborted();
    const data=await fetchJSON(`${this.baseURL}/song/detail?ids=${id}`,context);
    // A cached ID routes a fresh lookup only. Do not substitute a relink or
    // reuse old labels/words when the provider no longer returns that record.
    if(data?.code!==200||!Array.isArray(data.songs)||data.songs.length!==1||String(data.songs[0]?.id)!==String(id))
      throw Object.assign(new Error('NetEase source ID changed'),{code:'recording_mismatch'});
    const raw=data.songs[0],performers=raw.ar;
    if(!Array.isArray(performers)||!performers.length||performers.some(p=>!p||!/^\d{1,20}$/.test(String(p.id))||typeof p.name!=='string'||!p.name.trim())
      ||typeof raw.name!=='string'||!raw.name.trim()||!Number.isFinite(raw.dt)||raw.dt<=0)
      throw Object.assign(new Error('Invalid NetEase source metadata'),{code:'recording_mismatch'});
    const song={id:raw.id,title:raw.name,artist:performers.map(p=>p.name).join(' & '),album:raw.al?.name,duration:raw.dt/1000,source:'netease',
      ...(context.recordingProvider==='spotify'?{creditedArtistNames:performers.map(p=>p.name),...(raw.isrc?{isrc:raw.isrc}:{}),...(typeof raw.explicit==='boolean'?{explicit:raw.explicit}:{})}:{})};
    if(recordingScore(song,context)<0)await this.resolveArtistAliases(song,performers,context,context);
    findRecording([song],context);
    context.signal?.throwIfAborted();
    const lyrics=await this.getLyrics(id,{...context,song});
    return {song,lyrics};
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
    const decode=data=>{
      if(data?.code!==200)return {valid:false,lyrics:null};
      const yrc=parseYRC(data.yrc?.lyric,{songId:id,...(Number.isFinite(context.song?.duration)?{duration:context.song.duration}:{})});
      if(yrc)return {valid:true,lyrics:yrc};
      const lrc=typeof data.lrc?.lyric==='string'?data.lrc.lyric:null;
      const lines=lrc?this.parseLyrics(lrc):[];
      if(lines.some(l=>l.text?.trim()))return {valid:true,lyrics:{lines,source:'netease',songId:id}};
      // Explicit absence and genuinely empty variants are terminal. A failed
      // nonempty YRC/LRC decode with no readable sibling is an invalid payload,
      // even when its JSON field types look right, and needs the legacy route.
      const variants=[lrc,data.yrc?.lyric].filter(value=>typeof value==='string');
      return {valid:data.nolyric===true||data.uncollected===true||(variants.length>0&&variants.every(value=>!value.trim())),lyrics:null};
    };
    let data,result;
    try {
      context.signal?.throwIfAborted();
      data=await fetchJSON(`${this.baseURL}/lyric/new?id=${encodeURIComponent(id)}`,context);
      result=decode(data);
      if(!result.valid)throw new Error('Invalid NetEase lyric payload');
    }catch(error){
      // At most one legacy fallback, sharing the original caller's signal and
      // provider deadline. Cancellation never starts another network operation.
      if(context.signal?.aborted||error.name==='AbortError'||error.code==='provider_timeout')throw error;
      data=await fetchJSON(`${this.baseURL}/lyric?id=${encodeURIComponent(id)}`,context);
      result=decode(data);
    }
    if(data?.code!==200) throw new Error('NetEase lyrics unavailable');
    return result.lyrics;
  }
  parseLyrics(raw) { return parseLRC(raw); }
}
