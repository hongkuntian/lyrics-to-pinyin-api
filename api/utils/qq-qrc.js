import {createHash} from 'node:crypto';
import {decryptQRC} from './vendor/qq-qrc-codec.js';
import {validVocalTiming,validTimingTimestamp,timingDurationLimit,MAX_LYRIC_SECONDS} from './vocal-timing.js';

export const QQ_ACQUISITION_CAPABILITY='qq-qrc-3';
const MAX_SECONDS=MAX_LYRIC_SECONDS, MAX_BYTES=524288, MAX_ROWS=250, MAX_MARKERS=8192;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const number=s=>/^-?\d{1,16}$/.test(s)?Number(s):NaN;
const invalidUnicode=s=>/\p{Surrogate}|[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(s);
const fail=()=>{throw new Error('invalid_qrc_xml');};

// The provider's known XML envelope is parsed as a small closed grammar. No
// DTD, external entities, arbitrary markup, duplicate attrs or sibling sheets.
// Numeric entities are Unicode scalars; attribute newlines remain source rows.
function xmlValue(value,{literalAmpersands=false}={}) {
 let out='',at=0;
 while(at<value.length) {
  const next=value.indexOf('&',at);
  if(next<0){out+=value.slice(at);break;}
  out+=value.slice(at,next);
  const entity=/^&([^;&]{1,16});/.exec(value.slice(next));
  if(!entity) {
   // QQ sometimes leaves literal production/lyric ampersands unescaped.
   // Only LyricContent permits them. Entity-like numeric/unknown names remain
   // invalid, and the enclosing attribute/element grammar is unchanged.
   if(!literalAmpersands||/^&(?:#|[^\s&;]*;)/u.test(value.slice(next)))fail();
   out+='&';at=next+1;continue;
  }
  const name=entity[1],named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
  if(Object.hasOwn(named,name))out+=named[name];
  else {
   const n=/^#\d{1,7}$/.test(name)?Number(name.slice(1)):/^#x[\da-f]{1,6}$/i.test(name)?parseInt(name.slice(2),16):NaN;
   if(!integer(n)||n>0x10ffff||(n>=0xd800&&n<=0xdfff))fail();out+=String.fromCodePoint(n);
  }
  at=next+entity[0].length;
 }
 if(invalidUnicode(out))fail();return out;
}
function readAttrs(raw,{literalLyricContent=false}={}) {
 let at=0;const attrs={};
 while(at<raw.length) {
  const ws=/^\s+/.exec(raw.slice(at));if(!ws)fail();at+=ws[0].length;if(at===raw.length)break;
  const key=/^[A-Za-z_][A-Za-z0-9_.:-]{0,39}/.exec(raw.slice(at));if(!key)fail();at+=key[0].length;
  const equals=/^\s*=\s*(["'])/.exec(raw.slice(at));if(!equals)fail();at+=equals[0].length;
  const end=raw.indexOf(equals[1],at);if(end<0||Object.hasOwn(attrs,key[0])||Object.keys(attrs).length>=8)fail();
  const value=raw.slice(at,end);if(value.includes('<'))fail();attrs[key[0]]=xmlValue(value,{literalAmpersands:literalLyricContent&&key[0]==='LyricContent'});at=end+1;
 }
 return attrs;
}
function allowedAttrs(attrs,allowed,required=[]) {
 if(Object.keys(attrs).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(attrs,k)))fail();
}
export function qrcBody(raw) {
 if(typeof raw!=='string'||Buffer.byteLength(raw)>MAX_BYTES||invalidUnicode(raw))return null;
 try {
  let text=raw.replace(/^\uFEFF/,'').trim(),at=0;
  const consume=pattern=>{const m=pattern.exec(text.slice(at));if(!m)fail();at+=m[0].length;return m;};
  if(text.startsWith('<?xml')) {
   const prolog=consume(/^<\?xml([^?]*)\?>\s*/);const attrs=readAttrs(prolog[1]);
   allowedAttrs(attrs,['version','encoding','standalone'],['version']);
   if(attrs.version!=='1.0'||(attrs.encoding&&!/^utf-8$/i.test(attrs.encoding))||(attrs.standalone&&!['yes','no'].includes(attrs.standalone)))fail();
  }
  consume(/^<QrcInfos\s*>\s*/);
  if(text.slice(at).startsWith('<QrcHeadInfo')) {
   const m=consume(/^<QrcHeadInfo((?:[^"'<>]|"[^"<>]*"|'[^'<>]*')*)\/\s*>\s*/);const attrs=readAttrs(m[1]);
   allowedAttrs(attrs,['SaveTime','Version']);if(Object.values(attrs).some(v=>!/^\d{1,20}$/.test(v)))fail();
  }
  const info=consume(/^<LyricInfo((?:[^"'<>]|"[^"<>]*"|'[^'<>]*')*)>\s*/);const attrs=readAttrs(info[1]);
  allowedAttrs(attrs,['LyricCount'],['LyricCount']);if(attrs.LyricCount!=='1')fail();
  const lyric=consume(/^<Lyric_1((?:[^"'<>]|"[^"<>]*"|'[^'<>]*')*)(\/\s*>|>\s*<\/Lyric_1\s*>)\s*/);const l=readAttrs(lyric[1],{literalLyricContent:true});
  allowedAttrs(l,['LyricType','LyricContent'],['LyricType','LyricContent']);if(l.LyricType!=='1')fail();
  consume(/^<\/LyricInfo\s*>\s*<\/QrcInfos\s*>\s*$/);if(at!==text.length)fail();
  return l.LyricContent;
 }catch{return null;}
}

// QRC is a complete source edition. Word markers follow their text and their
// start times are absolute song milliseconds (like YRC, unlike KRC offsets).
// Invalid optional cues leave the decoded row readable; unknown rows abort.
export function parseQRC(raw,{songId,duration=MAX_SECONDS,durationResolution=0}={}) {
 if((typeof songId!=='string'&&!(Number.isSafeInteger(songId)&&songId>0))||! /^[1-9]\d{0,19}$/.test(String(songId))
  ||timingDurationLimit(duration,durationResolution)===null)return null;
 const body=qrcBody(raw);if(body===null)return null;
 const lines=[],sheet=[];let markers=0,metadata=0,metadataBytes=0;
 for(const row of body.split(/\r\n|[\r\n]/)) {
  if(!row.trim())continue;
  if(row.length>20000)return null;
  if(!lines.length&&(/^\[(?:ar|al|ti|by|re|ve|kana):[^\r\n]*\]$/i.test(row)||/^\[offset:0\]$/i.test(row))) {
   const bytes=Buffer.byteLength(row);
   if(++metadata>32||bytes>16384||(metadataBytes+=bytes)>65536)return null;
   continue;
  }
  const h=/^\[(\d{1,16}),(\d{1,16})\](.*)$/u.exec(row);if(!h)return null;
  const start=number(h[1]),length=number(h[2]),end=start+length;
  if(!integer(start)||!integer(length)||!integer(end)||length===0
   ||!validTimingTimestamp(start/1000,{duration,durationResolution})||!validTimingTimestamp(end/1000,{duration,durationResolution})
   ||(lines.length&&start/1000<lines.at(-1).timestamp))return null;
  const matches=[...h[3].matchAll(/\((-?\d+),([^(),\r\n]*)\)/gu)];
  if(matches.length>1024||(markers+=matches.length)>MAX_MARKERS)return null;
  let text='',cursor=0,bad=false;const segments=[],integerSegments=[];
  for(const m of matches) {
   const part=h[3].slice(cursor,m.index),utf16Start=text.length;text+=part;cursor=m.index+m[0].length;
   const at=number(m[1]),durationMS=number(m[2]);
   if(!integer(at)||!integer(durationMS)||!integer(at+durationMS)){bad=true;continue;}
   if(!part.length||durationMS===0)continue;
   segments.push({utf16Start,utf16Length:part.length,text:part,start:at/1000,end:(at+durationMS)/1000});
   integerSegments.push([utf16Start,part.length,part,at,at+durationMS]);
  }
  text+=h[3].slice(cursor);
  if(/\([^()]*,/u.test(text)||text.length>2000||!text.trim()||invalidUnicode(text))return null;
  // Some QQ rows end one source millisecond before their final measured word.
  // Use that supplied word endpoint for the enclosing envelope only. Every
  // word time stays byte-for-byte equivalent in milliseconds; larger conflicts
  // remain invalid. The original row endpoint is retained in the revision.
  const finalEnd=integerSegments.at(-1)?.[4],envelopeEnd=!bad&&finalEnd===end+1?finalEnd:end;
  const line={text,timestamp:start/1000,vocalTiming:{end:envelopeEnd/1000,segments}};
  if(bad||!validVocalTiming(line,{duration,durationResolution}))delete line.vocalTiming;
  sheet.push([text,start,end,line.vocalTiming?integerSegments:null]);lines.push(line);if(lines.length>MAX_ROWS)return null;
 }
 if(!lines.length)return null;
 const id=String(songId),source=`qq:${id}:qrc`;
 const revision=createHash('sha256').update(JSON.stringify([QQ_ACQUISITION_CAPABILITY,source,durationResolution,sheet])).digest('hex');
 return {source:'qq',songId:id,lines,timingSource:{source,revision},...(durationResolution===1?{durationResolution:1}:{})};
}
export function parseEncryptedQRC(hex,options) {
 try{return parseQRC(decryptQRC(hex),options);}catch{return null;}
}
