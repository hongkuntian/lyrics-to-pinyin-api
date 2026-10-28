import {BaseMusicAPI} from './base.js';
import {fetchJSON,withDeadline} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {parseYRC} from '../utils/netease-yrc.js';
import {findRecording,searchTitle,recordingNames,recordingScore,normalizeRecordingText,normalizedAlbum,sameRecordingVersions,RecordingMismatchError} from '../utils/recording-match.js';
import {cleanLyrics} from '../utils/lyric-quality.js';
import {hasCompleteMeasuredVocalTiming} from '../utils/lyric-selection.js';
import {BoundedCache} from '../utils/bounded-cache.js';
import {neteaseTitleEvidence,neteaseDescriptiveTitleMatches} from '../utils/netease-title-evidence.js';
import {simplifyRecordingScript} from '../utils/recording-script.js';
import {isNeteaseMetadataRow} from '../utils/netease-metadata.js';
import {buildArtistAliasEvidence,buildArtistIdentityEvidence,recoveredArtistNames,recoverySearchTitle} from '../utils/artist-alias-recovery.js';
const performerIDs=raw=>Array.isArray(raw?.artists)&&raw.artists.length>0&&raw.artists.length<=3
 &&raw.artists.every(p=>/^[1-9]\d{0,19}$/.test(String(p.id)))
 ?JSON.stringify(raw.artists.map(p=>String(p.id)).sort()):null;
// Cross-release timing is optional. Unknown annotations and named editions
// require the complete same release label, not merely matching boolean flags.
const qualifiedRelease=/[()[\]{}【】「」『』]|\b(?:live|remaster(?:ed)?|re[\s-]?record(?:ed|ing)?|recording|remix|mix|version|edition|edit|mono|stereo|instrumental|karaoke|acoustic|unplugged|a[\s-]?cap(?:p)?ella|demo|cover|reprise|clean|explicit|sped|speed|slowed|nightcore|daycore|pitch|dub|reverb|surround|spatial|dolby)\b|版本?|混音|现场|現場|演唱会|演唱會|重制|重製|重录|重錄|再录|再錄|伴奏|纯音乐|純音樂|不插电|不插電|清唱|翻唱|剪辑|剪輯|单声道|單聲道|立体声|立體聲|加速|减速|減速|ライブ|ライヴ|リミックス|バージョン|ヴァージョン|リマスター|モノラル|ステレオ|再録|라이브|리믹스|버전|리마스터|스테레오|모노|재녹음/iu;
const compatibleReleases=(a,b)=>typeof a.album==='string'&&!!a.album.trim()&&typeof b.album==='string'&&!!b.album.trim()
 &&(normalizedAlbum(a.album)===normalizedAlbum(b.album)||![a.album,b.album].some(value=>qualifiedRelease.test(value.normalize('NFKC'))));
