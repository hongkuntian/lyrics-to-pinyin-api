import {fail} from './model.js';
import {LibraryError} from '../song-library/store.js';
export const listeningScopes=['app-remote-control','user-read-playback-state','user-modify-playback-state','playlist-read-private','playlist-modify-private'];
export const hasListeningScopes=c=>listeningScopes.every(scope=>(c.scope??[]).includes(scope));
export class ListeningSpotify {
 constructor({broker,fetchFn=fetch,now=Date.now}){Object.assign(this,{brokerSource:broker,fetchFn,now});}
 get broker(){return this.brokerInstance??=(typeof this.brokerSource==='function'?this.brokerSource():this.brokerSource);}
 async authorize(user,connectionID,connectionEpoch){
  let c=await this.broker.owned(user,connectionID,connectionEpoch);
  if(!await this.broker.store.ownerValid(c))fail('app_access_revoked',403);
  c=await this.broker.credentials(c.id);
  c=await this.broker.owned(user,connectionID,connectionEpoch);
  if(c.status!=='connected'||!hasListeningScopes(c))fail('spotify_session_permissions_required',403);
  if(c.expiresAtMS<=this.now()+5000)fail('spotify_refresh_pending',503);
  return this.broker.open(c,c.access,'access');
 }
 async token(room){return this.authorize({id:room.host.userID,keyID:room.host.keyID,credentialDigest:room.host.credentialDigest},room.providerState.connectionID,room.providerState.connectionEpoch);}
 async request(token,method,path,body,query){
  if(!path.startsWith('/v1/')||path.includes('..')||!token)fail('invalid_request',400);
  const store=this.broker?.store,bucket=this.broker?.config?.rateBucket;
  if(bucket&&store?.circuit){const until=await store.circuit(bucket);if(until>this.now())throw Object.assign(new LibraryError('spotify_rate_limited',429),{notBefore:until});}
  const url=new URL('https://api.spotify.com'+path);for(const [key,value] of Object.entries(query??{}))url.searchParams.set(key,String(value));
  let response;try{response=await this.fetchFn(url.href,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(4000)});}catch{fail('spotify_session_unavailable',503);}
  if(response.status===429){const raw=response.headers.get('retry-after'),delay=Number(raw),date=Date.parse(raw),notBefore=this.now()+Math.max(1000,raw&&Number.isFinite(delay)?delay*1000:Number.isFinite(date)?date-this.now():30000);if(bucket&&store?.circuit)await store.circuit(bucket,notBefore,'spotify_rate_limited');throw Object.assign(new LibraryError('spotify_rate_limited',429),{notBefore});}
  if(!response.ok)fail(response.status===403?'spotify_session_playback_restricted':response.status===401?'spotify_reconnect_required':'spotify_session_unavailable',response.status===403?403:503);
  const bytes=await response.text();if(bytes.length>1_000_000)fail('spotify_session_invalid_response',503);
  if(method!=='GET'&&!(method==='POST'&&path==='/v1/me/playlists'))return {};
  if(response.status===204)return null;
  let result;try{result=JSON.parse(bytes);}catch{fail('spotify_session_invalid_response',503);}
  if(!result||Array.isArray(result)||typeof result!=='object')fail('spotify_session_invalid_response',503);return result;
 }
 async player(room,token){return this.request(token??await this.token(room),'GET','/v1/me/player');}
 async order(room,token){
  const ids=[];
  for(let offset=0;offset<100;offset+=50){const page=await this.request(token,'GET',`/v1/playlists/${room.providerState.playlistID}/items`,null,{limit:50,offset});
   if(!Array.isArray(page?.items))fail('spotify_session_invalid_response',503);
   for(const row of page.items){const item=row.item??row.track;if(!item?.id||item.uri!=='spotify:track:'+item.id)fail('spotify_recording_changed');ids.push(item.id);}
   if(!page.next)break;
  }return ids;
 }
 async createPlaylist(room,token){
  const result=await this.request(token,'POST','/v1/me/playlists',{name:'Lyrica · '+room.title,description:'Lyrica session '+room.id,public:false,collaborative:false});
  if(typeof result?.id!=='string'||!/^[A-Za-z0-9]{22}$/.test(result.id)||result.public!==false)fail('spotify_session_invalid_response',503);
  return result.id;
 }
 async recoverPlaylist(room,token){
  for(let offset=0;offset<200;offset+=50){
   const page=await this.request(token,'GET','/v1/me/playlists',null,{limit:50,offset});
   const matches=(page?.items??[]).filter(p=>p.description==='Lyrica session '+room.id&&p.public===false&&/^[A-Za-z0-9]{22}$/.test(p.id));
   if(matches.length>1)fail('spotify_session_setup_uncertain');if(matches.length===1)return matches[0].id;if(!page.next)break;
  }return null;
 }
 async replace(room,token){
  await this.request(token,'PUT',`/v1/playlists/${room.providerState.playlistID}/items`,{uris:room.entries.map(e=>'spotify:track:'+e.track.id)});
  const order=await this.order(room,token);
  if(JSON.stringify(order)!==JSON.stringify(room.entries.map(e=>e.track.id)))fail('spotify_session_queue_unconfirmed');
 }
 async sample(room,token){
  const p=await this.player(room,token);
  if(!p)return null;
  if(p.context?.uri!=='spotify:playlist:'+room.providerState.playlistID||p.device?.id!==room.providerState.deviceID)return {contextURI:p.context?.uri,deviceID:p.device?.id};
  const queue=await this.request(token,'GET','/v1/me/player/queue');
  if(!Array.isArray(queue?.queue)||p.item?.uri!=='spotify:track:'+p.item?.id)fail('spotify_session_invalid_response',503);
  return {contextURI:p.context.uri,deviceID:p.device.id,trackID:p.item.id,positionMS:p.progress_ms,playing:p.is_playing,queue:queue.queue.map(t=>t.id)};
 }
 async control(room,action,token){
  if(!['play','pause','next'].includes(action))fail('invalid_request',400);
  const p=await this.player(room,token);
  if(p?.context?.uri!=='spotify:playlist:'+room.providerState.playlistID||p?.device?.id!==room.providerState.deviceID)fail('session_playback_detached');
  await this.request(token,action==='next'?'POST':'PUT','/v1/me/player/'+action,undefined,{device_id:room.providerState.deviceID});
 }
}
