import {withLyricsDelivery} from './lyrics-delivery.js';
import {NETEASE_ACQUISITION_CAPABILITY} from './netease-yrc.js';
import {attachVocalTiming,stripVocalTiming} from './vocal-timing.js';
import {createVerifiedContextCache} from './verified-lyric-context.js';
import {hintedRecording} from './source-hint.js';
import {randomUUID} from 'node:crypto';
import {createRedisFromEnv} from './redis-client.js';
import {getAvailableAPIs} from '../music-apis/index.js';
import {detectLanguage,getDefaultRomanizationSystem} from './language-detection.js';
import {getProcessor} from '../processors/index.js';
import {formatMusicResponse} from './response-formatter.js';
import {getCached,setLyricsCached,cacheUnavailable,suspendCache} from './cache.js';
import {withDeadline} from './fetch-json.js';
import {recordingScore,findRecording,RecordingMismatchError} from './recording-match.js';
import {cleanLyrics,hasUsableLyrics} from './lyric-quality.js';
import {chooseMeasuredLyricCandidate as chooseLyricCandidate,timingQuality,VOCAL_SELECTION_CAPABILITY} from './lyric-selection.js';
import {hedgedLookup} from './hedged-lookup.js';
import {isRejectedRecordingLyrics} from './rejected-lyrics.js';
import {analyzeLyricLanguage} from './lyric-language.js';
import {LYRIC_SELECTION_REVISION,LYRIC_NORMALIZATION_VERSION,hasEmbeddedLyricCredits,publicRawLyrics} from './lyric-annotations.js';
import {BoundedCache} from './bounded-cache.js';
import {waitUntil} from '@vercel/functions';
import {LibraryError} from './song-library/store.js';
import {spotifyRecording,spotifyRequestHash,spotifySearchRequest,independentProvider,sourceCapsule,spotifyBinding,verifySpotifyBinding,attachSpotifyMatchEvidence} from './song-library/spotify-recording.js';

