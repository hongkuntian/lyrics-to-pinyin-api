import {randomBytes,randomUUID} from 'node:crypto';
import {ListeningStore} from './store.js';
import {applyCommand,memberOf,requireHost,roomDTO,observeApple,observeSpotify,uuid,fail} from './model.js';
import {ListeningSpotify} from './spotify.js';
import {ListeningCatalog} from './catalog.js';
import {enqueueListening} from './queue.js';
const base='https://lyrics-to-pinyin-api.vercel.app/api/sessions';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export class ListeningService {
 constructor({store=new ListeningStore(),broker,spotify,catalog,enqueue=enqueueListening,now=Date.now,crash=async()=>{}}={}){
  Object.assign(this,{store,enqueue,now,crash});this.spotify=spotify??(broker?new ListeningSpotify({broker,now}):null);this.catalog=catalog??new ListeningCatalog({spotify:this.spotify});
 }
 dto(room,user){return roomDTO(room,user,{inviteCode:room.invitation.code,inviteURL:base+'?join='+room.invitation.token,shareURL:room.shared?base+'?recap='+room.shareToken:undefined});}
 async room(id){const room=await this.store.read(id);if(!room)fail('session_not_found',404);return room;}
 expire(room){if(room.status==='active'&&room.expiresAtMS<=this.now()){room.status='ended';room.endedAtMS=room.expiresAtMS;room.playback.playing=false;room.playback.state='ended';}}
 async drain(id){
  for(let pass=0;pass<4;pass++){
   const rows=await this.store.pending(id);if(!rows.length)return;
   for(const row of rows){const receipt=await this.enqueue({version:1,sessionID:id,ordinal:row.ordinal,outboxID:row.id,dueAtMS:row.dueAtMS},{idempotencyKey:'listening:'+row.id,delaySeconds:Math.max(0,Math.ceil((row.dueAtMS-this.now())/1000)),retentionSeconds:86400});await this.crash('tickAccepted');await this.store.receipt(row.id,receipt?.messageId??'accepted');}
  }fail('session_updates_pending',503);
 }
 async send(user,input){
  const id=input.sessionID;
  if(input.action==='list'){
   const rooms=await this.store.list(user);for(const room of rooms)if(room.status==='active'&&room.expiresAtMS<=this.now())await this.store.mutate(room.id,r=>{this.expire(r);});
   const page=await this.store.page(user,input.cursor);
   return {version:1,summaries:page.rooms.map(r=>({id:r.id,provider:r.provider,title:r.title,status:r.status,createdAtMS:r.createdAtMS,endedAtMS:r.endedAtMS,playedCount:r.history.length,memberCount:r.members.filter(m=>m.leftAtMS===null).length,isHost:r.host.userID===user.id})),nextCursor:page.nextCursor};
  }
  if(input.action==='create'){
   const providerState={};
   if(input.provider==='spotify'){
    if(!this.spotify)fail('spotify_not_configured',503);
    await this.spotify.authorize(user,input.connectionID,input.connectionEpoch);
    Object.assign(providerState,{connectionID:input.connectionID,connectionEpoch:input.connectionEpoch});
   }
   const room=await this.store.create(user,{...input,providerState},this.now());await this.drain(room.id);return {version:1,session:this.dto(room,user)};
  }
  if(input.action==='join'){
   const room=await this.store.byInvite(input.invite);if(!room)fail('session_not_found',404);
   const joined=await this.store.mutate(room.id,r=>{applyCommand(r,user,input,this.now());});await this.drain(room.id);return {version:1,session:this.dto(joined,user)};
  }
  if(!uuid(id))fail('invalid_request',400);
  let room=await this.room(id);memberOf(room,user);
  if(input.action==='read'){await this.drain(id);if(room.status==='active'&&!await this.store.ownerValid(room))room=await this.store.mutate(id,r=>{r.status='ended';r.endedAtMS=this.now();r.playback.playing=false;r.playback.state='ended';});if(room.status==='active'&&room.expiresAtMS<=this.now())room=await this.store.mutate(id,r=>{this.expire(r);});return {version:1,session:this.dto(room,user)};}
  if(input.action==='sync'&&room.status==='ended'&&room.provider==='spotify'){requireHost(room,user,true);await this.finishSpotify(id);return {version:1,session:this.dto(await this.room(id),user)};}
  if(input.action==='search'){if(room.status!=='active')fail('session_ended',410);return {version:1,tracks:await this.catalog.search(room,input.term)};}
  if(input.action==='target'){
   requireHost(room,user,true);if(room.provider!=='spotify')fail('invalid_request',400);
   const p=await this.spotify.player(room);if(!p?.device?.id||p.device.is_active!==true||p.device.is_restricted)fail('spotify_no_active_device');
   const targetNonce=randomBytes(24).toString('base64url');
   await this.store.mutate(id,r=>{r.providerState.target={id:p.device.id,name:p.device.name??'Spotify device',nonce:targetNonce,readAtMS:this.now()};});
   return {version:1,target:{name:p.device.name??'Spotify device',nonce:targetNonce}};
  }
  if(input.action==='observe'){
   await this.store.mutate(id,r=>observeApple(r,user,input,this.now()));return {version:1,session:this.dto(await this.room(id),user)};
  }
  if(input.action==='applied'){
   room=await this.store.mutate(id,r=>{
    requireHost(r,user,true);if(r.provider!=='appleMusic'||input.leaseID!==r.providerState.leaseID||input.revision!==r.revision||input.entryID!==r.playback.entryID)fail('session_revision_changed');
    r.providerState.appliedRevision=r.revision;r.providerState.appliedOrder=r.entries.map(e=>e.id);r.providerState.syncPending=false;r.providerState.syncError=null;
   });return {version:1,session:this.dto(room,user)};
  }
  if(input.action==='control'){
   requireHost(room,user,true);if(room.provider!=='spotify'||room.status!=='active')fail('invalid_request',400);
   const accepted=await this.store.command(user,id,input,r=>{requireHost(r,user,true);r.providerState.controlPending=input.control;});
   if(!accepted.duplicate)await this.spotify.control(accepted.room,input.control,await this.spotify.token(accepted.room));return {version:1,session:this.dto(await this.room(id),user)};
  }
  let track;
  if(input.action==='add')track=await this.catalog.lookup(room,input.trackID);
  const result=await this.store.command(user,id,input,async(r,db)=>{
   this.expire(r);
   if(input.action==='share'||input.action==='unshare'){
    requireHost(r,user);if(r.status!=='ended')fail('end_session_first');r.shared=input.action==='share';r.shareToken=r.shared?randomBytes(24).toString('base64url'):null;return;
   }
   if(input.action==='start'){
    requireHost(r,user,true);
    if(r.provider==='spotify'){
     const target=r.providerState.target;
     if(!target||target.nonce!==input.targetNonce||this.now()-target.readAtMS>180000)fail('spotify_confirm_target_again');
     r.providerState.deviceID=target.id;r.providerState.target=null;
     r.providerState.setupUncertain=Boolean(r.providerState.creationRequestedAtMS&&!r.providerState.playlistID);
     r.providerState.creationRequestedAtMS??=this.now();
    }
    applyCommand(r,user,{...input,action:'begin',leaseID:input.commandID},this.now());r.providerState.syncPending=true;r.providerState.syncError=null;
    if(r.provider==='spotify'){r.tick.ordinal++;r.tick.dueAtMS=this.now();r.tick.lease=null;await this.store.putTick(db,r);}
    return;
   }
   if(input.action==='sync'){
    requireHost(r,user,true);if(r.status!=='active'||!r.providerState.started)fail('session_ended');r.providerState.syncError=null;r.providerState.syncPending=true;return;
   }
   applyCommand(r,user,{...input,...(track?{track,entryID:input.commandID}:{})},this.now());
   if(['add','remove','reorder'].includes(input.action)){
    r.providerState.syncPending=r.providerState.started;r.providerState.syncError=null;
    if(!r.providerState.started){r.providerState.appliedRevision=r.revision;r.providerState.appliedOrder=r.entries.map(e=>e.id);}
   }
  });
  room=result.room;
  if(!result.duplicate&&room.provider==='spotify'){
   if(input.action==='end')await this.finishSpotify(id);
   else if(input.action==='start')await this.startSpotify(id,input.commandID);
   else if(['add','remove','reorder','sync'].includes(input.action)&&room.providerState.started)await this.syncSpotify(id,{recover:input.action==='sync'});
  }
  await this.drain(id);return {version:1,session:this.dto(await this.room(id),user)};
 }
 async recordProviderError(id,error){await this.store.mutate(id,r=>{r.providerState.syncError=error.code??'spotify_session_unavailable';r.providerState.syncPending=true;});}
 async startSpotify(id,leaseID){
  try{
   // The intent is already durable. A duplicate start never repeats playback.
   let room=await this.room(id),token=await this.spotify.token(room);
   if(!room.providerState.playlistID){
    const playlistID=room.providerState.setupUncertain?await this.spotify.recoverPlaylist(room,token):await this.spotify.createPlaylist(room,token);
    if(!playlistID)fail('spotify_session_setup_uncertain');
    await this.store.mutate(id,r=>{if(r.providerState.leaseID!==leaseID||r.status!=='active')fail('session_playback_replaced');r.providerState.playlistID=playlistID;r.providerState.setupUncertain=false;});
   }
   await this.store.mutate(id,async r=>{
    if(r.providerState.leaseID!==leaseID||r.status!=='active')fail('session_playback_replaced');
    const p=await this.spotify.player(r,token);if(p?.device?.id!==r.providerState.deviceID||p?.device?.is_restricted)fail('spotify_confirm_target_again');
    r.providerState.originalOptions??={shuffle:p.shuffle_state,repeat:p.repeat_state};
    await this.spotify.replace(r,token);
    const device={device_id:r.providerState.deviceID};
    await this.spotify.request(token,'PUT','/v1/me/player/shuffle',undefined,{...device,state:'false'});
    await this.spotify.request(token,'PUT','/v1/me/player/repeat',undefined,{...device,state:'off'});
    const index=Math.max(0,r.entries.findIndex(e=>e.id===r.playback.entryID));
    await this.spotify.request(token,'PUT','/v1/me/player/play',{context_uri:'spotify:playlist:'+r.providerState.playlistID,offset:{position:index},position_ms:0},device);
    r.providerState.appliedRevision=r.revision;r.providerState.appliedOrder=r.entries.map(e=>e.id);r.providerState.syncPending=false;r.providerState.nativeQueuePending=true;r.providerState.syncError=null;
   });
  }catch(error){await this.recordProviderError(id,error);}
 }
 async syncSpotify(id,{recover=false,observeOnly=false}={}){
  try{
   const room=await this.room(id),token=await this.spotify.token(room);
   if(!room.providerState.playlistID&&recover){const playlistID=await this.spotify.recoverPlaylist(room,token);if(playlistID)await this.store.mutate(id,r=>{r.providerState.playlistID=playlistID;});}
   await this.store.mutate(id,async r=>{
    if(r.status!=='active'||!r.providerState.playlistID)fail('spotify_session_setup_uncertain');
    const desired=r.entries.map(e=>e.track.id),saved=await this.spotify.order(r,token);
    if(!same(saved,desired)){if(observeOnly)fail('spotify_session_queue_unconfirmed');await this.spotify.replace(r,token);}
    r.providerState.appliedRevision=r.revision;r.providerState.appliedOrder=r.entries.map(e=>e.id);r.providerState.syncPending=false;r.providerState.nativeQueuePending=true;r.providerState.syncError=null;
   });
  }catch(error){await this.recordProviderError(id,error);}
 }
 async finishSpotify(id){
  const room=await this.room(id);if(!room.providerState.playlistID)return;
  try{
   const token=await this.spotify.token(room),p=await this.spotify.player(room,token);
   const owns=p?.context?.uri==='spotify:playlist:'+room.providerState.playlistID&&p?.device?.id===room.providerState.deviceID;
   if(owns){
    await this.spotify.request(token,'PUT','/v1/me/player/pause',undefined,{device_id:room.providerState.deviceID});
    const o=room.providerState.originalOptions;
    if(typeof o?.shuffle==='boolean')await this.spotify.request(token,'PUT','/v1/me/player/shuffle',undefined,{device_id:room.providerState.deviceID,state:String(o.shuffle)});
    if(['off','context','track'].includes(o?.repeat))await this.spotify.request(token,'PUT','/v1/me/player/repeat',undefined,{device_id:room.providerState.deviceID,state:o.repeat});
   }
   await this.spotify.request(token,'DELETE',`/v1/playlists/${room.providerState.playlistID}/followers`);
   await this.store.mutate(id,r=>{r.providerState.cleanupComplete=true;r.providerState.syncPending=false;r.providerState.nativeQueuePending=false;r.providerState.syncError=null;});
  }catch(error){await this.recordProviderError(id,error);}
 }
 async tick(message){
  const id=message.sessionID;let room=await this.store.read(id);if(!room)return;await this.drain(id);room=await this.room(id);
  if(room.status==='ended'){if(room.provider==='spotify'&&!room.providerState.cleanupComplete&&room.providerState.playlistID)await this.finishSpotify(id);return;}
  if(message.ordinal!==room.tick.ordinal)return;
  if(message.dueAtMS>this.now())fail('session_tick_early',503);
  const lease=randomUUID();let claimed=false;
  await this.store.mutate(id,r=>{
   if(r.status!=='active'||r.tick.ordinal!==message.ordinal)return;
   if(r.tick.lease?.until>this.now())fail('session_tick_busy',503);
   r.tick.lease={id:lease,until:this.now()+20000};claimed=true;
  });if(!claimed)return;
  let sample,error,sampleRevision,sampleLeaseID;
  try{
   room=await this.room(id);
   if(!await this.store.ownerValid(room))error={code:'session_owner_unavailable',terminal:true};
   else if(room.provider==='spotify'&&room.providerState.started&&room.expiresAtMS>this.now()){
    if(room.providerState.syncPending&&room.providerState.playlistID)await this.syncSpotify(id);
    room=await this.room(id);sampleRevision=room.revision;sampleLeaseID=room.providerState.leaseID;sample=await this.spotify.sample(room,await this.spotify.token(room));
   }
  }catch(e){error=e;}
  await this.store.mutate(id,async(r,db)=>{
   if(r.tick.lease?.id!==lease||r.tick.ordinal!==message.ordinal)return;
   if(r.tick.lease.until<=this.now())fail('session_tick_lease_expired',503);
   r.tick.lease=null;
   this.expire(r);
   if(error?.terminal){r.status='ended';r.endedAtMS=this.now();r.playback.state='ended';r.playback.playing=false;}
   if(error&&!error.terminal){r.playback.state='delayed';r.providerState.observationError=error.code??'session_updates_delayed';}
   else if(sample&&sampleRevision===r.revision&&sampleLeaseID===r.providerState.leaseID)observeSpotify(r,sample,message.ordinal,this.now());
   if(r.status==='active'){
    r.tick.ordinal++;r.tick.dueAtMS=Math.max(error?.notBefore??0,this.now()+(r.provider==='spotify'?(r.providerState.started?5000:30000):Math.max(1000,r.expiresAtMS-this.now())));
    await this.store.putTick(db,r);
   }
  });
  await this.crash('tickCommitted');await this.drain(id);
  room=await this.room(id);if(room.status==='ended'&&room.provider==='spotify')await this.finishSpotify(id);
 }
}
