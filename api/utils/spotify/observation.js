import {randomUUID} from 'node:crypto';
import {spotifyRequestHash,spotifyRecordingKey} from '../song-library/spotify-recording.js';
export const requestFingerprint=spotifyRequestHash;
export const recordingFingerprint=spotifyRecordingKey;
const name=x=>typeof x==='string'&&x.trim()&&[...x].length<=500&&!/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(x);
export function observedRecording(item){
 if(!item||item.type!=='track'||item.is_local||!/^[A-Za-z0-9]{22}$/.test(item.id??'')||!name(item.name)||!Array.isArray(item.artists)||!item.artists.length||item.artists.length>32||item.artists.some(a=>!name(a.name))||!Number.isSafeInteger(item.duration_ms)||item.duration_ms<1||item.duration_ms>7200000)return null;
 const metadata={origin:'spotify',title:item.name,artists:item.artists.map(a=>a.name),duration_ms:item.duration_ms};
 const artistIDs=item.artists.map(a=>a.id);
 if(artistIDs.every(v=>typeof v==='string'&&/^[A-Za-z0-9]{22}$/.test(v))&&new Set(artistIDs).size===artistIDs.length)metadata.artist_ids=artistIDs;
 if(name(item.album?.name))metadata.album=item.album.name;
 if(/^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(item.external_ids?.isrc??''))metadata.isrc=item.external_ids.isrc;
 if(typeof item.explicit==='boolean')metadata.explicit=item.explicit;
 return {version:2,provider:'spotify',item_id:item.id,metadata};
}
export function observePlayback(sample,previous,ordinal){
 const {body,status,requestStartedAt,responseReceivedAt}=sample,rttMs=responseReceivedAt-requestStartedAt;
 const base={requestStartedAt,responseReceivedAt,rttMs,pollOrdinal:ordinal,providerChangedAtMs:body?.timestamp??null,confirmedAt:null,recording:null,positionMS:null,playing:false,phase:'unavailable',playbackOccurrence:previous?.playbackOccurrence??randomUUID(),deviceName:typeof body?.device?.name==='string'?body.device.name.slice(0,256):'',deviceID:body?.device?.id??null};
 if(rttMs<0||rttMs>=2000||status!==200&&status!==204)return {...base,reason:'observationUnavailable'};
 if(status===204)return {...base,confirmedAt:requestStartedAt,phase:'waiting',reason:'noPlayback'};
 if(!Number.isSafeInteger(body?.timestamp)||body.timestamp>responseReceivedAt+2000||previous?.providerChangedAtMs>body.timestamp)return {...base,reason:'regressingObservation'};
 const recording=observedRecording(body.item);
 if(!recording||body.currently_playing_type&&body.currently_playing_type!=='track')return {...base,confirmedAt:requestStartedAt,reason:'unsupportedItem'};
 if(!Number.isSafeInteger(body.progress_ms)||body.progress_ms<0||body.progress_ms>recording.metadata.duration_ms||typeof body.is_playing!=='boolean')return {...base,reason:'missingProgress'};
 const expected=(previous?.positionMS??body.progress_ms)+(previous?.playing&&previous.confirmedAt!=null?Math.max(0,responseReceivedAt-previous.responseReceivedAt):0);
 const changed=Math.abs(body.progress_ms-expected)>3000||!previous?.recording||requestFingerprint(previous.recording)!==requestFingerprint(recording)||previous.deviceID!==base.deviceID||body.progress_ms<(previous.positionMS??0)-1000;
 const stagnant=body.is_playing&&previous?.playing&&previous.recording&&requestFingerprint(previous.recording)===requestFingerprint(recording)&&previous.deviceID===base.deviceID&&body.progress_ms===previous.positionMS&&requestStartedAt-previous.requestStartedAt>=1500;
 const stalledSamples=stagnant?(previous.stalledSamples??0)+1:0;
 // The provider's timestamp describes a state change, not how old this response
 // is. Never extend freshness through a stationary clock reported as playing.
 return {...base,confirmedAt:stalledSamples>=3?null:requestStartedAt,recording,requestHash:requestFingerprint(recording),positionMS:body.progress_ms,playing:body.is_playing,stalledSamples,phase:stalledSamples>=3?'unavailable':'loading',reason:stalledSamples>=3?'playbackStalled':'',playbackOccurrence:changed?randomUUID():base.playbackOccurrence};
}
