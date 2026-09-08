import fetch from 'node-fetch';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {withDeadline} from './fetch-json.js';
import {normalizeRecordingText,recordingNames} from './recording-match.js';

const require=createRequire(import.meta.url);
function freeze(value) {
  if(value && typeof value==='object') {Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}
// Literal JSON require keeps the metadata-only registry in cloud bundles.
const productionRegistry=freeze(require('../data/official-transcriptions.json'));
const maxBytes=5*1024*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const nonempty=value=>typeof value==='string' && !!value.trim();
const close=(a,b)=>Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b)<=0.5;
function matches(actual,expected) {
  return /^\d{1,20}$/.test(actual.catalog_id || '') && actual.catalog_id===expected.catalog_id
    && ['title','artist','album'].every(key=>nonempty(actual[key]) && nonempty(expected[key]))
    && normalizeRecordingText(actual.title)===normalizeRecordingText(expected.title)
    && normalizeRecordingText(actual.album)===normalizeRecordingText(expected.album)
    && JSON.stringify(recordingNames(actual).credits)===JSON.stringify(recordingNames(expected).credits)
    && close(actual.duration,expected.duration);
}
function signature(song) {
  return {catalog_id:String(song.trackId),title:song.trackName,artist:song.artistName,album:song.collectionName,
    duration:Number.isFinite(song.trackTimeMillis) ? song.trackTimeMillis/1000:null};
}
function playerResponse(html,initialData=false) {
  const match=(initialData ? /\bytInitialData\s*=\s*/u : /\bytInitialPlayerResponse\s*=\s*/u).exec(html);
  if(!match || html[match.index+match[0].length]!=='{') return null;
  const start=match.index+match[0].length;
  let depth=0,quoted=false,escaped=false;
  for(let i=start;i<html.length;i++) {
    const char=html[i];
    if(quoted) {
      if(escaped) escaped=false;
      else if(char==='\\') escaped=true;
      else if(char==='"') quoted=false;
    } else if(char==='"') quoted=true;
    else if(char==='{') depth++;
    else if(char==='}' && --depth===0) return JSON.parse(html.slice(start,i+1));
  }
  return null;
}
function publicDuration(html,source) {
  const starts=[...html.matchAll(/<[^>]+\bitemtype=["']https?:\/\/schema\.org\/VideoObject["'][^>]*>/giu)];
  // An unsupported VideoObject representation is present metadata, not absent
  // metadata. Conservatively reject it rather than activating the reviewed
  // no-schema exception (including JSON-LD or a changed microdata format).
  const schemaTags=[...html.matchAll(/<[^>]+\bitemtype\s*=\s*["'][^"']*\bschema\.org\/VideoObject\b[^"']*["'][^>]*>/giu)];
  const unparsedSchemaPresent=schemaTags.length!==starts.length
    || (starts.length===0 && /\bschema\.org\/VideoObject\b/iu.test(html))
    || /["']@type["']\s*:\s*(?:["']VideoObject["']|\[[^\]]*["']VideoObject["'])/iu.test(html);
  const diagnostic={schemaCount:starts.length,unparsedSchemaPresent,identifierMatches:false,urlMatches:false,durationCount:0,parsedDuration:null,duration:null};
  if(starts.length!==1) return diagnostic;
  // Main VideoObject metadata precedes its nested author object. Do not read
  // duration or identifiers from recommendations or nested schema objects.
  const block=html.slice(starts[0].index+starts[0][0].length).split(/<span\b|<\/div>/iu)[0];
  if(block.length>8192) return diagnostic;
  const attr=(tag,name)=>new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`,'iu').exec(tag)?.[2];
  const metas=[...block.matchAll(/<(?:meta|link)\b[^>]*>/giu)].map(match=>match[0]);
  const values=name=>metas.filter(tag=>attr(tag,'itemprop')===name).map(tag=>attr(tag,'content') ?? attr(tag,'href'));
  const ids=values('identifier'),urls=values('url'),times=values('duration');
  diagnostic.identifierMatches=ids.length===1 && ids[0]===source.videoID;
  diagnostic.urlMatches=urls.length===1 && urls[0]===`https://www.youtube.com/watch?v=${source.videoID}`;
  diagnostic.durationCount=times.length;
  const time=times.length===1 ? /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/u.exec(times[0]):null;
  diagnostic.parsedDuration=time ? Number(time[1] || 0)*3600+Number(time[2] || 0)*60+Number(time[3] || 0):null;
  if(diagnostic.identifierMatches && diagnostic.urlMatches) diagnostic.duration=diagnostic.parsedDuration;
  return diagnostic;
}
async function boundedText(url,{fetchFn=fetch,signal}) {
  if(signal.aborted) throw new Error('Cancelled');
  const response=await fetchFn(url,{signal,redirect:'error',size:maxBytes,headers:{'User-Agent':'Lyra/2.3.0'}});
  if(!response.ok || (response.url && response.url!==url) || Number(response.headers?.get?.('content-length'))>maxBytes) throw new Error('Source unavailable');
  const text=await response.text();
  if(signal.aborted || Buffer.byteLength(text)>maxBytes) throw new Error('Source unavailable');
  return text;
}

// Registry injection is internal test dependency injection, never request data.
// An unreviewed recording does not trigger a search or a network request.
export async function lookupOfficialTranscription(request,context={}) {
  if(context.signal?.aborted) return null;
  const registry=context.registry || productionRegistry;
  const entry=registry.recordings?.find(item=>matches(request,item.signature));
  if(!entry) return null;
  const diagnose=event=>{try {context.diagnose?.(event);} catch { /* Diagnostics never affect selection. */ }};
  let stage='catalog_fetch';
  try {
    return await withDeadline(async signal=> {
      const transport={fetchFn:context.fetchFn || fetch,signal};
      const anchor=entry.catalogAnchor;
      const params=new URLSearchParams({id:anchor.signature.catalog_id,country:anchor.storefront,lang:'en_us'});
      const catalogText=await boundedText(`https://itunes.apple.com/lookup?${params}`,transport);
      stage='catalog_parse';
      const catalog=JSON.parse(catalogText);
      const anchors=(Array.isArray(catalog.results)?catalog.results:[]).filter(song=>song?.kind==='song' && matches(signature(song),anchor.signature) && close(song.trackTimeMillis/1000,request.duration));
      if(anchors.length!==1) {diagnose({stage:'catalog_identity',outcome:'rejected'});return null;}
      const source=entry.source;
      if(!/^[A-Za-z0-9_-]{11}$/.test(source.videoID) || !nonempty(source.channelID) || !/^[a-f0-9]{64}$/.test(source.paragraphSHA256)) return null;
      const url=`https://www.youtube.com/watch?v=${source.videoID}`;
      stage='source_fetch';
      const html=await boundedText(url,transport);
      stage='source_parse';
      const player=playerResponse(html),details=player?.videoDetails;
      const playability=player?.playabilityStatus?.status;
      let page;
      try { page=playerResponse(html,true); } catch { /* Missing public metadata cannot establish the fallback. */ }
      const watch=page?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
      const primary=watch.find(item=>item.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
      const secondary=watch.find(item=>item.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer;
      const pageDescription=secondary?.attributedDescription?.content;
      diagnose({stage:'public_page_metadata',pagePresent:!!page,
        videoMatches:page?.currentVideoEndpoint?.watchEndpoint?.videoId===source.videoID,
        channelMatches:secondary?.owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.browseId===source.channelID,
        titleMatches:(primary?.title?.runs || []).map(run=>run.text || '').join('')===source.title,
        descriptionPresent:typeof pageDescription==='string',
        paragraphMatches:typeof pageDescription==='string' && pageDescription.split(/\r?\n/u).some(paragraph=>hash(paragraph)===source.paragraphSHA256)});
      diagnose({stage:'source_metadata',playability:['OK','LOGIN_REQUIRED','UNPLAYABLE','ERROR'].includes(playability)?playability:'OTHER',
        playerPresent:!!player,videoMatches:details?.videoId===source.videoID,channelMatches:details?.channelId===source.channelID,
        titleMatches:details?.title===source.title,durationMatches:Number(details?.lengthSeconds)===source.duration,
        descriptionPresent:typeof details?.shortDescription==='string',
        paragraphMatches:typeof details?.shortDescription==='string' && details.shortDescription.split(/\r?\n/u).some(paragraph=>hash(paragraph)===source.paragraphSHA256)});
      let description,descriptionMetadata;
      if(details && Object.keys(details).length>0) {
        // A contradictory player identity cannot be concealed by another page
        // object. Retain the original fully verified metadata path when present.
        if(playability!=='OK' || details.videoId!==source.videoID || details.channelId!==source.channelID || details.title!==source.title
          || !/^\d+$/.test(details.lengthSeconds || '') || Number(details.lengthSeconds)!==source.duration
          || Math.abs(Number(details.lengthSeconds)-request.duration)>1) return null;
        description=details.shortDescription;descriptionMetadata='player';
      } else {
        const schema=publicDuration(html,source),duration=schema.duration;
        diagnose({stage:'public_page_duration',...schema,durationMatches:Number.isFinite(duration) && duration===source.publicDuration});
        const reviewedDescriptionOnly=schema.schemaCount===0 && !schema.unparsedSchemaPresent && source.allowAbsentPublicDurationForPartialDescription===true;
        if(watch.filter(item=>item.videoPrimaryInfoRenderer).length!==1 || watch.filter(item=>item.videoSecondaryInfoRenderer).length!==1
          || page?.currentVideoEndpoint?.watchEndpoint?.videoId!==source.videoID
          || secondary?.owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.browseId!==source.channelID
          || (primary?.title?.runs || []).map(run=>run.text || '').join('')!==source.title
          || schema.unparsedSchemaPresent || !Number.isFinite(source.duration) || !Number.isFinite(source.publicDuration)
          || (!reviewedDescriptionOnly && (!Number.isFinite(duration) || duration!==source.publicDuration))
          || Math.abs(source.publicDuration-source.duration)>1 || Math.abs(source.duration-request.duration)>1) return null;
        // Cloud playback can require login while the normal public watch page
        // independently returns the official description. Read only that page;
        // no authentication, player retry, alternate client, or media request.
        // Only a reviewed registry entry may use a completely absent schema.
        // The live catalog anchor and exact public video/channel/title/paragraph
        // remain mandatory. This establishes partial words, never their timing.
        description=pageDescription;descriptionMetadata=reviewedDescriptionOnly?'reviewed_catalog_and_public_description':'public_watch_page';
      }
      if(typeof description!=='string' || description.length>200000) return null;
      const paragraphs=description.split(/\r?\n/u).filter(paragraph=>hash(paragraph)===source.paragraphSHA256);
      if(paragraphs.length!==1) return null;
      const lines=paragraphs[0].split(/[，。；！？\n]/u).map(text=>text.trim()).filter(Boolean).map(text=>({text,timestamp:null}));
      if(!lines.length) return null;
      diagnose({stage:'source_verified',outcome:'accepted'});
      const actual=signature(anchors[0]);
      const lyrics={lines,source:'official_description',partial:true,instrumental:false};
      const song={id:source.videoID,title:actual.title,artist:actual.artist,album:actual.album,duration:actual.duration,source:'official_description'};
      return {song,lyrics,api:{name:'OfficialDescription'},target:request,reviewedIdentity:{id:entry.id,reviewedDate:entry.reviewedDate,
        catalogID:request.catalog_id,source:'official_description',sourceID:source.videoID,sourceChannelID:source.channelID,
        sourceURL:url,descriptionMetadata,paragraphSHA256:source.paragraphSHA256,provenance:entry.provenance}};
    },6000,context.signal);
  } catch(error) {
    diagnose({stage,outcome:'failed',category:context.signal?.aborted || error?.name==='AbortError'?'cancelled':error?.code==='provider_timeout'?'deadline':'source_unavailable'});
    // Login/consent pages, changed source content, redirects and transport errors
    // all fail closed; private HTTP implementation details never escape.
    return null;
  }
}
