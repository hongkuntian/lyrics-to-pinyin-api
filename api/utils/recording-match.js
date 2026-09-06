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
export function recordingScore(song, request) {
  if (normalizeRecordingText(song.title)!==normalizeRecordingText(request.title) ||
      normalizeRecordingText(song.artist)!==normalizeRecordingText(request.artist)) return -1;
  if (request.album && song.album && isLive(request.album) !== isLive(song.album)) return -1;
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
  if (!ranked.length || (ranked[1] && ranked[0].score===ranked[1].score && ranked[0].song.id!==ranked[1].song.id)) throw new RecordingMismatchError();
  return ranked[0].song;
}
