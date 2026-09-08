import chinese from 'chinese-conv';
import {cleanLyrics} from './lyric-quality.js';
export function normalizeRecordingText(value = '') {
  return chinese.sify(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');
}
export class RecordingMismatchError extends Error {
  constructor() { super('No unambiguous matching recording found'); this.code='recording_mismatch'; }
}
const unwrappedAlbum=value=>value.replace(/^Optional\("(.*)"\)$/, '$1');
export const stripTitleDescription=value=>value.normalize('NFKC').replace(/\s*\((?:from\s+[^()]+|(?:love\s+)?theme\s+(?:song\s+)?from\s+[^()]+|[^()]*(?:主题曲|主題曲|插曲|片尾曲|片頭曲|片头曲|主题歌|主題歌)[^()]*|抖音热歌)\)/gi,description=>/\b(live|remaster(?:ed)?|instrumental|karaoke|acapella|cover|remix|demo)\b|现场|現場|演唱会|演唱會|重制|重製|伴奏|翻唱/i.test(description) ? description : '').trim();
export function normalizedAlbum(value) {
  return normalizeRecordingText(unwrappedAlbum(value).replace(/\s+-\s+(single|ep)$/i,''));
}
// Keep every contributor. Only explicit credit syntax is interchangeable; a solo
// recording, unnamed guest, remix or live suffix is never silently discarded.
export function recordingNames({title='',artist=''}) {
  const guests=[];
  const base=stripTitleDescription(title).replace(/\(\s*live\s*版?\s*\)/gi,'(Live)').replace(/\s*\((?:feat\.?|ft\.?|featuring|with)\s+([^()]+)\)/gi,(_,credit)=>{guests.push(credit);return '';});
  const credits=[artist,...guests].flatMap(value=>value.normalize('NFKC').split(/\s*(?:&|,|\/|、|\bfeat\.?\s+|\bft\.?\s+|\bfeaturing\s+|\bwith\s+)\s*/i))
    .map(normalizeRecordingText).filter(Boolean).sort();
  return {title:normalizeRecordingText(base),credits:[...new Set(credits)]};
}
export function sameRecordingNames(a,b) {
  const left=recordingNames(a),right=recordingNames(b);
  return left.title===right.title && JSON.stringify(left.credits)===JSON.stringify(right.credits);
}
export function searchTitle(value) {
  return stripTitleDescription(value).replace(/\s*\((?:feat\.?|ft\.?|featuring|with)\s+[^()]+\)/gi,'').trim();
}
function isLive(value) {
  return /\blive\b|演唱会|现场/i.test(chinese.sify(value));
}
function version(value='') {
  const text=chinese.sify(value);
  return [isLive(text), /\bdemo\b|概念版|小样/i.test(text), /\b(remix|instrumental|karaoke)\b|伴奏/i.test(text)];
}
// Soft name equivalence is request-bound evidence, never unrestricted fuzzy search.
// All rules require the same album and near-identical duration plus a catalog ID.
const sensitiveCredit = /\b(feat|ft|featuring|with|live|remaster(?:ed)?|instrumental|karaoke|acapella|cover|remix|demo|version|acoustic|reprise|edit|mix)\b|合唱|翻唱|原唱|客串|现场|現場|演唱会|演唱會|伴奏|重制|重製/iu;
const soloArtist = value => typeof value==='string' && value.trim() && !/[&,/、]/u.test(value) && !sensitiveCredit.test(value);
function reversedSoloName(a,b) {
  const latin='[\\p{Script=Latin}\\p{M}]+';
  const ordered=new RegExp(`^(${latin})\\s+(${latin})$`,'u');
  const reversed=new RegExp(`^(${latin})\\s*,\\s*(${latin})$`,'u');
  for(const [left,right] of [[a,b],[b,a]]) {
    const normal=left.normalize('NFKC').trim().match(ordered),inverted=right.normalize('NFKC').trim().match(reversed);
    if(normal && inverted && normalizeRecordingText(normal[1])===normalizeRecordingText(inverted[2]) && normalizeRecordingText(normal[2])===normalizeRecordingText(inverted[1])) return true;
  }
  return false;
}
function compoundStageName(a,b) {
  for(const [compound,plain] of [[a,b],[b,a]]) {
    if(!soloArtist(compound) || !soloArtist(plain)) continue;
    const parts=compound.normalize('NFKC').match(/^([\p{Script=Han}]{2,8})\s*\(([\p{Script=Han}]{2,12})\)$/u);
    if(parts && normalizeRecordingText(parts[2])===normalizeRecordingText(plain)) return true;
  }
  return false;
}
function artistPrefixTitle(title,artists) {
  const parts=title.match(/^(.+?)\s+[-–—]\s+(.+)$/u);
  if(!parts || !artists.some(artist=>soloArtist(artist) && normalizeRecordingText(parts[1])===normalizeRecordingText(artist))) return title;
  return parts[2];
}
function oneLongLatinEdit(a,b) {
  const left=normalizeRecordingText(a),right=normalizeRecordingText(b);
  if(!/^[\p{Script=Latin}\p{M}0-9]+$/u.test(left) || !/^[\p{Script=Latin}\p{M}0-9]+$/u.test(right)
    || (left.match(/[a-z]/g) || []).length<20 || (right.match(/[a-z]/g) || []).length<20
    || Math.abs(left.length-right.length)>1 || JSON.stringify(left.match(/\d+/g))!==JSON.stringify(right.match(/\d+/g))) return false;
  let i=0,j=0,edits=0;
  while(i<left.length && j<right.length) {
    if(left[i]===right[j]) {i++;j++;continue;}
    if(++edits>1) return false;
    // Unchanged accents are allowed; only an ASCII letter may be corrected.
    if(left.length>=right.length) {if(!/[a-z]/.test(left[i])) return false;i++;}
    if(right.length>=left.length) {if(!/[a-z]/.test(right[j])) return false;j++;}
  }
  const tail=left.slice(i)+right.slice(j);
  return edits+tail.length===1 && (!tail || /^[a-z]$/.test(tail));
}
export function metadataEquivalence(song,request) {
  if(sameRecordingNames(song,request)) return null;
  if(!/^\d{1,20}$/.test(request.catalog_id || '') || !song.album || !request.album
    || !normalizedAlbum(song.album) || normalizedAlbum(song.album)!==normalizedAlbum(request.album)
    || !Number.isFinite(song.duration) || !Number.isFinite(request.duration) || Math.abs(song.duration-request.duration)>0.5) return null;
  if([song.artist,request.artist,song.title,request.title].some(value=>typeof value!=='string' || sensitiveCredit.test(value))) return null;
  const rules=[],left=recordingNames(song),right=recordingNames(request);
  if(JSON.stringify(left.credits)!==JSON.stringify(right.credits)) {
    if(reversedSoloName(song.artist,request.artist)) rules.push('reversed_solo_artist');
    else if(compoundStageName(song.artist,request.artist)) rules.push('compound_stage_name');
    else return null;
  }
  if(left.title!==right.title) {
    const artists=[song.artist,request.artist];
    const a=artistPrefixTitle(stripTitleDescription(song.title),artists),b=artistPrefixTitle(stripTitleDescription(request.title),artists);
    if(normalizeRecordingText(a)===normalizeRecordingText(b)) rules.push('artist_prefixed_title');
    else if(oneLongLatinEdit(a,b)) {
      if(a!==stripTitleDescription(song.title) || b!==stripTitleDescription(request.title)) rules.push('artist_prefixed_title');
      rules.push('long_title_typo');
    } else return null;
  }
  return rules.length ? {rules}:null;
}
function equivalentLyrics(a,b) {
  if (!Number.isFinite(a.duration) || !Number.isFinite(b.duration) || Math.abs(a.duration-b.duration)>0.5) return false;
  if (JSON.stringify(version(a.album))!==JSON.stringify(version(b.album))) return false;
  const instrumental=song=> {
    const data=cleanLyrics(song.lyricsData,{duration:song.duration});
    return data?.instrumental===true && data.lines.length===0;
  };
  // Instrumental copies have no text fingerprint. Require the full matching
  // album and names in addition to both sources' explicit instrumental flag.
  // An empty response, another album, or actual vocal text cannot form a tie.
  if(instrumental(a) || instrumental(b)) return instrumental(a) && instrumental(b)
    && !!a.album && !!b.album && !!normalizedAlbum(a.album)
    && normalizedAlbum(a.album)===normalizedAlbum(b.album) && sameRecordingNames(a,b);
  const canonical=song=> {
    const data=song.lyricsData;
    if(data?.lines?.some(line=>line.timestamp!=null && (!Number.isFinite(line.timestamp) || line.timestamp<0 || line.timestamp>song.duration))) return null;
    const lines=cleanLyrics(data,{duration:song.duration})?.lines;
    if (!lines?.length) return null;
    return JSON.stringify(lines.map(line=>[line.timestamp ?? null,normalizeRecordingText(line.text)]));
  };
  const left=canonical(a);
  return left!==null && left===canonical(b);
}
export function recordingScore(song, request) {
  const strict=sameRecordingNames(song,request);
  if (!strict && !metadataEquivalence(song,request)) return -1;
  if (request.album && song.album && JSON.stringify(version(`${request.title} ${request.album}`)) !== JSON.stringify(version(`${song.title} ${song.album}`))) return -1;
  let score = strict ? 1:0.75;
  if (request.duration != null && song.duration != null) {
    const difference = Math.abs(request.duration-song.duration);
    if (difference > 3) return -1;
    score += 2 - difference/10;
  }
  if (request.album && song.album && normalizedAlbum(request.album)===normalizedAlbum(song.album)) {
    // A release suffix is useful fallback evidence, but must not erase the
    // distinction when an exact album match also exists (e.g. Mojito).
    score += normalizeRecordingText(unwrappedAlbum(request.album))===normalizeRecordingText(unwrappedAlbum(song.album)) ? 3:2.5;
  }
  return score;
}
export function findRecording(songs, request) {
  if (!songs.length) return null;
  const ranked = songs.map(song=>({song,score:recordingScore(song,request)})).filter(x=>x.score>=0).sort((a,b)=>b.score-a.score);
  if (!ranked.length) throw new RecordingMismatchError();
  const tied=ranked.filter(item=>Math.abs(item.score-ranked[0].score)<1e-9).map(item=>item.song);
  if (tied.some(song=>song.id!==tied[0].id && !equivalentLyrics(tied[0],song))) throw new RecordingMismatchError();
  return tied.sort((a,b)=>String(a.id).localeCompare(String(b.id),'en',{numeric:true}))[0];
}

// Prefer usable timing only after establishing the recording. A release suffix
// alone must not strand plain lyrics when a near-identical timed copy exists.
export function findLyricsRecording(songs, request) {
  const best=findRecording(songs,request);
  if(!best || best.lyricsData?.lines?.some(line=>Number.isFinite(line.timestamp) && line.timestamp>=0)) return best;
  if(!Number.isFinite(request.duration) || !Number.isFinite(best.duration) || !best.album) return best;
  const text=song=>normalizeRecordingText((song.lyricsData?.lines || []).map(line=>line.text || '').join(''));
  const original=text(best);
  if(!original) return best;
  const candidates=songs.filter(song=> {
    if(recordingScore(song,request)<0 || !song.album || normalizedAlbum(song.album)!==normalizedAlbum(best.album)
       || !Number.isFinite(song.duration) || Math.abs(song.duration-best.duration)>0.5) return false;
    const lines=song.lyricsData?.lines?.filter(line=>line.text?.trim()) || [];
    if(lines.length<2 || !lines.every(line=>Number.isFinite(line.timestamp) && line.timestamp>=0 && line.timestamp<=song.duration)
       || new Set(lines.map(line=>line.timestamp)).size<2) return false;
    const candidate=text(song);
    if(candidate===original) return true;
    // Permit only tiny insertions (e.g. a transcribed ad-lib), never changed or
    // reordered words or a missing verse. Work is linear in lyric length.
    const left=Array.from(original),right=Array.from(candidate);
    const [short,long]=left.length<right.length ? [left,right]:[right,left];
    if(long.length-short.length>Math.min(8,Math.floor(short.length*0.02))) return false;
    let index=0;
    for(const character of long) if(character===short[index]) index++;
    return index===short.length;
  });
  try { return findRecording(candidates,request) || best; }
  catch(error) { if(error.code==='recording_mismatch') return best; throw error; }
}
