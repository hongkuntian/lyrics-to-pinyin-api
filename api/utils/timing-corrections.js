import {createHash} from 'node:crypto';
import {fetchJSON,withDeadline} from './fetch-json.js';
import {parseLRC} from './lrc.js';
import {cleanLyrics} from './lyric-quality.js';
import {normalizeRecordingText,normalizedAlbum,recordingScore} from './recording-match.js';
import {isMusicNotePlaceholder} from './lyric-annotations.js';
import {isRejectedRecordingLyrics} from './rejected-lyrics.js';

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
},{
  // The 4:37 So Bravo recording uses this broken transcription under several
  // LRCLIB IDs (including 19913744). Its first vocal is tagged at 28.96s;
  // the reviewed alternative starts at 48.80s. Twenty independent NetEase
  // anchors agree within 0.50s across the complete song (307525, 2026-10-01).
  // This is a full timeline replacement, never a guessed global offset.
  id:'valen-hsu-1560789314-timing-v1',catalog_id:'1560789314',
  artists:['Valen Hsu','许茹芸','許茹芸'],canonicalArtist:'Valen Hsu',
  title:'獨角戲',titles:['獨角戲','Du Jiao Xi'],canonicalTitle:'獨角戲',
  album:'茹此精彩十三首',albums:['茹此精彩十三首','So Bravo 13 Songs'],duration:277.093,
  rejected:['e78e01f157c9af5fb9504fbe2ad3f4c632541c547155efdd93a7fdee6c2b24ac',
    '33783447a3ceaad40bcdd4f62da0ba51afa5ccaffe147cd90dc781261b8dbc5b'],
  replacementID:11773385,replacementFingerprint:'fe68362286f9342888624f4452e4dee9d9307ace7136f848dd30b28a6452ac7a',
  replacementSignature:{title:'獨角戲',artist:'Valen Hsu',album:'茹此精彩十三首',duration:277}
}];
function correctionRule(lyrics,request,rules) {
  return rules.find(rule=>request.catalog_id===rule.catalog_id
    && rule.artists.some(artist=>normalizeRecordingText(artist)===normalizeRecordingText(request.artist))
    && (rule.titles || [rule.title]).some(title=>normalizeRecordingText(request.title)===normalizeRecordingText(title))
    && (rule.albums || [rule.album]).some(album=>normalizedAlbum(request.album || '')===normalizedAlbum(album))
    && Number.isFinite(request.duration) && Math.abs(request.duration-rule.duration)<=0.1
    && rule.rejected.includes(timingFingerprint(lyrics)));
}
// Invalidate only cached sources that need this repair. Keep the existing
// selection contract so current apps can still cache unaffected recordings.
export function lyricSourceNeedsRefresh(response,request,{rules=timingCorrections,recordingRejections}={}) {
  const lines=response?.lines || [];
  if(lines.some(line=>isMusicNotePlaceholder(line.original))) return true;
  if(isRejectedRecordingLyrics(lines.map(line=>({text:line.original})),request,recordingRejections)) return true;
  return Boolean(correctionRule({lines:lines.map(line=>({text:line.original,timestamp:line.timestamp}))},request,rules));
}
export async function applyTimingCorrection(candidate, request, context={}, {rules=timingCorrections,fetchJSONFn=fetchJSON}={}) {
  const rule=correctionRule(candidate.lyrics,request,rules);
  if(!rule) return candidate;
  try {
    const budget=Math.min(1500,(context.deadline ?? Date.now()+1600)-Date.now()-100);
    if(budget<=0) throw new Error('No correction budget remains');
    const raw=await withDeadline(signal=>fetchJSONFn(`https://lrclib.net/api/get/${rule.replacementID}`,{...context,signal}),budget,context.signal);
    const song={id:raw.id,title:raw.trackName,artist:raw.artistName,album:raw.albumName,duration:raw.duration,source:'lrclib'};
    const lyrics=cleanLyrics({lines:parseLRC(raw.syncedLyrics || ''),source:'lrclib',songId:raw.id},{duration:raw.duration});
    const expected=rule.replacementSignature;
    const verified=!expected || (['title','artist'].every(key=>typeof song[key]==='string'
      && normalizeRecordingText(song[key])===normalizeRecordingText(expected[key]))
      && typeof song.album==='string' && normalizedAlbum(song.album)===normalizedAlbum(expected.album)
      && Number.isFinite(song.duration) && Math.abs(song.duration-expected.duration)<=0.5);
    if(verified && String(raw.id)===String(rule.replacementID) && recordingScore(song,{...request,
      artist:rule.canonicalArtist || request.artist,title:rule.canonicalTitle || request.title,album:rule.album})>=0
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
  return {...candidate,lyrics:{...candidate.lyrics,lines:candidate.lyrics.lines.map(line=>({...line,timestamp:null})),
    ...(candidate.lyrics.lyricStructure ? {lyricStructure:{...candidate.lyrics.lyricStructure,
      sourceRows:candidate.lyrics.lyricStructure.sourceRows.map(row=>({...row,timestamp:null}))}}:{})},
    timingCorrection:{id:rule.id,status:'untimed_fallback'}};
}
