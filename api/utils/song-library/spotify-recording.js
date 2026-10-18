import {createHash} from 'node:crypto';
import {LibraryError} from './store.js';
import {validLyricStructure} from '../lyric-annotations.js';
import {timingQuality} from '../lyric-selection.js';
import {validTimingProvenance} from '../vocal-timing.js';

const matchEvidence=new WeakMap();
export function attachSpotifyMatchEvidence(response,candidate) {matchEvidence.set(response,structuredClone(candidate));return response;}
export const spotifyMatchEvidence=response=>matchEvidence.get(response)??null;

export const SPOTIFY_MATCH_POLICY='spotify-request-match-1';
export const isSpotifyRecording=value=>value?.provider==='spotify'&&value?.version===2;
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const scalars=value=>typeof value==='string'&&!/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
const name=(value,max=500)=>scalars(value)&&value.trim().length>0&&Array.from(value).length<=max;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9]{22}$/.test(value);
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(key=>allowed.includes(key));
export function spotifyRecording(value) {
  const m=value?.metadata;
  if(!keys(value,['version','provider','item_id','requested_item_id','market','metadata'])||value.version!==2||value.provider!=='spotify'||!id(value.item_id)
    ||('requested_item_id' in value&&!id(value.requested_item_id))||('market' in value&&(typeof value.market!=='string'||!/^[A-Z]{2}$/.test(value.market)))
    ||!keys(m,['origin','title','artists','album','duration_ms','isrc','explicit'])||m.origin!=='spotify'||!name(m.title)
    ||!Array.isArray(m.artists)||m.artists.length<1||m.artists.length>32||!m.artists.every(value=>name(value))
    ||!Number.isInteger(m.duration_ms)||m.duration_ms<1||m.duration_ms>7200000
    ||('album' in m&&!name(m.album))||('isrc' in m&&(typeof m.isrc!=='string'||!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(m.isrc)))
    ||('explicit' in m&&typeof m.explicit!=='boolean'))throw new LibraryError('invalid_recording',400);
  return structuredClone(value);
}

