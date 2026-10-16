import {randomUUID} from 'node:crypto';
import {sha} from './vault.js';
// Mirrors the frozen scalar tuple only; the authoritative parser is the shared
// Song Library V2 parser. No request metadata is promoted into source context.
export function requestFingerprint(r){const m=r.metadata;return sha(JSON.stringify(['spotify-request-2',r.item_id,r.requested_item_id??null,r.market??null,m.title,m.artists,m.album??null,m.duration_ms,m.isrc??null,m.explicit??null]));}
export const recordingFingerprint=r=>sha(JSON.stringify(['spotify-recording-2',r.item_id]));
const name=x=>typeof x==='string'&&x.trim()&&[...x].length<=500&&!/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(x);
export function observedRecording(item){
 if(!item||item.type!=='track'||item.is_local||!/^[A-Za-z0-9]{22}$/.test(item.id??'')||!name(item.name)||!Array.isArray(item.artists)||!item.artists.length||item.artists.length>32||item.artists.some(a=>!name(a.name))||!Number.isSafeInteger(item.duration_ms)||item.duration_ms<1||item.duration_ms>7200000)return null;
 const metadata={origin:'spotify',title:item.name,artists:item.artists.map(a=>a.name),duration_ms:item.duration_ms};
 if(name(item.album?.name))metadata.album=item.album.name;
 if(/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(item.external_ids?.isrc??''))metadata.isrc=item.external_ids.isrc;
 if(typeof item.explicit==='boolean')metadata.explicit=item.explicit;
 return {version:2,provider:'spotify',item_id:item.id,metadata};
}
export function observePlayback(sample,previous,ordinal){
 const {body,status,requestStartedAt,responseReceivedAt}=sample,rttMs=responseReceivedAt-requestStartedAt;
 const base={requestStartedAt,responseReceivedAt,rttMs,pollOrdinal:ordinal,providerChangedAtMs:body?.timestamp??null,confirmedAt:null,recording:null,positionMS:null,playing:false,phase:'unavailable',playbackOccurrence:previous?.playbackOccurrence??randomUUID(),deviceName:typeof body?.device?.name==='string'?body.device.name.slice(0,256):'',deviceID:body?.device?.id??null};
 if(rttMs<0||rttMs>=2000||status!==200&&status!==204)return {...base,reason:'observationUnavailable'};
 if(status===204)return {...base,confirmedAt:responseReceivedAt,phase:'waiting',reason:'noPlayback'};
 if(!Number.isSafeInteger(body?.timestamp)||body.timestamp>responseReceivedAt+2000||previous?.providerChangedAtMs>body.timestamp)return {...base,reason:'regressingObservation'};
 const recording=observedRecording(body.item);
 if(!recording||body.currently_playing_type&&body.currently_playing_type!=='track')return {...base,confirmedAt:responseReceivedAt,reason:'unsupportedItem'};
 if(!Number.isSafeInteger(body.progress_ms)||body.progress_ms<0||body.progress_ms>recording.metadata.duration_ms||typeof body.is_playing!=='boolean')return {...base,reason:'missingProgress'};
 const changed=!previous?.recording||requestFingerprint(previous.recording)!==requestFingerprint(recording)||previous.deviceID!==base.deviceID||body.progress_ms<(previous.positionMS??0)-1000;
 return {...base,confirmedAt:responseReceivedAt,recording,requestHash:requestFingerprint(recording),positionMS:body.progress_ms,playing:body.is_playing,phase:'loading',playbackOccurrence:changed?randomUUID():base.playbackOccurrence};
}
