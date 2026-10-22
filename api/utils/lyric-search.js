import chinese from 'chinese-conv';
import {fetchJSON,withDeadline} from './fetch-json.js';
import {LRCAPI} from '../music-apis/lrclib.js';
import {NeteaseAPI} from '../music-apis/netease.js';
import {KugouAPI} from '../music-apis/kugou.js';
import {cleanLyrics} from './lyric-quality.js';
import {validLyricStructure} from './lyric-annotations.js';
import {sameSpotifyRecordingNames,normalizeRecordingText} from './recording-match.js';
import {isRejectedLyrics,isRejectedRecordingLyrics} from './rejected-lyrics.js';
import {validVocalTiming} from './vocal-timing.js';

// Discovery is deliberately separate from recording verification. These source
// capsules never become Song Library documents or playback identities.
const neteaseOrigin='https://netease-cloud-music-api-gules-mu.vercel.app';
const text=(value,max=500)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
const sourceID=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(k=>allowed.includes(k));
const finiteDuration=value=>Number.isFinite(value)&&value>0&&value<=86400;
const validHints=h=>h===undefined||(keys(h,['title','artist','artists','album','duration','spotifyItemID','catalogID'])&&text(h.title)&&text(h.artist,1024)
  &&(h.album===undefined||text(h.album,1024))&&(h.duration===undefined||finiteDuration(h.duration))
  &&(h.artists===undefined||(Array.isArray(h.artists)&&h.artists.length>0&&h.artists.length<=32&&h.artists.every(a=>text(a,1024))))
  &&(h.spotifyItemID===undefined||typeof h.spotifyItemID==='string'&&/^[A-Za-z0-9]{22}$/.test(h.spotifyItemID))
  &&(h.catalogID===undefined||sourceID(h.catalogID)));
const rejectionContext=h=>({...h?.spotifyItemID?{recordingProvider:'spotify',recordingItemID:h.spotifyItemID}:{},catalog_id:h?.catalogID});
function similarity(a,b) {
  const x=normalizeRecordingText(a??''),y=normalizeRecordingText(b??'');
  if(!x||!y)return 0;if(x===y)return 1;
  const parts=s=>new Set(Array.from(s).slice(0,-1).map((c,i)=>c+Array.from(s)[i+1]));
  const left=parts(x),right=parts(y);
  return left.size+right.size?2*[...left].filter(v=>right.has(v)).length/(left.size+right.size):0;
}
function score(candidate,hints) {
  if(!hints)return 0;
  const namesMatch=sameSpotifyRecordingNames({...candidate,creditedArtistNames:candidate.artists},
    {title:hints.title,artist:hints.artist,creditedArtistNames:hints.artists??[hints.artist]});
  const delta=finiteDuration(hints.duration)&&finiteDuration(candidate.duration)?Math.abs(candidate.duration-hints.duration):null;
  const duration=delta===null?0.5:1/(1+delta/10);
  return {namesMatch,durationMatches:delta!==null&&delta<=3,
    score:4*similarity(candidate.title,hints.title)+4*similarity(candidate.artist,hints.artist)+duration
      +(hints.album&&candidate.album?0.5*similarity(candidate.album,hints.album):0)+(candidate.lines?.length?0.5:0)};
}
const rank=(candidate,hints)=>({...candidate,...(hints?score(candidate,hints):{namesMatch:false,durationMatches:false,score:0})});
const lrclib=new LRCAPI(),netease=new NeteaseAPI(),kugou=new KugouAPI();
const sourceLines=(lyrics,duration=7200)=>{
  const lines=lyrics?.lines?.map(l=>({text:l.text,...(Number.isFinite(l.timestamp)&&l.timestamp>=0?{timestamp:l.timestamp}:{})}));
  if(!lines?.length||lines.length>250||lines.some(l=>!text(l.text,4000))||Buffer.byteLength(JSON.stringify(lines))>180000)return null;
  const timed=lines.map((l,i)=>({...l,...(validVocalTiming(lyrics.lines[i],{duration})?{vocalTiming:lyrics.lines[i].vocalTiming}:{})}));
  // Optional cues cannot turn a readable transcription into an oversized miss.
  return Buffer.byteLength(JSON.stringify(timed))<=180000?timed:lines;
};
// Only canonical, row-bound cue evidence is additive preview metadata. Keep
// the exact same evidence through selected admission; a public speaker ID alone
// never protects words that resemble metadata.
const sourceEvidence=(lyrics,lines)=>validLyricStructure(lyrics?.lyricStructure,lines.map(l=>({original:l.text})))
  &&lyrics.lyricStructure.occurrences.some(o=>o.sourcePrefix)?{lyricStructure:structuredClone(lyrics.lyricStructure)}:{};
