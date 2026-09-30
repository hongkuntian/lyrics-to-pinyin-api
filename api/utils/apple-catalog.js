import {createPrivateKey,sign} from 'node:crypto';
import {fetchJSON} from './fetch-json.js';
import {BoundedCache} from './bounded-cache.js';
import {recordingNames} from './recording-match.js';

export const CATALOG_RESOLUTION_VERSION='catalog-recording-1';
const version=value=>{
 const text=(value??'').normalize('NFKC').toLowerCase();
 return [ /\blive\b|现场|現場|演唱会|演唱會|ライブ/.test(text), /remaster|重制|重製|リマスター/.test(text),
  /remix|混音|リミックス/.test(text), /instrumental|karaoke|伴奏|カラオケ/.test(text), /acoustic|unplugged|不插電|不插电/.test(text),
  /\bdemo\b|小样|小樣/.test(text), /\b(?:radio|single) edit\b|short version|剪辑|剪輯/.test(text),
  /\bcover\b|翻唱/.test(text), /mandarin version|国语版|國語版/.test(text), /cantonese version|粤语版|粵語版/.test(text) ];
};
export function sameCatalogRecording(anchor,candidate) {
 if(!anchor?.isrc || anchor.isrc!==candidate?.isrc || !Number.isFinite(anchor.duration) || !Number.isFinite(candidate.duration)
  || Math.abs(anchor.duration-candidate.duration)>0.5) return false;
 if(!anchor.artist_ids?.length || !candidate.artist_ids?.length || JSON.stringify([...anchor.artist_ids].sort())!==JSON.stringify([...candidate.artist_ids].sort())) return false;
 if(recordingNames(anchor).credits.length!==recordingNames(candidate).credits.length) return false;
 if((anchor.content_rating??null)!==(candidate.content_rating??null)) return false;
 return JSON.stringify(version(anchor.title))===JSON.stringify(version(candidate.title)) && JSON.stringify(version(anchor.album))===JSON.stringify(version(candidate.album));
}
export function createDeveloperToken({teamID,keyID,privateKey},now=Date.now()) {
 const issued=Math.floor(now/1000),encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const body=encode({alg:'ES256',kid:keyID})+'.'+encode({iss:teamID,iat:issued,exp:issued+1800});
 const key=createPrivateKey(privateKey.replace(/\\n/g,'\n'));
 if(key.asymmetricKeyType!=='ec' || key.asymmetricKeyDetails?.namedCurve!=='prime256v1') throw new Error('Invalid MusicKit signing key');
 return body+'.'+sign('sha256',Buffer.from(body),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
export function createAppleCatalog({teamID,keyID,privateKey,fetchFn,now=Date.now}={}) {
 if(!teamID || !keyID || !privateKey) return null;
 const cache=new BoundedCache({ttlMs:86400000});let token,expires=0;
 const get=async(path,context={})=>{
  if(!token || now()>=expires) {token=createDeveloperToken({teamID,keyID,privateKey},now());expires=now()+1500000;}
  return fetchJSON('https://api.music.apple.com/v1/'+path,{...context,...(fetchFn?{fetchFn}:{}),headers:{Authorization:'Bearer '+token}});
 };
 const item=(song,storefront)=>{
  const a=song.attributes,artists=song.relationships?.artists?.data??[];
  if(song.type!=='songs' || !/^\d{1,20}$/.test(song.id) || !a?.name || !a.artistName || !Number.isFinite(a.durationInMillis)) return null;
  return {catalog_id:song.id,title:a.name,artist:a.artistName,album:a.albumName,duration:a.durationInMillis/1000,storefront,
   isrc:a.isrc??null,artist_ids:artists.filter(s=>s.type==='artists').map(s=>s.id),genres:a.genreNames??[],content_rating:a.contentRating??null,provenance:'apple_music'};
 };
 const localizationCache=new BoundedCache({ttlMs:86400000});
 const languages=async(storefront,context)=>{
  const cached=localizationCache.get(storefront);if(cached)return cached;
  const page=await get(`storefronts/${storefront}`,context);
  const attributes=page.data?.[0]?.attributes;
  const supported=attributes?.supportedLanguageTags??[];
  const selected=[attributes?.defaultLanguageTag,supported.find(tag=>/^en(?:-|$)/i.test(tag))].filter(Boolean);
  const value=[...new Set(selected)].slice(0,2);localizationCache.set(storefront,value);return value;
 };
 const songs=async(storefront,params,context)=>{
  // Only ask for languages advertised by this storefront. Failure of optional
  // localization discovery must not discard the ordinary catalog lookup.
  let tags=[];try{tags=await languages(storefront,context);}catch{}
  const pages=await Promise.all((tags.length?tags:[null]).map(async tag=>{
   try {
    const page=await get(`catalog/${storefront}/songs?${new URLSearchParams({...params,include:'artists',...(tag?{l:tag}:{})})}`,context);
    return (page.data??[]).map(song=>item(song,storefront)).filter(Boolean);
   } catch(error){if(context.signal?.aborted)throw error;return [];}
  }));
  return [...new Map(pages.flat().map(song=>[JSON.stringify([song.catalog_id,song.title,song.artist,song.album]),song])).values()];
 };
 return {
  async lookup(id,storefront,context={}) {
   const key=storefront+':'+id,cached=cache.get(key);if(cached)return cached;
   const items=await songs(storefront,{ids:id},context),value=items.filter(s=>s.catalog_id===id);
   if(value.length)cache.set(key,value);return value;
  },
  equivalents(id,storefront,context={}) {return songs(storefront,{'filter[equivalents]':id},context);},
  byISRC(isrc,storefront,context={}) {return songs(storefront,{'filter[isrc]':isrc},context);}
 };
}
let configured;
export function configuredAppleCatalog(env=process.env) {
 if(configured!==undefined)return configured;
 configured=createAppleCatalog({teamID:env.APPLE_MUSIC_TEAM_ID,keyID:env.APPLE_MUSIC_KEY_ID,privateKey:env.APPLE_MUSIC_PRIVATE_KEY});
 return configured;
}
