import {randomUUID,randomBytes} from 'node:crypto';
import {LibraryError} from '../song-library/store.js';
import {sha,vaultContext} from './vault.js';
import {observePlayback,requestFingerprint} from './observation.js';
import {renderState,immutablePush,validateDocument,validateRecipe} from './render.js';
const fail=(code,status=409)=>{throw new LibraryError(code,status);};
const active=c=>Object.values(c.consumers??{}).filter(x=>x.status!=='ended');
const idFor=(c,kind,n)=>`${c.id}:${c.epoch}:${kind}:${n}`;
export function endConsumer(c,s,reason,now,put){
 if(s.status==='ended')return;
 const oldGeneration=s.generation;s.generation++;s.status='ended';s.reason=reason;s.endedAt=now;
 // The narrowly authorized terminal intent survives all ordinary admission gates.
 const due=Math.max(now,(s.lastTimestamp+1)*1000||now),id=`${c.id}:cleanup:${s.sessionID}:${s.tokenVersion}:${oldGeneration}`;
 put('cleanup',id,{sessionID:s.sessionID,tokenVersion:s.tokenVersion,generation:oldGeneration,reason},due);
}
export function closeConnection(c,reason,now,put,status='disconnected'){
 for(const s of active(c))endConsumer(c,s,reason,now,put);
 c.epoch=randomUUID();c.status=status;c.reason=reason;c.refresh=null;c.access=null;c.stage=null;c.refreshLease=null;c.pollLease=null;c.document=null;c.observation=null;c.closedAt=now;
}
export class SpotifyService {
 constructor({store,config,provider,enqueue,send,acquire,admit,resolveRecipe=async()=>({}),now=Date.now,crash=async()=>{}}){Object.assign(this,{store,config,provider,enqueue,send,acquire,admit,resolveRecipe,now,crash});}
 seal(c,value,purpose){return this.config.vault.seal(value,{...vaultContext(c),purpose});}
 open(c,value,purpose){return this.config.vault.open(value,{...vaultContext(c),purpose});}
 async owned(user,id,epoch){const c=await this.store.read(id);if(!c||c.ownerID!==user.id||c.keyID!==user.keyID||c.credentialDigest!==user.credentialDigest)fail('spotify_connection_not_found',404);if(epoch!==undefined&&c.epoch!==epoch)fail('spotify_connection_replaced');return c;}
 dto(c){if(c.status!=='connected')return {version:1,status:c.status};return {version:1,status:'connected',credential:{connectionID:c.id,connectionEpoch:c.epoch,credentialVersion:c.credentialVersion,accessToken:this.open(c,c.access,'access'),expiresAtMS:c.expiresAtMS,refreshOwnershipAcknowledged:true}};}
 async enrollment(user,input){
  let c=await this.store.enrollment(user,input.enrollmentID);
  if(!c){c={id:randomUUID(),epoch:randomUUID(),enrollmentID:input.enrollmentID,ownerID:user.id,keyID:user.keyID,credentialDigest:user.credentialDigest,bundleID:user.bundleID,apnsEnvironment:user.environment,clientID:this.config.clientID,environment:this.config.environment,status:'pending',credentialVersion:0,consumers:{},tickOrdinal:0,createdAt:this.now(),grantExpiresAt:this.now()+180*86400000};c.refresh=this.seal(c,input.refreshToken,'refresh');c=await this.store.create(c);}
  if(c.credentialDigest!==user.credentialDigest)fail('spotify_connection_not_found',404);
  if(c.status==='pending')await this.credentials(c.id,{initial:true});
  c=await this.store.read(c.id);
  if(c.status==='connected'){
   // Replace only after proof succeeds; old work is fenced before ACK.
   for(const prior of await this.store.matching({ownerID:user.id,keyID:user.keyID}))if(prior.id!==c.id&&['connected','pending'].includes(prior.status)){
    await this.store.mutate(prior.id,(p,put)=>closeConnection(p,'grantReplaced',this.now(),put));await this.drain(prior.id);
   }
  }
  return this.dto(c);
 }
 async credentials(id,{initial=false,force=false}={}){
  const lease=randomUUID(),time=this.now();let work;
  await this.store.mutate(id,(c,put)=>{
   if(!['connected','pending'].includes(c.status))return;
   if(c.grantExpiresAt<=time){closeConnection(c,'grantExpired',time,put,'reconnectRequired');return;}
   if(!force&&!initial&&c.access&&c.expiresAtMS>time+60000){work={done:true};return;}
   if(c.refreshLease?.until>time){work={busy:true};return;}
   if(c.refreshAttempt&&c.refreshAttempt.version===c.credentialVersion&&c.refreshAttempt.count>=2&&!c.stage){closeConnection(c,'refreshUncertain',time,put,'reconnectRequired');return;}
   c.refreshLease={id:lease,until:time+10000,version:c.credentialVersion};
   c.refreshAttempt={version:c.credentialVersion,count:(c.refreshAttempt?.version===c.credentialVersion?c.refreshAttempt.count:0)+1};
   work={c:structuredClone(c),version:c.credentialVersion,epoch:c.epoch,stage:c.stage};
  });
  if(!work||work.busy){await this.drain(id);return this.store.read(id);}
  if(work.done){await this.reencrypt(id);return this.store.read(id);}
  const matches=c=>c.refreshLease?.id===lease&&c.epoch===work.epoch&&c.credentialVersion===work.version&&['pending','connected'].includes(c.status);
  try{
   let stage=work.stage;
   if(!stage){
    const grant=await this.provider.refresh(this.open(work.c,work.c.refresh,'refresh'));
    stage={access:this.seal(work.c,grant.accessToken,'access'),refresh:this.seal(work.c,grant.refreshToken,'refresh'),expiresAtMS:grant.expiresAtMS,scope:grant.scope};
    const accepted=await this.store.mutate(id,c=>{if(!matches(c))return false;c.stage=stage;return true;});
    if(!accepted)return this.store.read(id);
    await this.crash('refreshStaged');
   }
   // Only the refreshed token and actual returned scope constitute evidence.
   const probe=await this.provider.playback(this.open(work.c,stage.access,'access'));
   if(![200,204].includes(probe.status))fail('spotify_scope_required',403);
   await this.store.mutate(id,c=>{if(!matches(c))return;Object.assign(c,{access:stage.access,refresh:stage.refresh,expiresAtMS:stage.expiresAtMS,scope:stage.scope,credentialVersion:c.credentialVersion+1,status:'connected',stage:null,refreshLease:null,refreshAttempt:null});});
  }catch(error){
   if(error.code==='simulated_crash')throw error;
   await this.store.mutate(id,(c,put)=>{if(!matches(c))return;c.refreshLease=null;if(['spotify_invalid_grant','spotify_scope_required','spotify_access_denied'].includes(error.code))closeConnection(c,error.code,this.now(),put,'reconnectRequired');else c.reason='refreshUncertain';});
   await this.drain(id);throw new LibraryError(error.code??'spotify_refresh_uncertain',error.status??503);
  }
  return this.store.read(id);
 }
 async reencrypt(id){
  await this.store.mutate(id,c=>{
   if(c.refreshLease||c.status!=='connected')return;
   let changed=false;
   for(const key of ['access','refresh'])if(c[key]&&c[key].keyID!==this.config.vault.active){c[key]=this.seal(c,this.open(c,c[key],key),key);changed=true;}
   for(const s of Object.values(c.consumers))for(const [key,purpose] of [['token','activity'],['widgetToken','widget'],['capability','capability']])if(s[key]&&s[key].keyID!==this.config.vault.active){const context={...vaultContext(c),epoch:s.vaultEpoch,purpose:purpose+':'+s.sessionID};s[key]=this.config.vault.seal(this.config.vault.open(s[key],context),context);changed=true;}
   if(changed)c.credentialVersion++;
  });
 }
 async status(user,input){let c=await this.store.enrollment(user,input.enrollmentID);if(!c)return {version:1,status:'disconnected'};await this.owned(user,c.id);if(c.status==='pending')c=await this.credentials(c.id,{initial:true});return this.dto(c);}
 async access(user,input){const c=await this.owned(user,input.connectionID,input.connectionEpoch);if(!await this.store.ownerValid(c))fail('app_access_revoked',403);return this.dto(await this.credentials(c.id));}
 async disconnect(user,input){
  let c;
  if(input.enrollmentID){c=await this.store.enrollment(user,input.enrollmentID);if(!c)c=await this.store.create({id:randomUUID(),epoch:randomUUID(),enrollmentID:input.enrollmentID,ownerID:user.id,keyID:user.keyID,credentialDigest:user.credentialDigest,status:'disconnected',consumers:{},closedAt:this.now()});else await this.owned(user,c.id);}
  else c=await this.owned(user,input.connectionID); // Repeated stop tolerates the closed epoch.
  await this.store.mutate(c.id,(current,put)=>{if(current.status!=='disconnected')closeConnection(current,'disconnected',this.now(),put);});
  await this.store.revokeCapabilities(c.id);await this.drain(c.id);return {version:1,status:'disconnected'};
 }
 sessionReply(c,s){return {version:1,status:s.status,session:{sessionID:s.sessionID,activityID:s.activityID,activityGeneration:s.generation,connectionID:c.id,connectionEpoch:c.epoch,tokenVersion:s.tokenVersion,recipeRevision:s.recipeRevision,expiresAtMS:s.expiresAt}};}
 async arm(user,input){
  let c=await this.owned(user,input.connectionID,input.connectionEpoch);if(c.status!=='connected')fail('spotify_reconnect_required');
  const existing=c.consumers[input.sessionID];
  if(existing){if(existing.armID!==input.armID||existing.activityID!==input.activityID||existing.installationID!==input.installationID)fail('spotify_session_conflict');await this.drain(c.id);c=await this.store.read(c.id);const existingSession=c.consumers[input.sessionID];if(existingSession.status!=='ended')await this.store.addCapability(existingSession.capabilityDigest,c.id,existingSession.sessionID,existingSession.expiresAt);return this.armReply(c,existingSession);}
  if(!await this.store.ownerValid(c))fail('app_access_revoked',403);
  const result=await this.acquire(input.recording,user);if(result.status!==200||!result.document)fail('spotify_synced_lyrics_required');
  const binding=validateDocument(result.document,input.recording);if(!binding.synchronizationEligible)fail('spotify_synced_lyrics_required');
  await this.admit(c,{activityID:input.activityID,state:{recordingID:input.recording.item_id}});
  const recipe=validateRecipe(input.recipe),resolved=await this.resolveRecipe(c,recipe,result.document),capability='lyra_w_'+randomBytes(32).toString('base64url');
  await this.store.mutate(c.id,(current,put)=>{
   if(current.epoch!==input.connectionEpoch||current.status!=='connected')fail('spotify_connection_replaced');
   if(current.consumers[input.sessionID])return;
   for(const s of active(current))if(s.installationID===input.installationID)endConsumer(current,s,'replaced',this.now(),put);
   const s={sessionID:input.sessionID,installationID:input.installationID,armID:input.armID,activityID:input.activityID,generation:1,vaultEpoch:current.epoch,previewRecordingID:input.recording.item_id,tokenVersion:input.tokenVersion,token:this.seal(current,input.token,'activity:'+input.sessionID),recipe,recipeRevision:1,...resolved,frequentPushesEnabled:input.frequentPushesEnabled,status:'connecting',createdAt:this.now(),expiresAt:this.now()+28500000,sequence:0,lastTimestamp:0,capability:this.seal(current,capability,'capability:'+input.sessionID),capabilityDigest:sha(capability)};
   current.consumers[s.sessionID]=s;
   if(active(current).length===1||!current.nextDue){current.nextDue=this.now();put('tick',idFor(current,'tick',current.tickOrdinal),{ordinal:current.tickOrdinal},current.nextDue);}
  });
  await this.crash('armCommitted');await this.drain(c.id);
  c=await this.store.read(c.id);const s=c.consumers[input.sessionID];await this.store.addCapability(s.capabilityDigest,c.id,s.sessionID,s.expiresAt);
  return this.armReply(c,s);
 }
 armReply(c,s){const result=this.sessionReply(c,s);if(s.status!=='ended')result.snapshotCapability={token:this.open(c,s.capability,'capability:'+s.sessionID),expiresAtMS:s.expiresAt};return result;}
 async live(user,input,action){
  const c=await this.owned(user,input.connectionID,action==='live.stop'?undefined:input.connectionEpoch),s=c.consumers[input.sessionID];if(!s)fail('spotify_session_not_found',404);
  let resolved;
  if(action==='live.preferences'){validateRecipe(input.recipe);resolved=await this.resolveRecipe(c,input.recipe,c.document);}
  await this.store.mutate(c.id,(current,put)=>{
   const consumer=current.consumers[input.sessionID];if(action==='live.stop'){endConsumer(current,consumer,input.reason,this.now(),put);return;}
   if(consumer.status==='ended')return;
   if(action==='live.token'){
    if(input.frequentPushesEnabled!==undefined)consumer.frequentPushesEnabled=input.frequentPushesEnabled;
    if(consumer.activityID!==input.activityID)fail('spotify_session_conflict');
    if(input.tokenVersion<consumer.tokenVersion)fail('spotify_token_superseded');
    if(input.tokenVersion===consumer.tokenVersion&&this.open(current,consumer.token,'activity:'+consumer.sessionID)!==input.token)fail('spotify_token_superseded');
    consumer.token=this.seal(current,input.token,'activity:'+consumer.sessionID);consumer.tokenVersion=input.tokenVersion;consumer.pendingPublication=null;
   }
   if(action==='live.preferences'){consumer.recipe=input.recipe;consumer.recipeRevision++;Object.assign(consumer,resolved);consumer.pendingPublication=null;}
   if(action==='live.hint'||action==='live.preferences'||action==='live.token'){
    // A separate deterministic wake key never attempts to shorten an accepted tick.
    if(!current.wakePending){current.hintOrdinal=(current.hintOrdinal??0)+1;current.wakePending=current.hintOrdinal;put('wake',idFor(current,'wake',current.hintOrdinal),{hintOrdinal:current.hintOrdinal},Math.max(this.now(),current.pollLease?.until??0));}
   }
  });
  if(action==='live.stop')await this.store.revokeCapabilities(c.id,s.sessionID);
  await this.drain(c.id);const current=await this.store.read(c.id);return this.sessionReply(current,current.consumers[s.sessionID]);
 }
 async drain(id){
  // Every predecessor/duplicate drains ALL committed required publications before
  // returning, including after its own ordinal has advanced.
  for(const row of await this.store.pending(id)){
   const c=await this.store.read(id);if(!c)return;
   if(row.kind!=='cleanup'&&(c.epoch!==row.epoch||c.status!=='connected'||!active(c).length)){await this.store.receipt(row.id,null,'cancelled');continue;}
   if(row.kind==='publication'||row.kind==='widget'){await this.publish(c,row);continue;}
   if(row.kind==='acquire'&&c.observation?.requestHash!==row.data.requestHash){await this.store.receipt(row.id,null,'cancelled');continue;}
   const message={version:1,kind:row.kind,connectionID:id,connectionEpoch:row.epoch,outboxID:row.id,ordinal:row.data.ordinal??0,dueAtMS:row.due};
   const receipt=await this.enqueue(row.kind==='acquire'?'acquire':'tick',message,{idempotencyKey:row.id,delaySeconds:Math.max(0,Math.ceil((row.due-this.now())/1000)),retentionSeconds:86400});
   await this.crash('queueAccepted');await this.store.receipt(row.id,receipt?.messageId??'accepted');
   await this.crash('queueReceipt');
   if(row.kind==='tick')await this.store.mutate(id,current=>{for(const s of active(current))if(s.status==='connecting')s.status='armed';});
  }
 }
 async tick(message){
  const id=message.connectionID;let c=await this.store.read(id);if(!c)return;
  if(message.kind==='cleanup'){await this.cleanup(message);await this.drain(id);return;}
  await this.drain(id);c=await this.store.read(id);
  if(message.connectionEpoch!==c.epoch||c.status!=='connected')return;
  if(!await this.store.ownerValid(c)){await this.stopAll(id,'ownerRevoked');return;}
  for(const s of active(c)){
   if(s.expiresAt<=this.now()){await this.stopOne(id,s.sessionID,'expired');continue;}
   try{await this.admit(c,{activityID:s.activityID,state:{recordingID:c.observation?.recording?.item_id??s.previewRecordingID??''}});}catch(error){await this.stopOne(id,s.sessionID,error.code??'entitlementRemoved');}
  }
  c=await this.store.read(id);if(!active(c).length){await this.drain(id);return;}
  const lease=randomUUID(),time=this.now(),circuit=await this.store.circuit(this.config.rateBucket);let claim;
  await this.store.mutate(id,(current,put)=>{
   if(current.epoch!==message.connectionEpoch||current.status!=='connected'||!active(current).length)return;
   const due=Math.max(current.notBefore??0,circuit);
   if(current.pollLease?.until>time){if(message.kind==='wake')throw new LibraryError('spotify_poll_busy',503);return;}
   if(message.kind!=='wake'&&message.ordinal!==current.tickOrdinal)return;
   if(time<due){current.tickOrdinal++;current.nextDue=due;put('tick',idFor(current,'tick',current.tickOrdinal),{ordinal:current.tickOrdinal},due);return;}
   if(message.kind!=='wake'&&time<(current.nextDue??0))throw new LibraryError('spotify_tick_early',503);
   current.pollLease={id:lease,until:time+10000,ordinal:current.tickOrdinal};current.wakePending=null;claim={epoch:current.epoch,ordinal:current.tickOrdinal,priorDue:current.nextDue??time};
  });
  if(!claim){await this.drain(id);return;}
  let sample,error;
  try{
   c=await this.credentials(id);if(c.status!=='connected')throw new LibraryError('spotify_reconnect_required',401);
   sample=await this.provider.playback(this.open(c,c.access,'access'));
  }catch(e){
   if(e.code==='spotify_unauthorized')try{c=await this.credentials(id,{force:true});if(c.status!=='connected')throw new LibraryError('spotify_reconnect_required',401);sample=await this.provider.playback(this.open(c,c.access,'access'));}catch(second){error=second;}
   else error=e;
  }
  if(error?.notBefore)await this.store.circuit(this.config.rateBucket,error.notBefore,error.code);
  await this.store.mutate(id,(current,put)=>{
   if(current.epoch!==claim.epoch||current.pollLease?.id!==lease||current.tickOrdinal!==claim.ordinal||current.pollLease.until<this.now())return;
   current.pollLease=null;
   if(error&&['spotify_invalid_grant','spotify_access_denied','spotify_unauthorized','spotify_reconnect_required'].includes(error.code)){closeConnection(current,error.code,this.now(),put,'reconnectRequired');return;}
   if(sample){
    const observation=observePlayback(sample,current.observation,claim.ordinal+1),changed=current.observation?.requestHash!==observation.requestHash;
    current.observation=observation;
    if(changed){current.document=null;current.acquisition=null;for(const s of active(current)){s.validatedAid=null;s.validatedCorrection=false;s.validatedTranslation=null;s.pendingPublication=null;}}
    if(observation.confirmedAt!=null){if(!observation.playing)current.inactiveSince??=observation.confirmedAt;else current.inactiveSince=null;}
    if(current.inactiveSince!=null&&this.now()-current.inactiveSince>=120000)for(const s of active(current))endConsumer(current,s,'inactive',this.now(),put);
    if(observation.recording&&!current.document&&!current.acquisition){current.acquisition={requestHash:observation.requestHash,attempt:0};put('acquire',idFor(current,'acquire',`${observation.requestHash}:0`),{requestHash:observation.requestHash,recording:observation.recording,attempt:0},this.now());}
   }else current.lastError=error?.code??'spotify_unavailable';
   for(const s of active(current)){
    const state=renderState({observation:current.observation,document:current.document,consumer:s,now:this.now()});
    s.snapshot={state,confirmedAtMS:current.observation?.confirmedAt??0,expiresAtMS:(current.observation?.confirmedAt??0)+8000};
    const semantic=sha(JSON.stringify({...state,sequence:0,observedAt:0,confirmedAt:0,validUntil:0,progress:0}));
    if(semantic===s.semantic&&this.now()-(s.lastPublicationAt??0)<4000)continue;
    if(Math.floor(this.now()/1000)<=s.lastTimestamp)continue;
    const publication=immutablePush({state,consumer:s,now:this.now()});
    if(semantic===s.semantic)publication.priority=5;
    s.semantic=semantic;s.sequence=publication.sequence;s.lastTimestamp=publication.timestamp;s.lastPublicationAt=this.now();
    const publicationID=idFor(current,'publication',`${s.sessionID}:${s.sequence}`);s.pendingPublication=publicationID;
    put('publication',publicationID,{sessionID:s.sessionID,recipeRevision:s.recipeRevision,...publication},this.now());
    if(s.widgetToken&&this.now()-(s.lastWidgetAt??0)>=30000&&s.widgetSemantic!==semantic){s.lastWidgetAt=this.now();s.widgetSemantic=semantic;put('widget',idFor(current,'widget',`${s.sessionID}:${s.sequence}`),{sessionID:s.sessionID,tokenVersion:s.widgetTokenVersion},this.now());}
   }
   if(active(current).length){current.tickOrdinal++;current.nextDue=Math.max(this.now(),claim.priorDue+2000,error?.notBefore??0);current.notBefore=error?.notBefore??0;put('tick',idFor(current,'tick',current.tickOrdinal),{ordinal:current.tickOrdinal},current.nextDue);}
  });
  await this.crash('tickCommitted');await this.drain(id);
 }
 async publish(c,row){
  const s=c.consumers[row.data.sessionID],p=row.data;
  if(!s||s.status==='ended'||row.epoch!==c.epoch||row.kind==='publication'&&(s.pendingPublication!==row.id||s.tokenVersion!==p.tokenVersion||s.recipeRevision!==p.recipeRevision||this.now()>=p.expiresAt)||row.kind==='widget'&&s.widgetTokenVersion!==p.tokenVersion){await this.store.receipt(row.id,null,'cancelled');return;}
  if(!await this.store.ownerValid(c)){await this.stopAll(c.id,'ownerRevoked');return;}
  try{
   await this.send({bundleID:c.bundleID,environment:c.apnsEnvironment,token:this.open(c,row.kind==='widget'?s.widgetToken:s.token,(row.kind==='widget'?'widget:':'activity:')+s.sessionID),payload:row.kind==='widget'?{aps:{'content-changed':true}}:p.payload,priority:row.kind==='widget'?5:p.priority,pushType:row.kind==='widget'?'widgets':'liveactivity'});
   await this.crash('apnsAccepted');await this.store.receipt(row.id,'accepted');
  }catch(error){if(error.code==='push_token_invalid'){
   await this.store.mutate(c.id,(current,put)=>{const latest=current.consumers[s.sessionID];if(row.kind==='widget'){if(latest.widgetTokenVersion===p.tokenVersion)latest.widgetToken=null;}else if(latest.tokenVersion===p.tokenVersion)endConsumer(current,latest,'tokenInvalid',this.now(),put);});await this.store.receipt(row.id,'invalid');
  }else throw error;}
 }
 async acquireMessage(message){
  const c=await this.store.read(message.connectionID);if(!c)return;await this.drain(c.id);
  const row=await this.store.outbox(message.outboxID);if(!row||c.document||c.acquisition?.attempt!==row.data.attempt||c.status!=='connected'||c.epoch!==message.connectionEpoch||!active(c).length||c.observation?.requestHash!==row.data.requestHash)return;
  if(!await this.store.ownerValid(c)){await this.stopAll(c.id,'ownerRevoked');return;}
  let result;try{result=await this.acquire(row.data.recording,{id:c.ownerID,keyID:c.keyID,credentialDigest:c.credentialDigest,bundleID:c.bundleID});}catch(error){result={status:error.status??503,code:error.code};}
  const resolved={};
  if(result.status===200&&result.document)for(const s of active(c))resolved[s.sessionID]={revision:s.recipeRevision,value:await this.resolveRecipe(c,s.recipe,result.document)};
  const retry=result.status===202||[429,500,502,503,504].includes(result.status);
  await this.store.mutate(c.id,(current,put)=>{
   if(current.epoch!==message.connectionEpoch||current.observation?.requestHash!==row.data.requestHash||current.acquisition?.attempt!==row.data.attempt||!active(current).length)return;
   if(result.status===200&&result.document){validateDocument(result.document,row.data.recording);current.document=result.document;current.acquisition=null;for(const s of active(current))if(resolved[s.sessionID]?.revision===s.recipeRevision)Object.assign(s,resolved[s.sessionID].value);}
   else if(retry){const attempt=row.data.attempt+1;current.acquisition={requestHash:row.data.requestHash,attempt};put('acquire',idFor(current,'acquire',`${row.data.requestHash}:${attempt}`),{...row.data,attempt},this.now()+Math.min(60000,Math.max(2000,result.retryAfterMS??2000)*Math.min(attempt,10)));}
   else {current.acquisition={requestHash:row.data.requestHash,terminal:true};current.lastError=result.code??'lyrics_absent';}
  });
  await this.crash('acquireCommitted');await this.drain(c.id);
 }
 async stopOne(id,sessionID,reason){await this.store.mutate(id,(c,put)=>endConsumer(c,c.consumers[sessionID],reason,this.now(),put));await this.store.revokeCapabilities(id,sessionID);}
 async stopAll(id,reason){await this.store.mutate(id,(c,put)=>closeConnection(c,reason,this.now(),put,'reconnectRequired'));await this.store.revokeCapabilities(id);await this.drain(id);}
 async cleanup(message){
  const row=await this.store.outbox(message.outboxID);if(!row||row.kind!=='cleanup')return;
  let c=await this.store.read(message.connectionID),s=c?.consumers[row.data.sessionID];if(!s||s.cleanupComplete?.includes(row.id))return;
  if(this.now()<Number(row.due_at_ms))throw new LibraryError('spotify_cleanup_early',503);
  // A late old-token failure cannot end a rebound current token. Terminal intent
  // is only for the exact closed generation/token captured by the transaction.
  if(s.status!=='ended'||s.tokenVersion!==row.data.tokenVersion){await this.store.receipt(row.id,null,'cancelled');return;}
  let terminal;
  await this.store.mutate(c.id,current=>{
   const latest=current.consumers[s.sessionID];if(latest.terminalPayload){terminal=latest.terminalPayload;return;}
   const state=renderState({consumer:latest,observation:current.observation,now:this.now()});Object.assign(state,{phase:'ended',playing:false,original:'',pronunciation:'',translation:'',statusReason:row.data.reason,activityGeneration:latest.generation});
   terminal=immutablePush({state,consumer:latest,now:this.now(),event:'end'});latest.terminalPayload=terminal;latest.lastTimestamp=terminal.timestamp;
  });
  try{await this.send({bundleID:c.bundleID,environment:c.apnsEnvironment,token:this.config.vault.open(s.token,{...vaultContext(c),epoch:s.vaultEpoch,purpose:'activity:'+s.sessionID}),payload:terminal.payload,priority:10});}catch(error){if(error.code!=='push_token_invalid'&&this.now()<s.expiresAt+3600000)throw error;}
  await this.store.mutate(c.id,current=>{const latest=current.consumers[s.sessionID];latest.token=null;latest.widgetToken=null;latest.capability=null;latest.capabilityDigest=null;latest.snapshot=null;latest.terminalPayload=null;latest.cleanupComplete=[row.id];});
  await this.store.revokeCapabilities(c.id,s.sessionID);
 }
 async snapshot(token,input){
  const capability=await this.store.capability(sha(token));if(!capability||Number(capability.expiresAtMS)<=this.now())fail('snapshot_expired',410);
  const c=await this.store.read(capability.connectionID),s=c?.consumers[capability.sessionID];
  if(!c||!s||s.status==='ended'||c.status!=='connected'||s.capabilityDigest!==sha(token)||!await this.store.ownerValid(c))fail('snapshot_expired',410);
  if(input.action==='snapshot.token')await this.store.mutate(c.id,current=>{const currentSession=current.consumers[s.sessionID];if(currentSession.status==='ended')fail('snapshot_expired',410);if(input.tokenVersion<=(currentSession.widgetTokenVersion??0)){if(input.tokenVersion===currentSession.widgetTokenVersion&&input.widgetToken===this.open(current,currentSession.widgetToken,'widget:'+s.sessionID))return;fail('spotify_token_superseded');}currentSession.widgetTokenVersion=input.tokenVersion;currentSession.widgetToken=this.seal(current,input.widgetToken,'widget:'+s.sessionID);});
  if(input.action==='snapshot.token')return {version:1,status:'registered',tokenVersion:input.tokenVersion};
  const snapshot=s.snapshot;
  return {version:1,status:!snapshot?'waiting':this.now()>=snapshot.expiresAtMS?'stale':'ready',state:snapshot?.state??renderState({consumer:s,observation:null,now:this.now()}),confirmedAtMS:snapshot?.confirmedAtMS??0,expiresAtMS:snapshot?.expiresAtMS??this.now()};
 }
}
