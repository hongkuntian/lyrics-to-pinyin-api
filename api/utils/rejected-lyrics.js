import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {normalizeRecordingText} from './recording-match.js';

const require=createRequire(import.meta.url);
const {recordings}=require('../data/rejected-lyrics.json');

// Match words independently of timestamps, wrapping, punctuation, and Chinese
// script. Metadata alone cannot identify a mislabeled language version.
export function lyricsFingerprint(lines) {
  return createHash('sha256').update(normalizeRecordingText(lines.map(line=>line.text || '').join(''))).digest('hex');
}
export function isRejectedLyrics(provider,id,lines,records=recordings) {
  const matches=records.filter(record=>record.provider===provider && record.id===String(id));
  return matches.length>0 && matches.some(record=>record.lyricsSha256===lyricsFingerprint(lines));
}