function fromLRCLIB(raw,hints) {
  if(!raw||!sourceID(String(raw.id))||!text(raw.trackName)&&!text(raw.name)||!text(raw.artistName,1024))return null;
  const lyrics=lrclib.lyricsFromRecord(raw,rejectionContext(hints)),lines=sourceLines(lyrics);if(!lines)return null;
  return {provider:'lrclib',itemID:String(raw.id),title:raw.trackName??raw.name,artist:raw.artistName,
    ...(text(raw.albumName,1024)?{album:raw.albumName}:{}),...(finiteDuration(raw.duration)?{duration:raw.duration}:{}),lines,...sourceEvidence(lyrics,lines)};
}
function fromNetEase(raw) {
  const artists=raw?.artists??raw?.ar;
  if(!raw||!sourceID(String(raw.id))||!text(raw.name)||!Array.isArray(artists)||!artists.length||artists.length>32||artists.some(a=>!text(a.name,1024)))return null;
  const duration=(raw.duration??raw.dt)/1000,album=(raw.album??raw.al)?.name;
  return {provider:'netease',itemID:String(raw.id),title:raw.name,artist:artists.map(a=>a.name).join(' & '),artists:artists.map(a=>a.name),
    ...(text(album,1024)?{album}:{}),...(finiteDuration(duration)?{duration}:{})};
}
async function searchLRCLIB(query,hints,signal) {
  const queries=[{q:query}];
  if(hints&&normalizeRecordingText(query).includes(normalizeRecordingText(hints.title)))
    queries.push(...[...new Set([chinese.sify(hints.title),chinese.tify(hints.title)])].map(track_name=>({track_name})));
  const pages=await Promise.allSettled(queries.slice(0,3).map(params=>fetchJSON('https://lrclib.net/api/search?'+new URLSearchParams(params),{signal})));
  if(pages.every(p=>p.status==='rejected'))throw new Error('provider_unavailable');
  return pages.flatMap(p=>p.status==='fulfilled'&&Array.isArray(p.value)?p.value.slice(0,100):[]);
}
async function searchNetEase(query,_hints,signal) {
  const page=await fetchJSON(neteaseOrigin+'/search?'+new URLSearchParams({keywords:chinese.sify(query),limit:'30'}),{signal});
  if(page.code!==200||!Array.isArray(page.result?.songs))throw new Error('provider_unavailable');
  return page.result.songs.slice(0,30);
}
async function previewLRCLIB(id,signal) {return fetchJSON('https://lrclib.net/api/get/'+id,{signal});}
async function previewNetEase(id,signal) {
  const page=await fetchJSON(neteaseOrigin+'/song/detail?ids='+id,{signal});
  const raw=page.code===200&&page.songs?.length===1?page.songs[0]:null;
  const candidate=fromNetEase(raw);if(!candidate||candidate.itemID!==id)return null;
  const lyrics=cleanLyrics(await netease.getLyrics(id,{signal,song:candidate}),{title:candidate.title,artist:candidate.artist,duration:candidate.duration});
  const lines=sourceLines(lyrics,candidate.duration);return lines?{...candidate,lines,...sourceEvidence(lyrics,lines)}:null;
}
async function searchKugou(query,hints,signal) {return kugou.searchLyrics(query,{signal,duration:hints?.duration});}
const fromKugou=raw=>raw&&sourceID(String(raw.id))&&text(raw.title)&&text(raw.artist,1024)&&finiteDuration(raw.duration)
  ?{provider:'kugou',itemID:String(raw.id),title:raw.title,artist:raw.artist,duration:raw.duration}:null;
async function previewKugou(id,signal,context) {
  const raw=await kugou.previewLyrics(id,context.query,{signal,duration:context.hints?.duration});
  const candidate=fromKugou(raw),lines=sourceLines(raw?.lyricsData,raw?.duration);
  return candidate&&lines?{...candidate,lines,...sourceEvidence(raw.lyricsData,lines)}:null;
}

