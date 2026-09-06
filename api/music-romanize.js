import {Redis} from '@upstash/redis';
import {detectLanguage,getDefaultRomanizationSystem} from './utils/language-detection.js';
import {getProcessor} from './processors/index.js';
import {formatMusicResponse} from './utils/response-formatter.js';
import {getCacheKey,getCached,setCached} from './utils/cache.js';
import {getMusicAPI,getAvailableAPIs,getSupportedCombinations} from './music-apis/index.js';
import {withDeadline} from './utils/fetch-json.js';
import {recordingScore,RecordingMismatchError} from './utils/recording-match.js';
import {resolveCatalogAliases} from './utils/catalog-aliases.js';
const RESPONSE_VERSION='2.2.0';
function redisFromEnv() {
  return process.env.LYRICS_KV_REST_API_URL && process.env.LYRICS_KV_REST_API_TOKEN ? new Redis({url:process.env.LYRICS_KV_REST_API_URL,token:process.env.LYRICS_KV_REST_API_TOKEN}):null;
}
export function createMusicRomanizeHandler(dependencies={}) {
  const {redis=redisFromEnv(),detectLanguageFn=detectLanguage,getDefaultRomanizationSystemFn=getDefaultRomanizationSystem,getProcessorFn=getProcessor,formatMusicResponseFn=formatMusicResponse,getCacheKeyFn=getCacheKey,getCachedFn=getCached,setCachedFn=setCached,getMusicAPIFn=getMusicAPI,getAvailableAPIsFn=getAvailableAPIs,getSupportedMusicAPIsFn=getSupportedCombinations,providerTimeoutMs=6000,resolveCatalogAliasesFn=resolveCatalogAliases,logger=console}=dependencies;
  return async (req,res)=> {
    res.setHeader('Content-Type','application/json');
    if(req.method!=='POST') return res.status(405).json({error:'Only POST allowed'});
    const {artist,title,album,duration,catalog_id,storefront,language,romanization_system,music_platform,options={}}=req.body || {};
    if(typeof artist!=='string' || !artist.trim() || typeof title!=='string' || !title.trim()) return res.status(400).json({error:"Missing 'artist' or 'title' parameter"});
    if((catalog_id!=null && (typeof catalog_id!=='string' || !/^\d{1,20}$/.test(catalog_id))) || (storefront!=null && (typeof storefront!=='string' || !/^[a-z]{2}$/.test(storefront))) || artist.length>300 || title.length>500 || (album!=null && typeof album!=='string') || (duration!=null && (!Number.isFinite(duration) || duration<=0)) || (language!=null && typeof language!=='string') || (romanization_system!=null && typeof romanization_system!=='string') || (music_platform!=null && typeof music_platform!=='string') || !options || typeof options!=='object' || Array.isArray(options)) return res.status(400).json({error:'Invalid request fields'});
    try {
      const searchScript=language || await detectLanguageFn(`${artist} ${title}`);
      const searchSystem=romanization_system || getDefaultRomanizationSystemFn(searchScript);
      const available=getAvailableAPIsFn(searchScript);
      const preferred=music_platform ? getMusicAPIFn(searchScript,music_platform):null;
      if(music_platform && !preferred) return res.status(400).json({error:`Platform '${music_platform}' not available for script '${searchScript}'`,supported_combinations:getSupportedMusicAPIsFn()});
      const apis=preferred ? [preferred,...available.filter(api=>api!==preferred)]:available;
      if(!apis.length) return res.status(400).json({error:`No music API available for script '${searchScript}' and platform '${music_platform}'`,supported_combinations:getSupportedMusicAPIsFn()});
      const key=getCacheKeyFn(JSON.stringify({artist,title,album,duration,catalog_id,storefront,requestedSource:music_platform || 'auto',sources:apis.map(api=>api.name),version:RESPONSE_VERSION}),searchScript,searchSystem,options);
      if(redis) {
        const cached=await withDeadline(()=>getCachedFn(redis,key),800).catch(()=>null);
        if(cached?.metadata?.version===RESPONSE_VERSION) return res.status(200).json(cached);
      }
      const request={artist,title,album,duration,catalog_id,storefront};
      let matched=false,mismatch=false,timedOut=false,unavailable=false;
      const deadline=Date.now()+16000;
      const diagnose=(provider,reason)=>logger.info?.('lyrics_lookup',{provider,reason});
      const tryRecording=async target=> {
        for(const api of apis) {
          const remaining=deadline-Date.now();
          if(remaining<=0) { timedOut=true; return null; }
          try {
            const result=await withDeadline(async signal=> {
              const song=await api.searchSong(target.artist,target.title,{album:target.album,duration:target.duration,signal});
              if(!song) { diagnose(api.name,'not_found'); return null; }
              if(recordingScore(song,target)<0 || (duration!=null && song.duration!=null && Math.abs(duration-song.duration)>3)) throw new RecordingMismatchError();
              matched=true;
              const lyrics=await api.getLyrics(song.id,{signal,song});
              return lyrics?.lines?.some(line=>line.text?.trim()) ? {song,lyrics,api,target}:null;
            },Math.min(providerTimeoutMs,remaining));
            if(result) return result;
          } catch(error) {
            if(error.code==='recording_mismatch') { mismatch=true; diagnose(api.name,'recording_mismatch'); }
            else if(error.code==='provider_timeout' || error.name==='AbortError') { timedOut=true; diagnose(api.name,'provider_timeout'); }
            else { unavailable=true; logger.error('Lyrics provider failed',api.name,error.message); }
          }
        }
        return null;
      };
      let result=await tryRecording(request);
      if(!result && catalog_id && deadline>Date.now()) {
        const aliases=await withDeadline(signal=>resolveCatalogAliasesFn(request,{signal}),Math.min(2500,deadline-Date.now())).catch(()=>[]);
        for(const alias of aliases.slice(0,2)) {
          result=await tryRecording(alias);
          if(result) break;
        }
      }
      if(result) {
        const {song,lyrics,api,target}=result;
        // Catalog labels may be English even when the lyrics need pinyin.
        const script=language || await detectLanguageFn(lyrics.lines.map(line=>line.text || '').join('\n'));
        const system=romanization_system || getDefaultRomanizationSystemFn(script);
        const processor=script==='en' ? null:getProcessorFn(script);
        if(!processor && script!=='en') return res.status(400).json({error:`Script '${script}' is not supported for romanization`});
        const romanize=async text=>processor && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}]/u.test(text)
          ? processor.romanize(text,system,options):{romanized:text};
        const [romanizedTitle,romanizedArtist,lines]=await Promise.all([
          romanize(song.title),romanize(song.artist),Promise.all(lyrics.lines.filter(line=>line.text?.trim()).map(async line=>({original:line.text,romanized:(await romanize(line.text)).romanized,timestamp:Number.isFinite(line.timestamp) && line.timestamp>=0 ? line.timestamp:null})))
        ]);
        const response=formatMusicResponseFn({...song,source:api.name},{title:romanizedTitle.romanized,artist:romanizedArtist.romanized,language:script,system,lines});
        response.song.album=song.album ?? null;
        response.song.duration=song.duration ?? null;
        response.metadata.version=RESPONSE_VERSION;
        if(target!==request) {
          response.metadata.recording_match={method:'catalog_alias',catalog_id,artist,title,duration};
        }
        diagnose(api.name,target===request ? 'matched':'catalog_alias');
        if(redis) await withDeadline(()=>setCachedFn(redis,key,response,86400),800).catch(()=>{});
        return res.status(200).json(response);
      }
      if(timedOut) return res.status(504).json({error:'Lyrics providers timed out',code:'provider_timeout'});
      if(unavailable) return res.status(502).json({error:'Lyrics providers are unavailable',code:'provider_unavailable'});
      if(mismatch) return res.status(409).json({error:'Could not verify the requested recording',code:'recording_mismatch'});
      if(matched) return res.status(404).json({error:'Lyrics not found'});
      return res.status(404).json({error:'Song not found',details:`Tried ${apis.map(api=>api.name).join(', ')}`});
    } catch(error) {
      logger.error('Music romanization failed',error.message);
      return res.status(500).json({error:'Server error'});
    }
  };
}
export default createMusicRomanizeHandler();
