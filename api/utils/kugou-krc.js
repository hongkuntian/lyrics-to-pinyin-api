import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {validVocalTiming,MAX_LYRIC_SECONDS} from './vocal-timing.js';

export const KUGOU_ACQUISITION_CAPABILITY='kugou-krc-1';
const maxBytes=524288;
// Public KRC container format, independently documented by LyricsKit. This is
// a format codec, not a provider credential or a key extracted from an app.
const codec=Buffer.from([64,71,97,119,94,50,116,71,81,54,49,45,206,210,110,105]);
export function decodeKRC(content) {
 try {
  if(typeof content!=='string'||!content||content.length>maxBytes||content.length%4!==0
   ||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content))return null;
  const data=Buffer.from(content,'base64');
  if(data.length<5||data.toString('base64')!==content||data.subarray(0,4).toString('ascii')!=='krc1')return null;
  const compressed=Buffer.from(data.subarray(4).map((byte,index)=>byte^codec[index%16]));
  const decoded=inflateSync(compressed,{maxOutputLength:maxBytes});
  const text=new TextDecoder('utf-8',{fatal:true}).decode(decoded);
  return text.includes('\u0000')?null:text;
 }catch{return null;}
}
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const number=value=>/^-?\d+$/.test(value)?Number(value):NaN;

// KRC is its own complete lyric edition. Token starts are offsets from the
// line, unlike YRC's absolute starts. Preserve words even when optional cues
// are invalid; never shift/clamp measured times or graft them onto sibling LRC.
export function parseKRC(raw,{songId,duration=MAX_LYRIC_SECONDS}={}) {
 if(typeof raw!=='string'||Buffer.byteLength(raw)>maxBytes||/\p{Surrogate}/u.test(raw)
  ||!/^\d{1,20}$/.test(String(songId))||!Number.isFinite(duration)||duration<=0||duration>MAX_LYRIC_SECONDS)return null;
 const lines=[],sheet=[];let tokens=0,metadata=0;
 for(const row of raw.replace(/^\uFEFF/,'').split(/\r?\n/)) {
  if(!row.trim())continue;
  const tag=row.match(/^\[([A-Za-z][A-Za-z0-9_-]{0,31}):([^\r\n]*)\]$/u);
  if(tag&&!lines.length){if(++metadata>32||tag[1].toLowerCase()==='offset'&&tag[2]!=='0')return null;continue;}
  const header=row.match(/^\[(\d+),(\d+)\](.*)$/u);
  if(!header)return null;
  const start=number(header[1]),length=number(header[2]),end=start+length;
  if(!integer(start)||!integer(length)||!integer(end)||length<=0||end>duration*1000
   ||lines.length&&start/1000<lines.at(-1).timestamp)return null;
  const body=header[3],markers=[...body.matchAll(/<(-?\d+),([^<> ,]*),([^<> ,]*)>/gu)];
  if(markers.length>1024||(tokens+=markers.length)>8192)return null;
  let text=markers.length?body.slice(0,markers[0].index):body,bad=false;
  const segments=[],integerSegments=[];
  for(let i=0;i<markers.length;i++) {
   const marker=markers[i],part=body.slice(marker.index+marker[0].length,markers[i+1]?.index??body.length),utf16Start=text.length;
   text+=part;
   const relative=number(marker[1]),durationMS=number(marker[2]),reserved=number(marker[3]),at=start+relative;
   if(!integer(relative)||!integer(durationMS)||!Number.isSafeInteger(reserved)||!integer(at)||!integer(at+durationMS)){bad=true;continue;}
   if(!durationMS||!part.length)continue;
   segments.push({utf16Start,utf16Length:part.length,text:part,start:at/1000,end:(at+durationMS)/1000});
   integerSegments.push([utf16Start,part.length,part,at,at+durationMS]);
  }
  if(/<[^<>]*,/u.test(text)||text.length>2000||!text.trim())return null;
  const line={text,timestamp:start/1000,vocalTiming:{end:end/1000,segments}};
  if(bad||!validVocalTiming(line,{duration}))delete line.vocalTiming;
  sheet.push([text,start,end,line.vocalTiming?integerSegments:null]);lines.push(line);
  if(lines.length>250)return null;
 }
 if(!lines.length)return null;
 const source=`kugou:${songId}:krc`;
 const revision=createHash('sha256').update(JSON.stringify([KUGOU_ACQUISITION_CAPABILITY,source,sheet])).digest('hex');
 return {lines,source:'kugou',songId,timingSource:{source,revision}};
}
