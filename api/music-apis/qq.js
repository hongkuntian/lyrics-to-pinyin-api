import fetch from 'node-fetch';
import {BaseMusicAPI} from './base.js';
import {cleanLyrics} from '../utils/lyric-quality.js';
import {parseLRC} from '../utils/lrc.js';
import {decryptQRC} from '../utils/vendor/qq-qrc-codec.js';
import {parseQRC,qrcBody} from '../utils/qq-qrc.js';
import {sameRecordingNames,sameRecordingVersions,recordingNames,normalizeRecordingText,normalizedAlbum,stripTitleDescription,recordingScore,findRecording,RecordingMismatchError,searchTitle} from '../utils/recording-match.js';
import {simplifyRecordingScript} from '../utils/recording-script.js';

const maxBytes=512*1024,legacyOrigin='https://c.y.qq.com',musicuOrigin='https://u.y.qq.com';
const comm={ct:24,cv:4747474,format:'json',inCharset:'utf-8',outCharset:'utf-8',notice:0,platform:'yqq.json',needNewCode:1,g_tk:5381,chid:'0'};
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const scalar=(v,max=500)=>typeof v==='string'&&!!v.trim()&&v.length<=max&&!/\p{Surrogate}|[\u0000-\u001f]/u.test(v);
const id=v=>((typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v))||Number.isSafeInteger(v))&&Number.isSafeInteger(Number(v))&&Number(v)>0?String(v):null;
const mid=v=>typeof v==='string'&&/^[A-Za-z0-9]{14}$/.test(v);
const providerError=()=>new Error('QQ provider unavailable');
const mismatch=()=>new RecordingMismatchError();
// Only a fresh structured detail binds display labels to these source IDs.
// Copied/serialized song properties are evidence, not alias authority.
const boundLabels=new WeakMap();
const explicitSheets=new WeakSet();
function cancelled(signal){if(signal?.aborted)throw Object.assign(new Error('Lookup cancelled'),{name:'AbortError'});}

