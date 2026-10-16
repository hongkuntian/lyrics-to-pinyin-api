import {createRedisFromEnv} from './redis-client.js';
import {getAvailableAPIs} from '../music-apis/index.js';
import {detectLanguage,getDefaultRomanizationSystem} from './language-detection.js';
import {getProcessor} from '../processors/index.js';
import {formatMusicResponse} from './response-formatter.js';
import {getCached,setLyricsCached,cacheUnavailable,suspendCache} from './cache.js';
import {withDeadline} from './fetch-json.js';
import {recordingScore,findRecording,RecordingMismatchError} from './recording-match.js';
import {cleanLyrics,hasUsableLyrics} from './lyric-quality.js';
import {timingQuality} from './lyric-selection.js';
import {hedgedLookup} from './hedged-lookup.js';
import {isRejectedRecordingLyrics} from './rejected-lyrics.js';
import {analyzeLyricLanguage} from './lyric-language.js';
import {LYRIC_SELECTION_REVISION} from './lyric-annotations.js';
import {BoundedCache} from './bounded-cache.js';
import {waitUntil} from '@vercel/functions';
import {LibraryError} from './song-library/store.js';
import {spotifyRecording,spotifyRequestHash,spotifySearchRequest,independentProvider,sourceCapsule,spotifyBinding,verifySpotifyBinding,attachSpotifyMatchEvidence} from './song-library/spotify-recording.js';

