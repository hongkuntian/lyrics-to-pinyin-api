import {SourceAcquisitions,canonicalAcquisitionKey} from './utils/source-acquisitions.js';
import {NETEASE_ACQUISITION_CAPABILITY} from './utils/netease-yrc.js';
import {attachVocalTiming,verifiedTimingAlias,stripVocalTiming} from './utils/vocal-timing.js';
import {startSpeculativeDiscovery} from './utils/speculative-discovery.js';
import {withLyricsDelivery} from './utils/lyrics-delivery.js';
import {createVerifiedContextCache,contextSignature} from './utils/verified-lyric-context.js';
import {hintedRecording} from './utils/source-hint.js';
import {createSpotifyLyricsService} from './utils/spotify-lyrics.js';
import {withAppAuth} from './utils/app-auth/http.js';
import {createRedisFromEnv} from './utils/redis-client.js';
import {detectLanguage,getDefaultRomanizationSystem} from './utils/language-detection.js';
import {getProcessor} from './processors/index.js';
import {formatMusicResponse,canonicalProviderID} from './utils/response-formatter.js';
import {getCacheKey,getCached,setLyricsCached,cacheUnavailable,suspendCache} from './utils/cache.js';
import {getMusicAPI,getAvailableAPIs,getSupportedCombinations} from './music-apis/index.js';
import {withDeadline} from './utils/fetch-json.js';
import {recordingScore,sameRecordingNames,metadataEquivalence,RecordingMismatchError} from './utils/recording-match.js';
import {resolveCatalogAliases} from './utils/catalog-aliases.js';
import {waitUntil} from '@vercel/functions';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {BoundedCache} from './utils/bounded-cache.js';
import {cleanLyrics,hasUsableLyrics} from './utils/lyric-quality.js';
import {LYRIC_NORMALIZATION_VERSION,LYRIC_SELECTION_REVISION,publicRawLyrics} from './utils/lyric-annotations.js';
import {applyTimingCorrection,lyricSourceNeedsRefresh} from './utils/timing-corrections.js';
import {hedgedLookup} from './utils/hedged-lookup.js';
import {lookupReviewedRecording,hasReviewedCatalogSource} from './utils/reviewed-recordings.js';
import {lookupOfficialTranscription,hasOfficialCatalogSource} from './utils/official-transcriptions.js';
import {lookupListeningReviewedRecording,hasListeningCatalogSource} from './utils/listening-reviewed-recordings.js';
import {analyzeLyricLanguage} from './utils/lyric-language.js';
import {chooseMeasuredLyricCandidate as chooseLyricCandidate,timingQuality,VOCAL_SELECTION_CAPABILITY} from './utils/lyric-selection.js';
import {isRejectedRecordingLyrics} from './utils/rejected-lyrics.js';
export const RESPONSE_VERSION='2.5.0';
export const config={supportsResponseStreaming:true};
export const SELECTION_REVISION=LYRIC_SELECTION_REVISION;
const responseLifetimeMs=response=>response.quality?.partial===true || (response.quality?.synced===false && response.quality?.instrumental!==true) ? 300000:86400000;
const remainingLifetimeMs=response=> {
  const created=Date.parse(response.metadata?.timestamp);
  return Math.max(0,responseLifetimeMs(response)-(Number.isFinite(created)?Math.max(0,Date.now()-created):0));
};
export function createMusicRomanizeService(dependencies={}) {
  const {
    redis=createRedisFromEnv(),detectLanguageFn=detectLanguage,getDefaultRomanizationSystemFn=getDefaultRomanizationSystem,
    getProcessorFn=getProcessor,formatMusicResponseFn=formatMusicResponse,getCacheKeyFn=getCacheKey,
    getCachedFn=getCached,setCachedFn=setLyricsCached,getMusicAPIFn=getMusicAPI,getAvailableAPIsFn=getAvailableAPIs,
    getSupportedMusicAPIsFn=getSupportedCombinations,providerTimeoutMs=6000,reviewedTimeoutMs=providerTimeoutMs*2,hedgeDelayMs=350,untimedGraceMs=2500,wordTimingGraceMs=providerTimeoutMs,cacheTimeoutMs=300,
    applyTimingCorrectionFn=applyTimingCorrection,resolveCatalogAliasesFn=resolveCatalogAliases,lookupReviewedRecordingFn=lookupReviewedRecording,lookupListeningReviewedRecordingFn=lookupListeningReviewedRecording,lookupOfficialTranscriptionFn=lookupOfficialTranscription,waitUntilFn=waitUntil,logger=console,
    responseCache=new BoundedCache(),analyzeLyricLanguageFn=analyzeLyricLanguage,
    rejectRecordingLyricsFn=isRejectedRecordingLyrics,contextNow=Date.now,contextTTLms=21600000,sourceHintBudgetMs=800,neteaseSourceHintBudgetMs=2500,speculativeDiscovery=true
  }=dependencies;
  const spotifyService=createSpotifyLyricsService(dependencies);
  const contexts=createVerifiedContextCache({redis,getFn:dependencies.getContextFn??getCachedFn,setFn:dependencies.setContextFn??setCachedFn,waitUntilFn,now:contextNow,ttlMs:contextTTLms,cacheTimeoutMs,policy:{response:RESPONSE_VERSION,selection:SELECTION_REVISION,normalization:LYRIC_NORMALIZATION_VERSION}});
  const inflight=new Map(),sourceAcquisitions=new SourceAcquisitions({waitUntilFn});
  const canonicalCache=new BoundedCache();
  const verifiedRouting=new BoundedCache({ttlMs:contextTTLms,now:contextNow});
  let latestStart=0;
  const saveNewest=(cache,key,response,ttlMs)=> {
    const previous=cache.get(key);
    if((previous?.metadata?.acquisition_started_at??0)<=(response.metadata?.acquisition_started_at??0)) cache.set(key,response,{ttlMs});
  };
  return withLyricsDelivery(async (req,res)=> {
    const started=performance.now(),requestID=randomUUID(),timings=[];
    const acquisitionStartedAt=latestStart=Math.max(Date.now(),latestStart+0.001);
    let cacheStatus='MISS';
    const measure=async(name,work)=> {
      const start=performance.now();
      try { return await work(); }
      finally { timings.push(`${name};dur=${(performance.now()-start).toFixed(1)}`); }
    };
    const send=({status,body})=> {
      if(status===200 && body?.song) body={...body,song:{...body.song,id:canonicalProviderID(body.song.id)}};
      res.setHeader('X-Request-ID',requestID);
      res.setHeader('X-Lyrics-Cache',cacheStatus);
      res.setHeader('Server-Timing',[...timings,`total;dur=${(performance.now()-started).toFixed(1)}`].join(', '));
      logger.info?.('lyrics_request',{requestID,status,cache:cacheStatus,duration_ms:Math.round(performance.now()-started)});
      return res.status(status).json(body);
    };
    res.setHeader('Content-Type','application/json');
    if(Buffer.byteLength(JSON.stringify(req.body??{}))>32768)return res.status(400).json({code:'invalid_request'});
    if(req.method!=='POST') return send({status:405,body:{error:'Only POST allowed'}});
    if(req.body && Object.hasOwn(req.body,'recording'))return spotifyService(req,res);
    const {artist,title,album,duration,catalog_id,storefront,account_storefront,isrc,language,romanization_system,music_platform,options={}}=req.body || {};
    if((account_storefront!=null&&(typeof account_storefront!=='string'||!/^[a-z]{2}$/.test(account_storefront)))||
      (isrc!=null&&(typeof isrc!=='string'||!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(isrc)))) return send({status:400,body:{error:'Invalid recording hints',code:'invalid_recording'}});
    if(typeof artist!=='string' || !artist.trim() || typeof title!=='string' || !title.trim()) return res.status(400).json({error:"Missing 'artist' or 'title' parameter"});
    if((catalog_id!=null && (typeof catalog_id!=='string' || !/^\d{1,20}$/.test(catalog_id))) || (storefront!=null && (typeof storefront!=='string' || !/^[a-z]{2}$/.test(storefront))) || artist.length>1024 || title.length>500 || (album!=null && (typeof album!=='string'||album.length>1024)) || (duration!=null && (!Number.isFinite(duration) || duration<=0)) || (language!=null && typeof language!=='string') || (romanization_system!=null && typeof romanization_system!=='string') || (music_platform!=null && typeof music_platform!=='string') || !options || typeof options!=='object' || Array.isArray(options) || Object.keys(options).some(k=>!['tone_style','separator','case','refresh','include_metadata'].includes(k)) || Object.values(options).some(v=>typeof v==='string'&&v.length>32)) return res.status(400).json({error:'Invalid request fields'});
    try {
      const searchScript=language || await detectLanguageFn(`${artist} ${title}`);
      const searchSystem=romanization_system || getDefaultRomanizationSystemFn(searchScript);
      const available=getAvailableAPIsFn(searchScript);
      const preferred=music_platform ? getMusicAPIFn(searchScript,music_platform):null;
      if(music_platform && !preferred) return send({status:400,body:{error:`Platform '${music_platform}' not available for script '${searchScript}'`,supported_combinations:getSupportedMusicAPIsFn()}});
      const apis=preferred ? [preferred,...available.filter(api=>api!==preferred)]:available;
      if(!apis.length) return send({status:400,body:{error:`No music API available for script '${searchScript}' and platform '${music_platform}'`,code:'provider_coverage_unsupported',supported_combinations:getSupportedMusicAPIsFn()}});
      // Sort option keys without relaxing recording or request-bound alias identity.
      // Refresh controls acquisition, not the identity of the verified content.
      // Its successful result must warm subsequent ordinary requests too.
      const stableOptions=Object.fromEntries(Object.entries(options).filter(([key])=>key!=='refresh').sort(([a],[b])=>a.localeCompare(b)));
      const key=getCacheKeyFn(JSON.stringify({artist,title,album,duration,catalog_id,storefront,isrc,requestedSource:music_platform || 'auto',sources:apis.map(api=>api.name),version:RESPONSE_VERSION,cachePolicy:2,selectionPolicy:SELECTION_REVISION,normalizationPolicy:LYRIC_NORMALIZATION_VERSION,providerCapability:NETEASE_ACQUISITION_CAPABILITY,vocalSelection:VOCAL_SELECTION_CAPABILITY}),searchScript,searchSystem,stableOptions);
      const request={artist,title,album,duration,catalog_id,storefront,...(account_storefront?{account_storefront}:{}),...(isrc?{isrc}:{})};
      const inflightKey=(options.refresh===true?key+':refresh':key)+':owner:'+(req.lyricDelivery?.acquisitionID??'legacy');
      const local=options.refresh===true?null:responseCache.get(key);
      if(local && !lyricSourceNeedsRefresh(local,request)) { cacheStatus='MEMORY';return send({status:200,body:local}); }
      if(inflight.has(inflightKey)) { cacheStatus='COALESCED';return send(await measure('shared',()=>inflight.get(inflightKey))); }
      let speculation;
      const compute=async()=> {
       try {
        if(options.refresh!==true && redis && !cacheUnavailable(redis)) {
          const cached=await measure('cache_read',()=>withDeadline(()=>getCachedFn(redis,key),cacheTimeoutMs)).catch(error=>{suspendCache(redis,error);return null;});
          if(cached?.metadata?.version===RESPONSE_VERSION && cached.metadata.selection_revision===SELECTION_REVISION && cached.metadata.timing_correction?.status!=='untimed_fallback' && remainingLifetimeMs(cached)>0 && !lyricSourceNeedsRefresh(cached,request)) {
            saveNewest(responseCache,key,cached,remainingLifetimeMs(cached));cacheStatus='REDIS';return {status:200,body:cached};
          }
        }
        let matched=false,mismatch=false,timedOut=false,unavailable=false;
        let scope=req.lyricDelivery;
        const deadline=Math.min(Date.now()+16000,scope?.deadlineAtMS??Infinity);
        let publishCandidate=async()=>{};
        const diagnose=(provider,reason)=>logger.info?.('lyrics_lookup',{requestID,provider,reason});
        const recordFailure=(api,error)=>{
          if(error.code==='recording_mismatch'){mismatch=true;diagnose(api.name,error.reason??'recording_mismatch');}
          else if(error.code==='provider_timeout'||error.name==='AbortError'){timedOut=true;diagnose(api.name,'provider_timeout');}
          else{unavailable=true;logger.error('Lyrics provider failed',api.name,error.message);}
        };
        const sourceContext=await measure('verified_context_read',()=>options.refresh===true&&!apis.some(a=>a.name==='NeteaseAPI'&&typeof a.getRecording==='function')?null:contexts.read(request));
        // Explicit refresh still resolves Apple catalog evidence afresh. An old
        // NetEase ID may only route fresh source validation for the new target.
        let verifiedContext=options.refresh===true?null:sourceContext;
        const hintContext=options.refresh===true&&sourceContext?{hints:sourceContext.hints.filter(h=>h.provider==='NeteaseAPI')}:sourceContext;
        const {storefront:routeStorefront,account_storefront:routeAccount,...routeRequest}=JSON.parse(contextSignature(request)),routeKey=JSON.stringify(routeRequest);
        if(speculativeDiscovery&&!verifiedContext&&!hintContext?.hints?.some(h=>h.provider==='NeteaseAPI')&&!verifiedRouting.get(routeKey)&&!preferred&&!hasReviewedCatalogSource(request)&&!hasOfficialCatalogSource(request)&&!hasListeningCatalogSource(request)&&(catalog_id||(album&&duration))&&!/[&,/、]|\b(?:feat|featuring|with)\b/iu.test(artist+' '+title))speculation=startSpeculativeDiscovery(apis[0],request,{deadline,timeoutMs:providerTimeoutMs,signal:scope?.signal,measure});
        const knownAliases=verifiedContext?Object.assign([...verifiedContext.aliases],{resolution:verifiedContext.resolution}):null;
        // Resolve metadata before selecting a provider spelling. The fixed query
        // order makes native and international requests compete on the same terms.
        const aliasTask=(catalog_id || (album && duration))
          ? measure('catalog_alias',()=>knownAliases || withDeadline(signal=>resolveCatalogAliasesFn(request,{signal}),2500,scope?.signal).catch(()=>[]))
          : Promise.resolve([]);
        const tryRecording=async target=> {
          const lookup=async(api,parentSignal)=> {
            // A cancelled pre-proof original attempt already spent this source
            // query. Never repeat it later in a localized search sequence.
            if(speculation?.discarded&&!speculation.result?.song&&target===request&&api===speculation.api){
              // The original target is now admitted: consume its completed
              // failure once without confusing an outage with provider absence.
              if(speculation.result?.error&&!speculation.result.cancelled)recordFailure(api,speculation.result.error);
              return null;
            }
            const remaining=deadline-Date.now();
            if(remaining<=0) { timedOut=true; return null; }
            const probe=speculation&&!speculation.used&&(!speculation.discarded||speculation.result?.song)&&api===speculation.api&&target===request?speculation:null;
            if(probe){probe.used=true;probe.transfer(parentSignal??scope?.signal);}
            const providerDeadline=probe?Math.min(deadline,probe.deadline):Date.now()+Math.min(providerTimeoutMs,remaining);
            if(providerDeadline<=Date.now()){timedOut=true;return null;}
            try {
              return await withDeadline(async signal=> {
                const label=api.name.replace(/[^a-zA-Z0-9_]/g,'');
                const validateSource=async(song,raw,ordinary=false)=>{
                  if(!song)return null;
                  if(recordingScore(song,target)<0||(duration!=null&&song.duration!=null&&Math.abs(duration-song.duration)>3))throw new RecordingMismatchError();
                  if(ordinary)matched=true;
                  let lyrics=cleanLyrics(raw??await measure(`${label}_lyrics`,()=>api.getLyrics(song.id,{signal,song})),{duration:song.duration,title:song.title,artist:song.artist,catalogID:catalog_id});
                  if(rejectRecordingLyricsFn(lyrics?.lines??[],request))throw new RecordingMismatchError('lyric_version_conflict');
                  const candidate=await applyTimingCorrectionFn({song,lyrics,api,target},request,{signal,deadline:providerDeadline});
                  return hasUsableLyrics(candidate.lyrics,{duration:candidate.song.duration})?candidate:null;
                };
                const fresh=probe?null:await hintedRecording(api,target,hintContext,{signal,deadline:providerDeadline,budgetMs:sourceHintBudgetMs,neteaseBudgetMs:neteaseSourceHintBudgetMs,measure});
                signal.throwIfAborted();
                if(fresh){try{const candidate=await validateSource(fresh.song,fresh.lyrics);if(candidate){matched=true;return candidate;}}catch(error){diagnose(api.name,error.reason??'source_hint_rejected');}signal.throwIfAborted();}
                const discovered=probe?await probe.promise:null;if(discovered?.error)throw discovered.error;
                const song=probe?discovered.song:await measure(`${label}_search`,()=>api.searchSong(target.artist,target.title,{album:target.album,duration:target.duration,catalog_id:target.catalog_id||catalog_id,...(target.artist_entities?.length?{artist_entities:target.artist_entities}:{}),signal}));
                if(!song){diagnose(api.name,'not_found');return null;}
                return validateSource(song,undefined,true);
              },Math.max(1,providerDeadline-Date.now()),parentSignal);
            } catch(error) {
              if(parentSignal?.aborted) return null;
              recordFailure(api,error);
              return null;
            }
          };
          // An explicit source retains its first opportunity before fallback.
          if(preferred) { for(const api of apis) { const result=await lookup(api,scope?.signal);if(result){await publishCandidate(result);return result;} }return null; }
          // Fast plain lyrics remain available, but do not cancel a verified
          // timed candidate after just 350 ms. The extra wait applies only
          // when the current fallback has no timestamps, and remains bounded.
          const targetScript=await detectLanguageFn(`${target.artist} ${target.title}`);
          const targetAPIs=target===request || preferred ? apis : [...new Set([...getAvailableAPIsFn(targetScript),...apis])];
          return hedgedLookup(targetAPIs,lookup,{delayMs:hedgeDelayMs,untimedGraceMs:Math.min(untimedGraceMs,Math.max(0,deadline-Date.now())),wordTimingGraceMs:Math.min(wordTimingGraceMs,Math.max(0,deadline-Date.now())),chooseCandidate:chooseLyricCandidate,signal:scope?.signal,onCandidate:publishCandidate});
        };
        // Reuse previously verified localizations first on repeated catalog requests.
        const timed=candidate=>timingQuality(candidate).usable;
        const mayImprove=candidate=>!candidate || (!preferred && !candidate.lyrics.instrumental && (candidate.lyrics.partial || !timed(candidate)));
        const better=chooseLyricCandidate;
        const aliases=await aliasTask,resolution=aliases.resolution;
        if(!verifiedContext)verifiedContext=contexts.catalog(request,aliases,acquisitionStartedAt);
        if(verifiedContext){contexts.save(verifiedContext);verifiedRouting.set(routeKey,true,{ttlMs:verifiedContext.expiresAtMS-contextNow()});}else diagnose('catalog','alias_evidence_missing');
        const {searches:resolvedSearches,genres,artist_entities,...proof}=resolution??{};
        // Only server-fetched catalog relationships may guide punctuation parsing.
        // This reuses the existing bounded lookup; client display strings cannot
        // supply artist entities or erase real guest credits.
        if(artist_entities?.length)request.artist_entities=artist_entities;
        // Never join work by names or client ISRC. Only server-verified catalog
        // evidence establishes the shared recording, then each caller is rebound.
        const canonicalKey=canonicalAcquisitionKey(request,resolution,{language:language??null,reading:romanization_system??null,source:music_platform??null,sources:apis.map(a=>a.name),selection:SELECTION_REVISION,normalization:LYRIC_NORMALIZATION_VERSION,response:RESPONSE_VERSION,providerCapability:NETEASE_ACQUISITION_CAPABILITY,vocalSelection:VOCAL_SELECTION_CAPABILITY,options:stableOptions});
        const canonicalWorkKey=canonicalKey&&(options.refresh===true?canonicalKey+':refresh:'+acquisitionStartedAt:canonicalKey);
        const bind=body=>{
          const bound={...body,metadata:{...body.metadata,catalog_resolution:proof},song_details:{...body.song_details,catalog_id:catalog_id??null}};
          if(bound.metadata.lyric_timing){
            if(verifiedTimingAlias(resolution,request,resolution?.canonical_recording_id))bound.metadata.lyric_timing={...bound.metadata.lyric_timing,recordingID:catalog_id};
            else stripVocalTiming(bound);
          }
          return bound;
        };
        if(canonicalKey && options.refresh!==true) {
          const cached=canonicalCache.get(canonicalKey);
          if(cached && remainingLifetimeMs(cached)>0 && !lyricSourceNeedsRefresh(cached,request)){cacheStatus='RECORDING_MEMORY';return {status:200,body:bind(cached)};}

        }
        const formatted=new WeakMap();
        const responseFor=result=>{if(!formatted.has(result))formatted.set(result,scope?.own?scope.own(formatCandidate(result)):formatCandidate(result));return formatted.get(result);};
        const formatCandidate=async result=> {
          const {song,api,target}=result;
          const lyrics=cleanLyrics(result.lyrics,{duration:song.duration,title:song.title,artist:song.artist,catalogID:catalog_id});
          const cacheable=result.timingCorrection?.status!=='untimed_fallback';
          const languageDetails=analyzeLyricLanguageFn(lyrics.lines.map(line=>line.text || ''),{genres:resolution?.genres??[],verified:Boolean(resolution)});
          const response=await measure('romanize',async()=> {
            const script=lyrics.instrumental ? searchScript : language || (dependencies.detectLanguageFn ? await detectLanguageFn(lyrics.lines.map(line=>line.text || '').join('\n')) : languageDetails.primary);
            const system=romanization_system || (language || dependencies.detectLanguageFn ? getDefaultRomanizationSystemFn(script) : getDefaultRomanizationSystemFn(languageDetails.pronunciation_language));
            const processor=system==='none'?null:getProcessorFn(script);
            const romanize=async text=>processor && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Cyrillic}]/u.test(text)
              ? processor.romanize(text,system,options):{romanized:text};
            const [romanizedTitle,romanizedArtist,lines]=await Promise.all([
              romanize(song.title),romanize(song.artist),Promise.all(lyrics.lines.filter(line=>line.text?.trim()).map(async line=>({original:line.text,romanized:(await romanize(line.text)).romanized,timestamp:Number.isFinite(line.timestamp) && line.timestamp>=0 ? line.timestamp:null,...(line.vocalTiming?{vocalTiming:line.vocalTiming}:{})})))
            ]);
            return formatMusicResponseFn({...song,source:api.name},{title:romanizedTitle.romanized,artist:romanizedArtist.romanized,language:script,system,lines});
          });
          if(!response)return null;
          response.song.album=song.album ?? null;response.song.duration=song.duration ?? null;
          response.metadata.version=RESPONSE_VERSION;
          response.metadata.acquisition_started_at=acquisitionStartedAt;
          response.metadata.language_details=languageDetails;
          response.metadata.timing_quality=timingQuality(result);
          if(resolution) {
            const {searches,genres,artist_entities,...proof}=resolution;
            response.metadata.catalog_resolution=proof;
          }
          response.metadata.lyric_structure=lyrics.lyricStructure;
          response.song_details={catalog_id:catalog_id??null,source_id:String(song.id),source:song.source??api.name,credits:lyrics.credits??[]};
          if(lyrics.providerTranslation) response.provider_translation=lyrics.providerTranslation;
          if(cacheable) response.metadata.selection_revision=SELECTION_REVISION;
          response.quality.instrumental=lyrics.instrumental===true;
          response.quality.partial=lyrics.partial===true;
          response.quality.synced=response.quality.synced && timingQuality(result).usable;
          response.metadata.word_timing_upgrade_supported=!lyrics.instrumental&&!lyrics.partial&&result.timingCorrection?.status!=='replacement'
            &&(preferred?preferred.supportsVocalTiming===true:apis.some(a=>a.supportsVocalTiming===true));
          if(result.timingCorrection) response.metadata.timing_correction=result.timingCorrection;
          if(result.reviewedIdentity) response.metadata.reviewed_recording=result.reviewedIdentity;
          if(target!==request) response.metadata.recording_match={method:catalog_id ? 'catalog_alias':'metadata_alias',catalog_id:catalog_id || target.catalog_id,artist,title,duration,...(!catalog_id ? {album}:{})};
          if(target===request && !sameRecordingNames(song,request)) {
            const method=result.timingCorrection?.status==='replacement' && !metadataEquivalence(song,request) ? 'catalog_alias':'metadata_equivalence';
            response.metadata.recording_match={method,catalog_id,artist,title,album,duration};
          }
          if(lyrics.timingSource)publicRawLyrics(response);
          attachVocalTiming(response,lyrics,{provider:'appleMusic',recordingID:catalog_id,sourceID:song.id});
          scope?.signal.throwIfAborted();
          return response;
        };
        let publishedCandidate=null;
        publishCandidate=async candidate=> {
          if(!scope || chooseLyricCandidate(publishedCandidate,candidate)!==candidate)return;
          const response=await responseFor(candidate);
          if(response?.song&&chooseLyricCandidate(publishedCandidate,candidate)===candidate){publishedCandidate=candidate;scope.publish(response,{requestID,serverTiming:timings.join(', ')});}
        };
        const reviewedFirst=async()=>{
        // Reviewed cross-catalog metadata is only an exact-ID discovery path.
        // The helper rechecks complete catalog and source signatures before
        // returning any provider words; ordinary mismatches stay strict.
        let result=!preferred ? await measure('reviewed_recording',()=>withDeadline(async signal=> {
          const candidate=await lookupListeningReviewedRecordingFn(request,{signal}) ?? await lookupReviewedRecordingFn(request,{signal});
          return candidate ? applyTimingCorrectionFn(candidate,request,{signal,deadline}):null;
        },Math.min(reviewedTimeoutMs,Math.max(1,deadline-Date.now())),scope?.signal)).catch(()=>null):null;
        if(!result && !preferred) result=await measure('official_transcription',()=>withDeadline(
          signal=>lookupOfficialTranscriptionFn(request,{signal,diagnose:event=>logger.info?.('official_transcription',{requestID,...event})}),Math.min(providerTimeoutMs,Math.max(1,deadline-Date.now())),scope?.signal)).catch(()=>null);
        return result;
        };
        const lookupResolved=async(reviewed)=>{
        let result=reviewed;
        if(result)await publishCandidate(result);
        const searches=preferred ? [request,...aliases] : resolution?.searches ?? [request,...aliases];
        const firstSearch=searches[0],originalFirst=firstSearch&&firstSearch.artist===artist&&firstSearch.title===title&&firstSearch.album===album&&firstSearch.catalog_id===catalog_id;
        // A held probe must never occupy a third slot while another spelling
        // starts its two-source hedge. Only the first admitted target adopts it.
        if(speculation&&!originalFirst){speculation.discarded=true;speculation.cancel();await speculation.promise;}
        const queryLimit=4-(speculation?.discarded?1:0);
        for(const target of searches.slice(0,queryLimit)) {
          if(!mayImprove(result) || deadline<=Date.now())break;
          // Preserve object identity for an exact original query and its proof.
          const original=target.artist===artist&&target.title===title&&target.album===album&&target.catalog_id===catalog_id;
          result=better(result,await tryRecording(original?request:target));
        }
        scope?.signal.throwIfAborted();
        if(result) {
          const {song,api,target}=result;
          const response=await responseFor(result);
          scope?.signal.throwIfAborted();
          if(!response)return {status:400,body:{error:'Script is not supported for romanization'}};
          const cacheable=result.timingCorrection?.status!=='untimed_fallback';
          const languageDetails=response.metadata.language_details;
          if(cacheable&&verifiedContext)contexts.save(contexts.hint(verifiedContext,result,acquisitionStartedAt));
          diagnose(api.name,target===request ? 'matched':'catalog_alias');
          if(cacheable) saveNewest(responseCache,key,response,responseLifetimeMs(response));
          if(cacheable && canonicalKey)saveNewest(canonicalCache,canonicalKey,response,responseLifetimeMs(response));
          logger.info?.('lyrics_resolution',{requestID,method:resolution?.method??'provider_metadata',
            territories:resolution?.catalog_items?.length??0,language:languageDetails.primary,
            pronunciation:languageDetails.pronunciation_language,timing:response.quality.synced?'timed':'plain',partial:response.quality.partial});
          if(cacheable && redis && !cacheUnavailable(redis)) {
            const writeStart=performance.now();
            const write=withDeadline(()=>setCachedFn(redis,key,response,responseLifetimeMs(response)/1000),cacheTimeoutMs)
              .catch(error=>suspendCache(redis,error))
              .finally(()=>logger.info?.('lyrics_cache_write',{requestID,duration_ms:Math.round(performance.now()-writeStart)}));
            waitUntilFn(write);
          }
          return {status:200,body:response,selectedCandidate:result};
        }
        if(timedOut) return {status:504,body:{error:'Lyrics providers timed out',code:'provider_timeout'}};
        if(unavailable) return {status:502,body:{error:'Lyrics providers are unavailable',code:'provider_unavailable'}};
        if(mismatch) return {status:409,body:{error:'Could not verify the requested recording',code:'recording_mismatch'}};
        if(matched) return {status:404,body:{error:'Lyrics not found',code:'lyrics_absent'}};
        return {status:404,body:{error:'Song not found',details:`Tried ${apis.map(api=>api.name).join(', ')}`}};
        };
        const reviewed=await reviewedFirst();
        if(reviewed||!canonicalWorkKey){
          if(reviewed&&speculation){speculation.discarded=true;speculation.cancel();await speculation.promise;}
          return await lookupResolved(reviewed);
        }
        const outer=req.lyricDelivery;
        const publishBound=(response,diagnostics)=>{
          if(lyricSourceNeedsRefresh(response,request))return;
          outer?.publish(bind(structuredClone(response)),diagnostics);
        };
        // A joining reader discards its own optional probe before it can join
        // another owner's provider budget or cancellation domain.
        if(sourceAcquisitions.owners.has(canonicalWorkKey)&&speculation){speculation.discarded=true;speculation.cancel();await speculation.promise;}
        const shared=await measure('shared_source',()=>sourceAcquisitions.join(canonicalWorkKey,{signal:outer?.signal,deadlineAtMS:deadline,onSnapshot:publishBound,start:async owned=>{
          scope=owned;
          if(speculation&&!speculation.discarded)speculation.transfer(owned.signal);
          try{return await lookupResolved(null);}finally{if(speculation){speculation.cancel();await speculation.promise;speculation.dispose();}}
        }}));
        logger.info?.('lyrics_shared_source',{requestID,sourceAcquisitionID:shared.sourceAcquisitionID,httpAcquisitionID:outer?.acquisitionID??null,joined:shared.joined,deadlineAtMS:shared.deadlineAtMS});
        const result=shared.result;
        if(result.status===200){
          if(lyricSourceNeedsRefresh(result.body,request))return {status:409,body:{code:'recording_mismatch'}};
          const body=bind(structuredClone(result.body));
          if(shared.joined)cacheStatus='RECORDING_COALESCED';
          if(result.selectedCandidate&&verifiedContext)contexts.save(contexts.hint(verifiedContext,result.selectedCandidate,result.body.metadata.acquisition_started_at));
          if(shared.joined&&result.body.metadata.selection_revision===SELECTION_REVISION){
            saveNewest(responseCache,key,body,remainingLifetimeMs(body));
            if(redis&&!cacheUnavailable(redis))waitUntilFn(withDeadline(()=>setCachedFn(redis,key,body,remainingLifetimeMs(body)/1000),cacheTimeoutMs).catch(error=>suspendCache(redis,error)));
          }
          return {...result,body};
        }
        return result;
       }finally{if(speculation&&!speculation.transferred){speculation.cancel();await speculation.promise;speculation.dispose();}}
      };
      const task=compute();inflight.set(inflightKey,task);
      try { return send(await task); } finally { inflight.delete(inflightKey); }
    } catch(error) {
      logger.error('Music romanization failed',error.message);
      return send({status:500,body:{error:'Server error'}});
    }
  },{waitUntilFn});
}
export function createMusicRomanizeHandler(dependencies={}) {
  return withAppAuth(createMusicRomanizeService(dependencies),{...dependencies,route:'music'});
}
export default createMusicRomanizeHandler();
