import {normalizeRecordingText,normalizedAlbum,sameRecordingVersions,recordingScore} from './recording-match.js';
import {validArtistIdentity} from './artist-identities.js';

export const ARTIST_ALIAS_RECOVERY_POLICY='artist-alias-recovery-1';
export const ARTIST_ID_ALIAS_POLICY='artist-id-alias-recovery-1';
const text=value=>typeof value==='string'&&value.trim().length>0&&value.length<=512&&!/\p{C}/u.test(value);
const positiveID=value=>/^[1-9]\d{0,19}$/.test(String(value));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
// PostgreSQL JSONB reorders object keys. Evidence compares canonical values,
// while array order (including performer boundaries) remains significant.
const same=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const latin=value=>text(value)&&/^[\p{Script=Latin}\p{M}\s,\p{Dash_Punctuation}]+$/u.test(value)
  ?value.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu,'').replace(/\p{Dash_Punctuation}/gu,'-').toLowerCase().trim():null;
const sensitive=/\b(?:feat|ft|featuring|with|live|cover|remix|demo|version|band|orchestra|choir)\b/iu;

// These are explicit personal-name representations, not a token-sort or edit
// distance permission. Short names, changed letters and mixed scripts abstain.
export function artistAliasRule(a,b) {
  if(!text(a)||!text(b))return null;
  if(normalizeRecordingText(a)===normalizeRecordingText(b))return 'exact';
  const left=latin(a),right=latin(b);
  if(!left||!right||sensitive.test(left)||sensitive.test(right))return null;
  if(normalizeRecordingText(left)===normalizeRecordingText(right))return 'latin_diacritics';
  for(const [normal,inverted] of [[left,right],[right,left]]) {
    const ordered=normal.match(/^([a-z]{2,}(?:-[a-z]{2,})?)\s+([a-z]{2,})$/u);
    const comma=inverted.match(/^([a-z]{2,}),\s*([a-z]{2,}(?:-[a-z]{2,})?)$/u);
    if(ordered&&comma&&ordered[1]===comma[2]&&ordered[2]===comma[1])return 'comma_name_order';
    const givenFirst=normal.match(/^([a-z]{2,}-[a-z]{2,})\s+([a-z]{2,})$/u);
    const familyFirst=inverted.match(/^([a-z]{2,})\s+([a-z]{2,}-[a-z]{2,})$/u);
    if(givenFirst&&familyFirst&&givenFirst[1]===familyFirst[2]&&givenFirst[2]===familyFirst[1])return 'hyphenated_name_order';
    const separated=normal.match(/^([a-z]{2,})\s+([a-z]{2,}-[a-z]{2,})$/u);
    const joined=inverted.match(/^([a-z]{4,})\s+([a-z]{2,})$/u);
    if(separated&&joined&&separated[1]===joined[2]&&separated[2].replace('-','')===joined[1])return 'hyphenated_name_order';
  }
  return null;
}
const requestSignature=request=>({itemID:request.recordingItemID,title:request.title,album:request.album,
  duration:request.duration,artists:request.creditedArtistNames,...(request.creditedArtistIDs?{artistIDs:request.creditedArtistIDs}:{}),isrc:request.isrc??null,explicit:request.explicit??null});
const sourceSignature=song=>({id:String(song.id),provider:song.source,title:song.title,artist:song.artist,album:song.album,
  duration:song.duration,artists:song.creditedArtistNames,...(song.creditedArtistIDs?{artistIDs:song.creditedArtistIDs}:{}),isrc:song.isrc??null,explicit:song.explicit??null});
