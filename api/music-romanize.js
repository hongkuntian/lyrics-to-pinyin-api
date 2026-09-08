import {createRedisFromEnv} from './utils/redis-client.js';
import {detectLanguage,getDefaultRomanizationSystem} from './utils/language-detection.js';
import {getProcessor} from './processors/index.js';
import {formatMusicResponse} from './utils/response-formatter.js';
import {getCacheKey,getCached,setCached,cacheUnavailable,suspendCache} from './utils/cache.js';
import {getMusicAPI,getAvailableAPIs,getSupportedCombinations} from './music-apis/index.js';
import {withDeadline} from './utils/fetch-json.js';
import {recordingScore,sameRecordingNames,metadataEquivalence,RecordingMismatchError} from './utils/recording-match.js';
import {resolveCatalogAliases} from './utils/catalog-aliases.js';
import {waitUntil} from '@vercel/functions';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {BoundedCache} from './utils/bounded-cache.js';
import {cleanLyrics,hasUsableLyrics} from './utils/lyric-quality.js';
import {applyTimingCorrection} from './utils/timing-corrections.js';
import {hedgedLookup} from './utils/hedged-lookup.js';
import {lookupReviewedRecording} from './utils/reviewed-recordings.js';
import {lookupOfficialTranscription} from './utils/official-transcriptions.js';
const RESPONSE_VERSION='2.3.0';
export const SELECTION_REVISION='lyrics-selection-2026-09-08-durable';
const responseLifetimeMs=response=>response.quality?.partial===true || (response.quality?.synced===false && response.quality?.instrumental!==true) ? 300000:86400000;
const remainingLifetimeMs=response=> {
  const created=Date.parse(response.metadata?.timestamp);
  return Math.max(0,responseLifetimeMs(response)-(Number.isFinite(created)?Math.max(0,Date.now()-created):0));
};
export function createMusicRomanizeHandler(dependencies={}) {
  const {
    redis=createRedisFromEnv(),detectLanguageFn=detectLanguage,getDefaultRomanizationSystemFn=getDefaultRomanizationSystem,
    getProcessorFn=getProcessor,formatMusicResponseFn=formatMusicResponse,getCacheKeyFn=getCacheKey,
    getCachedFn=getCached,setCachedFn=setCached,getMusicAPIFn=getMusicAPI,getAvailableAPIsFn=getAvailableAPIs,
    getSupportedMusicAPIsFn=getSupportedCombinations,providerTimeoutMs=6000,hedgeDelayMs=350,untimedGraceMs=2500,cacheTimeoutMs=300,
    applyTimingCorrectionFn=applyTimingCorrection,resolveCatalogAliasesFn=resolveCatalogAliases,lookupReviewedRecordingFn=lookupReviewedRecording,lookupOfficialTranscriptionFn=lookupOfficialTranscription,waitUntilFn=waitUntil,logger=console,
    responseCache=new BoundedCache(),aliasCache=new BoundedCache({ttlMs:86400000})
  }=dependencies;
  const inflight=new Map();
  return async (req,res)=> {
    const started=performance.now(),requestID=randomUUID(),timings=[];
    let cacheStatus='MISS';
    const measure=async(name,work)=> {
      const start=performance.now();
      try { return await work(); }
      finally { timings.push(`${name};dur=${(performance.now()-start).toFixed(1)}`); }
    };
    const send=({status,body})=> {
      res.setHeader('X-Request-ID',requestID);
      res.setHeader('X-Lyrics-Cache',cacheStatus);
      res.setHeader('Server-Timing',[...timings,`total;dur=${(performance.now()-started).toFixed(1)}`].join(', '));
      logger.info?.('lyrics_request',{requestID,status,cache:cacheStatus,duration_ms:Math.round(performance.now()-started)});
      return res.status(status).json(body);
    };
    res.setHeader('Content-Type','application/json');
    if(req.method!=='POST') return send({status:405,body:{error:'Only POST allowed'}});
    const {artist,title,album,duration,catalog_id,storefront,language,romanization_system,music_platform,options={}}=req.body || {};
    if(typeof artist!=='string' || !artist.trim() || typeof title!=='string' || !title.trim()) return res.status(400).json({error:"Missing 'artist' or 'title' parameter"});
    if((catalog_id!=null && (typeof catalog_id!=='string' || !/^\d{1,20}$/.test(catalog_id))) || (storefront!=null && (typeof storefront!=='string' || !/^[a-z]{2}$/.test(storefront))) || artist.length>1024 || title.length>500 || (album!=null && typeof album!=='string') || (duration!=null && (!Number.isFinite(duration) || duration<=0)) || (language!=null && typeof language!=='string') || (romanization_system!=null && typeof romanization_system!=='string') || (music_platform!=null && typeof music_platform!=='string') || !options || typeof options!=='object' || Array.isArray(options)) return res.status(400).json({error:'Invalid request fields'});
    try {
      const searchScript=language || await detectLanguageFn(`${artist} ${title}`);
      const searchSystem=romanization_system || getDefaultRomanizationSystemFn(searchScript);
      const available=getAvailableAPIsFn(searchScript);
      const preferred=music_platform ? getMusicAPIFn(searchScript,music_platform):null;
      if(music_platform && !preferred) return send({status:400,body:{error:`Platform '${music_platform}' not available for script '${searchScript}'`,supported_combinations:getSupportedMusicAPIsFn()}});
      const apis=preferred ? [preferred,...available.filter(api=>api!==preferred)]:available;
      if(!apis.length) return send({status:400,body:{error:`No music API available for script '${searchScript}' and platform '${music_platform}'`,supported_combinations:getSupportedMusicAPIsFn()}});
      // Sort option keys without relaxing recording or request-bound alias identity.
      const stableOptions=Object.fromEntries(Object.entries(options).sort(([a],[b])=>a.localeCompare(b)));
      const key=getCacheKeyFn(JSON.stringify({artist,title,album,duration,catalog_id,storefront,requestedSource:music_platform || 'auto',sources:apis.map(api=>api.name),version:RESPONSE_VERSION,selectionPolicy:SELECTION_REVISION}),searchScript,searchSystem,stableOptions);
      const local=responseCache.get(key);
      if(local) { cacheStatus='MEMORY';return send({status:200,body:local}); }
      if(inflight.has(key)) { cacheStatus='COALESCED';return send(await measure('shared',()=>inflight.get(key))); }
      const request={artist,title,album,duration,catalog_id,storefront};
      const compute=async()=> {
        if(redis && !cacheUnavailable(redis)) {
          const cached=await measure('cache_read',()=>withDeadline(()=>getCachedFn(redis,key),cacheTimeoutMs)).catch(error=>{suspendCache(redis,error);return null;});
          if(cached?.metadata?.version===RESPONSE_VERSION && cached.metadata.selection_revision===SELECTION_REVISION && cached.metadata.timing_correction?.status!=='untimed_fallback' && remainingLifetimeMs(cached)>0) {
            responseCache.set(key,cached,{ttlMs:remainingLifetimeMs(cached)});cacheStatus='REDIS';return {status:200,body:cached};
          }
        }
        let matched=false,mismatch=false,timedOut=false,unavailable=false;
        const deadline=Date.now()+16000;
        const diagnose=(provider,reason)=>logger.info?.('lyrics_lookup',{requestID,provider,reason});
        const tryRecording=async target=> {
          const lookup=async(api,parentSignal)=> {
            const remaining=deadline-Date.now();
            if(remaining<=0) { timedOut=true; return null; }
            const providerDeadline=Date.now()+Math.min(providerTimeoutMs,remaining);
            try {
              return await withDeadline(async signal=> {
                const label=api.name.replace(/[^a-zA-Z0-9_]/g,'');
                const song=await measure(`${label}_search`,()=>api.searchSong(target.artist,target.title,{album:target.album,duration:target.duration,catalog_id:target.catalog_id || catalog_id,signal}));
                if(!song) { diagnose(api.name,'not_found');return null; }
                if(recordingScore(song,target)<0 || (duration!=null && song.duration!=null && Math.abs(duration-song.duration)>3)) throw new RecordingMismatchError();
                matched=true;
                let lyrics=cleanLyrics(await measure(`${label}_lyrics`,()=>api.getLyrics(song.id,{signal,song})),{duration:song.duration});
                const candidate=await applyTimingCorrectionFn({song,lyrics,api,target},request,{signal,deadline:providerDeadline});
                lyrics=candidate.lyrics;
                return hasUsableLyrics(lyrics,{duration:candidate.song.duration}) ? candidate:null;
              },Math.min(providerTimeoutMs,remaining),parentSignal);
            } catch(error) {
              if(parentSignal?.aborted) return null;
              if(error.code==='recording_mismatch') { mismatch=true;diagnose(api.name,'recording_mismatch'); }
              else if(error.code==='provider_timeout' || error.name==='AbortError') { timedOut=true;diagnose(api.name,'provider_timeout'); }
              else { unavailable=true;logger.error('Lyrics provider failed',api.name,error.message); }
              return null;
            }
          };
          // An explicit source retains its first opportunity before fallback.
          if(preferred) { for(const api of apis) { const result=await lookup(api);if(result) return result; }return null; }
          // Fast plain lyrics remain available, but do not cancel a verified
          // timed candidate after just 350 ms. The extra wait applies only
          // when the current fallback has no timestamps, and remains bounded.
          return hedgedLookup(apis,lookup,{delayMs:hedgeDelayMs,untimedGraceMs:Math.min(untimedGraceMs,Math.max(0,deadline-Date.now()))});
        };
        // Reuse previously verified localizations first on repeated catalog requests.
        const aliasKey=JSON.stringify(request),knownAliases=aliasCache.get(aliasKey);
        const timed=candidate=>candidate?.lyrics?.lines?.some(line=>Number.isFinite(line.timestamp) && line.timestamp>=0);
        const mayImprove=candidate=>!candidate || (!preferred && !candidate.lyrics.instrumental && !timed(candidate));
        const better=(current,candidate)=> {
          if(!current) return candidate;
          if(!candidate || candidate.lyrics.instrumental || (!current.lyrics.partial && candidate.lyrics.partial)) return current;
          return (current.lyrics.partial && !candidate.lyrics.partial) || (timed(candidate) && !timed(current)) ? candidate:current;
        };
        // Reviewed cross-catalog metadata is only an exact-ID discovery path.
        // The helper rechecks complete catalog and source signatures before
        // returning any provider words; ordinary mismatches stay strict.
        let result=!preferred ? await measure('reviewed_recording',()=>withDeadline(async signal=> {
          const candidate=await lookupReviewedRecordingFn(request,{signal});
          return candidate ? applyTimingCorrectionFn(candidate,request,{signal,deadline}):null;
        },Math.min(providerTimeoutMs,Math.max(1,deadline-Date.now())))).catch(()=>null):null;
        if(!result && !preferred) result=await measure('official_transcription',()=>withDeadline(
          signal=>lookupOfficialTranscriptionFn(request,{signal,diagnose:event=>logger.info?.('official_transcription',{requestID,...event})}),Math.min(providerTimeoutMs,Math.max(1,deadline-Date.now())))).catch(()=>null);
        if(mayImprove(result) && knownAliases?.length) result=better(result,await tryRecording(knownAliases[0]));
        if(mayImprove(result)) result=better(result,await tryRecording(request));
        if(mayImprove(result) && (catalog_id || (album && duration)) && deadline>Date.now()) {
          const aliases=knownAliases || await measure('catalog_alias',()=>withDeadline(signal=>resolveCatalogAliasesFn(request,{signal}),Math.min(2500,deadline-Date.now()))).catch(()=>[]);
          if(aliases.length) aliasCache.set(aliasKey,aliases);
          for(const alias of aliases.slice(0,3)) {
            if(alias===knownAliases?.[0]) continue;
            result=better(result,await tryRecording(alias));
            if(!mayImprove(result)) break;
          }
        }
        if(result) {
          const {song,lyrics,api,target}=result;
          const cacheable=result.timingCorrection?.status!=='untimed_fallback';
          const response=await measure('romanize',async()=> {
            const script=lyrics.instrumental ? searchScript : language || await detectLanguageFn(lyrics.lines.map(line=>line.text || '').join('\n'));
            const system=romanization_system || getDefaultRomanizationSystemFn(script);
            const processor=script==='en' ? null:getProcessorFn(script);
            if(!processor && script!=='en') return null;
            const romanize=async text=>processor && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}]/u.test(text)
              ? processor.romanize(text,system,options):{romanized:text};
            const [romanizedTitle,romanizedArtist,lines]=await Promise.all([
              romanize(song.title),romanize(song.artist),Promise.all(lyrics.lines.filter(line=>line.text?.trim()).map(async line=>({original:line.text,romanized:(await romanize(line.text)).romanized,timestamp:Number.isFinite(line.timestamp) && line.timestamp>=0 ? line.timestamp:null})))
            ]);
            return formatMusicResponseFn({...song,source:api.name},{title:romanizedTitle.romanized,artist:romanizedArtist.romanized,language:script,system,lines});
          });
          if(!response) return {status:400,body:{error:'Script is not supported for romanization'}};
          response.song.album=song.album ?? null;response.song.duration=song.duration ?? null;
          response.metadata.version=RESPONSE_VERSION;
          if(cacheable) response.metadata.selection_revision=SELECTION_REVISION;
          response.quality.instrumental=lyrics.instrumental===true;
          response.quality.partial=lyrics.partial===true;
          if(result.timingCorrection) response.metadata.timing_correction=result.timingCorrection;
          if(result.reviewedIdentity) response.metadata.reviewed_recording=result.reviewedIdentity;
          if(target!==request) response.metadata.recording_match={method:catalog_id ? 'catalog_alias':'metadata_alias',catalog_id:catalog_id || target.catalog_id,artist,title,duration,...(!catalog_id ? {album}:{})};
          if(target===request && !sameRecordingNames(song,request)) {
            const method=result.timingCorrection?.status==='replacement' && !metadataEquivalence(song,request) ? 'catalog_alias':'metadata_equivalence';
            response.metadata.recording_match={method,catalog_id,artist,title,album,duration};
          }
          diagnose(api.name,target===request ? 'matched':'catalog_alias');
          if(cacheable) responseCache.set(key,response,{ttlMs:responseLifetimeMs(response)});
          if(cacheable && redis && !cacheUnavailable(redis)) {
            const writeStart=performance.now();
            const write=withDeadline(()=>setCachedFn(redis,key,response,responseLifetimeMs(response)/1000),cacheTimeoutMs)
              .catch(error=>suspendCache(redis,error))
              .finally(()=>logger.info?.('lyrics_cache_write',{requestID,duration_ms:Math.round(performance.now()-writeStart)}));
            waitUntilFn(write);
          }
          return {status:200,body:response};
        }
        if(timedOut) return {status:504,body:{error:'Lyrics providers timed out',code:'provider_timeout'}};
        if(unavailable) return {status:502,body:{error:'Lyrics providers are unavailable',code:'provider_unavailable'}};
        if(mismatch) return {status:409,body:{error:'Could not verify the requested recording',code:'recording_mismatch'}};
        if(matched) return {status:404,body:{error:'Lyrics not found'}};
        return {status:404,body:{error:'Song not found',details:`Tried ${apis.map(api=>api.name).join(', ')}`}};
      };
      const task=compute();inflight.set(key,task);
      try { return send(await task); } finally { inflight.delete(key); }
    } catch(error) {
      logger.error('Music romanization failed',error.message);
      return send({status:500,body:{error:'Server error'}});
    }
  };
}
export default createMusicRomanizeHandler();
