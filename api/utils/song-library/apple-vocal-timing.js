import {createHash} from 'node:crypto';
import {validVocalTiming,validTimingProvenance} from '../vocal-timing.js';

// Only server-side document creation or an actual request lookup can grant this
// evidence. JSON/structuredClone cannot transport it to a different document.
const requests=new WeakMap();
export function bindAppleTimingRequest(document,key){requests.set(document,key);return document;}
export const appleTimingRequest=document=>requests.get(document);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const hasVocalTiming=response=>response?.lines?.some(l=>l.vocalTiming!=null)??false;
export function appleTimingOrigin(response) {
 const p=response.metadata?.lyric_timing;
 if(!hasVocalTiming(response))return null;
 if(!validTimingProvenance(p)||p.provider!=='appleMusic'||!['netease','NeteaseAPI'].includes(response.metadata.source)||p.source!==`netease:${response.song.id}:yrc`
  ||response.lines.some(l=>l.vocalTiming&&!validVocalTiming(l,{duration:response.song.duration})))throw new Error('invalid_vocal_timing');
 return {source:p.source,revision:p.revision};
}
// This new branch uses canonical JSON so JSONB key order cannot change an
// immutable identity. The legacy Apple digest recipes remain in document.js.
export function appleVocalHashes(response,structure,{recordingKey,canonicalRecordingID,textRevision}) {
 const lyricTiming=appleTimingOrigin(response);
 if(!lyricTiming)return null;
 const sourceHash=hash({language:response.song.language,lines:response.lines,structure,lyricTiming});
 return {sourceHash,timingRevision:hash({policy:'apple-vocal-timing-1',recording:canonicalRecordingID??recordingKey,textRevision,
  timestamps:response.lines.map(l=>l.timestamp??null),vocalTiming:response.lines.map(l=>l.vocalTiming??null),lyricTiming})};
}
