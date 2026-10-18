import {randomUUID} from 'node:crypto';
import {LibraryError} from '../song-library/store.js';
export const fail=(code,status=409)=>{throw new LibraryError(code,status);};
export const uuid=v=>typeof v==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(v);
export function text(value,max,fallback){if((value===undefined||value==='')&&fallback!==undefined)return fallback;if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\x00-\x1f\x7f]/.test(value))fail('invalid_request',400);return value.trim();}
export function validateTrack(track,provider){
 if(!track||track.provider!==provider||typeof track.id!=='string'||!(provider==='spotify'?/^[A-Za-z0-9]{22}$/:/^\d{1,20}$/).test(track.id))fail('invalid_recording',400);
 const durationMS=track.durationMS;if(!Number.isSafeInteger(durationMS)||durationMS<1000||durationMS>86400000)fail('invalid_recording',400);
 let artworkURL=null;
 if(track.artworkURL){try{const url=new URL(track.artworkURL);if(url.protocol!=='https:'||url.username||url.password||url.port||!(/(^|\.)mzstatic\.com$/.test(url.hostname)||url.hostname==='i.scdn.co'))fail('invalid_recording',400);artworkURL=url.href;}catch{fail('invalid_recording',400);}}
 return {provider,id:track.id,title:text(track.title,300),artist:text(track.artist,500),album:text(track.album,300,''),durationMS,artworkURL};
}
export function newRoom(user,input,now){
 if(!uuid(input.sessionID)||!['appleMusic','spotify'].includes(input.provider)||typeof input.shareName!=='boolean')fail('invalid_request',400);
 const member={id:randomUUID(),userID:user.id,name:text(input.name,40),shareName:input.shareName,joinedAtMS:now,leftAtMS:null};
 return {stateVersion:0,id:input.sessionID,provider:input.provider,title:text(input.title,80),revision:0,status:'active',createdAtMS:now,expiresAtMS:now+8*3600000,endedAtMS:null,
  host:{userID:user.id,keyID:user.keyID,credentialDigest:user.credentialDigest,memberID:member.id},members:[member],entries:[],retiredEntries:[],history:[],playback:{state:'waiting',entryID:null,positionMS:0,playing:false,observedAtMS:null},
  providerState:{started:false,leaseID:null,lastSequence:0,appliedRevision:0,appliedOrder:[],lastSpotifyOrdinal:-1},shared:false,storefront:/^[a-z]{2}$/.test(input.storefront??'')?input.storefront:'us'};
}
export function memberOf(room,user){const member=room.members.find(m=>m.userID===user?.id&&m.leftAtMS===null);if(!member)fail('session_not_found',404);return member;}
export function requireHost(room,user,device=false){memberOf(room,user);if(room.host.userID!==user.id)fail('host_required',403);if(device&&room.host.keyID!==user.keyID)fail('host_device_required',403);}
export function upcoming(room){const index=room.entries.findIndex(e=>e.id===room.playback.entryID);return room.entries.slice(room.providerState.started&&index>=0?index+1:0);}
export function applyCommand(room,user,input,now){
 if(input.action==='join'){
  if(room.status!=='active'||room.expiresAtMS<=now)fail('session_ended',410);
  if(typeof input.shareName!=='boolean')fail('invalid_request',400);
  let member=room.members.find(m=>m.userID===user.id);
  if(!member){if(room.members.length>=25)fail('session_full');member={id:randomUUID(),userID:user.id,joinedAtMS:now};room.members.push(member);}
  Object.assign(member,{name:text(input.name,40),shareName:input.shareName,leftAtMS:null});return;
 }
 const member=memberOf(room,user);
 if(input.action==='profile'){const name=text(input.name,40);if(typeof input.shareName!=='boolean')fail('invalid_request',400);Object.assign(member,{name,shareName:input.shareName});return;}
 if(input.action==='leave'){if(room.host.userID===user.id)fail('host_must_end');member.leftAtMS=now;return;}
 if(room.status!=='active'||room.expiresAtMS<=now)fail('session_ended',410);
 if(['add','remove','reorder','begin','end'].includes(input.action)&&input.revision!==room.revision)fail('session_revision_changed');
 if(['add','remove','reorder'].includes(input.action)&&room.provider==='spotify'&&room.providerState.syncPending)fail('session_queue_syncing');
 switch(input.action){
 case 'add':
  if(room.entries.length+room.retiredEntries.length>=100)fail('session_queue_full');
  if(!uuid(input.entryID)||room.entries.some(e=>e.id===input.entryID))fail('invalid_request',400);
  room.entries.push({id:input.entryID,track:validateTrack(input.track,room.provider),contributorID:member.id,addedAtMS:now});break;
 case 'remove':{
  if(!upcoming(room).some(e=>e.id===input.entryID))fail('upcoming_only');
  room.retiredEntries.push(room.entries.find(e=>e.id===input.entryID));
  room.entries=room.entries.filter(e=>e.id!==input.entryID);break;
 }
 case 'reorder':{
  const next=upcoming(room),ids=next.map(e=>e.id);
  if(!Array.isArray(input.order)||new Set(input.order).size!==ids.length||input.order.length!==ids.length||input.order.some(id=>!ids.includes(id)))fail('invalid_queue_order',400);
  room.entries=[...room.entries.slice(0,room.entries.length-next.length),...input.order.map(id=>next.find(e=>e.id===id))];break;
 }
 case 'begin':
  requireHost(room,user,true);if(!room.entries.length)fail('session_queue_empty');if(!uuid(input.leaseID))fail('invalid_request',400);
  room.providerState.observationOrder=room.entries.map(e=>e.id);
  room.providerState.started=true;room.providerState.leaseID=input.leaseID;room.providerState.lastSequence=0;
  if(input.entryID&&!upcoming(room).some(e=>e.id===input.entryID))fail('upcoming_only');
  room.playback={state:'starting',entryID:input.entryID??room.playback.entryID??room.entries[0].id,positionMS:0,playing:false,observedAtMS:null};break;
 case 'end':
  requireHost(room,user);room.status='ended';room.endedAtMS=now;room.playback.playing=false;room.playback.state='ended';break;
 default:fail('invalid_request',400);
 }
 room.revision++;
}
function capture(room,entry,positionMS,playing,now){
 room.playback={state:'connected',entryID:entry.id,positionMS,playing,observedAtMS:now};
 if(!playing)return;
 const prior=room.history.find(h=>h.entryID===entry.id);
 if(prior?.entryID===entry.id){prior.lastObservedAtMS=now;return;}
 room.history.push({id:randomUUID(),entryID:entry.id,track:structuredClone(entry.track),contributorID:entry.contributorID,startedAtMS:now,lastObservedAtMS:now});
}
export function observeApple(room,user,input,now){
 requireHost(room,user,true);
 if(room.provider!=='appleMusic'||room.status!=='active'||!room.providerState.started||input.leaseID!==room.providerState.leaseID)fail('session_playback_replaced');
 if(!Number.isSafeInteger(input.sequence)||input.sequence<1)fail('invalid_request',400);
 if(input.sequence<=room.providerState.lastSequence)return;
 const entry=room.entries.find(e=>e.id===input.entryID)??room.retiredEntries.find(e=>e.id===input.entryID);
 if(!entry||input.trackID!==entry.track.id)fail('recording_changed');
 if(typeof input.playing!=='boolean'||!Number.isSafeInteger(input.positionMS)||input.positionMS<0||input.positionMS>entry.track.durationMS+2000)fail('invalid_observation',400);
 if(!room.entries.some(e=>e.id===entry.id)){
  // The exact MusicKit occurrence can start while its removal is in flight.
  // Preserve that observed fact rather than fabricating a skip or losing credit.
  const cursor=room.entries.findIndex(e=>e.id===room.playback.entryID);
  room.entries.splice(cursor+1,0,entry);room.retiredEntries=room.retiredEntries.filter(e=>e.id!==entry.id);room.revision++;room.providerState.syncPending=true;
 }
 room.providerState.lastSequence=input.sequence;capture(room,entry,input.positionMS,input.playing,now);
}
export function observeSpotify(room,sample,ordinal,now){
 if(room.status!=='active'||!room.providerState.started||ordinal<=room.providerState.lastSpotifyOrdinal)return;
 room.providerState.lastSpotifyOrdinal=ordinal;
 if(sample?.contextURI!=='spotify:playlist:'+room.providerState.playlistID||sample?.deviceID!==room.providerState.deviceID){room.playback.state='detached';room.playback.playing=false;room.playback.observedAtMS=now;return;}
 if(room.providerState.syncPending||room.providerState.appliedRevision!==room.revision||!Array.isArray(sample.queue))return;
 const order=room.providerState.appliedOrder.map(id=>room.entries.find(e=>e.id===id));
 if(order.some(e=>!e))return;
 const candidates=order.map((entry,index)=>({entry,index,tail:order.slice(index+1).map(e=>e.track.id)}))
  .filter(c=>c.entry.track.id===sample.trackID&&sample.queue.length>=Math.min(c.tail.length,20)&&c.tail.slice(0,20).every((id,index)=>sample.queue[index]===id));
 // Prefer the longest exact remaining context suffix. An earlier duplicate has
 // more expected upcoming entries than its later occurrence. Unrelated native
 // queue prefixes and delayed provider state cannot silently bind by title.
 candidates.sort((a,b)=>b.tail.length-a.tail.length);
 const candidate=candidates[0];
 const retained=(room.providerState.observationOrder??[]).map(id=>room.entries.find(e=>e.id===id)??room.retiredEntries.find(e=>e.id===id)).filter(Boolean);
 const retainedCursor=retained.findIndex(e=>e.id===room.playback.entryID);
 const possibleRetired=retained.slice(retainedCursor+1).some(e=>e.track.id===sample.trackID&&room.retiredEntries.some(r=>r.id===e.id));
 if((!candidate||possibleRetired)&&Number.isSafeInteger(sample.positionMS)&&sample.positionMS>=0&&typeof sample.playing==='boolean'){
  // A song can start between observations while its removal is being applied.
  // Retain the confirmed occurrence cursor until native queue confirmation.
  const former=(room.providerState.observationOrder??[]).map(id=>room.entries.find(e=>e.id===id)??room.retiredEntries.find(e=>e.id===id)).filter(Boolean);
  const cursor=former.findIndex(e=>e.id===room.playback.entryID),eligible=former.slice(cursor+1);
  const matching=[...new Map([...eligible,...upcoming(room)].filter(e=>e.track.id===sample.trackID).map(e=>[e.id,e])).values()];
  if(matching.length===1&&room.retiredEntries.some(e=>e.id===matching[0].id)){
   const entry=matching[0],index=former.findIndex(e=>e.id===entry.id),successors=new Set(former.slice(index+1).map(e=>e.id));
   const insertion=room.entries.findIndex(e=>successors.has(e.id)),tail=insertion>=0?room.entries.slice(insertion):[];
   const afterCurrent=room.entries.findIndex(e=>e.id===room.playback.entryID);
   if(insertion>afterCurrent&&tail.length>0&&sample.queue.length>=Math.min(tail.length,20)&&tail.slice(0,20).every((e,i)=>sample.queue[i]===e.track.id)){
    room.entries.splice(insertion,0,entry);room.retiredEntries=room.retiredEntries.filter(e=>e.id!==entry.id);
    room.revision++;room.providerState.syncPending=true;room.providerState.nativeQueuePending=true;
    capture(room,entry,sample.positionMS,sample.playing,now);return;
   }
  }
 }
 if(possibleRetired||candidate&&candidates.filter(c=>Math.min(c.tail.length,20)===Math.min(candidate.tail.length,20)).length>1){room.playback.state='unconfirmed';return;}
 if(!candidate||!Number.isSafeInteger(sample.positionMS)||sample.positionMS<0||typeof sample.playing!=='boolean'){room.playback.state='unconfirmed';return;}
 const previous=order.findIndex(e=>e.id===room.playback.entryID);
 if(candidate.index<previous){room.playback.state='unconfirmed';return;}
 if(candidate.index>previous&&previous>=0&&order[previous].track.id===candidate.entry.track.id&&
    (candidate.tail.length===0||sample.positionMS+1500>=room.playback.positionMS)){room.playback.state='unconfirmed';return;}
 room.providerState.nativeQueuePending=false;room.providerState.observationOrder=room.providerState.appliedOrder.slice();capture(room,candidate.entry,sample.positionMS,sample.playing,now);
}
export function roomDTO(room,user,{publicRecap=false,inviteCode,inviteURL,shareURL}={}){
 if(publicRecap&&(!room.shared||room.status!=='ended'))fail('session_not_shared',404);
 const viewer=publicRecap?null:memberOf(room,user);
 const person=id=>room.members.find(m=>m.id===id);
 const attributed=e=>({...e,contributorName:publicRecap&&!person(e.contributorID)?.shareName?'Friend':person(e.contributorID)?.name??'Friend'});
 const base={stateVersion:room.stateVersion,id:room.id,provider:room.provider,title:room.title,status:room.status,revision:room.revision,createdAtMS:room.createdAtMS,endedAtMS:room.endedAtMS,expiresAtMS:room.expiresAtMS,history:room.history.map(attributed)};
 if(publicRecap)return base;
 return {...base,viewerID:viewer.id,isHost:room.host.userID===user.id,isHostDevice:room.host.userID===user.id&&room.host.keyID===user.keyID,storefront:room.storefront,
  members:room.members.map(({userID,...m})=>({...m,isHost:m.id===room.host.memberID})),queue:room.entries.map(attributed),upcomingIDs:upcoming(room).map(e=>e.id),playback:room.playback,
  playbackLeaseID:room.providerState.leaseID,observationSequence:room.providerState.lastSequence,started:room.providerState.started,
  appliedRevision:room.providerState.appliedRevision,syncPending:Boolean(room.providerState.syncPending||room.providerState.nativeQueuePending),syncError:room.providerState.syncError??null,
  playlistURI:room.providerState.playlistID?'spotify:playlist:'+room.providerState.playlistID:null,inviteCode,inviteURL,shareURL:room.shared?shareURL:null};
}
