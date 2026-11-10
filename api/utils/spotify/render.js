import {LibraryError} from '../song-library/store.js';
import {verifySpotifyBinding,sourceCapsule} from '../song-library/spotify-recording.js';
import {displayText} from './display.js';
import {isRejectedRecordingLyrics} from '../rejected-lyrics.js';
const swift=ms=>ms/1000-978307200;
const bytes=v=>Buffer.byteLength(JSON.stringify(v));
export function validateDocument(doc,recording){
 if(!doc?.response||!doc.selectionRevision||doc.response.metadata?.selection_revision!==doc.selectionRevision)throw new LibraryError('recording_mismatch',409);
 if(isRejectedRecordingLyrics(doc.response.lines.map(l=>({text:l.original})),recording))throw new LibraryError('recording_mismatch',409);
 const b=verifySpotifyBinding(doc.recordingBinding,recording,sourceCapsule(doc.response),doc.selectionRevision,doc.response,{durable:true});
 if(b.documentID!==doc.id||b.recordingKey!==doc.recordingKey||['sourceHash','textRevision','timingRevision','readingRevision'].some(k=>b[k]!==doc[k]))throw new LibraryError('recording_mismatch',409);
 return b;
}
export function validateRecipe(r){
 const keys=['version','language','reading','pronunciationAbove','alignment','showPronunciation','showTranslation','translationTarget','readyTranslation','timingCorrection','deviceAid'];
 if(!r||Object.keys(r).some(k=>!keys.includes(k))||r.version!==1||typeof r.language!=='string'||r.language.length>64||!['sourceDefault','none','validatedDeviceAid'].includes(r.reading)||!['leading','centered'].includes(r.alignment)||['pronunciationAbove','showPronunciation','showTranslation'].some(k=>typeof r[k]!=='boolean')||r.translationTarget!==null&&typeof r.translationTarget!=='string')throw new LibraryError('invalid_request',400);
 if(r.readyTranslation!==null&&(!r.readyTranslation||typeof r.readyTranslation.documentID!=='string'||typeof r.readyTranslation.contentFingerprint!=='string')||r.deviceAid!==null&&(!r.deviceAid||typeof r.deviceAid.referenceID!=='string')||r.timingCorrection!==null&&(!r.timingCorrection||!Number.isFinite(r.timingCorrection.offsetSeconds)||Math.abs(r.timingCorrection.offsetSeconds)>600))throw new LibraryError('invalid_request',400);
 return structuredClone(r);
}
// A card is drawn about half a second after its publication is decided (measured
// 0.33-0.84 s on a phone). Choosing each cue this much early puts a line on screen
// just before it is sung. Only cue selection moves: the reported confirmation time
// and its eight-second deadline are unchanged.
export const leadSeconds=.65;
// A new sample can place playback slightly behind the previous estimate. The cue
// already shown is held instead of stepping back; a real seek exceeds this.
export const holdSeconds=.75;
const synchronized=(document,b)=>b.synchronizationEligible&&document.response.quality?.synced&&!document.response.quality.partial&&Array.isArray(document.response.lines)&&document.response.lines.length>0;
// The anchor is the returned progress. Bounded age interpolation is an estimate,
// never providerChangedAt-derived elapsed time. `origin` is the cue position at
// `anchor`; `position` is the one to display now.
function playhead(o,c,b,now){
 const correction=c.recipe.timingCorrection,offset=correction?.recordingKey===b.recordingKey&&correction.sourceHash===b.sourceHash&&correction.timingRevision===b.timingRevision&&c.validatedCorrection?correction.offsetSeconds:0;
 const anchor=o.responseReceivedAt??o.confirmedAt,origin=o.positionMS/1000-offset+leadSeconds;
 let position=origin+(o.playing?Math.max(0,now-anchor)/1000:0);
 const shown=c.shown;
 if(shown&&shown.occurrence===o.playbackOccurrence&&position<shown.position&&shown.position-position<=holdSeconds)position=shown.position;
 return {position,origin,anchor};
}
// Source rows are split at grapheme boundaries; the card identifies the segment
// instead of inventing truncated performed words or ellipses.
function segments(value,max=700){const result=[];let part='';for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)){if(bytes(part+segment)>max&&part){result.push(part);part='';}part+=segment;}if(part||!result.length)result.push(part);return result;}
export function renderState({observation:o,document,consumer:c,now,trace}){
 const fresh=o?.confirmedAt!=null&&now-o.confirmedAt<8000&&now>=o.confirmedAt;
 const state={recordingID:o?.recording?.item_id??'',title:o?.recording?.metadata.title??'Lyrica',artist:o?.recording?.metadata.artists.join(' & ')??'',lineID:'',original:'',pronunciation:'',translation:'',nextOriginal:'',rubyReadings:[],pronunciationAbove:c.recipe.pronunciationAbove,centered:c.recipe.alignment==='centered',artwork:null,progress:0,part:0,parts:1,phase:fresh?(o?.phase??'waiting'):'unavailable',playing:fresh&&Boolean(o?.playing),observedAt:swift(o?.confirmedAt??now-8000),sequence:c.sequence+1,provider:'spotify',observedDeviceName:typeof o?.deviceName==='string'&&bytes(segments(o.deviceName,256)[0])<=256?segments(o.deviceName,256)[0]:null,activityGeneration:c.generation,confirmedAt:swift(o?.confirmedAt??now-8000),validUntil:swift((o?.confirmedAt??now-8000)+8000),statusReason:fresh?(o?.reason??''):'updatesDelayed'};
 if(!fresh||!o.recording||!document)return state;
 let b;try{b=validateDocument(document,o.recording);}catch{return {...state,phase:'unavailable',statusReason:'recordingMismatch'};}
 Object.assign(state,...['recordingKey','sourceHash','textRevision','timingRevision','readingRevision'].map(k=>({[k]:b[k]})));
 const lines=document.response.lines;
 if(!synchronized(document,b))return {...state,phase:'untimed'};
 const {position}=playhead(o,c,b,now);if(trace)trace.position=position;
 let index=-1;for(let i=0;i<lines.length;i++)if(Number.isFinite(lines[i].timestamp)&&lines[i].timestamp<=position)index=i;
 if(index<0)return {...state,phase:'waiting'};
 const line=lines[index],end=lines[index+1]?.timestamp??o.recording.metadata.duration_ms/1000;
 const parts=segments(displayText(line.original??'',c.recipe.language)),fraction=Math.max(0,Math.min(.999999,(position-line.timestamp)/Math.max(.001,end-line.timestamp))),part=Math.floor(fraction*parts.length);
 Object.assign(state,{phase:'lyrics',lineID:document.structure?.occurrences?.[index]?.sourceID??`L${index+1}`,original:parts[part],parts:parts.length,part,progress:fraction*parts.length-part});
 if(c.recipe.showPronunciation&&c.recipe.reading!=='none'&&parts.length===1)state.pronunciation=typeof line.romanized==='string'&&bytes(line.romanized)<=500?line.romanized:'';
 if(c.recipe.showPronunciation&&c.recipe.reading==='validatedDeviceAid'&&c.validatedAid?.sourceHash===b.sourceHash&&c.validatedAid.textRevision===b.textRevision&&c.validatedAid.readingRevision===b.readingRevision&&parts.length===1)state.pronunciation=c.validatedAid.lines?.[index]?.pronunciation??state.pronunciation;
 if(c.recipe.showTranslation&&c.validatedTranslation?.sourceHash===b.sourceHash&&c.validatedTranslation.documentID===document.id&&parts.length===1)state.translation=c.validatedTranslation.lines?.[index]?.translation??'';
 const next=displayText(lines[index+1]?.original??'',c.recipe.language);
 state.nextOriginal=parts.length===1&&bytes(next)<=256?next:'';
 for(const key of ['title','artist']){state[key]=displayText(state[key],c.recipe.language);if(bytes(state[key])>256)state[key]='';}
 return state;
}
// When the displayed line or page next changes if playback continues from this
// observation, as a wall-clock time inside the observation's eight-second lease.
// Null when nothing is predictable: paused, untimed, no later cue, or lease over.
export function nextChangeAt({observation:o,document,consumer:c,now}){
 if(!o?.playing||o.confirmedAt==null||!o.recording||!document||!Number.isFinite(o.positionMS)||now<o.confirmedAt||now-o.confirmedAt>=8000)return null;
 let b;try{b=validateDocument(document,o.recording);}catch{return null;}
 if(!synchronized(document,b))return null;
 const lines=document.response.lines,{position,origin,anchor}=playhead(o,c,b,now);
 let index=-1,target=Infinity;
 for(let i=0;i<lines.length;i++){const t=lines[i].timestamp;if(!Number.isFinite(t))continue;if(t<=position)index=i;else if(t<target)target=t;}
 if(index>=0){
  const line=lines[index],end=lines[index+1]?.timestamp??o.recording.metadata.duration_ms/1000,span=Math.max(.001,end-line.timestamp),parts=segments(displayText(line.original??'',c.recipe.language)).length;
  for(let k=1;k<parts;k++){const t=line.timestamp+k*span/parts;if(t>position&&t<target){target=t;break;}}
 }
 if(target===Infinity)return null;
 // One millisecond late rather than early: the cue must already be selected.
 const at=Math.floor(anchor+(target-origin)*1000)+1;
 return at-o.confirmedAt<8000?Math.max(at,now):null;
}
export function immutablePush({state,consumer,now,event='update'}){
 const timestamp=Math.floor(now/1000);if(timestamp<=(consumer.lastTimestamp??0))throw new LibraryError('publication_coalesced',409);
 const attributes={schemaVersion:1,sessionID:consumer.sessionID,generation:consumer.generation,source:'spotify'};
 const payload={aps:{timestamp,event,'content-state':structuredClone(state),'stale-date':Math.floor((state.validUntil+978307200))}};
 if(event==='end')payload.aps['dismissal-date']=timestamp;
 const fits=()=>bytes(attributes)+bytes(payload.aps['content-state'])<=3900&&bytes(payload)<=3900;
 for(const key of ['artwork','nextOriginal','translation','rubyReadings','pronunciation']){if(fits())break;payload.aps['content-state'][key]=key==='artwork'?null:key==='rubyReadings'?[]:'';}
 if(!fits()){Object.assign(payload.aps['content-state'],{original:'',pronunciation:'',translation:'',nextOriginal:'',rubyReadings:[],phase:'unavailable',playing:false,statusReason:'lyricSegmentTooLarge'});}
 if(!fits())throw new LibraryError('spotify_payload_too_large',500);
 return {payload,timestamp,sequence:state.sequence,tokenVersion:consumer.tokenVersion,generation:consumer.generation,confirmedAt:(state.confirmedAt+978307200)*1000,expiresAt:(state.validUntil+978307200)*1000,priority:event==='end'?10:consumer.frequentPushesEnabled?10:5};
}
