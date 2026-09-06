import chinese from 'chinese-conv';
export function normalizeRecordingText(value = '') {
  return chinese.sify(value).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');
}
export class RecordingMismatchError extends Error {
  constructor() { super('No unambiguous matching recording found'); this.code='recording_mismatch'; }
}
function normalizedAlbum(value) {
  return normalizeRecordingText(value.replace(/^Optional\("(.*)"\)$/, '$1'));
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
  if (normalizeRecordingText(song.title)!==normalizeRecordingText(request.title) ||
      normalizeRecordingText(song.artist)!==normalizeRecordingText(request.artist)) return -1;
  if (request.album && song.album && JSON.stringify(version(request.album)) !== JSON.stringify(version(song.album))) return -1;
  let score = 1;
  if (request.duration != null && song.duration != null) {
    const difference = Math.abs(request.duration-song.duration);
    if (difference > 3) return -1;
    score += 2 - difference/10;
  }
  if (request.album && song.album && normalizedAlbum(request.album)===normalizedAlbum(song.album)) score += 3;
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