function eligible(song,request) {
  return request?.recordingProvider==='spotify'&&/^[A-Za-z0-9]{22}$/.test(request.recordingItemID??'')
    &&song?.source==='netease'&&positiveID(song.id)&&text(song.title)&&text(request.title)
    &&normalizeRecordingText(song.title)===normalizeRecordingText(request.title)
    &&text(song.album)&&text(request.album)&&normalizedAlbum(song.album)===normalizedAlbum(request.album)
    &&Number.isFinite(song.duration)&&Number.isFinite(request.duration)&&song.duration>0&&Math.abs(song.duration-request.duration)<=0.5
    &&sameRecordingVersions(song,request)&&!(song.isrc&&request.isrc&&song.isrc!==request.isrc)
    &&!(typeof song.explicit==='boolean'&&typeof request.explicit==='boolean'&&song.explicit!==request.explicit)
    &&Array.isArray(song.creditedArtistNames)&&song.creditedArtistNames.length>0&&song.creditedArtistNames.length<=3
    &&song.creditedArtistNames.every(text)&&Array.isArray(request.creditedArtistNames)
    &&request.creditedArtistNames.length===song.creditedArtistNames.length&&request.creditedArtistNames.every(text)
    &&new Set(request.creditedArtistNames.map(normalizeRecordingText)).size===request.creditedArtistNames.length;
}
function assignments(performers,requested) {
  const found=[];
  const visit=(index,used,chosen)=>{
    if(found.length>1)return;
    if(index===performers.length){found.push(chosen);return;}
    const performer=performers[index];
    for(let i=0;i<requested.length;i++)if(!used.has(i)) {
      const rules=performer.names.map(name=>artistAliasRule(name,requested[i])).filter(Boolean);
      const rule=['exact','latin_diacritics','comma_name_order','hyphenated_name_order'].find(value=>rules.includes(value));
      if(rule)visit(index+1,new Set([...used,i]),[...chosen,{...performer,requested:requested[i],rule}]);
    }
  };
  visit(0,new Set(),[]);return found;
}
function validPerformers(performers,song) {
  return Array.isArray(performers)&&performers.length===song.creditedArtistNames.length
    &&new Set(performers.map(p=>p?.id)).size===performers.length
    &&performers.every((p,i)=>p&&positiveID(p.id)&&typeof p.id==='string'&&p.name===song.creditedArtistNames[i]
      &&(song.creditedArtistIDs===undefined||p.id===song.creditedArtistIDs[i])
      &&Array.isArray(p.names)&&p.names.length>0&&p.names.length<=32&&p.names.every(text)
      &&normalizeRecordingText(p.names[0])===normalizeRecordingText(p.name));
}
export function buildArtistAliasEvidence(song,performers,request,profiles) {
  if(!eligible(song,request)||!Array.isArray(performers))return null;
  const entries=performers.map(p=>({id:String(p.id),name:p.name,names:(profiles.get(String(p.id))??[p.name]).slice(0,32)}));
  if(!validPerformers(entries,song))return null;
  const matches=assignments(entries,request.creditedArtistNames);
  if(matches.length!==1||matches[0].every(p=>p.rule==='exact'))return null;
  return {version:1,policy:ARTIST_ALIAS_RECOVERY_POLICY,source:sourceSignature(song),request:requestSignature(request),performers:matches[0]};
}
export function recoveredArtistNames(song,request) {
  try {
    const e=song.artistAliasEvidence;
    if(e?.policy===ARTIST_ID_ALIAS_POLICY)return recoveredIdentityNames(song,request);
    if(!eligible(song,request)||e?.version!==1||e.policy!==ARTIST_ALIAS_RECOVERY_POLICY
      ||!same(e.source,sourceSignature(song))||!same(e.request,requestSignature(request))||!validPerformers(e.performers,song))return null;
    const matches=assignments(e.performers,request.creditedArtistNames);
    return matches.length===1&&matches[0].some(p=>p.rule!=='exact')&&same(matches[0],e.performers)
      ?matches[0].map(p=>p.requested):null;
  }catch{return null;}
}

