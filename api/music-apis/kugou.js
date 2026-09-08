import fetch from 'node-fetch';
import chinese from 'chinese-conv';
import {BaseMusicAPI} from './base.js';
import {fetchJSON} from '../utils/fetch-json.js';
import {parseLRC} from '../utils/lrc.js';
import {cleanLyrics} from '../utils/lyric-quality.js';
import {sameRecordingNames,recordingScore,findRecording,RecordingMismatchError,normalizeRecordingText,searchTitle} from '../utils/recording-match.js';

const origin='https://lyrics.kugou.com';
const maxBytes=512*1024;
const official='官方推荐歌词';
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
function lyricsBody(data,song) {
  const encoded=data.content;
  if(typeof encoded!=='string' || !encoded || encoded.length>maxBytes || encoded.length%4!==0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw providerError();
  const bytes=Buffer.from(encoded,'base64');
  if(bytes.length>maxBytes || bytes.toString('base64')!==encoded) throw providerError();
  let raw;
  try { raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes); } catch { throw providerError(); }
  if(raw.includes('\u0000')) throw providerError();
  for(const match of raw.matchAll(/^\s*\[(ar|ti):([^\]\r\n]*)\]\s*$/gim)) {
    const value=match[2].trim();
    if(value && !sameRecordingNames({...song,[match[1].toLowerCase()==='ar' ? 'artist':'title']:value},song)) throw new RecordingMismatchError();
  }
  const parsed=parseLRC(raw);
  if(parsed.some(line=>line.timestamp!=null && (!Number.isFinite(line.timestamp) || line.timestamp<0 || line.timestamp>song.duration))) throw new RecordingMismatchError();
  const result=cleanLyrics({lines:parsed.filter(line=>!header(line.text,song)),source:'kugou',songId:song.id},{duration:song.duration});
  if(!result?.lines.length) throw new RecordingMismatchError();
  return result;
}

export class KugouAPI extends BaseMusicAPI {
  constructor() { super('KugouAPI',['zh','en','yue']); }
  async searchSong(artist,title,context={}) {
    cancelled(context.signal);
    if(!Number.isFinite(context.duration) || context.duration<=0) return null;
    const request={...context,artist,title};
    const data=await requestJSON('/search',{ver:1,man:'yes',client:'pc',keyword:chinese.sify(`${artist} - ${searchTitle(title)}`),duration:Math.round(context.duration*1000)},context);
    if(!Array.isArray(data.candidates) || data.candidates.length>100) throw providerError();
    if(!data.candidates.length) return null;
    const records=new Map();
    for(const raw of data.candidates) {
      if(!raw || typeof raw!=='object' || raw.product_from!==official || typeof raw.singer!=='string' || typeof raw.song!=='string'
        || !Number.isFinite(raw.duration) || raw.duration<=0 || Math.abs(raw.duration/1000-context.duration)>1
        || !/^\d{1,20}$/.test(String(raw.id ?? '')) || typeof raw.accesskey!=='string' || !/^[A-Za-z0-9_-]{1,256}$/.test(raw.accesskey)
        || /伴奏|instrumental|karaoke/iu.test(raw.language || '')) continue;
      const song={source:'kugou',id:String(raw.id),title:raw.song,artist:raw.singer,duration:raw.duration/1000};
      if(!sameRecordingNames(song,request) || recordingScore(song,request)<0) continue;
      const previous=records.get(song.id);
      if(previous && (JSON.stringify(previous.song)!==JSON.stringify(song) || previous.key!==raw.accesskey)) throw new RecordingMismatchError();
      records.set(song.id,{song,key:raw.accesskey,score:recordingScore(song,request)});
    }
    const ranked=[...records.values()].sort((a,b)=>b.score-a.score);
    if(!ranked.length) throw new RecordingMismatchError();
    const best=ranked.filter(entry=>Math.abs(entry.score-ranked[0].score)<1e-9);
    // Inspect every tied candidate or fail closed; selecting a truncated subset
    // can hide a conflicting timeline. Provider rank is not identity evidence.
    if(best.length>3) throw new RecordingMismatchError();
    await Promise.all(best.map(async entry=> {
      const response=await requestJSON('/download',{ver:1,client:'pc',id:entry.song.id,accesskey:entry.key,fmt:'lrc',charset:'utf8'},context);
      entry.song.lyricsData=lyricsBody(response,entry.song);
    }));
    const signature=song=>JSON.stringify(song.lyricsData.lines.map(line=>[line.timestamp ?? null,line.text]));
    if(best.some(entry=>signature(entry.song)!==signature(best[0].song))) throw new RecordingMismatchError();
    return findRecording(best.map(entry=>entry.song),request);
  }
  async getLyrics(id,context={}) {
    cancelled(context.signal);
    // Search hydrates its complete bounded tie. Capabilities never escape that
    // call or persist on the provider instance, returned song, or cache record.
    return String(context.song?.id)===String(id) && context.song?.source==='kugou' ? context.song.lyricsData || null:null;
  }
}
