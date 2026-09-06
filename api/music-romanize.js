import {Redis} from '@upstash/redis';
import {detectLanguage,getDefaultRomanizationSystem} from './utils/language-detection.js';
import {getProcessor} from './processors/index.js';
import {formatMusicResponse} from './utils/response-formatter.js';
import {getCacheKey,getCached,setCached} from './utils/cache.js';
import {getMusicAPI,getAvailableAPIs,getSupportedCombinations} from './music-apis/index.js';
import {withDeadline} from './utils/fetch-json.js';
import {recordingScore,RecordingMismatchError} from './utils/recording-match.js';
const RESPONSE_VERSION='2.1.0';
function redisFromEnv() {
  return process.env.LYRICS_KV_REST_API_URL && process.env.LYRICS_KV_REST_API_TOKEN ? new Redis({url:process.env.LYRICS_KV_REST_API_URL,token:process.env.LYRICS_KV_REST_API_TOKEN}):null;
}
export function createMusicRomanizeHandler(dependencies={}) {
  const {redis=redisFromEnv(),detectLanguageFn=detectLanguage,getDefaultRomanizationSystemFn=getDefaultRomanizationSystem,getProcessorFn=getProcessor,formatMusicResponseFn=formatMusicResponse,getCacheKeyFn=getCacheKey,getCachedFn=getCached,setCachedFn=setCached,getMusicAPIFn=getMusicAPI,getAvailableAPIsFn=getAvailableAPIs,getSupportedMusicAPIsFn=getSupportedCombinations,providerTimeoutMs=6000,logger=console}=dependencies;
  return async (req,res)=> {
    res.setHeader('Content-Type','application/json');
    if(req.method!=='POST') return res.status(405).json({error:'Only POST allowed'});
    const {artist,title,album,duration,language,romanization_system,music_platform,options={}}=req.body || {};
    if(typeof artist!=='string' || !artist.trim() || typeof title!=='string' || !title.trim()) return res.status(400).json({error:"Missing 'artist' or 'title' parameter"});
    if(artist.length>300 || title.length>500 || (album!=null && typeof album!=='string') || (duration!=null && (!Number.isFinite(duration) || duration<=0)) || (language!=null && typeof language!=='string') || (romanization_system!=null && typeof romanization_system!=='string') || (music_platform!=null && typeof music_platform!=='string') || !options || typeof options!=='object' || Array.isArray(options)) return res.status(400).json({error:'Invalid request fields'});
    try {
      const script=language || await detectLanguageFn(`${artist} ${title}`);
      const system=romanization_system || getDefaultRomanizationSystemFn(script);
      const available=getAvailableAPIsFn(script);
      const preferred=music_platform ? getMusicAPIFn(script,music_platform):null;
      if(music_platform && !preferred) return res.status(400).json({error:`Platform '${music_platform}' not available for script '${script}'`,supported_combinations:getSupportedMusicAPIsFn()});
      const apis=preferred ? [preferred,...available.filter(api=>api!==preferred)]:available;
      if(!apis.length) return res.status(400).json({error:`No music API available for script '${script}' and platform '${music_platform}'`,supported_combinations:getSupportedMusicAPIsFn()});
      const key=getCacheKeyFn(JSON.stringify({artist,title,album,duration,requestedSource:music_platform || 'auto',sources:apis.map(api=>api.name),version:RESPONSE_VERSION}),script,system,options);
      if(redis) {
        const cached=await withDeadline(()=>getCachedFn(redis,key),800).catch(()=>null);
        if(cached?.metadata?.version===RESPONSE_VERSION) return res.status(200).json(cached);
      }
      const processor=getProcessorFn(script);
      // Latin lyrics need no romanization processor.
      if(!processor && script!=='en') return res.status(400).json({error:`Script '${script}' is not supported for romanization`});
      const romanize=async text=>processor ? processor.romanize(text,system,options):{romanized:text};
      const request={artist,title,album,duration};
      let matched=false,mismatch=false,timedOut=false,unavailable=false;
      for(const api of apis) {
        try {
          const result=await withDeadline(async signal=> {
            const song=await api.searchSong(artist,title,{album,duration,signal});
            if(!song) return null;
            if(recordingScore(song,request)<0) throw new RecordingMismatchError();
            matched=true;
            const lyrics=await api.getLyrics(song.id,{signal,song});
            return lyrics?.lines?.some(line=>line.text?.trim()) ? {song,lyrics}:null;
          },providerTimeoutMs);
          if(!result) continue;
          const {song,lyrics}=result;
          const [romanizedTitle,romanizedArtist,lines]=await Promise.all([
            romanize(song.title),romanize(song.artist),Promise.all(lyrics.lines.filter(line=>line.text?.trim()).map(async line=>({original:line.text,romanized:(await romanize(line.text)).romanized,timestamp:Number.isFinite(line.timestamp) && line.timestamp>=0 ? line.timestamp:null})))
          ]);
          const response=formatMusicResponseFn({...song,source:api.name},{title:romanizedTitle.romanized,artist:romanizedArtist.romanized,language:script,system,lines});
          response.song.album=song.album ?? null;
          response.song.duration=song.duration ?? null;
          response.metadata.version=RESPONSE_VERSION;
          if(redis) await withDeadline(()=>setCachedFn(redis,key,response,86400),800).catch(()=>{});
          return res.status(200).json(response);
        } catch(error) {
          if(error.code==='recording_mismatch') mismatch=true;
          else if(error.code==='provider_timeout' || error.name==='AbortError') timedOut=true;
          else { unavailable=true; logger.error('Lyrics provider failed',api.name,error.message); }
        }
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