// Fixed origins, no account headers or redirects, and bounded response streams.
async function requestJSON(url,payload,context) {
 cancelled(context.signal);const transport=context.fetchFn??fetch;
 try {
  const expected=new URL(url).origin;if(![legacyOrigin,musicuOrigin].includes(expected))throw providerError();
  const response=await transport(String(url),{signal:context.signal,redirect:'error',size:maxBytes,
   method:payload?'POST':'GET',headers:{'User-Agent':'Lyrica/2.3.0',Referer:'https://y.qq.com/',...(payload?{'Content-Type':'application/json'}:{})},
   ...(payload?{body:JSON.stringify(payload)}:{})});
  if(!response.ok||(response.url&&new URL(response.url).origin!==expected)||Number(response.headers?.get?.('content-length'))>maxBytes)throw providerError();
  let data;
  if(response.body?.[Symbol.asyncIterator]) {
   const chunks=[];let bytes=0;
   for await(const value of response.body){cancelled(context.signal);const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);bytes+=chunk.length;if(bytes>maxBytes){response.body.destroy?.();throw providerError();}chunks.push(chunk);}
   data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes)));
  }else if(typeof response.text==='function') {
   const raw=await response.text();if(typeof raw!=='string'||Buffer.byteLength(raw)>maxBytes||/\p{Surrogate}/u.test(raw))throw providerError();data=JSON.parse(raw);
  }else data=await response.json();
  cancelled(context.signal);
  if(!object(data)||Buffer.byteLength(JSON.stringify(data))>maxBytes||data.code!==0)throw providerError();return data;
 }catch(error){
  if(error.name==='AbortError'||context.signal?.aborted)throw Object.assign(new Error('Lookup cancelled'),{name:'AbortError'});
  throw providerError(); // Transport messages can contain URLs or response bodies.
 }
}
async function service(module,method,param,context) {
 const data=await requestJSON(`${musicuOrigin}/cgi-bin/musicu.fcg`,{comm,req:{module,method,param}},context);
 if(!object(data.req)||!Number.isSafeInteger(data.req.code))throw providerError();return data.req;
}
function completeTitle(primary,subtitle) {
 if(!scalar(primary)||subtitle!==undefined&&subtitle!==''&&!scalar(subtitle))return null;
 return subtitle&&!primary.includes(subtitle)?`${primary} (${subtitle})`:primary;
}
// An open marker list cannot prove that an unknown annotation is harmless.
// Keep every complete annotation/suffix as edition evidence except these
// closed release labels and reviewed, freshly source-bound sheet semantics.
const releaseLabel=/^(?:(?:super\s+|digital\s+)?deluxe(?:\s+edition)?|expanded\s+edition|standard\s+edition|single|ep|lp|album|bonus\s+tracks?|disc\s+\d{1,2}|cd\s*\d{1,2})$/iu;
const materialWords=/(?<![\p{L}\p{N}])(?:live|remaster(?:ed)?|re[\s-]?record(?:ed|ing)?|remix|mix(?:ed)?|version|edition|edit(?:ed)?|mono(?:phonic)?|stereo(?:phonic)?|instrumental|karaoke|acoustic|a[\s-]?cap(?:p)?ella|demo|cover|reprise|clean|explicit|sped(?:\s+up)?|speed(?:\s+up)?|slowed(?:\s+down)?|nightcore|daycore|pitch(?:ed)?|dub|surround|spatial|dolby)(?![\p{L}\p{N}])|版本?|混音|现场|現場|演唱会|演唱會|重制|重製|重录|重錄|再录|再錄|伴奏|纯音乐|純音樂|不插电|不插電|清唱|翻唱|剪辑|剪輯|单声道|單聲道|立体声|立體聲|加速|减速|減速|ライブ|ライヴ|リミックス|バージョン|ヴァージョン|リマスター|モノラル|ステレオ|再録|라이브|리믹스|버전|리마스터|스테레오|모노|재녹음/iu;
const descriptorSet=values=>[...new Set(values)].sort();
const sameDescriptors=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function editionDetails(value,{album=false,information=[]}={}) {
 if(value===undefined||value==='')return {base:'',canonical:'',descriptors:[]};
 if(!scalar(value,1000))return null;
 const text=value.normalize('NFKC').trim(),pairs={'(':')','[':']','{':'}','【':'】','「':'」','『':'』'},closers=new Set(Object.values(pairs));
 const pieces=[];let plain='',at=0;
 while(at<text.length) {
  const char=text[at];
  if(!pairs[char]){if(closers.has(char))return null;plain+=char;at++;continue;}
  if(plain){pieces.push({plain});plain='';}
  const start=at++,stack=[pairs[char]];
  while(at<text.length&&stack.length) {
   const next=text[at++];if(pairs[next]){stack.push(pairs[next]);if(stack.length>8)return null;}
   else if(closers.has(next)&&stack.pop()!==next)return null;
  }
  if(stack.length)return null;
  pieces.push({raw:text.slice(start,at),label:text.slice(start+1,at-1).trim()});if(pieces.length>64)return null;
 }
 if(plain)pieces.push({plain});
 const outside=pieces.filter(p=>p.plain!==undefined).map(p=>p.plain).join(' '),suffixes=outside.split(/\s+[-–—:|]\s+/u);
 let base=suffixes.shift().trim(),canonical='',descriptors=[];
 for(const piece of pieces) {
  if(piece.plain!==undefined){canonical+=piece.plain;continue;}
  const label=piece.label;if(!label)continue;
  const reviewed=information.some(rule=>normalizeRecordingText(outside)===rule.base&&normalizeRecordingText(label)===rule.label);
  const credits=/^(?:feat\.?|ft\.?|featuring|with)\s+\S/iu.test(label);
  const description=stripTitleDescription(`x (${label})`)==='x';
  if(reviewed||album&&releaseLabel.test(label)||credits||description&&!materialWords.test(label))continue;
  descriptors.push(normalizeRecordingText(label));canonical+=piece.raw;
 }
 for(const suffix of suffixes)if(suffix.trim()&&!(album&&releaseLabel.test(suffix.trim())))descriptors.push(normalizeRecordingText(suffix));
 // Bare album names remain release names. Explicitly qualified trailing
 // editions and live-venue phrases retain their entire supplied descriptor.
 if(album) {
  base=base.replace(/\s+(?:(?:super\s+|digital\s+)?deluxe(?:\s+edition)?|expanded\s+edition|standard\s+edition)$/iu,'');
  const remaster=/(?:^|\s)((?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?(?:\s+(?:version|edition))?)$/iu.test(base);
  const live=/\blive\s+(?:at|in|from|on|recordings?|performances?)\b.*$/iu.exec(base);
  const qualified=/\bacoustic\s+sessions?\b|\bre[\s-]?record(?:ed|ing)?\b|\b(?:sped|slowed|dolby|atmos|spatial|surround|reverb)\b|\bspeed\s+up\b|\bpitch(?:ed)?\s+(?:shift|up|down|[+-]?\d)/iu.test(base);
  const tail=/(?<![\p{L}\p{N}])(?:live|mix(?:ed)?|remix|version|edition|edit(?:ed)?|mono(?:phonic)?|stereo(?:phonic)?|instrumental|karaoke|acoustic|a[\s-]?cap(?:p)?ella|demo|cover|reprise|clean|explicit|nightcore|daycore|reverb)(?:\s+\d{4})?$|\b\d+(?:\.\d+)?x$|\b\d{2,3}\s*bpm$/iu.test(base);
  const localized=materialWords.test(base.replace(/\p{Script=Latin}+/gu,''));
  // Without a delimiter the recording/release boundary is ambiguous. Retain
  // the complete qualified label rather than dropping earlier descriptors.
  if(remaster||live||qualified||tail||localized)descriptors.push(normalizeRecordingText(base));
 }else if(materialWords.test(base))descriptors.push(normalizeRecordingText(base));
 const titleText=canonical.replace(/\s*\((?:feat\.?|ft\.?|featuring|with)\s+[^()]+\)/giu,'');
 return {base:normalizeRecordingText(base),canonical:normalizeRecordingText(titleText),descriptors:descriptorSet(descriptors)};
}
function metadata(raw,detail=false,allowMissingAlbum=false) {
 if(!object(raw))return null;
 const songID=id(detail?raw.id:raw.songid),songMID=detail?raw.mid:raw.songmid;
 const primary=detail?(raw.name||raw.title):raw.songname,display=detail?(raw.title||raw.name):primary;
 const fullTitle=completeTitle(display,raw.subtitle);let title=fullTitle;
 const album=detail?(raw.album?.title||raw.album?.name):raw.albumname;
 const albumID=id(detail?raw.album?.id:raw.albumid),albumMID=detail?raw.album?.mid:raw.albummid;
 const completeAlbum=scalar(album)&&albumID&&mid(albumMID);
 if(!songID||!mid(songMID)||!scalar(primary)||!title||title.length>1000||(!completeAlbum&&!allowMissingAlbum)
  ||(detail&&raw.title!==undefined&&raw.title!==''&&!scalar(raw.title))
  ||(detail&&raw.name!==undefined&&raw.name!==''&&!scalar(raw.name))
  ||!Number.isSafeInteger(raw.interval)||raw.interval<=0||raw.interval>7200||!Array.isArray(raw.singer)||!raw.singer.length||raw.singer.length>48
  ||raw.singer.some(s=>!object(s)||!id(s.id)||!mid(s.mid)||!scalar(s.name,1024)
    ||detail&&s.title!==undefined&&s.title!==''&&!scalar(s.title,1024))
  ||(raw.explicit!==undefined&&typeof raw.explicit!=='boolean')||(raw.isrc!=null&&!scalar(raw.isrc,32)))return null;
 const names=raw.singer.map(s=>s.name);
 const artist=names.join(' & '),entities=raw.singer.map(s=>({id:id(s.id),name:s.name}));
 // Reviewed sheet-label semantics only; this never rewrites a request or
 // equates catalog names. Unknown appended translations fail closed.
 const information=detail&&primary==='アイドル'&&normalizeRecordingText(display)===normalizeRecordingText('アイドル (偶像)')&&names.length===1&&names[0]==='YOASOBI'
  ?[{base:normalizeRecordingText('アイドル'),label:normalizeRecordingText('偶像')}]:[];
 let displayAuthority=false;
 if(detail) {
  const left={title:primary,artist,album,artist_entities:entities},right={...left,title:fullTitle};
  const primaryNames=recordingNames(left),displayNames=recordingNames(right);
  const p=editionDetails(primary,{information}),d=editionDetails(fullTitle,{information}),release=editionDetails(album,{album:true,information});
  if(!p||!d||!release)return null;
  if(p.canonical===d.canonical)d.descriptors=p.descriptors;
  else if(p.descriptors.length&&d.descriptors.length||p.base!==d.base)return null;
  const required=descriptorSet([...p.descriptors,...d.descriptors,...release.descriptors]);
  const credits=descriptorSet([...primaryNames.credits,...displayNames.credits]);
  const complete=(parts,names)=>sameDescriptors(descriptorSet([...parts.descriptors,...release.descriptors]),required)&&sameDescriptors(names,credits);
  const primaryComplete=complete(p,primaryNames.credits);displayAuthority=complete(d,displayNames.credits);
  if(!primaryComplete&&!displayAuthority)return null;
  title=primaryComplete?primary:fullTitle;
 }
 const song={source:'qq',id:songID,qqMID:songMID,title,artist,...(completeAlbum?{album}:{}),duration:raw.interval,
  creditedArtistNames:names,artist_entities:entities,
  providerTitle:detail?(raw.name??raw.title):primary,...(raw.subtitle?{subtitle:raw.subtitle}:{}),
  ...(detail?{providerDisplayTitle:display,providerDisplayArtistNames:raw.singer.map(s=>s.title||s.name)}:{}),
  ...(typeof raw.explicit==='boolean'?{explicit:raw.explicit}:{}),...(raw.isrc?{isrc:raw.isrc}:{})};
 if(detail)boundLabels.set(song,{title:displayAuthority?fullTitle:null,artists:song.providerDisplayArtistNames,information});return song;
}
function validateNames(data,song) {
 if(id(data?.songID)!==song.id)throw mismatch();
 const optional=(v,max)=>v===undefined||typeof v==='string'&&v.length<=max&&!/\p{Surrogate}|[\u0000-\u001f]/u.test(v);
 if(!optional(data.songName,1000)||!optional(data.singerName,2048)
  ||data.songName?.trim()&&!matchesTitleLabel(data.songName.trim(),song)
  ||data.singerName?.trim()&&!matchesArtistLabel(data.singerName.trim(),song))throw mismatch();
}
function matchesArtistLabel(value,song) {
 if(sameRecordingNames({...song,artist:value},song))return true;
 const artists=boundLabels.get(song)?.artists;
 return !!artists&&sameRecordingNames({...song,artist:value},{...song,artist:artists.join(' & ')});
}
function matchesCoreTitle(value,song,reference=song.title) {
 const information=boundLabels.get(song)?.information;
 const a=editionDetails(value,{information}),b=editionDetails(reference,{information});
 return !!a&&!!b&&sameRecordingNames({...song,title:value},{...song,title:reference})
  &&(a.canonical===b.canonical||sameDescriptors(a.descriptors,b.descriptors));
}
function matchesTitleLabel(value,song) {
 if(matchesCoreTitle(value,song))return true;
 const display=boundLabels.get(song)?.title;
 if(display&&matchesCoreTitle(value,song,display))return true;
 // QQ's source-owned sheet may append an informational Grammy award label.
 // This closed descriptor grammar excludes guests and recording versions;
 // its remaining base must still exactly match the selected catalog source.
 const award=/^(.+?)\s*(?:\([0-9]{1,3}届格莱美获奖歌曲\)|（[0-9]{1,3}届格莱美获奖歌曲）)$/u.exec(value);
 return !!award&&matchesCoreTitle(award[1].trim(),song);
}
function matchesSheetTitle(value,song,context) {
 if(matchesTitleLabel(value,song))return true;
 // This source-owned label agrees with an explicit request classification.
 // Only a fresh exact catalog admission can authorize it for this source;
 // serialized DTO fields cannot grant permission or change catalog matching.
 if(!explicitSheets.has(song)||context.explicit!==true||song.explicit===false||!compatible(song,context))return false;
 const label=/^(.+?)\s*(?:\(Explicit\)|（Explicit）)$/u.exec(value);
 return !!label&&matchesCoreTitle(label[1].trim(),song);
}
function validateHeaders(raw,song,context) {
 const labels=[];
 for(const match of raw.matchAll(/^\s*\[(ar|al|ti):([^\]\r\n]*)\]\s*$/gim)) {
  const kind=match[1].toLowerCase(),value=match[2].trim();if(!value)continue;
  if(!scalar(value,kind==='ar'?2048:1000)||labels.length>=32)throw mismatch();
  if(kind==='ar'&&!matchesArtistLabel(value,song)||kind==='ti'&&!matchesSheetTitle(value,song,context))throw mismatch();
  // Sheet release labels are informational and never replace song.album.
  labels.push({kind,value:match[2]});
 }
 return labels;
}
const clean=(value,song)=>cleanLyrics(value,{duration:song.duration,title:song.title,artist:song.artist});
function compatibleVersions(song,request) {
 // Apple name scoring predates clean/explicit album markers. QQ must retain
 // every rendition marker even when a primary/display title moved it to album.
 // An explicit request flag can qualify that one marker; it cannot erase Clean,
 // Live, Remix, guests, or any other recording distinction.
 const classified=value=>request.explicit===true?{...value,title:`${value.title} (Explicit)`}:value;
 if(!sameRecordingVersions(classified(song),classified(request)))return false;
 const information=boundLabels.get(song)?.information;
 const left=editionDetails(song.album,{album:true,information}),right=editionDetails(request.album,{album:true});
 const a=editionDetails(song.title,{information}),b=editionDetails(request.title);
 if(!left||!right||!a||!b)return false;
 const qualified=parts=>descriptorSet(parts.descriptors.filter(label=>request.explicit!==true||label!=='explicit'));
 const sameAlbum=typeof song.album==='string'&&typeof request.album==='string'&&normalizedAlbum(song.album)===normalizedAlbum(request.album);
 return (sameAlbum||sameDescriptors(qualified(left),qualified(right)))
  &&(a.canonical===b.canonical||sameDescriptors(qualified(a),qualified(b)));
}
const compatible=(song,request)=>sameRecordingNames(song,request)&&recordingScore(song,request)>=0
 &&compatibleVersions(song,request)
 &&!(typeof song.explicit==='boolean'&&typeof request.explicit==='boolean'&&song.explicit!==request.explicit);