// This serializer belongs exclusively to Spotify V2. Legacy digest uses its
// original property insertion order and JSON.stringify behavior unchanged.
export function canonicalJSON(value) {
  const seen=new Set();
  const encode=value=>{
    if(value===null)return 'null';
    if(typeof value==='string') {if(!scalars(value)&&/[\ud800-\udfff]/u.test(value))throw new TypeError('Invalid Unicode scalar');return JSON.stringify(value);}
    if(typeof value==='boolean')return String(value);
    if(typeof value==='number') {if(!Number.isFinite(value)||Object.is(value,-0))throw new TypeError('Invalid JSON number');return JSON.stringify(value);}
    if(!Array.isArray(value)&&!object(value))throw new TypeError('Invalid JSON value');
    if(seen.has(value))throw new TypeError('Cyclic JSON');seen.add(value);
    let result;
    if(Array.isArray(value)) {
      if(Object.keys(value).length!==value.length||!Array.from({length:value.length},(_,i)=>Object.hasOwn(value,i)).every(Boolean))throw new TypeError('Sparse or extended array');
      result='['+value.map(encode).join(',')+']';
    } else {
      if(Reflect.ownKeys(value).some(key=>typeof key!=='string'))throw new TypeError('Invalid JSON key');
      result='{'+Object.keys(value).sort().map(key=>encode(key)+':'+encode(value[key])).join(',')+'}';
    }
    seen.delete(value);return result;
  };
  return encode(value);
}
export const spotifyHash=value=>createHash('sha256').update(canonicalJSON(value),'utf8').digest('hex');
export function spotifyRequestHash(value) {
  const r=spotifyRecording(value),m=r.metadata;
  return spotifyHash(['spotify-request-2',r.item_id,r.requested_item_id??null,r.market??null,m.title,m.artists,m.album??null,m.duration_ms,m.isrc??null,m.explicit??null]);
}
export const spotifyRecordingKey=r=>spotifyHash(['spotify-recording-2',spotifyRecording(r).item_id]);
export function spotifySearchRequest(value) {
  const r=spotifyRecording(value),m=r.metadata;
  return {recordingProvider:'spotify',recordingItemID:r.item_id,creditedArtistNames:[...m.artists],artist:m.artists.join(' & '),title:m.title,
    ...(m.album!==undefined?{album:m.album}:{}),duration:m.duration_ms/1000,...(m.isrc?{isrc:m.isrc}:{}),...(m.explicit!==undefined?{explicit:m.explicit}:{})};
}
const providers=new Map([['lrclib','lrclib'],['LRCAPI','lrclib'],['netease','netease'],['NeteaseAPI','netease'],['kugou','kugou'],['KugouAPI','kugou'],['qq','qq'],['QQMusicAPI','qq']]);
export const independentProvider=value=>providers.get(value)??null;
export function sourceCapsule(response) {
  const provider=independentProvider(response?.metadata?.source),rawID=response?.song?.id;
  const itemID=typeof rawID==='number'&&Number.isSafeInteger(rawID)?String(rawID):rawID;
  if(!provider||!name(itemID,512)||!Array.isArray(response.lines)||typeof response.song.language!=='string'||typeof response.song.romanization_system!=='string')throw new LibraryError('invalid_source',502);
  const lines=structuredClone(response.lines),supplied=response.metadata.lyric_structure;
  if(supplied&&!validLyricStructure(supplied,lines))throw new LibraryError('invalid_source_structure',502);
  const structure=supplied??{version:'source-speakers-1',speakers:[],occurrences:lines.map((line,i)=>({sourceID:`L${String(i+1).padStart(4,'0')}`,
    sourceText:line.original,lyricText:line.original,speakerID:null,startsTurn:false,sourcePrefix:''}))};
  const names=Object.fromEntries(['title','artist','album'].flatMap(key=>{
    const value=key==='album'?response.song.album:response.song[key]?.original;
    return name(value)?[[key,value]]:[];
  }));
  const s={provider,itemID,...names,language:response.song.language,romanizationSystem:response.song.romanization_system,
    lines,structure:structuredClone(structure),...(response.metadata.lyric_timing?{lyricTiming:structuredClone(response.metadata.lyric_timing)}:{})};
  canonicalJSON(s);return s;
}
export function modelContextFromSource(s) {
  return {version:1,origin:'independent_lyric_source',source:{provider:s.provider,itemID:s.itemID},
    ...Object.fromEntries(['title','artist','album'].filter(key=>s[key]!==undefined).map(key=>[key,s[key]]))};
}
export function independentContextHash(s) {
  return spotifyHash(['independent-lyric-context-1',s.provider,s.itemID,s.title??null,s.artist??null,s.album??null]);
}
export function spotifyHashes(r,s,selectionRevision) {
  const recordingKey=spotifyRecordingKey(r),requestHash=spotifyRequestHash(r),contextHash=independentContextHash(s);
  const textRevision=spotifyHash(['spotify-text-2',s.language,s.structure.speakers,s.structure.occurrences.map(o=>[o.sourceID,o.sourceText,o.lyricText,o.speakerID??null,o.startsTurn,o.sourcePrefix])]);
  const timingRevision=spotifyHash(['spotify-timing-2',recordingKey,s.provider,s.itemID,textRevision,s.lines.map(l=>[l.original,l.timestamp??null,l.vocalTiming??null]),s.lyricTiming??null]);
  const readingRevision=spotifyHash(['spotify-reading-2',textRevision,s.romanizationSystem,s.lines.map(l=>l.romanized)]);
  const sourceHash=spotifyHash(['spotify-source-2',s.provider,s.itemID,contextHash,s.language,s.romanizationSystem,s.lines,s.structure,s.lyricTiming??null]);
  const documentID=spotifyHash(['spotify-document-2',recordingKey,sourceHash,selectionRevision]);
  return {recordingKey,requestHash,contextHash,textRevision,timingRevision,readingRevision,sourceHash,documentID};
}
export function synchronizationEligible(response) {
  const p=response.metadata?.lyric_timing;
  const lyrics={lines:response.lines,...(validTimingProvenance(p)?{
    source:independentProvider(response.metadata.source),songId:response.song.id,timingSource:{source:p.source,revision:p.revision},
    ...(p.durationResolution!==undefined?{durationResolution:p.durationResolution}:{})}:{})};
  return response.quality?.synced===true&&!response.quality.partial&&!response.quality.instrumental&&response.lines.length>0
    &&response.lines.every(l=>Number.isFinite(l.timestamp)&&l.timestamp>=0)
    &&timingQuality({song:{id:response.song.id,duration:response.song.duration},lyrics}).usable;
}
export function spotifyBinding(r,s,selectionRevision,response,{durable=false}={}) {
  const h=spotifyHashes(r,s,selectionRevision);
  return {version:2,provider:'spotify',itemID:r.item_id,requestedItemID:r.requested_item_id??null,market:r.market??null,
    recordingKey:h.recordingKey,requestHash:h.requestHash,documentID:durable?h.documentID:null,
    source:{provider:s.provider,itemID:s.itemID,metadataOrigin:'independent_lyric_source',contextHash:h.contextHash},
    sourceHash:h.sourceHash,textRevision:h.textRevision,timingRevision:h.timingRevision,readingRevision:h.readingRevision,selectionRevision,
    match:{method:'request_metadata_match',policy:SPOTIFY_MATCH_POLICY,spotifyCatalogVerified:false,acousticVerified:false},
    synchronizationEligible:synchronizationEligible(response)};
}
export function verifySpotifyBinding(binding,r,s,selectionRevision,response,{durable=false}={}) {
  const expected=spotifyBinding(r,s,selectionRevision,response,{durable});
  try {if(canonicalJSON(binding)!==canonicalJSON(expected))throw new Error();}
  catch {throw new LibraryError('recording_mismatch');}
  return expected;
}