/// Shared by explicit learning-source admission and the independent preview API.
/// Returned words/labels come from fixed providers, never caller supplied text.
export function createLyricSourceLoader(dependencies={}) {
  const previews={lrclib:dependencies.previewLRCLIB??previewLRCLIB,netease:dependencies.previewNetEase??previewNetEase,kugou:dependencies.previewKugou??previewKugou};
  return async({provider,itemID,query,hints},signal)=>{
    if(!Object.hasOwn(previews,provider)||!sourceID(itemID)||!validHints(hints)
      ||(query!==undefined&&!text(query))||(provider==='kugou'&&!text(query)))return null;
    const raw=await previews[provider](itemID,signal,{query,hints});
    const candidate=provider==='lrclib'?fromLRCLIB(raw,hints):raw;
    if(!candidate||candidate.provider!==provider||candidate.itemID!==itemID||!text(candidate.title)||!text(candidate.artist,1024))return null;
    const lines=sourceLines({lines:candidate.lines},candidate.duration);
    if(!lines||isRejectedLyrics(provider,itemID,lines)||isRejectedRecordingLyrics(lines,rejectionContext(hints))
      ||(candidate.lyricStructure&&!validLyricStructure(candidate.lyricStructure,lines.map(l=>({original:l.text})))))return null;
    return {provider,itemID,title:candidate.title,artist:candidate.artist,
      ...(text(candidate.album,1024)?{album:candidate.album}:{}),
      ...(finiteDuration(candidate.duration)?{duration:candidate.duration}:{}),
      ...(Array.isArray(candidate.artists)&&candidate.artists.length<=32&&candidate.artists.every(a=>text(a,1024))?{artists:candidate.artists}:{}),lines,...sourceEvidence(candidate,lines)};
  };
}
export function createLyricSearchService(dependencies={}) {
  const searchers={lrclib:dependencies.searchLRCLIB??searchLRCLIB,netease:dependencies.searchNetEase??searchNetEase,kugou:dependencies.searchKugou??searchKugou};
  const loadSource=createLyricSourceLoader(dependencies);
  const timeout=dependencies.searchTimeoutMs??5000;
  return async(req,res)=>{
    res.setHeader('Cache-Control','private, no-store');
    const body=req.body,fail=()=>res.status(400).json({version:1,code:'invalid_request'});
    if(req.method!=='POST'||!object(body))return fail();
    if(body.action==='search_lyrics') {
      const providers=body.providers??['lrclib','netease'];
      if(!keys(body,['action','query','hints','providers'])||!text(body.query)||!validHints(body.hints)
        ||!Array.isArray(providers)||!providers.length||providers.length>3||new Set(providers).size!==providers.length
        ||providers.some(p=>!Object.hasOwn(searchers,p)))return fail();
      const pages=await Promise.all(providers.map(async provider=>{
        const search=searchers[provider];
        try {const raw=await withDeadline(signal=>search(body.query,body.hints,signal),timeout);
          return {provider,candidates:(Array.isArray(raw)?raw:[]).slice(0,300).map(r=>provider==='lrclib'?fromLRCLIB(r,body.hints):provider==='kugou'?fromKugou(r):fromNetEase(r)).filter(Boolean)};
        }catch{return {provider,candidates:[],failed:true};}
      }));
      const unavailable=pages.filter(p=>p.failed).map(p=>p.provider);
      if(unavailable.length===pages.length)return res.status(502).json({version:1,code:'provider_unavailable'});
      const unique=new Map();
      for(const candidate of pages.flatMap(p=>p.candidates))unique.set(candidate.provider+':'+candidate.itemID,rank(candidate,body.hints));
      const candidates=[...unique.values()].sort((a,b)=>b.score-a.score||a.provider.localeCompare(b.provider)||a.itemID.localeCompare(b.itemID,'en',{numeric:true})).slice(0,20);
      // Keep metadata choices even when several complete transcriptions exceed
      // the transport budget; those words can be requested explicitly later.
      let bytes=0;for(const c of candidates){bytes+=Buffer.byteLength(JSON.stringify(c));if(bytes>500000){delete c.lines;delete c.lyricStructure;}}
      return res.status(200).json({version:1,candidates,unavailable});
    }
    if(body.action==='preview_lyrics') {
      if(!keys(body,['action','provider','itemID','hints','query'])||!Object.hasOwn(searchers,body.provider)||!sourceID(body.itemID)||!validHints(body.hints)
        ||(body.query!==undefined&&!text(body.query))||(body.provider==='kugou'&&!text(body.query)))return fail();
      try {
        const candidate=await withDeadline(signal=>loadSource(body,signal),timeout);
        if(!candidate)
          return res.status(404).json({version:1,code:'lyrics_absent'});
        return res.status(200).json({version:1,candidate});
      }catch{return res.status(502).json({version:1,code:'provider_unavailable'});}
    }
    return fail();
  };
}
