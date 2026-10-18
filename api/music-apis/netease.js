import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {parseYRC} from '../utils/netease-yrc.js';
import {findRecording,searchTitle,recordingNames,recordingScore,normalizeRecordingText,RecordingMismatchError} from '../utils/recording-match.js';
import {BoundedCache} from '../utils/bounded-cache.js';
import {neteaseTitleEvidence,neteaseDescriptiveTitleMatches} from '../utils/netease-title-evidence.js';
import chinese from 'chinese-conv';
const withTitleEvidence=(song,raw,field,request)=>{
  if(request.recordingProvider!=='spotify')return song;
  const evidence=neteaseTitleEvidence(raw,field),candidate={...song,neteaseTitleEvidence:evidence};
  return evidence&&neteaseDescriptiveTitleMatches(candidate,request,normalizeRecordingText)?candidate:song;
};
// NetEase may prepend the same structured credits to LRC as to YRC. They
// describe the sheet, not sung rows. Unknown shapes and later JSON stay intact.
function withoutLeadingLRCMetadata(raw='') {
  const rows=raw.replace(/^\uFEFF/,'').split(/\r?\n/),kept=[];let leading=true,count=0;
  for(const row of rows){
    if(leading&&!row.trim()){kept.push(row);continue;}
    if(leading&&/^\[(?:ar|al|ti|by|offset|length|re|ve):[^\r\n]*\]$/i.test(row)){kept.push(row);continue;}
    if(leading&&count<32&&row.length<=16384&&/^\s*\{/.test(row)){
      try {
        const v=JSON.parse(row),bounded=s=>typeof s==='string'&&s.length<=4096&&!/\p{Surrogate}/u.test(s);
        if(v&&Object.keys(v).every(k=>['t','c'].includes(k))&&Number.isSafeInteger(v.t)&&Math.abs(v.t)<=7200000
          &&Array.isArray(v.c)&&v.c.length>0&&v.c.length<=128&&v.c.every(c=>c&&typeof c==='object'&&!Array.isArray(c)
            &&Object.keys(c).every(k=>['tx','li','or'].includes(k))&&bounded(c.tx)&&c.tx.length<=2000
            &&['li','or'].every(k=>!(k in c)||bounded(c[k])))) {count++;continue;}
      }catch { /* Preserve unrecognized content for the normal parser. */ }
    }
    leading=false;kept.push(row);
  }
  return kept.join('\n');
}
export class NeteaseAPI extends BaseMusicAPI {
  constructor() { super('NeteaseAPI',['zh','yue','en','ja','ko','ru']); this.supportsVocalTiming=true; this.languageAgnosticDiscovery=true; this.baseURL='https://netease-cloud-music-api-gules-mu.vercel.app'; this.artistAliases=new BoundedCache({limit:128,ttlMs:86400000}); }
  supportsLanguage(language) { return typeof language==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(language); }
  async searchSong(artist,title,context={}) {
    const request={artist,title,...context},records=new Map(),profiles=new Map(),hydrated=new Set();
    let lastMismatch;
    const select=async()=> {
      const songs=[...records.values()].map(entry=>entry.song);
      const spotify=context.recordingProvider==='spotify';
      const described=spotify?songs.filter(song=>neteaseDescriptiveTitleMatches(song,request,normalizeRecordingText)
        &&Number.isFinite(song.duration)&&Number.isFinite(request.duration)
        &&recordingScore({...song,title,artist,creditedArtistNames:request.creditedArtistNames},request)>=0):[];
      // Do not turn an arbitrary verified prefix into a unique winner. Resolve
      // every eligible descriptor candidate before the first ranking decision.
      if(described.length>3){lastMismatch=new RecordingMismatchError('duplicate_candidates');return null;}
      for(const song of described)await this.resolveArtistAliases(song,records.get(song.id).raw.artists||[],request,context,profiles);
      try { return findRecording(songs,request); }
      catch(error) { if(error.code!=='recording_mismatch') throw error;lastMismatch=error; }
      const expected=recordingNames(request);
      // Resolve authoritative artist aliases only for plausible recordings.
      // The profile promises are shared between the shallow and deeper pages.
      const plausible=songs.filter(song=>(recordingNames(song).title===expected.title||(spotify&&neteaseDescriptiveTitleMatches(song,request,normalizeRecordingText))) && Number.isFinite(song.duration) && Number.isFinite(request.duration)
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
      for(const raw of data.result?.songs || []) if(!records.has(raw.id)) {
        const song={id:raw.id,title:raw.name,artist:raw.artists?.map(x=>x.name).join(' & ') || '',album:raw.album?.name,duration:raw.duration ? raw.duration/1000:null,source:'netease',...(context.recordingProvider==='spotify'?{creditedArtistNames:raw.artists?.map(x=>x.name),...(raw.isrc?{isrc:raw.isrc}:{}),...(typeof raw.explicit==='boolean'?{explicit:raw.explicit}:{})}:{})};
        records.set(raw.id,{raw,song:withTitleEvidence(song,raw,'alias',request)});
      }
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
    const song=withTitleEvidence({id:raw.id,title:raw.name,artist:performers.map(p=>p.name).join(' & '),album:raw.al?.name,duration:raw.dt/1000,source:'netease',
      ...(context.recordingProvider==='spotify'?{creditedArtistNames:performers.map(p=>p.name),...(raw.isrc?{isrc:raw.isrc}:{}),...(typeof raw.explicit==='boolean'?{explicit:raw.explicit}:{})}:{})},raw,'alia',context);
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
  parseLyrics(raw) { return parseLRC(withoutLeadingLRCMetadata(raw)); }
}
