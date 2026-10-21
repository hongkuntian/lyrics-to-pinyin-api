import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import chinese from 'chinese-conv';

const require=createRequire(import.meta.url);
const {recordings,catalogRecordings=[],spotifyRecordings=[]}=require('../data/rejected-lyrics.json');
const spotifyKeys=new Map(spotifyRecordings.flatMap(record=>record.itemIDs.map(itemID=>[
  createHash('sha256').update(JSON.stringify(['spotify-recording-2',itemID])).digest('hex'),record])));

// Match words independently of timestamps, wrapping, punctuation, and Chinese
// script. Metadata alone cannot identify a mislabeled language version.
export function lyricsFingerprint(lines) {
  // Published negative reviews use this historical digest recipe. Catalogue
  // spelling recovery must never silently change those existing exclusions.
  const text=chinese.sify(lines.map(line=>line.text || '').join('')).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,'');
  return createHash('sha256').update(text).digest('hex');
}
export function isRejectedLyrics(provider,id,lines,records=recordings) {
  const matches=records.filter(record=>record.provider===provider && record.id===String(id));
  return matches.length>0 && matches.some(record=>record.lyricsSha256===lyricsFingerprint(lines));
}

// A valid transcription for one language version can be copied under many
// provider IDs. Reject its complete performed-word fingerprint only for the
// reviewed catalog recording; it remains available for its legitimate version.
// Negative evidence never grants recording equivalence or supplies replacement
// words/timing. Provider metadata still validates through the ordinary matcher.
export function isRejectedRecordingLyrics(lines,request={},records=catalogRecordings) {
  // Negative evidence never aliases a Spotify item to an Apple recording. The
  // same predicate accepts the validated V2 request and its internal search DTO.
  const spotifyID=request.provider==='spotify'&&request.version===2?request.item_id
    :request.recordingProvider==='spotify'?request.recordingItemID:null;
  const immutableReview=request.recordingProvider==='spotify'?spotifyKeys.get(request.recordingKey):null;
  const matches=[...records.filter(record=>record.catalogIDs?.includes(request.catalog_id)),
    ...spotifyRecordings.filter(record=>spotifyID&&record.itemIDs.includes(spotifyID)),...(immutableReview?[immutableReview]:[])];
  return matches.length>0 && matches.some(record=> {
    if(record.requiredScripts) {
      // Reviewed recording-specific source evidence, never a title-script guess.
      const text=lines.map(line=>line.text??'').join('\n');
      return !record.requiredScripts.some(script=>new RegExp(`\\p{Script=${script}}`,'u').test(text));
    }
    return record.lyricsSha256===lyricsFingerprint(lines);
  });
}