function identityEligible(song,request) {
  return request?.recordingProvider==='spotify'&&/^[A-Za-z0-9]{22}$/.test(request.recordingItemID??'')
    &&song?.source==='netease'&&positiveID(song.id)&&text(song.album)&&text(request.album)
    &&normalizedAlbum(song.album)===normalizedAlbum(request.album)
    &&Array.isArray(request.creditedArtistNames)&&request.creditedArtistNames.length>0&&request.creditedArtistNames.length<=3
    &&request.creditedArtistNames.every(text)&&new Set(request.creditedArtistNames.map(normalizeRecordingText)).size===request.creditedArtistNames.length
    &&Array.isArray(request.creditedArtistIDs)&&request.creditedArtistIDs.length===request.creditedArtistNames.length
    &&request.creditedArtistIDs.every(v=>typeof v==='string'&&/^[A-Za-z0-9]{22}$/.test(v))
    &&new Set(request.creditedArtistIDs).size===request.creditedArtistIDs.length
    &&Array.isArray(song.creditedArtistNames)&&song.creditedArtistNames.length===request.creditedArtistNames.length
    &&Array.isArray(song.creditedArtistIDs)&&song.creditedArtistIDs.length===song.creditedArtistNames.length
    &&song.creditedArtistIDs.every(v=>typeof v==='string'&&positiveID(v))&&new Set(song.creditedArtistIDs).size===song.creditedArtistIDs.length
    // Identity evidence changes names only. All ordinary recording gates still
    // run, including the existing duration policy used by provider aliases.
    &&recordingScore({...song,artistAliasEvidence:undefined,creditedArtistNames:request.creditedArtistNames},request)>=0;
}
function identitySupports(identity,performer,requested,requestedID) {
  if(!validArtistIdentity(identity)||identity.spotifyArtistID!==requestedID)return false;
  const names=new Set(identity.names.map(normalizeRecordingText));
  if(!names.has(normalizeRecordingText(requested))||!names.has(normalizeRecordingText(performer.name)))return false;
  if(identity.neteaseArtistIDs.length)return identity.neteaseArtistIDs.includes(performer.id);
  // Some entities lack a NetEase ID. Require two distinct fresh provider
  // profile names, including its canonical name; a shared homonym is insufficient.
  return new Set(performer.names.filter(name=>names.has(normalizeRecordingText(name))).map(normalizeRecordingText)).size>=2;
}
function identityAssignments(performers,request,identities) {
  const found=[];
  const visit=(at,used,chosen)=>{
    if(found.length>1)return;
    if(at===performers.length){found.push(chosen);return;}
    const p=performers[at];
    for(let i=0;i<request.creditedArtistNames.length;i++)if(!used.has(i)) {
      const requested=request.creditedArtistNames[i],requestedID=request.creditedArtistIDs[i];
      if(p.names.some(name=>normalizeRecordingText(name)===normalizeRecordingText(requested)))
        visit(at+1,new Set([...used,i]),[...chosen,{...p,requested,requestedID,rule:'exact'}]);
      else {
        const matched=identities.filter(identity=>identitySupports(identity,p,requested,requestedID));
        if(matched.length===1)visit(at+1,new Set([...used,i]),[...chosen,{...p,requested,requestedID,rule:'catalog_artist_identity',identity:matched[0]}]);
      }
    }
  };
  visit(0,new Set(),[]);return found;
}
export function buildArtistIdentityEvidence(song,performers,request,profiles,identities) {
  if(!identityEligible(song,request)||!Array.isArray(performers)||!Array.isArray(identities)||identities.length>3)return null;
  const entries=performers.map(p=>({id:String(p.id),name:p.name,names:(profiles.get(String(p.id))??[p.name]).slice(0,32)}));
  if(!validPerformers(entries,song))return null;
  const matches=identityAssignments(entries,request,identities);
  if(matches.length!==1||!matches[0].some(p=>p.rule==='catalog_artist_identity'))return null;
  return {version:1,policy:ARTIST_ID_ALIAS_POLICY,source:sourceSignature(song),request:requestSignature(request),performers:matches[0]};
}
function recoveredIdentityNames(song,request) {
  const e=song.artistAliasEvidence;
  if(!identityEligible(song,request)||e?.version!==1||!same(e.source,sourceSignature(song))||!same(e.request,requestSignature(request))
    ||!validPerformers(e.performers,song))return null;
  const identities=e.performers.flatMap(p=>p.identity?[p.identity]:[]);
  const base=e.performers.map(({requested,requestedID,rule,identity,...p})=>p);
  const matches=identityAssignments(base,request,identities);
  return matches.length===1&&matches[0].some(p=>p.rule==='catalog_artist_identity')&&same(matches[0],e.performers)?matches[0].map(p=>p.requested):null;
}

// Broadening discovery never authorizes acceptance. Reuse the second NetEase
// query only when the first page has no plausible metadata anchor, keeping the
// existing two-query bound and retaining short-title / Apple behavior.
export function recoverySearchTitle(request) {
  const title=request?.title;
  if(request?.recordingProvider==='spotify'&&text(title)&&text(request.album)&&Number.isFinite(request.duration)
    &&Array.isArray(request.creditedArtistIDs)&&request.creditedArtistIDs.length>0&&request.creditedArtistIDs.length<=3
    &&request.creditedArtistIDs.length===request.creditedArtistNames?.length
    &&request.creditedArtistIDs.every(v=>typeof v==='string'&&/^[A-Za-z0-9]{22}$/.test(v)))return title;
  return request?.recordingProvider==='spotify'&&text(request.album)&&Number.isFinite(request.duration)
    &&typeof title==='string'&&/^[\p{Script=Han}\p{P}\p{Z}\s]+$/u.test(title)
    &&(title.match(/\p{Script=Han}/gu)?.length??0)>=3&&Array.isArray(request.creditedArtistNames)
    &&request.creditedArtistNames.some(name=>/\p{Script=Latin}/u.test(name))?title:null;
}
