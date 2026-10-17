import {createHash} from 'node:crypto';
import {validVocalTiming,MAX_LYRIC_SECONDS} from './vocal-timing.js';
export const NETEASE_ACQUISITION_CAPABILITY='netease-yrc-1';
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const number=value=>/^-?\d+$/.test(value)?Number(value):NaN;

// A YRC result is a complete source edition, never a timing overlay on LRC.
// Unknown rows abort the edition; decoded rows with bad optional cues remain
// readable. No relative-time heuristic, timing clamp, role or grammar revision
// is inferred from provider fields.
export function parseYRC(raw,{songId,duration=MAX_LYRIC_SECONDS}={}) {
 if(typeof raw!=='string'||Buffer.byteLength(raw)>524288||/\p{Surrogate}/u.test(raw)
  ||!/^\d{1,20}$/.test(String(songId))||!Number.isFinite(duration)||duration<=0||duration>MAX_LYRIC_SECONDS)return null;
 const lines=[],sheet=[];let tokens=0,metadata=0;
 for(const row of raw.replace(/^\uFEFF/,'').split(/\r?\n/)){
  if(!row.trim())continue;
  if(!lines.length&&/^\s*\{/.test(row)){
   try{const v=JSON.parse(row);if(integer(v?.t)&&Array.isArray(v.c)&&v.c.length<=128&&v.c.every(c=>typeof c?.tx==='string')&&++metadata<=32)continue;}catch{}
   return null;
  }
  if(!lines.length&&(/^\[(?:ar|al|ti|by|re|ve):[^\r\n]*\]$/i.test(row)||/^\[offset:0\]$/i.test(row))){if(++metadata>32)return null;continue;}
  const header=row.match(/^\[(\d+),(\d+)\](.*)$/u);
  if(!header)return null;
  const start=number(header[1]),length=number(header[2]),end=start+length;
  if(!integer(start)||!integer(length)||!integer(end)||length<=0||end>duration*1000
   ||(lines.length&&start/1000<lines.at(-1).timestamp))return null;
  const body=header[3],markers=[...body.matchAll(/\((-?\d+),([^(),]*),([^(),]*)\)/gu)];
  if(markers.length>1024||(tokens+=markers.length)>8192)return null;
  let text=markers.length?body.slice(0,markers[0].index):body,bad=false;const segments=[],integerSegments=[];
  for(let i=0;i<markers.length;i++){
   const marker=markers[i],part=body.slice(marker.index+marker[0].length,markers[i+1]?.index??body.length),utf16Start=text.length;
   text+=part;
   const at=number(marker[1]),durationMS=number(marker[2]),reserved=number(marker[3]);
   if(!integer(at)||!integer(durationMS)||!Number.isSafeInteger(reserved)||!integer(at+durationMS)){bad=true;continue;}
   if(!durationMS||!part.length)continue;
   segments.push({utf16Start,utf16Length:part.length,text:part,start:at/1000,end:(at+durationMS)/1000});
   integerSegments.push([utf16Start,part.length,part,at,at+durationMS]);
  }
  // A remaining marker-like string has no unambiguous text decoding. Falling
  // back whole preserves the LRC transcription instead of silently losing rows.
  if(/\([^()]*,/u.test(text)||text.length>2000||!text.trim())return null;
  const line={text,timestamp:start/1000,vocalTiming:{end:end/1000,segments}};
  if(bad||!validVocalTiming(line,{duration}))delete line.vocalTiming;
  sheet.push([text,start,end,line.vocalTiming?integerSegments:null]);
  lines.push(line);if(lines.length>250)return null;
 }
 if(!lines.length)return null;
 const source=`netease:${songId}:yrc`;
 const revision=createHash('sha256').update(JSON.stringify([NETEASE_ACQUISITION_CAPABILITY,source,sheet])).digest('hex');
 return {lines,source:'netease',songId,timingSource:{source,revision}};
}
