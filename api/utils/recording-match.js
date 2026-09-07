import chinese from 'chinese-conv';
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
  const base=stripTitleDescription(title).replace(/\s*\((?:feat\.?|ft\.?|featuring|with)\s+([^()]+)\)/gi,(_,credit)=>{guests.push(credit);return '';});
  const credits=[artist,...guests].flatMap(value=>value.normalize('NFKC').split(/\s*(?:&|,|\/|、|\bfeat\.?\s+|\bft\.?\s+|\bfeaturing\s+|\bwith\s+)\s*/i))
    .map(normalizeRecordingText).filter(Boolean).sort();
  return {title:normalizeRecordingText(base),credits};
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
function equivalentLyrics(a,b) {
  if (!Number.isFinite(a.duration) || !Number.isFinite(b.duration) || Math.abs(a.duration-b.duration)>0.5) return false;
  if (JSON.stringify(version(a.album))!==JSON.stringify(version(b.album))) return false;
  const canonical=song=> {
    const lines=song.lyricsData?.lines;
    if (!lines?.length || !lines.some(line=>line.text?.trim())) return null;
    return JSON.stringify(lines.map(line=>[line.timestamp ?? null,line.text.trim().normalize('NFC')]));
  };
  const left=canonical(a);
  return left!==null && left===canonical(b);
}
export function recordingScore(song, request) {
  if (!sameRecordingNames(song,request)) return -1;
  if (request.album && song.album && JSON.stringify(version(request.album)) !== JSON.stringify(version(song.album))) return -1;
  let score = 1;
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
