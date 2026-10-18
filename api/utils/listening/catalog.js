import {configuredAppleCatalog} from '../apple-catalog.js';
import {validateTrack,fail,text} from './model.js';
export class ListeningCatalog {
 constructor({spotify,fetchFn=fetch,apple=configuredAppleCatalog()}={}){Object.assign(this,{spotify,fetchFn,apple});}
 spotifyTrack(t){return validateTrack({provider:'spotify',id:t.id,title:t.name,artist:(t.artists??[]).map(a=>a.name).join(', '),album:t.album?.name??'',durationMS:t.duration_ms,artworkURL:t.album?.images?.at(-1)?.url??null},'spotify');}
 appleTrack(t){return validateTrack({provider:'appleMusic',id:t.catalog_id,title:t.title,artist:t.artist,album:t.album??'',durationMS:Math.round(t.duration*1000),artworkURL:t.artworkURL??null},'appleMusic');}
 async itunes(path,query){
  const url=new URL('https://itunes.apple.com/'+path);Object.entries(query).forEach(([k,v])=>url.searchParams.set(k,v));
  let r;try{r=await this.fetchFn(url,{redirect:'error',signal:AbortSignal.timeout(4000)});}catch{fail('session_catalog_unavailable',503);}
  if(!r.ok)fail('session_catalog_unavailable',503);const bytes=await r.text();if(bytes.length>1_000_000)fail('session_catalog_unavailable',503);
  try{const result=JSON.parse(bytes);if(!Array.isArray(result.results))fail('session_catalog_unavailable',503);return result.results.filter(t=>t.kind==='song').map(t=>validateTrack({provider:'appleMusic',id:String(t.trackId),title:t.trackName,artist:t.artistName,album:t.collectionName??'',durationMS:t.trackTimeMillis,artworkURL:t.artworkUrl100??null},'appleMusic'));}catch{fail('session_catalog_unavailable',503);}
 }
 async search(room,term){
  term=text(term,100);
  if(room.provider==='spotify'){
   const token=await this.spotify.token(room),page=await this.spotify.request(token,'GET','/v1/search',null,{q:term,type:'track',limit:10,market:'from_token'});
   return (page?.tracks?.items??[]).filter(t=>t.is_playable!==false&&!t.restrictions?.reason).map(t=>this.spotifyTrack(t));
  }
  if(this.apple?.search)return (await this.apple.search(term,room.storefront)).map(t=>this.appleTrack(t));
  return this.itunes('search',{term,country:room.storefront,entity:'song',limit:'20'});
 }
 async lookup(room,id){
  if(room.provider==='spotify'){
   if(!/^[A-Za-z0-9]{22}$/.test(id))fail('invalid_recording',400);
   const token=await this.spotify.token(room),t=await this.spotify.request(token,'GET','/v1/tracks/'+id,null,{market:'from_token'});
   if(t?.id!==id||t?.uri!=='spotify:track:'+id||t.is_playable===false||t.restrictions?.reason)fail('session_recording_unavailable');
   return this.spotifyTrack(t);
  }
  if(!/^\d{1,20}$/.test(id))fail('invalid_recording',400);
  const tracks=this.apple? (await this.apple.lookup(id,room.storefront)).map(t=>this.appleTrack(t)):await this.itunes('lookup',{id,country:room.storefront,entity:'song'});
  const exact=tracks.find(t=>t.id===id);if(!exact)fail('session_recording_unavailable',404);return exact;
 }
}
