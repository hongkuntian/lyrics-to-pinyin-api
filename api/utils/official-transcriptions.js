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
function playerResponse(html) {
  const match=/\bytInitialPlayerResponse\s*=\s*/u.exec(html);
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
  try {
    return await withDeadline(async signal=> {
      const transport={fetchFn:context.fetchFn || fetch,signal};
      const anchor=entry.catalogAnchor;
      const params=new URLSearchParams({id:anchor.signature.catalog_id,country:anchor.storefront,lang:'en_us'});
      const catalog=JSON.parse(await boundedText(`https://itunes.apple.com/lookup?${params}`,transport));
      const anchors=(Array.isArray(catalog.results)?catalog.results:[]).filter(song=>song?.kind==='song' && matches(signature(song),anchor.signature) && close(song.trackTimeMillis/1000,request.duration));
      if(anchors.length!==1) return null;
      const source=entry.source;
      if(!/^[A-Za-z0-9_-]{11}$/.test(source.videoID) || !nonempty(source.channelID) || !/^[a-f0-9]{64}$/.test(source.paragraphSHA256)) return null;
      const url=`https://www.youtube.com/watch?v=${source.videoID}`;
      const player=playerResponse(await boundedText(url,transport)),details=player?.videoDetails;
      if(player?.playabilityStatus?.status!=='OK' || !details || details.videoId!==source.videoID
        || details.channelId!==source.channelID || details.title!==source.title
        || !/^\d+$/.test(details.lengthSeconds || '') || Number(details.lengthSeconds)!==source.duration
        || Math.abs(Number(details.lengthSeconds)-request.duration)>1 || typeof details.shortDescription!=='string'
        || details.shortDescription.length>200000) return null;
      const paragraphs=details.shortDescription.split(/\r?\n/u).filter(paragraph=>hash(paragraph)===source.paragraphSHA256);
      if(paragraphs.length!==1) return null;
      const lines=paragraphs[0].split(/[，。；！？\n]/u).map(text=>text.trim()).filter(Boolean).map(text=>({text,timestamp:null}));
      if(!lines.length) return null;
      const actual=signature(anchors[0]);
      const lyrics={lines,source:'official_description',partial:true,instrumental:false};
      const song={id:source.videoID,title:actual.title,artist:actual.artist,album:actual.album,duration:actual.duration,source:'official_description'};
      return {song,lyrics,api:{name:'OfficialDescription'},target:request,reviewedIdentity:{id:entry.id,reviewedDate:entry.reviewedDate,
        catalogID:request.catalog_id,source:'official_description',sourceID:source.videoID,sourceChannelID:source.channelID,
        sourceURL:url,paragraphSHA256:source.paragraphSHA256,provenance:entry.provenance}};
    },6000,context.signal);
  } catch {
    // Login/consent pages, changed source content, redirects and transport errors
    // all fail closed; private HTTP implementation details never escape.
    return null;
  }
}
