import {createHash} from 'node:crypto';
import {LibraryError} from './store.js';
import {canonicalJSON,spotifyHash} from './spotify-recording.js';
import {analyzeLyricLanguage} from '../lyric-language.js';
import {getDefaultRomanizationSystem} from '../language-detection.js';
import {validVocalTiming} from '../vocal-timing.js';
import {validLyricStructure,hasEmbeddedLyricCredits} from '../lyric-annotations.js';

export const SELECTED_SOURCE_REVISION='selected-lyrics-learning-1';
const providers={lrclib:'LRCLIB',netease:'NetEase',kugou:'Kugou'};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=1024)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(v);
const item=v=>typeof v==='string'&&/^[1-9]\d{0,19}$/.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function selectedSourceRequest(v) {
  if(!object(v)||Object.keys(v).some(k=>!['provider','itemID','query','expectedTextHash'].includes(k))
    ||!Object.hasOwn(providers,v.provider)||!item(v.itemID)||!hash(v.expectedTextHash)
    ||(v.query!==undefined&&!text(v.query,500))||(v.provider==='kugou'&&!text(v.query,500)))
    throw new LibraryError('invalid_selected_source',400);
  return {...v};
}
export function selectedTextHash(rows) {
  const h=createHash('sha256').update('selected-source-text-1\n','utf8');
  for(const row of rows){
    const value=typeof row==='string'?row:row.text??row.original;
    if(typeof value!=='string')throw new LibraryError('invalid_source',502);
    const bytes=Buffer.from(value,'utf8');h.update(String(bytes.length)+':','utf8');h.update(bytes);
  }
  return h.digest('hex');
}
export const selectedSourceDescriptor=s=>({version:1,provider:s.provider,itemID:s.itemID,textHash:selectedTextHash(s.lines)});
export const selectedDocumentFromRow=row=>row?.selected_source?{id:row.id,recordingKey:row.recording_key,sourceHash:row.source_hash,
  textRevision:row.text_revision,timingRevision:row.timing_revision,readingRevision:row.reading_revision,
  selectionRevision:row.selection_revision,canonicalRecordingID:row.canonical_recording_id??null,
  response:row.response,structure:row.structure,selectedSourceCapsule:row.selected_source,
  selectedSource:selectedSourceDescriptor(row.selected_source),modelContext:row.model_context}:null;
const context=s=>({version:1,origin:'selected_lyric_source',source:{provider:s.provider,itemID:s.itemID},
  title:s.title,artist:s.artist,...(s.album!==null?{album:s.album}:{})});
