import {createHash} from 'node:crypto';
import {fetchJSON,withDeadline} from './fetch-json.js';
import {parseLRC} from './lrc.js';
import {cleanLyrics} from './lyric-quality.js';
import {normalizeRecordingText,normalizedAlbum,recordingScore} from './recording-match.js';

export function timingFingerprint(lyrics) {
  return createHash('sha256').update(JSON.stringify((lyrics?.lines || []).map(line=>[line.timestamp ?? null,line.text.normalize('NFC')]))).digest('hex');
}
// Recording-bound source correction, supported by independent NetEase timing
// alignment. Store fingerprints rather than redistributing a lyric corpus.
// A revised upstream transcription must be reviewed again, never auto-offset.
export const timingCorrections=[{
  id:'faye-wong-966805806-timing-v1',catalog_id:'966805806',
  artists:['Faye Wong','王菲'],canonicalArtist:'Faye Wong',title:'匆匆那年',album:'匆匆那年',duration:241,
  rejected:['162ea9e84242bce797d7512e891d71746a73eabd7ad3e301dd4936fc6c1da2c1'],
  replacementID:38130197,replacementFingerprint:'b9349b6cc4f04372386bbf0a41ed26e2a894a2d66bb7ab25bee8c3458a70d810'
}];
export async function applyTimingCorrection(candidate, request, context={}, {rules=timingCorrections,fetchJSONFn=fetchJSON}={}) {
  const rule=rules.find(rule=>request.catalog_id===rule.catalog_id
    && rule.artists.some(artist=>normalizeRecordingText(artist)===normalizeRecordingText(request.artist))
    && normalizeRecordingText(request.title)===normalizeRecordingText(rule.title)
    && normalizedAlbum(request.album || '')===normalizedAlbum(rule.album)
    && Number.isFinite(request.duration) && Math.abs(request.duration-rule.duration)<=0.1
    && rule.rejected.includes(timingFingerprint(candidate.lyrics)));
  if(!rule) return candidate;
  try {
    const budget=Math.min(1500,(context.deadline ?? Date.now()+1600)-Date.now()-100);
    if(budget<=0) throw new Error('No correction budget remains');
    const raw=await withDeadline(signal=>fetchJSONFn(`https://lrclib.net/api/get/${rule.replacementID}`,{...context,signal}),budget,context.signal);
    const song={id:raw.id,title:raw.trackName,artist:raw.artistName,album:raw.albumName,duration:raw.duration,source:'lrclib'};
    const lyrics=cleanLyrics({lines:parseLRC(raw.syncedLyrics || ''),source:'lrclib',songId:raw.id},{duration:raw.duration});
    if(String(raw.id)===String(rule.replacementID) && recordingScore(song,{...request,artist:rule.canonicalArtist || request.artist})>=0
      && timingFingerprint(lyrics)===rule.replacementFingerprint) {
      // Retain the original spelling and character ranges when every row
      // has identical normalized words; only the verified timestamps change.
      const sameRows=candidate.lyrics.lines.length===lyrics.lines.length && candidate.lyrics.lines.every((line,index)=>normalizeRecordingText(line.text)===normalizeRecordingText(lyrics.lines[index].text));
      const corrected=sameRows ? {...lyrics,lines:lyrics.lines.map((line,index)=>({...line,text:candidate.lyrics.lines[index].text}))}:lyrics;
      return {...candidate,song,lyrics:corrected,api:{name:'LRCAPI'},target:request,
        timingCorrection:{id:rule.id,status:'replacement',source_fingerprint:rule.replacementFingerprint}};
    }
  } catch { /* The other provider can still supply verified timing. */ }
  // Known-bad timing is never returned as synced merely because a correction
  // source is unavailable. Preserve the words for reading and study.
  return {...candidate,lyrics:{...candidate.lyrics,lines:candidate.lyrics.lines.map(line=>({...line,timestamp:null}))},
    timingCorrection:{id:rule.id,status:'untimed_fallback'}};
}