function bindSheetPermission(song,request) {
 if(boundLabels.has(song)&&request.explicit===true&&song.explicit!==false&&compatible(song,request))explicitSheets.add(song);
}
const lyricParam=(songId,qrc)=>({songId:Number(songId),crypt:1,qrc,lrc_t:0,qrc_t:0,roma:0,roma_t:0,trans:0,trans_t:0,needSingingAnnotations:false,type:1});
function checkedLyric(response,song,qrc) {
 if(!object(response))throw providerError();
 if(response.code===24001)return null;
 if(response.code!==0||!object(response.data))throw providerError();validateNames(response.data,song);
 if(response.data.qrc!==qrc||response.data.crypt!==1||typeof response.data.lyric!=='string')throw providerError();return response.data.lyric;
}
async function lyricPayload(song,qrc,context) {
 return checkedLyric(await service('music.musichallSong.PlayLyricInfo','GetPlayLyricInfo',lyricParam(song.id,qrc),context),song,qrc);
}
async function fetchLyrics(song,context,initialResponse) {
 try {
  const hex=initialResponse===undefined?await lyricPayload(song,1,context):checkedLyric(initialResponse,song,1);
  if(hex) {
   const raw=decryptQRC(hex),body=qrcBody(raw),labels=body===null?[]:validateHeaders(body,song,context);
   const parsed=parseQRC(raw,{songId:song.id,duration:song.duration,durationResolution:1});
   if(parsed){const result=clean({...parsed,providerLyricLabels:labels},song);if(result?.lines.length)return result;}
  }
 }catch(error){if(error.name==='AbortError'||context.signal?.aborted||error.code==='recording_mismatch')throw error;}
 cancelled(context.signal);const hex=await lyricPayload(song,0,context);if(!hex)return null;
 let raw;try{raw=decryptQRC(hex);}catch{throw providerError();}const labels=validateHeaders(raw,song,context),lines=parseLRC(raw);
 if(lines.length>250||lines.some(l=>!scalar(l.text,2000)||l.timestamp!==null&&(!Number.isFinite(l.timestamp)||l.timestamp<0||l.timestamp>song.duration)))throw mismatch();
 const result=clean({source:'qq',songId:song.id,lines,providerLyricLabels:labels},song);return result?.lines.length?result:null;
}
async function discover(query,context) {
 if(!scalar(query,1000))throw providerError();const url=new URL('/soso/fcgi-bin/client_search_cp',legacyOrigin);
 // This legacy route returns an empty success for n=100; its verified page
 // size is 30. Keep every returned best candidate inside the bounded page.
 for(const [key,value] of Object.entries({w:simplifyRecordingScript(query,{preserveOtherCJK:true}),format:'json',n:30,p:1}))url.searchParams.set(key,value);
 const data=await requestJSON(url,undefined,context),rows=data.data?.song?.list;
 if(!Array.isArray(rows)||rows.length>100)throw providerError();const songs=new Map();
 for(const row of rows){const song=metadata(row);if(!song)continue;const old=songs.get(song.id);if(old&&JSON.stringify(old)!==JSON.stringify(song))throw mismatch();songs.set(song.id,song);}
 return [...songs.values()];
}
async function fastDiscover(query,request,context,records,responses,state) {
 const url=new URL('/splcloud/fcgi-bin/smartbox_new.fcg',legacyOrigin);
 for(const [key,value] of Object.entries({format:'json',is_xml:0,key:simplifyRecordingScript(query,{preserveOtherCJK:true})}))url.searchParams.set(key,value);
 const data=await requestJSON(url,undefined,context),group=data.data?.song;
 if(!object(group)||!Number.isSafeInteger(group.count)||!Array.isArray(group.itemlist)
  ||group.count!==group.itemlist.length||group.count>10)throw providerError();
 if(!group.count)return;
 const hints=new Map();
 for(const hint of group.itemlist) {
  const value=id(hint?.id);
  if(!value||id(hint.docid)!==value||!mid(hint.mid)||!scalar(hint.name,1000)||!scalar(hint.singer,2048))throw providerError();
  const previous=hints.get(value);if(previous&&previous.mid!==hint.mid){state.unresolved=true;throw mismatch();}hints.set(value,hint);
 }
 // Suggestions are a bounded discovery set, not an exhaustive catalog claim.
 // Every ID is hydrated; their flat title/singer hints never enter admission.
 const payload={comm};
 for(const value of hints.keys()) {
  payload[`details_${value}`]={module:'music.pf_song_detail_svr',method:'get_song_detail_yqq',param:{song_id:Number(value)}};
  payload[`lyric_${value}`]={module:'music.musichallSong.PlayLyricInfo',method:'GetPlayLyricInfo',param:lyricParam(value,1)};
 }
 const batch=await requestJSON(`${musicuOrigin}/cgi-bin/musicu.fcg`,payload,context);
 for(const [value,hint] of hints) {
  const detail=batch[`details_${value}`],raw=detail?.data?.track_info;
  if(detail?.code!==0||!object(raw)||id(raw.id)!==value||raw.mid!==hint.mid){state.unresolved=true;continue;}
  const song=metadata(raw,true),core=song??metadata(raw,true,true);
  if(!core){
   // ID and MID above are fresh exact echoes. A valid source interval outside
   // the unchanged recording bound independently excludes an unusable title;
   // potentially eligible or malformed intervals must remain unresolved.
   if(Number.isSafeInteger(raw.interval)&&raw.interval>0&&raw.interval<=7200&&Math.abs(raw.interval-request.duration)>3){state.excluded.add(value);continue;}
   state.unresolved=true;continue;
  }
  records.set(value,core);
  if(!song&&compatible(core,request))state.unresolved=true;
  responses.set(value,batch[`lyric_${value}`]??null);
 }
}
// All best metadata ties are checked by three workers. Proven text/cue conflict
// cancels peer requests immediately; caller cancellation owns the same scope.
async function hydrate(songs,context,responses=new Map(),failures=new Map()) {
 const controller=new AbortController(),relay=()=>controller.abort();
 context.signal?.addEventListener('abort',relay,{once:true});if(context.signal?.aborted)relay();
 let next=0,failure=null,signature=null,rejectFailure;
 const failed=new Promise((_,reject)=>{rejectFailure=reject;});
 try {
  const workers=Array.from({length:Math.min(3,songs.length)},async()=>{
   while(next<songs.length&&!failure) {
    const song=songs[next++];
    try {
     cancelled(controller.signal);if(failures.has(song.id))throw failures.get(song.id);
     song.lyricsData??=await fetchLyrics(song,{...context,signal:controller.signal},responses.get(song.id));if(!song.lyricsData?.lines.length)throw mismatch();
     const current=JSON.stringify(song.lyricsData.lines.map(l=>[l.text,l.timestamp??null,l.vocalTiming??null]));
     if(signature!==null&&signature!==current)throw mismatch();signature=current;
    }catch(error){if(!failure){failure=error;if(error.name!=='AbortError')failures.set(song.id,error);rejectFailure(error);controller.abort();}}
   }
  });
  // The provider transport may ignore abort. Its caught worker remains safe,
  // while the proved failure is returned without waiting on that peer.
  await Promise.race([Promise.all(workers),failed]);
 }finally{context.signal?.removeEventListener('abort',relay);}
}
async function selectRecording(records,request,context,responses,failures,{measured=false}={}) {
 const ranked=[...records.values()].filter(s=>compatible(s,request)).map(song=>({song,score:recordingScore(song,request)})).sort((a,b)=>b.score-a.score);
 if(!ranked.length)return null;const best=ranked.filter(s=>Math.abs(s.score-ranked[0].score)<1e-9).map(s=>s.song);
 for(const song of best)bindSheetPermission(song,request);
 await hydrate(best,{...context,artist:request.artist,title:request.title},responses,failures);
 const selected=findRecording(best,request);
 return measured&&!best.every(s=>s.lyricsData?.lines.some(l=>l.vocalTiming))?null:selected;
}
export class QQMusicAPI extends BaseMusicAPI {
 constructor(){super('QQMusicAPI',['zh','yue','en','ja','ko','ru']);this.supportsVocalTiming=true;this.languageAgnosticDiscovery=true;}
 supportsLanguage(language){return typeof language==='string'&&/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/.test(language);}
 async searchSong(artist,title,context={}) {
  cancelled(context.signal);if(!scalar(artist,2048)||!scalar(title,1000)||!Number.isFinite(context.duration)||context.duration<=0||context.duration>7200)return null;
  const request={...context,artist,title},records=new Map(),responses=new Map(),failures=new Map(),state={unresolved:false,excluded:new Set()};
  try {
   await fastDiscover(`${title} ${artist}`,request,context,records,responses,state);
   if(!state.unresolved){const selected=await selectRecording(records,request,context,responses,failures,{measured:true});if(selected)return selected;}
  }catch(error){if(error.name==='AbortError'||context.signal?.aborted)throw error;}
  cancelled(context.signal);const songs=await discover(`${artist} ${searchTitle(title)}`,context);
  for(const song of songs) {
   if(state.excluded.has(song.id))continue;
   const known=records.get(song.id);
   if(known){if(known.qqMID!==song.qqMID)failures.set(song.id,mismatch());}
   else records.set(song.id,song);
  }
  // A legacy subset cannot erase fresh version labels, missing potentially
  // eligible metadata, or a measured-sheet conflict from the fast discovery.
  if(state.unresolved)throw mismatch();if(!records.size)return null;
  const selected=await selectRecording(records,request,context,responses,failures);if(!selected)throw mismatch();return selected;
 }
 async getLyrics(songId,context={}) {
  const value=id(songId),song=context.song;cancelled(context.signal);
  if(!value||song?.source!=='qq'||song.id!==value||!Number.isFinite(song.duration)||song.duration<=0||song.duration>7200)return null;
  if(context.artist!==undefined&&context.title!==undefined&&!compatible(song,context))throw mismatch();
  if(song.lyricsData) {
   // A cached private source object still cannot carry an explicit header
   // permission into a clean/unknown or otherwise different request.
   for(const label of song.lyricsData.providerLyricLabels??[]) {
    if(label.kind==='ti'&&!matchesSheetTitle(label.value.trim(),song,context)
     ||label.kind==='ar'&&!matchesArtistLabel(label.value.trim(),song))throw mismatch();
   }
   return song.lyricsData;
  }
  return fetchLyrics(song,context);
 }
 async getRecording(songId,context={}) {
  const value=id(songId);cancelled(context.signal);if(!value)return null;
  const batch=await requestJSON(`${musicuOrigin}/cgi-bin/musicu.fcg`,{comm,
   details:{module:'music.pf_song_detail_svr',method:'get_song_detail_yqq',param:{song_id:Number(value)}},
   lyric:{module:'music.musichallSong.PlayLyricInfo',method:'GetPlayLyricInfo',param:lyricParam(value,1)}},context);
  const response=batch.details;if(!object(response))throw providerError();
  if(response.code!==0||!object(response.data))throw providerError();const song=metadata(response.data.track_info,true);
  if(!song||song.id!==value||!compatible(song,context))throw mismatch();
  bindSheetPermission(song,context);
  const lyrics=await fetchLyrics(song,context,batch.lyric??null);return {song,lyrics};
 }
 async searchLyrics(query,context={}){return discover(query,context);}
 async previewLyrics(songId,query,context={}) {
  const value=id(songId);if(!value)return null;const song=(await discover(query,context)).find(s=>s.id===value);
  return song?{...song,lyricsData:await fetchLyrics(song,context)}:null;
 }
}
