import {LibraryError} from '../song-library/store.js';
const error=(code,status,extra={})=>Object.assign(new LibraryError(code,status),extra);
export function createSpotifyProvider({fetchFn=fetch,now=Date.now,clientID}={}){
 const request=async(url,options)=>{try{return await fetchFn(url,{...options,signal:AbortSignal.timeout(2000)});}catch{throw error('spotify_unavailable',503);}};
 return {async refresh(refreshToken){
  const response=await request('https://accounts.spotify.com/api/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:refreshToken,client_id:clientID})});
  let body;try{body=await response.json();}catch{throw error('spotify_refresh_uncertain',503);}
  if(!response.ok)throw error(body.error==='invalid_grant'?'spotify_invalid_grant':'spotify_refresh_uncertain',body.error==='invalid_grant'?401:503);
  const scopes=typeof body.scope==='string'?body.scope.split(/\s+/):[];
  if(!scopes.includes('app-remote-control')||!scopes.includes('user-read-playback-state'))throw error('spotify_scope_required',403);
  if(typeof body.access_token!=='string'||!body.access_token.length||!Number.isInteger(body.expires_in)||body.expires_in<1||body.expires_in>86400||body.refresh_token!==undefined&&typeof body.refresh_token!=='string')throw error('spotify_refresh_uncertain',503);
  return {accessToken:body.access_token,refreshToken:body.refresh_token??refreshToken,expiresAtMS:now()+body.expires_in*1000,scope:scopes};
 },async playback(accessToken){
  const requestStartedAt=now(),response=await request('https://api.spotify.com/v1/me/player',{headers:{Authorization:`Bearer ${accessToken}`}});
  if(response.status===204)return {status:204,requestStartedAt,responseReceivedAt:now()};
  let body;try{body=await response.json();}catch{throw error('spotify_unavailable',503);}
  const quota=body.error?.reason==='QUOTA_EXCEEDED'||body.error?.message==='QUOTA_EXCEEDED'||body.error==='QUOTA_EXCEEDED';
  if(quota)throw error('spotify_quota_exceeded',429,{notBefore:now()+300000});
  if(response.status===429){const value=response.headers.get('retry-after'),seconds=Number(value),date=Date.parse(value);throw error('spotify_rate_limited',429,{notBefore:now()+(Number.isFinite(seconds)?Math.max(1,seconds)*1000:Number.isFinite(date)?Math.max(1000,date-now()):30000)});}
  if(!response.ok){throw error(quota?'spotify_quota_exceeded':response.status===401?'spotify_unauthorized':response.status===403?'spotify_access_denied':'spotify_unavailable',response.status,{notBefore:quota?now()+300000:undefined});}
  return {status:200,body,requestStartedAt,responseReceivedAt:now()};
 }};
}
