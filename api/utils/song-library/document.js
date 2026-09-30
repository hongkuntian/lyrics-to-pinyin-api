import {digest,LibraryError} from './store.js';
import {reviewedSpeakerLabels,validLyricStructure} from '../lyric-annotations.js';

// Source metadata carried forward from the reviewed corpus, not guessed from arbitrary colons.
export function recordingRequest(value) {
  const keys=['catalog_id','artist','title','album','duration','storefront','account_storefront','isrc'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||
    typeof value.catalog_id!=='string'||!/^\d{1,20}$/.test(value.catalog_id)||
    ['artist','title'].some(k=>typeof value[k]!=='string'||!value[k].trim()||value[k].length>500)||
    (value.album!=null&&(typeof value.album!=='string'||value.album.length>500))||
    !Number.isFinite(value.duration)||value.duration<=0||value.duration>7200||
    (value.storefront!=null&&(typeof value.storefront!=='string'||!/^[a-z]{2}$/.test(value.storefront)))||
    (value.account_storefront!=null&&(typeof value.account_storefront!=='string'||!/^[a-z]{2}$/.test(value.account_storefront)))||
    (value.isrc!=null&&(typeof value.isrc!=='string'||!/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(value.isrc)))) throw new LibraryError('invalid_recording',400);
  return {catalog_id:value.catalog_id,artist:value.artist.trim(),title:value.title.trim(),album:value.album??null,
    duration:value.duration,storefront:value.storefront??null,...(value.account_storefront?{account_storefront:value.account_storefront}:{}),...(value.isrc?{isrc:value.isrc}:{})};
}
export const requestKey=request=>{const {account_storefront,isrc,...identity}=recordingRequest(request);return digest(identity);};
export function makeDocument(request,response,selectionRevision,labels=reviewedSpeakerLabels(request.catalog_id)) {
  request=recordingRequest(request);
  if(!response?.song||!Array.isArray(response.lines)||!response.metadata||!response.quality) throw new LibraryError('invalid_source',502);
  if(response.quality.partial || !response.lines.length || response.quality.instrumental) throw new LibraryError('source_incomplete',422);
  if(response.lines.length>250 || Buffer.byteLength(JSON.stringify(response))>160_000) throw new LibraryError('source_too_large',422);
  if(response.lines.some(l=>typeof l.original!=='string'||!l.original.trim()||/[\r\n]/.test(l.original)||l.original.length>2000||typeof l.romanized!=='string'||
    (l.timestamp!=null&&(!Number.isFinite(l.timestamp)||l.timestamp<0)))) throw new LibraryError('invalid_source',502);
  const normalized=response.metadata.lyric_structure;
  if(normalized && !validLyricStructure(normalized,response.lines)) throw new LibraryError('invalid_source_structure',502);
  const speakers=normalized?.speakers??Object.entries(labels).map(([sourceLabel,displayName],i)=>({id:`S${i+1}`,sourceLabel,displayName}));
  let active=null;const seen=new Set();
  const occurrences=normalized?.occurrences??response.lines.map((line,i)=> {
    let prefix='';
    for(const speaker of speakers) {
      if(line.original.startsWith(speaker.sourceLabel+':')||line.original.startsWith(speaker.sourceLabel+'：')) {
        prefix=line.original.slice(0,speaker.sourceLabel.length+1);
        prefix+=line.original.slice(prefix.length).match(/^[ \t]*/)[0];active=speaker.id;seen.add(active);break;
      }
    }
    const lyricText=line.original.slice(prefix.length);
    if(!lyricText.trim()) throw new LibraryError('invalid_source',502);
    return {sourceID:`L${String(i+1).padStart(4,'0')}`,sourceText:line.original,lyricText,speakerID:active,startsTurn:Boolean(prefix),sourcePrefix:prefix};
  });
  if(!normalized && speakers.some(s=>!seen.has(s.id))) throw new LibraryError('source_speaker_metadata_changed',422);
  const structure=normalized??{version:'source-speakers-1',speakers,occurrences};
  // Preserve recording and exact ordered source; local IDs are generated from occurrence position.
  // Provider fetch timestamps and model versions do not expire a durable document.
  const recordingKey=digest({catalogID:request.catalog_id,storefront:request.storefront});
  const sourceHash=digest({language:response.song.language,lines:response.lines,structure});
  const id=digest({recordingKey,sourceHash});
  const resolution=response.metadata.catalog_resolution;
  const accepted=resolution?.accepted_request;
  const canonicalRecordingID=resolution?.version==='catalog-recording-1'&&resolution.requested?.catalog_id===request.catalog_id
    && resolution.requested?.storefront===request.storefront
    && accepted?.catalog_id===request.catalog_id&&accepted.artist===request.artist&&accepted.title===request.title
    && (accepted.album??null)===request.album&&accepted.duration===request.duration
    && resolution.catalog_items?.some(item=>item.catalog_id===request.catalog_id)
    && /^apple:\d{1,20}$/.test(resolution.canonical_recording_id)?resolution.canonical_recording_id:null;
  const textRevision=digest({language:response.song.language,speakers:structure.speakers,occurrences:structure.occurrences.map(o=>({sourceID:o.sourceID,lyricText:o.lyricText,speakerID:o.speakerID,startsTurn:o.startsTurn,sourcePrefix:o.sourcePrefix}))});
  return {id,recordingKey,sourceHash,requestKey:requestKey(request),selectionRevision,response,structure,canonicalRecordingID,textRevision,
    timingRevision:digest({recording:canonicalRecordingID??recordingKey,textRevision,timestamps:response.lines.map(l=>l.timestamp??null)}),
    readingRevision:digest({textRevision,system:response.song.romanization_system,readings:response.lines.map(l=>l.romanized)})};
}