const withTitleEvidence=(song,raw,field,request)=>{
  if(request.recordingProvider!=='spotify')return song;
  const evidence=neteaseTitleEvidence(raw,field),candidate={...song,neteaseTitleEvidence:evidence};
  return evidence&&neteaseDescriptiveTitleMatches(candidate,request,normalizeRecordingText)?candidate:song;
};
// NetEase's reserved metadata containers may occur between or after vocals.
// Timestamped JSON and unknown shapes remain exact performed text.
function withoutLRCMetadata(raw='') {
  const rows=raw.replace(/^\uFEFF/,'').split(/\r?\n/),kept=[];let count=0;
  for(const row of rows){
    if(count<32&&isNeteaseMetadataRow(row)){count++;continue;}
    kept.push(row);
  }
  return kept.join('\n');
}
export class NeteaseAPI extends BaseMusicAPI {
  constructor() { super('NeteaseAPI',['zh','yue','en','ja','ko','ru']); this.supportsVocalTiming=true; this.languageAgnosticDiscovery=true; this.baseURL='https://netease-cloud-music-api-gules-mu.vercel.app'; this.artistAliases=new BoundedCache({limit:128,ttlMs:86400000}); }
  supportsLanguage(language) { return typeof language==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(language); }
  async searchSong(artist,title,context={}) {
    context.signal?.throwIfAborted();
    const request={artist,title,...context},records=new Map(),profiles=new Map(),hydrated=new Set();
    const plausibleMetadata=song=>(recordingNames(song).title===recordingNames(request).title
      ||context.recordingProvider==='spotify'&&neteaseDescriptiveTitleMatches(song,request,normalizeRecordingText))
      &&Number.isFinite(song.duration)&&Number.isFinite(request.duration)
      &&recordingScore({...song,title,artist,artistAliasEvidence:undefined,
        ...(context.recordingProvider==='spotify'?{creditedArtistNames:request.creditedArtistNames}:{})},request)>=0;
    let lastMismatch;
    const select=async()=> {
      const songs=[...records.values()].map(entry=>entry.song);
      const spotify=context.recordingProvider==='spotify';
      const unresolvedRecovery=()=>songs.some(song=>song.artistAliasEvidence)
        &&!songs.some(song=>!song.artistAliasEvidence&&recordingScore(song,request)>=0)
        &&[...records.values()].some(({song,raw})=>plausibleMetadata(song)&&raw.artists?.some(p=>
          !recordingNames(request).credits.includes(normalizeRecordingText(p.name))&&!profiles.has(String(p.id))));
      if(unresolvedRecovery()){lastMismatch=new RecordingMismatchError('duplicate_candidates');return null;}
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
      // One verified performer profile also applies to other search rows for
      // that exact ID. The three-profile budget must not strand an exact album
      // or a measured release merely because it appears later in the page.
      for(const {song,raw} of records.values()) {
        if(plausible.includes(song)||!performerIDs(raw)||!raw.artists.every(p=>profiles.has(String(p.id))))continue;
        await this.resolveArtistAliases(song,raw.artists,request,context,profiles);
      }
      if(unresolvedRecovery()) {
        // A profile budget is not proof that an unexamined plausible artist
        // cannot match. Do not turn the verified prefix into a fuzzy winner.
        lastMismatch=new RecordingMismatchError('duplicate_candidates');return null;
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
          song.lyricsData=await this.getLyrics(song.id,{...context,song});
        }));
        try { return findRecording(songs,request); }
        catch(error) { if(error.code!=='recording_mismatch') throw error;lastMismatch=error; }
      }
      return null;
    };
    for(const limit of [30,100]) {
      const recoveryTitle=limit===100&&recoverySearchTitle(request)&&![...records.values()].some(({song})=>plausibleMetadata(song));
      const query=recoveryTitle?searchTitle(title):`${artist} ${searchTitle(title)}`;
      const data=await fetchJSON(`${this.baseURL}/search?limit=${limit}&keywords=${encodeURIComponent(simplifyRecordingScript(query))}`,context);
      if(data.code!==200) throw new Error('NetEase search unavailable');
      for(const raw of data.result?.songs || []) if(!records.has(raw.id)) {
        const song={id:raw.id,title:raw.name,artist:raw.artists?.map(x=>x.name).join(' & ') || '',album:raw.album?.name,duration:raw.duration ? raw.duration/1000:null,source:'netease',...(typeof raw.explicit==='boolean'?{explicit:raw.explicit}:{}),...(context.recordingProvider==='spotify'?{creditedArtistNames:raw.artists?.map(x=>x.name),creditedArtistIDs:raw.artists?.map(x=>String(x.id)),...(raw.isrc?{isrc:raw.isrc}:{})}:{})};
        records.set(raw.id,{raw,song:withTitleEvidence({...song,...(recoveryTitle?{searchRecovery:'title_only_fallback'}:{})},raw,'alias',request)});
      }
      const song=await select();if(song) return this.measuredRelease(song,records,request,context);
      if(context.signal?.aborted) throw Object.assign(new Error('Lookup cancelled'),{name:'AbortError'});
    }
    if(lastMismatch) throw lastMismatch;
    return null;
  }
  async measuredRelease(best,records,request,context) {
    const origin=records.get(best.id)?.raw,ids=performerIDs(origin);
    if(!ids||origin.originCoverType===2||!compatibleReleases(best,request)||!Number.isFinite(request.duration)||Math.abs(best.duration-request.duration)>0.5)return best;
    const family=[...records.values()].filter(({song,raw})=>performerIDs(raw)===ids
      &&raw.originCoverType!==2
      &&Number.isFinite(song.duration)&&Math.abs(song.duration-best.duration)<=0.5&&Math.abs(song.duration-request.duration)<=0.5
      &&recordingScore(song,request)>=0&&sameRecordingVersions(song,best)&&sameRecordingVersions(song,request)
      &&compatibleReleases(song,best)&&compatibleReleases(song,request)
      &&!(raw.isrc&&origin.isrc&&raw.isrc!==origin.isrc)
      &&!(typeof raw.explicit==='boolean'&&typeof origin.explicit==='boolean'&&raw.explicit!==origin.explicit));
    // Recording selection above must already be unambiguous. These are
    // optional source editions for that anchor, not a new uniqueness test.
    // Keep discovery and lyric acquisition bounded independently.
    if(family.length<2||family.length>16)return best;
    best.lyricsData??=await this.getLyrics(best.id,{...context,song:best});
    const cleaned=song=>cleanLyrics(song.lyricsData,{duration:song.duration,title:song.title,artist:song.artist});
    const baseline=cleaned(best);
    if(!baseline?.lines.length||baseline.partial||baseline.instrumental||hasCompleteMeasuredVocalTiming({song:best,lyrics:baseline}))return best;
    const text=lyrics=>normalizeRecordingText(lyrics.lines.map(l=>l.text).join(''));
    const expected=text(baseline);if(!expected)return best;
    try {
      // Optional acquisition owns a fixed sub-budget inside the caller's
      // unchanged provider deadline. Failure keeps the readable primary.
      const companions=family.filter(({song})=>song!==best).sort((a,b)=>recordingScore(b.song,request)-recordingScore(a.song,request)
        ||String(a.song.id).localeCompare(String(b.song.id),'en',{numeric:true})).slice(0,3);
      const selected=await withDeadline(async signal=>{
        const controller=new AbortController(),relay=()=>controller.abort();
        signal.addEventListener('abort',relay,{once:true});if(signal.aborted)relay();
        try {
          // Every companion independently matches the established anchor.
          // A slow or absent peer cannot erase a complete measured edition.
          return await Promise.any(companions.map(async({song})=>{
            controller.signal.throwIfAborted();
            const raw=song.lyricsData??await this.getLyrics(song.id,{...context,signal:controller.signal,song});
            controller.signal.throwIfAborted();song.lyricsData=raw;
            const lyrics=cleaned(song);
            if(!lyrics||lyrics.partial||lyrics.instrumental||text(lyrics)!==expected
              ||!hasCompleteMeasuredVocalTiming({song,lyrics}))throw new Error('No complete measured edition');
            return song;
          }));
        }finally{signal.removeEventListener('abort',relay);controller.abort();}
      },1500,context.signal);
      // Two sheets for this established recording can contain different
      // measured annotations, just as its LRC and YRC can. Adopt the first
      // complete verified edition; never combine or shift their cues.
      return selected;
    }catch(error) {
      context.signal?.throwIfAborted();
      return best;
    }
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
    } else if(spotify) {
      const verifiedProfiles=new Map(await Promise.all(performers.map(async p=>[String(p.id),
        profiles.has(String(p.id))?await profiles.get(String(p.id)):[p.name]])));
      let evidence=buildArtistAliasEvidence(song,performers,request,verifiedProfiles);
      if(!evidence&&request.creditedArtistIDs&&typeof context.resolveArtistIdentities==='function') {
        const identities=await context.resolveArtistIdentities({signal:context.signal});
        context.signal?.throwIfAborted();
        evidence=buildArtistIdentityEvidence(song,performers,request,verifiedProfiles,identities);
      }
      if(evidence) {
        song.artistAliasEvidence=evidence;
        if(recordingScore(song,request)>=0)
          context.onVerifiedArtistCredits?.({names:performers.map(p=>p.name),aliases:recoveredArtistNames(song,request)});
      }
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
    const song=withTitleEvidence({id:raw.id,title:raw.name,artist:performers.map(p=>p.name).join(' & '),album:raw.al?.name,duration:raw.dt/1000,source:'netease',...(typeof raw.explicit==='boolean'?{explicit:raw.explicit}:{}),
      ...(context.recordingProvider==='spotify'?{creditedArtistNames:performers.map(p=>p.name),creditedArtistIDs:performers.map(p=>String(p.id)),...(raw.isrc?{isrc:raw.isrc}:{})}:{})},raw,'alia',context);
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
      // Catalogs sometimes omit Latin accents (Rene / René). Derive only this
      // spelling from this freshly verified artist ID, never from song titles
      // or arbitrary search labels. Other scripts keep their combining marks.
      const latin=names.filter(name=>/\p{Script=Latin}/u.test(name)&&!name.replace(/[\p{Script=Latin}\p{M}\p{N}\p{P}\p{Z}\s]/gu,'')
        ).map(name=>name.normalize('NFD').replace(/\p{M}/gu,'').normalize('NFC'));
      names.push(...latin.filter(name=>!names.includes(name)));
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
  parseLyrics(raw) { return parseLRC(withoutLRCMetadata(raw)); }
}
