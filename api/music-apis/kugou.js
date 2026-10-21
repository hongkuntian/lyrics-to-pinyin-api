import fetch from 'node-fetch';
import chinese from 'chinese-conv';
import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {cleanLyrics} from '../utils/lyric-quality.js';
import {decodeKRC,parseKRC} from '../utils/kugou-krc.js';
import {sameRecordingNames,recordingScore,findRecording,RecordingMismatchError,normalizeRecordingText,searchTitle} from '../utils/recording-match.js';
import {simplifyRecordingScript} from '../utils/recording-script.js';

const origin='https://lyrics.kugou.com';
const maxBytes=512*1024;
const official='官方推荐歌词';
const albumVersionMarkers=[
  /\blive\b|\bconcert\b|现场|演唱会/iu,
  /\bremaster(?:ed)?\b|重制/iu,
  /\binstrumental\b|纯音乐|器乐/iu,
  /\bkaraoke\b|伴奏|卡拉\s*ok/iu,
  /\bremix\b|混音/iu,
  /\bdemo\b|概念版|小样/iu,
  /\bacoustic\b|不插电/iu,
  /\ba[ -]?cap(?:p)?ella\b|清唱/iu,
  /\bedit\b|剪辑版/iu,
  /\bmix\b/iu,
  /\bcover\b|翻唱/iu,
  /\breprise\b/iu,
  /\bversion\b|版本/iu
];
function preservesAlbumVersion(song,request) {
  const album=chinese.sify(request.album || '').normalize('NFKC');
  const candidate=chinese.sify(song.title).normalize('NFKC');
  // This provider has no authoritative album metadata. Every explicit version
  // mentioned only on the requested album must also be established by the
  // independently matching candidate title; unknown album evidence is not a match.
  return albumVersionMarkers.every(marker=>!marker.test(album) || marker.test(candidate));
}
function cancelled(signal) {
  if(signal?.aborted) throw Object.assign(new Error('Lookup cancelled'),{name:'AbortError'});
}
function providerError() { return new Error('Kugou provider unavailable'); }
async function requestJSON(path,params,context) {
  cancelled(context.signal);
  const url=new URL(path,origin);
  for(const [name,value] of Object.entries(params)) url.searchParams.set(name,String(value));
  const transport=context.fetchFn || fetch;
  try {
    const data=await fetchJSON(url.toString(),{...context,fetchFn:async(address,init)=>{
      cancelled(init.signal);
      const response=await transport(address,{...init,redirect:'error',size:maxBytes});
      if(response.url && new URL(response.url).origin!==origin) throw providerError();
      if(Number(response.headers?.get?.('content-length'))>maxBytes) throw providerError();
      return response;
    }});
    cancelled(context.signal);
    if(!data || typeof data!=='object' || Array.isArray(data) || Buffer.byteLength(JSON.stringify(data))>maxBytes || data.status!==200) throw providerError();
    return data;
  } catch(error) {
    // Download URLs contain a per-candidate capability. Never expose transport
    // error messages or causes that may include that URL.
    if(error.name==='AbortError' || context.signal?.aborted) throw Object.assign(new Error('Lookup cancelled'),{name:'AbortError'});
    throw providerError();
  }
}
function header(text,song) {
  const parts=text.normalize('NFKC').split(/\s+[-–—]\s+/u);
  if(parts.length!==2) return false;
  const title=value=>normalizeRecordingText(value.replace(/\s*\(正式版\)\s*$/u,''));
  const artist=value=>normalizeRecordingText(value);
  const expectedTitle=title(song.title),expectedArtist=artist(song.artist);
  return (title(parts[0])===expectedTitle && artist(parts[1])===expectedArtist)
    || (artist(parts[0])===expectedArtist && title(parts[1])===expectedTitle);
}
function validateHeaders(raw,song) {
  for(const match of raw.matchAll(/^\s*\[(ar|ti):([^\]\r\n]*)\]\s*$/gim)) {
    const value=match[2].trim();
    if(value && !sameRecordingNames({...song,[match[1].toLowerCase()==='ar' ? 'artist':'title']:value},song)) throw new RecordingMismatchError();
  }
}
function lyricsBody(data,song) {
  const encoded=data.content;
  if(typeof encoded!=='string' || !encoded || encoded.length>maxBytes || encoded.length%4!==0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw providerError();
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length>maxBytes || bytes.toString('base64')!==encoded) throw providerError();
  let raw;
  try { raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { throw providerError(); }
  if(raw.includes('\u0000')) throw providerError();
  validateHeaders(raw,song);
  const parsed=parseLRC(raw);
  if(parsed.some(line=>line.timestamp!=null && (!Number.isFinite(line.timestamp) || line.timestamp<0 || line.timestamp>song.duration))) throw new RecordingMismatchError();
  const result=cleanLyrics({lines:parsed.filter(line=>!header(line.text,song)),source:'kugou',songId:song.id},{duration:song.duration});
  if(!result?.lines.length) throw new RecordingMismatchError();
  return result;
}

async function fetchLyrics(entry,context) {
  const params={ver:1,client:'pc',id:entry.song.id,accesskey:entry.key,charset:'utf8'};
  try {
    const data=await requestJSON('/download',{...params,fmt:'krc'},context);
    // An explicitly returned readable sibling needs no duplicate download.
    if(data.fmt==='lrc')return lyricsBody(data,entry.song);
    const raw=decodeKRC(data.content);
    if(raw!==null) {
      validateHeaders(raw,entry.song);
      const parsed=parseKRC(raw,{songId:entry.song.id,duration:entry.song.duration});
      if(parsed) {
        const result=cleanLyrics({...parsed,lines:parsed.lines.filter(l=>!header(l.text,entry.song))},
          {duration:entry.song.duration,title:entry.song.title,artist:entry.song.artist});
        if(result?.lines.length)return result;
      }
    }
  }catch(error){
    if(error.name==='AbortError'||context.signal?.aborted||error.code==='recording_mismatch')throw error;
  }
  cancelled(context.signal);
  return lyricsBody(await requestJSON('/download',{...params,fmt:'lrc'},context),entry.song);
}

// Every best-ranked metadata tie must be inspected before admitting a source.
// A small worker pool avoids the old >3 duplicate rejection without issuing an
// unbounded burst. Caller cancellation/deadline covers the complete operation.
async function hydrateEquivalent(entries,context) {
  cancelled(context.signal);
  let next=0,failure=null,signature=null,rejectFailure;
  const controller=new AbortController(),abort=()=>controller.abort();
  context.signal?.addEventListener('abort',abort,{once:true});
  const failed=new Promise((_,reject)=>{rejectFailure=reject;});
  const local={...context,signal:controller.signal};
  const workers=Array.from({length:Math.min(3,entries.length)},async()=>{
    while(next<entries.length&&!failure) {
      const entry=entries[next++];
      try {
        cancelled(local.signal);
        entry.song.lyricsData=await fetchLyrics(entry,local);
        const current=JSON.stringify(entry.song.lyricsData.lines.map(l=>[l.timestamp??null,l.text,l.vocalTiming??null]));
        if(signature!==null&&signature!==current)throw new RecordingMismatchError();
        signature=current;
      }catch(error){if(!failure){failure=error;rejectFailure(error);controller.abort();}}
    }
  });
  try { await Promise.race([Promise.all(workers),failed]); }
  finally { context.signal?.removeEventListener('abort',abort); }
}

// Manual discovery deliberately does not claim recording equivalence. Provider
// download capabilities live only within this call and never reach a client.
async function lyricCandidates(query,context={}) {
  if(typeof query!=='string'||!query.trim()||query.length>500)throw providerError();
  const data=await requestJSON('/search',{ver:1,man:'yes',client:'pc',keyword:simplifyRecordingScript(query),
    ...(Number.isFinite(context.duration)&&context.duration>0?{duration:Math.round(context.duration*1000)}:{})},context);
  if(!Array.isArray(data.candidates)||data.candidates.length>100)throw providerError();
  const records=new Map();
  for(const raw of data.candidates) {
    if(!raw||!/^\d{1,20}$/.test(String(raw.id??''))||String(raw.id).startsWith('0')
      ||typeof raw.song!=='string'||!raw.song.trim()||raw.song.length>500
      ||typeof raw.singer!=='string'||!raw.singer.trim()||raw.singer.length>1024
      ||!Number.isFinite(raw.duration)||raw.duration<=0||raw.duration>7200000
      ||typeof raw.accesskey!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(raw.accesskey))continue;
    const song={source:'kugou',id:String(raw.id),title:raw.song,artist:raw.singer,duration:raw.duration/1000};
    const existing=records.get(song.id);
    if(existing&&(JSON.stringify(existing.song)!==JSON.stringify(song)||existing.key!==raw.accesskey))throw providerError();
    records.set(song.id,{song,key:raw.accesskey});
  }
  return records;
}

export class KugouAPI extends BaseMusicAPI {
  constructor() { super('KugouAPI',['zh','en','yue','ja','ko','ru']); this.supportsVocalTiming=true; this.languageAgnosticDiscovery=true; }
  supportsLanguage(language) { return typeof language==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(language); }
  async searchLyrics(query,context={}) {
    return [...(await lyricCandidates(query,context)).values()].map(entry=>entry.song);
  }
  async previewLyrics(id,query,context={}) {
    if(!/^[1-9]\d{0,19}$/.test(String(id)))throw providerError();
    const entry=(await lyricCandidates(query,context)).get(String(id));
    if(!entry)return null;
    return {...entry.song,lyricsData:await fetchLyrics(entry,context)};
  }
  async searchSong(artist,title,context={}) {
    cancelled(context.signal);
    if(!Number.isFinite(context.duration) || context.duration<=0) return null;
    const request={...context,artist,title};
    const data=await requestJSON('/search',{ver:1,man:'yes',client:'pc',keyword:simplifyRecordingScript(`${artist} - ${searchTitle(title)}`),duration:Math.round(context.duration*1000)},context);
    if(!Array.isArray(data.candidates) || data.candidates.length>100) throw providerError();
    if(!data.candidates.length) return null;
    const records=new Map();
    for(const raw of data.candidates) {
      if(!raw || typeof raw!=='object' || raw.product_from!==official || typeof raw.singer!=='string' || typeof raw.song!=='string'
        || !Number.isFinite(raw.duration) || raw.duration<=0 || Math.abs(raw.duration/1000-context.duration)>1
        || !/^\d{1,20}$/.test(String(raw.id ?? '')) || typeof raw.accesskey!=='string' || !/^[A-Za-z0-9_-]{1,256}$/.test(raw.accesskey)
        || /伴奏|instrumental|karaoke/iu.test(raw.language || '')) continue;
      const song={source:'kugou',id:String(raw.id),title:raw.song,artist:raw.singer,duration:raw.duration/1000,...(typeof raw.explicit==='boolean'?{explicit:raw.explicit}:{}),...(context.recordingProvider==='spotify'?{
        ...(raw.creditedArtistNames!==undefined?{creditedArtistNames:raw.creditedArtistNames}:{}),
        ...(raw.isrc?{isrc:raw.isrc}:{})}:{})};
      if(!sameRecordingNames(song,request) || !preservesAlbumVersion(song,request) || recordingScore(song,request)<0) continue;
      const previous=records.get(song.id);
      if(previous && (JSON.stringify(previous.song)!==JSON.stringify(song) || previous.key!==raw.accesskey)) throw new RecordingMismatchError();
      records.set(song.id,{song,key:raw.accesskey,score:recordingScore(song,request)});
    }
    const ranked=[...records.values()].sort((a,b)=>b.score-a.score);
    if(!ranked.length) throw new RecordingMismatchError();
    const best=ranked.filter(entry=>Math.abs(entry.score-ranked[0].score)<1e-9);
    await hydrateEquivalent(best,context);
    return findRecording(best.map(entry=>entry.song),request);
  }
  async getLyrics(id,context={}) {
    cancelled(context.signal);
    // Search hydrates its complete bounded tie. Capabilities never escape that
    // call or persist on the provider instance, returned song, or cache record.
    return String(context.song?.id)===String(id) && context.song?.source==='kugou' ? context.song.lyricsData || null:null;
  }
}