// The same independent provider path serves durable acquisition and readable
// fallback. It never resolves Apple aliases or calls the disabled sample API.
export function createSpotifyLyricsService(dependencies={}) {
  const {redis=createRedisFromEnv(),getAvailableAPIsFn=getAvailableAPIs,detectLanguageFn=detectLanguage,
    getDefaultRomanizationSystemFn=getDefaultRomanizationSystem,getProcessorFn=getProcessor,formatMusicResponseFn=formatMusicResponse,
    getCachedFn=getCached,setCachedFn=setLyricsCached,providerTimeoutMs=6000,cacheTimeoutMs=300,hedgeDelayMs=350,untimedGraceMs=2500,wordTimingGraceMs=providerTimeoutMs,
    rejectRecordingLyricsFn=isRejectedRecordingLyrics,analyzeLyricLanguageFn=analyzeLyricLanguage,waitUntilFn=waitUntil,logger=console,contextNow=Date.now,contextTTLms=21600000,sourceHintBudgetMs=800}=dependencies;
  const contexts=createVerifiedContextCache({redis,getFn:dependencies.getContextFn??getCachedFn,setFn:dependencies.setContextFn??setCachedFn,waitUntilFn,now:contextNow,ttlMs:contextTTLms,cacheTimeoutMs,policy:{response:'spotify-1',selection:LYRIC_SELECTION_REVISION,normalization:LYRIC_NORMALIZATION_VERSION}});
  const cache=new BoundedCache(),inflight=new Map();let latestStart=0;
  const validCached=(entry,r)=>{
    const response=entry?.response,candidate=entry?.candidate;
    try {
      if(!candidate||String(candidate.id)!==String(response?.song?.id)||recordingScore(candidate,spotifySearchRequest(r))<0)return false;
      if(rejectRecordingLyricsFn(response.lines.map(l=>({text:l.original})),spotifySearchRequest(r)))return false;
      if(hasEmbeddedLyricCredits(response,spotifySearchRequest(r)))return false;
      if(response.metadata.selection_revision!==LYRIC_SELECTION_REVISION||response.metadata.spotify_response_version!==1)return false;
      if(!Number.isFinite(Date.parse(response.metadata.timestamp))||Date.now()-Date.parse(response.metadata.timestamp)>(response.quality.partial||!response.quality.synced?300000:86400000))return false;
      verifySpotifyBinding(response.recordingBinding,r,sourceCapsule(response),LYRIC_SELECTION_REVISION,response);return true;
    }catch{return false;}
  };
  return withLyricsDelivery(async(req,res)=>{
    const started=performance.now(),requestID=randomUUID(),timings=[];
    const measure=async(name,work)=>{const start=performance.now();try{return await work();}finally{timings.push(`${name};dur=${(performance.now()-start).toFixed(1)}`);}};
    const validate=(name,work)=>{const start=performance.now();try{return work();}finally{timings.push(`${name};dur=${(performance.now()-start).toFixed(1)}`);}};
    const reply=(status,body)=>{
      res.setHeader('X-Request-ID',requestID);res.setHeader('Server-Timing',[...timings,`total;dur=${(performance.now()-started).toFixed(1)}`].join(', '));
      logger.info?.('spotify_lyrics_request',{requestID,status,reason:body.reason??body.code??'matched',duration_ms:Math.round(performance.now()-started)});
      return res.status(status).json(body);
    };
    try {
      const body=req.body,options=body?.options??{};
      if(!body||typeof body!=='object'||Array.isArray(body)||Buffer.byteLength(JSON.stringify(body))>8192
        ||Object.keys(body).some(k=>!['recording','options'].includes(k))||!options||typeof options!=='object'||Array.isArray(options)
        ||Object.keys(options).some(k=>!['tone_style','separator','case','refresh'].includes(k))
        ||('tone_style' in options&&options.tone_style!=='marks')||('separator' in options&&options.separator!==' ')
        ||('case' in options&&options.case!=='lower')||('refresh' in options&&typeof options.refresh!=='boolean'))throw new LibraryError('invalid_recording',400);
      const r=spotifyRecording(body.recording),target=spotifySearchRequest(r),requestHash=spotifyRequestHash(r);
      const key=`spotify:lyrics:v2:${requestHash}:${LYRIC_SELECTION_REVISION}:${NETEASE_ACQUISITION_CAPABILITY}:${VOCAL_SELECTION_CAPABILITY}`,workKey=key+(options.refresh?':refresh':'')+':owner:'+(req.lyricDelivery?.acquisitionID??'legacy');
      const send=result=>{if(result.candidate)attachSpotifyMatchEvidence(result.body,result.candidate);res.setHeader('X-Lyrics-Cache',result.cache??'MISS');return reply(result.status,result.body);};
      const cached=!options.refresh&&cache.get(key);
      if(cached&&validate('cache_validation',()=>validCached(cached,r)))return send({status:200,body:cached.response,candidate:cached.candidate,cache:'MEMORY'});
      if(inflight.has(workKey))return send({...await inflight.get(workKey),cache:'COALESCED'});
      const acquisitionStartedAt=latestStart=Math.max(Date.now(),latestStart+0.001);
      const compute=async()=>{
        if(!options.refresh&&redis&&!cacheUnavailable(redis)) {
          const saved=await measure('cache_read',()=>withDeadline(()=>getCachedFn(redis,key),cacheTimeoutMs)).catch(error=>{suspendCache(redis,error);return null;});
          if(saved&&validate('cache_validation',()=>validCached(saved,r))){cache.set(key,saved);return {status:200,body:saved.response,candidate:saved.candidate,cache:'REDIS'};}
        }
        const script=await detectLanguageFn(`${target.artist} ${target.title}`);
        const apis=getAvailableAPIsFn(script).filter(api=>independentProvider(api.name));
        const canHint=apis.some(api=>api.name==='LRCAPI'&&typeof api.getRecording==='function');
        let verifiedContext=options.refresh||!canHint?null:await measure('verified_context_read',()=>contexts.read(r,'spotify'));
        if(!apis.length)return {status:404,body:{code:'lyrics_absent'}};
        let mismatch=null,timedOut=false,unavailable=false;
        const deadline=Math.min(Date.now()+16000,req.lyricDelivery?.deadlineAtMS??Infinity),localizations=[];
        const onVerifiedArtistCredits=credits=>{
          if(!Array.isArray(credits?.names)||!Array.isArray(credits.aliases)||credits.names.length!==target.creditedArtistNames.length
            ||credits.aliases.length!==credits.names.length||credits.names.length>3
            ||[...credits.names,...credits.aliases].some(n=>typeof n!=='string'||!n.trim()||n.length>1024)
            ||recordingScore({...target,creditedArtistNames:credits.aliases},target)<0)return;
          const key=JSON.stringify(credits.names);
          if(!localizations.some(v=>v.key===key)&&localizations.length<1)localizations.push({...credits,key});
        };
        const lookup=async(api,parentSignal,localization=null)=>{
          const label=api.name.replace(/[^a-zA-Z0-9_]/g,'');
          try {
            return await withDeadline(async signal=>{
              const searchTarget=localization?{...target,artist:localization.names.join(' & '),creditedArtistNames:localization.names}:target;
              const {artist,title,...context}=searchTarget;
              const validateSource=async(song,raw)=>{
                if(!song)return null;
                song=validate(`${label}_validation`,()=>{
                  if(recordingScore(song,searchTarget)<0)findRecording([song],searchTarget);
                  // Native aliases are accepted only through server-verified
                  // complete contributor profiles, never a public binding DTO.
                  if(localization)song={...song,creditedArtistNames:localization.aliases};
                  if(recordingScore(song,target)<0)findRecording([song],target);
                  return song;
                });
                raw=raw??await measure(`${label}_lyrics`,()=>api.getLyrics(song.id,{signal,song}));
                return validate(`${label}_validation`,()=>{
                  const lyrics=cleanLyrics(raw,{duration:song.duration,title:song.title,artist:song.artist});
                  if(rejectRecordingLyricsFn(lyrics?.lines??[],target))throw new RecordingMismatchError('version_conflict');
                  return hasUsableLyrics(lyrics,{duration:song.duration})?{song,lyrics,api,target}:null;
                });
              };
              const fresh=await hintedRecording(api,searchTarget,verifiedContext,{signal,deadline:Math.min(deadline,Date.now()+providerTimeoutMs),budgetMs:sourceHintBudgetMs,measure});
              signal.throwIfAborted();
              if(fresh){try{const candidate=await validateSource(fresh.song,fresh.lyrics);if(candidate)return candidate;}catch(error){logger.info?.('spotify_lyrics_lookup',{provider:independentProvider(api.name),reason:error.reason??'source_hint_rejected'});}signal.throwIfAborted();}
              return validateSource(await measure(`${label}_search`,()=>api.searchSong(artist,title,{...context,signal,...(independentProvider(api.name)==='netease'?{onVerifiedArtistCredits}:{})})));
            },Math.max(1,Math.min(providerTimeoutMs,deadline-Date.now())),parentSignal);
          }catch(error){
            if(parentSignal?.aborted)return null;
            logger.info?.('spotify_lyrics_lookup',{provider:independentProvider(api.name),reason:error.reason??error.code??'provider_unavailable'});
            if(error.code==='recording_mismatch')mismatch=error.reason;
            else if(error.code==='provider_timeout'||error.name==='AbortError')timedOut=true;
            else {unavailable=true;logger.info?.('spotify_lyrics_provider_failure',{provider:independentProvider(api.name)});}
            return null;
          }
        };
        const formatted=new WeakMap();
        const responseFor=candidate=>{if(!formatted.has(candidate)){const work=measure('format',()=>formatCandidate(candidate));formatted.set(candidate,req.lyricDelivery?.own?req.lyricDelivery.own(work):work);}return formatted.get(candidate);};
        const formatCandidate=async selected=>{
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
        if(lyrics.timingSource)publicRawLyrics(response);
        attachVocalTiming(response,lyrics,{provider:'spotify',recordingID:r.item_id,sourceID:song.id});
        const capsule=sourceCapsule(response);
        response.recordingBinding=spotifyBinding(r,capsule,LYRIC_SELECTION_REVISION,response);
        if(Buffer.byteLength(JSON.stringify(response))>160_000&&response.metadata.lyric_timing){
          stripVocalTiming(response);response.recordingBinding=spotifyBinding(r,sourceCapsule(response),LYRIC_SELECTION_REVISION,response);
        }
        req.lyricDelivery?.signal.throwIfAborted();
        return response;
        };
        let publishedCandidate=null;
        const publishCandidate=async candidate=>{
          if(!req.lyricDelivery||chooseLyricCandidate(publishedCandidate,candidate)!==candidate)return;
          const response=await responseFor(candidate);
          if(chooseLyricCandidate(publishedCandidate,candidate)!==candidate)return;
          attachSpotifyMatchEvidence(response,{...candidate.song,id:String(candidate.song.id)});
          publishedCandidate=candidate;req.lyricDelivery.publish(response,{requestID,serverTiming:timings.join(', ')});
        };
        const hedgeOptions=()=>({delayMs:hedgeDelayMs,untimedGraceMs,wordTimingGraceMs:Math.min(wordTimingGraceMs,Math.max(0,deadline-Date.now())),chooseCandidate:chooseLyricCandidate,signal:req.lyricDelivery?.signal,onCandidate:publishCandidate});
        let selected=await hedgedLookup(apis,lookup,hedgeOptions());
        if(!selected&&localizations.length&&Date.now()<deadline) {
          // One bounded native-name retry. Ambiguous NetEase timelines remain
          // rejected; LRCLIB/Kugou must supply their own verified recording.
          selected=await hedgedLookup(apis.filter(api=>independentProvider(api.name)!=='netease'),
            (api,signal)=>lookup(api,signal,localizations[0]),hedgeOptions());
        }
        if(!selected)return timedOut?{status:504,body:{code:'provider_timeout'}}:unavailable?{status:502,body:{code:'provider_unavailable'}}
          :mismatch?{status:409,body:{code:'recording_mismatch',reason:mismatch}}:{status:404,body:{code:'lyrics_absent'}};
        const {song}=selected,response=await responseFor(selected);
        req.lyricDelivery?.signal.throwIfAborted();
        const ttlMs=response.quality.partial||!response.quality.synced?300000:86400000;
        // Late ordinary work cannot replace a newer explicit refresh in memory.
        const candidate={id:String(song.id),title:song.title,artist:song.artist,duration:song.duration,
          ...Object.fromEntries(['album','creditedArtistNames','isrc','explicit'].filter(k=>song[k]!==undefined).map(k=>[k,song[k]]))};
        const entry={response,candidate,metadata:{acquisition_started_at:acquisitionStartedAt}};
        if(canHint)verifiedContext=verifiedContext??contexts.spotify(r,response,acquisitionStartedAt);
        if(verifiedContext)contexts.save(contexts.hint(verifiedContext,selected,acquisitionStartedAt));
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
  },{waitUntilFn});
}
