// Required native SongLibraryDocument / LyricsResponse decoding fields.
// Keep provider-normalized values; never invent missing readings or provenance.
import {LibraryError} from '../song-library/store.js';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const string=v=>typeof v==='string';
const nonblank=v=>string(v)&&v.trim().length>0;
export function validatePreparedDocumentWire(d){
 const bad=()=>{throw new LibraryError('invalid_prepared_document',422);};
 if(!d||![d.id,d.sourceHash,d.recordingKey].every(hash)||!nonblank(d.selectionRevision))bad();
 for(const key of ['textRevision','timingRevision','readingRevision'])if(d[key]!=null&&!hash(d[key]))bad();
 const r=d.response,s=r?.song,m=r?.metadata,q=r?.quality,structure=d.structure;
 if(d.selectedSource!=null||d.recordingBinding!=null||r?.recordingBinding!=null||r?.library!=null)bad();
 if(!s||!m||!q||!Array.isArray(r.lines)||!r.lines.length||r.lines.length>250)bad();
 for(const text of [s.title,s.artist])if(!text||!nonblank(text.original)||!string(text.romanized))bad();
 if(!(Number.isSafeInteger(s.id)&&s.id>=0||string(s.id)&&s.id.length>0&&Buffer.byteLength(s.id)<=128&&!/[\s\p{Cc}]/u.test(s.id))||!nonblank(s.language)||!nonblank(s.romanization_system))bad();
 if(s.album!=null&&!string(s.album)||s.duration!=null&&(!Number.isFinite(s.duration)||s.duration<=0||s.duration>7200))bad();
 if(q.synced!==true||q.partial!==undefined&&typeof q.partial!=='boolean'||q.instrumental!==undefined&&typeof q.instrumental!=='boolean'||q.partial===true||q.instrumental===true)bad();
 if(!string(m.timestamp)||!nonblank(m.version))bad();
 for(const field of ['source','detected_script','processor','music_api','selection_revision'])if(m[field]!=null&&!string(m[field]))bad();
 if(m.processing_time!=null&&!Number.isSafeInteger(m.processing_time))bad();
 if(!structure||structure.version!=='source-speakers-1'||!Array.isArray(structure.speakers)||!Array.isArray(structure.occurrences)||structure.occurrences.length!==r.lines.length)bad();
 const ids=new Set();for(const speaker of structure.speakers){if(!nonblank(speaker.id)||!string(speaker.sourceLabel)||!string(speaker.displayName)||ids.has(speaker.id))bad();ids.add(speaker.id);}
 for(const [index,line] of r.lines.entries()){
  if(!nonblank(line.original)||!string(line.romanized)||line.timestamp!=null&&(!Number.isFinite(line.timestamp)||line.timestamp<0||line.timestamp>7200))bad();
  const o=structure.occurrences[index];
  if(!o||o.sourceID!==`L${String(index+1).padStart(4,'0')}`||!string(o.sourceText)||!nonblank(o.lyricText)||!string(o.sourcePrefix)||typeof o.startsTurn!=='boolean'||
   o.sourceText!==line.original||o.sourcePrefix+o.lyricText!==o.sourceText||o.speakerID!=null&&!ids.has(o.speakerID)||o.startsTurn&&(!o.speakerID||!o.sourcePrefix))bad();
 }
 return d;
}