function hashes(s) {
  const sourceHash=spotifyHash(['selected-provider-source-1',s]);
  const textRevision=spotifyHash(['selected-lyrics-text-1',s.language,s.structure]);
  return {sourceHash,recordingKey:spotifyHash(['selected-lyrics-recording-1',s.provider,s.itemID]),
    id:spotifyHash(['selected-lyrics-document-1',sourceHash,SELECTED_SOURCE_REVISION]),textRevision,
    timingRevision:spotifyHash(['selected-lyrics-timing-1',textRevision,s.sourceTiming]),
    readingRevision:spotifyHash(['selected-lyrics-reading-1',textRevision,s.romanizationSystem,s.lines.map(l=>l.romanized)])};
}
export async function makeSelectedDocument(candidate,request,{analyzeLanguageFn=analyzeLyricLanguage,getProcessorFn}={}) {
  request=selectedSourceRequest(request);
  if(!candidate||candidate.provider!==request.provider||candidate.itemID!==request.itemID
    ||!text(candidate.title,500)||!text(candidate.artist)||candidate.album!==undefined&&!text(candidate.album)
    ||candidate.duration!==undefined&&(!Number.isFinite(candidate.duration)||candidate.duration<=0||candidate.duration>86400)
    ||!Array.isArray(candidate.lines)||!candidate.lines.length||candidate.lines.length>250
    ||candidate.lines.some(l=>!text(l.text,4000))||Buffer.byteLength(JSON.stringify(candidate))>200000)
    throw new LibraryError('invalid_source',502);
  // Freeze provider-owned inputs before asynchronous pronunciation work. The
  // preview hash binds the visible words; canonical cue evidence is separately
  // validated and then included in the immutable source capsule/hash.
  candidate=structuredClone(candidate);
  if(selectedTextHash(candidate.lines)!==request.expectedTextHash)throw new LibraryError('selected_source_changed');
  const canonical=candidate.lyricStructure;
  const originals=candidate.lines.map(l=>({original:l.text}));
  if(canonical&&!validLyricStructure(canonical,originals))throw new LibraryError('invalid_source_structure',502);
  if(hasEmbeddedLyricCredits({lines:originals,metadata:{lyric_structure:canonical}}))
    throw new LibraryError('selected_source_changed');
  const details=analyzeLanguageFn(candidate.lines.map(l=>l.text));
  // Processors use pronunciation aids, which in turn validate library context.
  // Resolve the registry after module initialization rather than creating a
  // model-context -> selected-source -> processor initialization cycle.
  const system=getDefaultRomanizationSystem(details.pronunciation_language);
  const processor=system==='none'?null:(getProcessorFn??(await import('../../processors/index.js')).getProcessor)(details.pronunciation_language);
  const lines=await Promise.all(candidate.lines.map(async l=>({original:l.text,romanized:processor?(await processor.romanize(l.text,system,{tone_style:'marks',separator:' ',case:'lower'})).romanized:l.text,timestamp:null})));
  if(lines.some(l=>typeof l.romanized!=='string'||l.romanized.length>16000))throw new LibraryError('invalid_source',502);
  const structure={version:'source-speakers-1',speakers:[],occurrences:lines.map((l,i)=>({sourceID:`L${String(i+1).padStart(4,'0')}`,
    sourceText:l.original,lyricText:l.original,speakerID:null,startsTurn:false,sourcePrefix:''}))};
  const s={version:'selected-provider-source-1',provider:request.provider,itemID:request.itemID,title:candidate.title,artist:candidate.artist,
    album:candidate.album??null,duration:candidate.duration??null,language:details.primary,romanizationSystem:system,lines,structure,
    ...(canonical?{lyricStructure:canonical}:{}),
    sourceTiming:candidate.lines.map(l=>({timestamp:Number.isFinite(l.timestamp)&&l.timestamp>=0?l.timestamp:null,
      ...(validVocalTiming(l,{duration:candidate.duration??7200})?{vocalTiming:structuredClone(l.vocalTiming)}:{})}))};
  const h=hashes(s);
  const response={song:{id:s.itemID,title:{original:s.title,romanized:s.title},artist:{original:s.artist,romanized:s.artist},album:s.album,duration:s.duration,
    language:s.language,romanization_system:s.romanizationSystem},lines,quality:{synced:false,partial:false,instrumental:false},
    metadata:{version:'2.5.0',timestamp:new Date().toISOString(),source:providers[s.provider],music_api:s.provider,
      selection_revision:SELECTED_SOURCE_REVISION,language_details:details,...(canonical?{lyric_structure:canonical}:{})}};
  return {...h,selectionRevision:SELECTED_SOURCE_REVISION,canonicalRecordingID:null,response,structure,
    selectedSourceCapsule:s,selectedSource:selectedSourceDescriptor(s),modelContext:context(s)};
}
// The selected-source trust boundary is independent of recording bindings and
// cannot be created by a metadata flag on an automatic document.
export function validateSelectedDocument(doc) {
  try {
    const s=doc.selectedSourceCapsule;
    if(!s||s.version!=='selected-provider-source-1'||!Object.hasOwn(providers,s.provider)||!item(s.itemID)
      ||!text(s.title,500)||!text(s.artist)||!s.lines?.length||s.lines.length>250||s.lines.some(l=>!text(l.original,4000)||typeof l.romanized!=='string'||l.timestamp!==null||l.vocalTiming)
      ||s.sourceTiming?.length!==s.lines.length||s.structure?.version!=='source-speakers-1'
      ||doc.selectionRevision!==SELECTED_SOURCE_REVISION||doc.sourceCapsule||doc.canonicalRecordingID!=null||doc.recordingBinding||doc.requestRecording||doc.requestEvidence||doc.requestKey)
      throw new Error();
    if(s.lyricStructure&&!validLyricStructure(s.lyricStructure,s.lines))throw new Error();
    if(canonicalJSON(doc.response.metadata.lyric_structure??null)!==canonicalJSON(s.lyricStructure??null))throw new Error();
    const h=hashes(s),song=doc.response.song;
    if(Object.entries(h).some(([k,v])=>doc[k]!==v)||canonicalJSON(doc.modelContext)!==canonicalJSON(context(s))
      ||canonicalJSON(doc.selectedSource)!==canonicalJSON(selectedSourceDescriptor(s))||canonicalJSON(doc.structure)!==canonicalJSON(s.structure)
      ||canonicalJSON(doc.response.lines)!==canonicalJSON(s.lines)||song.id!==s.itemID||song.title.original!==s.title||song.artist.original!==s.artist
      ||(song.album??null)!==s.album||(song.duration??null)!==s.duration||song.language!==s.language||song.romanization_system!==s.romanizationSystem
      ||doc.response.metadata.music_api!==s.provider||doc.response.metadata.source!==providers[s.provider]
      ||s.structure.speakers.length!==0||s.structure.occurrences.length!==s.lines.length
      ||s.structure.occurrences.some((o,i)=>o.sourceID!==`L${String(i+1).padStart(4,'0')}`||o.sourceText!==s.lines[i].original||o.lyricText!==s.lines[i].original||o.speakerID!==null||o.startsTurn||o.sourcePrefix!==''))throw new Error();
    return context(s);
  } catch {throw new LibraryError('source_context_unavailable');}
}