// The same independent provider path serves durable acquisition and readable
// fallback. It never resolves Apple aliases or calls the disabled sample API.
export function createSpotifyLyricsService(dependencies={}) {
  const {redis=createRedisFromEnv(),getAvailableAPIsFn=getAvailableAPIs,detectLanguageFn=detectLanguage,
    getDefaultRomanizationSystemFn=getDefaultRomanizationSystem,getProcessorFn=getProcessor,formatMusicResponseFn=formatMusicResponse,
    getCachedFn=getCached,setCachedFn=setLyricsCached,providerTimeoutMs=6000,cacheTimeoutMs=300,hedgeDelayMs=350,untimedGraceMs=2500,
    rejectRecordingLyricsFn=isRejectedRecordingLyrics,analyzeLyricLanguageFn=analyzeLyricLanguage,waitUntilFn=waitUntil,logger=console}=dependencies;
  const cache=new BoundedCache(),inflight=new Map();let latestStart=0;
  const validCached=(entry,r)=>{
    const response=entry?.response,candidate=entry?.candidate;
    try {
      if(!candidate||String(candidate.id)!==String(response?.song?.id)||recordingScore(candidate,spotifySearchRequest(r))<0)return false;
      if(response.metadata.selection_revision!==LYRIC_SELECTION_REVISION||response.metadata.spotify_response_version!==1)return false;
      if(!Number.isFinite(Date.parse(response.metadata.timestamp))||Date.now()-Date.parse(response.metadata.timestamp)>(response.quality.partial||!response.quality.synced?300000:86400000))return false;
      verifySpotifyBinding(response.recordingBinding,r,sourceCapsule(response),LYRIC_SELECTION_REVISION,response);return true;
    }catch{return false;}
  };
  return async(req,res)=>{
    const reply=(status,body)=>res.status(status).json(body);
    try {
      const body=req.body,options=body?.options??{};
      if(!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>8192
        ||Object.keys(body).some(k=>!['recording','options'].includes(k))||!options||typeof options!=='object'||Array.isArray(options)
        ||Object.keys(options).some(k=>!['tone_style','separator','case','refresh'].includes(k))
        ||('tone_style' in options&&options.tone_style!=='marks')||('separator' in options&&options.separator!==' ')
        ||('case' in options&&options.case!=='lower')||('refresh' in options&&typeof options.refresh!=='boolean'))throw new LibraryError('invalid_recording',400);
      const r=spotifyRecording(body.recording),target=spotifySearchRequest(r),requestHash=spotifyRequestHash(r);
      const key=`spotify:lyrics:v2:${requestHash}:${LYRIC_SELECTION_REVISION}`,workKey=key+(options.refresh?':refresh':'');
      const send=result=>{if(result.candidate)attachSpotifyMatchEvidence(result.body,result.candidate);res.setHeader('X-Lyrics-Cache',result.cache??'MISS');return reply(result.status,result.body);};
      const cached=!options.refresh&&cache.get(key);
      if(cached&&validCached(cached,r))return send({status:200,body:cached.response,candidate:cached.candidate,cache:'MEMORY'});
      if(inflight.has(workKey))return send({...await inflight.get(workKey),cache:'COALESCED'});
      const acquisitionStartedAt=latestStart=Math.max(Date.now(),latestStart+0.001);
      const compute=async()=>{
        if(!options.refresh&&redis&&!cacheUnavailable(redis)) {
          const saved=await withDeadline(()=>getCachedFn(redis,key),cacheTimeoutMs).catch(error=>{suspendCache(redis,error);return null;});
          if(saved&&validCached(saved,r)){cache.set(key,saved);return {status:200,body:saved.response,candidate:saved.candidate,cache:'REDIS'};}
        }
        const script=await detectLanguageFn(`${target.artist} ${target.title}`);
        const apis=getAvailableAPIsFn(script).filter(api=>independentProvider(api.name));
        if(!apis.length)return {status:404,body:{code:'lyrics_absent'}};
        let mismatch=null,timedOut=false,unavailable=false;
        const lookup=async(api,parentSignal)=>{
          try {
            return await withDeadline(async signal=>{
              const {artist,title,...context}=target;
              const song=await api.searchSong(artist,title,{...context,signal});
              if(!song)return null;
              if(recordingScore(song,target)<0)findRecording([song],target);
              const raw=await api.getLyrics(song.id,{signal,song});
              const lyrics=cleanLyrics(raw,{duration:song.duration,title:song.title,artist:song.artist});
              if(rejectRecordingLyricsFn(lyrics?.lines??[],target))throw new RecordingMismatchError('version_conflict');
              return hasUsableLyrics(lyrics,{duration:song.duration})?{song,lyrics,api,target}:null;
            },providerTimeoutMs,parentSignal);
          }catch(error){
            if(parentSignal?.aborted)return null;
            if(error.code==='recording_mismatch')mismatch=error.reason;
            else if(error.code==='provider_timeout'||error.name==='AbortError')timedOut=true;
            else {unavailable=true;logger.info?.('spotify_lyrics_provider_failure',{provider:independentProvider(api.name)});}
            return null;
          }
        };
        const selected=await hedgedLookup(apis,lookup,{delayMs:hedgeDelayMs,untimedGraceMs});
        if(!selected)return timedOut?{status:504,body:{code:'provider_timeout'}}:unavailable?{status:502,body:{code:'provider_unavailable'}}
          :mismatch?{status:409,body:{code:'recording_mismatch',reason:mismatch}}:{status:404,body:{code:'lyrics_absent'}};
        const {song,lyrics,api}=selected,languageDetails=analyzeLyricLanguageFn(lyrics.lines.map(l=>l.text??''),{genres:[],verified:false});
        const language=dependencies.detectLanguageFn?await detectLanguageFn(lyrics.lines.map(l=>l.text).join('\n')):languageDetails.primary;
        const system=getDefaultRomanizationSystemFn(dependencies.detectLanguageFn?language:languageDetails.pronunciation_language);
        const processor=system==='none'?null:getProcessorFn(language);
        const romanize=async text=>processor&&/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}]/u.test(text)
          ?(await processor.romanize(text,system,{tone_style:'marks',separator:' ',case:'lower'})).romanized:text;
        // No query/request backfill. All labels come from the selected provider
        // record; absent labels stay empty for the legacy display DTO only.
        const independentSong={...song,title:typeof song.title==='string'?song.title:'',artist:typeof song.artist==='string'?song.artist:'',source:api.name};
        const [title,artist,lines]=await Promise.all([romanize(independentSong.title),romanize(independentSong.artist),Promise.all(lyrics.lines.map(async line=>({original:line.text,romanized:await romanize(line.text),timestamp:line.timestamp??null,
          ...(line.vocalTiming?{vocalTiming:line.vocalTiming}:{})})))]);
        const response=formatMusicResponseFn(independentSong,{title,artist,language,system,lines});
        if(!response)throw new LibraryError('invalid_source',502);
        response.song.album=song.album??null;response.song.duration=song.duration;
        response.metadata={...response.metadata,version:'2.5.0',spotify_response_version:1,selection_revision:LYRIC_SELECTION_REVISION,
          acquisition_started_at:acquisitionStartedAt,language_details:languageDetails,timing_quality:timingQuality(selected),lyric_structure:lyrics.lyricStructure};
        response.quality={...response.quality,partial:lyrics.partial===true,instrumental:lyrics.instrumental===true,synced:response.quality.synced&&timingQuality(selected).usable};
        response.song_details={catalog_id:null,source_id:String(song.id),source:independentProvider(api.name),credits:lyrics.credits??[]};
        if(lyrics.providerTranslation)response.provider_translation=lyrics.providerTranslation;
        const capsule=sourceCapsule(response);
        response.recordingBinding=spotifyBinding(r,capsule,LYRIC_SELECTION_REVISION,response);
        const ttlMs=response.quality.partial||!response.quality.synced?300000:86400000;
        // Late ordinary work cannot replace a newer explicit refresh in memory.
        const candidate={id:String(song.id),title:song.title,artist:song.artist,duration:song.duration,
          ...Object.fromEntries(['album','creditedArtistNames','isrc','explicit'].filter(k=>song[k]!==undefined).map(k=>[k,song[k]]))};
        const entry={response,candidate,metadata:{acquisition_started_at:acquisitionStartedAt}};
        const old=cache.get(key);
        if(!old||acquisitionStartedAt>=(old.metadata.acquisition_started_at??0)){
          cache.set(key,entry,{ttlMs});
          if(redis&&!cacheUnavailable(redis))waitUntilFn(withDeadline(()=>setCachedFn(redis,key,entry,ttlMs/1000),cacheTimeoutMs).catch(error=>suspendCache(redis,error)));
        }
        return {status:200,body:response,candidate};
      };
      const task=compute();inflight.set(workKey,task);
      try{return send(await task);}finally{if(inflight.get(workKey)===task)inflight.delete(workKey);}
    }catch(error){return reply(error instanceof LibraryError?error.status:502,{code:error instanceof LibraryError?error.code:'provider_unavailable'});}
  };
}
