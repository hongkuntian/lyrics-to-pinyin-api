import {normalizeLyricAnnotations} from './lyric-annotations.js';

export function cleanLyrics(data, options = {}) {
  if (!data) return null;
  const {duration}=options;
  const normalized=normalizeLyricAnnotations(data,options);
  const lines = normalized.lines
    .map(line => ({...line, timestamp: Number.isFinite(line.timestamp) && line.timestamp >= 0
      && (!Number.isFinite(duration) || line.timestamp <= duration) ? line.timestamp : null}));
  // NetEase encodes its explicit instrumental flag as this fixed full phrase.
  // Only accept it from that provider and only when no vocal text remains.
  const markedInstrumental=data.source==='netease' && (data.lines || []).some(line=>
    /^(?:纯音乐[，,。\s]*请欣赏|純音樂[，,。\s]*請欣賞)[。.!\s]*$/u.test(line.text?.trim() || ''));
  return {...normalized, lines, instrumental: (data.instrumental === true || markedInstrumental) && lines.length === 0};
}

export function hasUsableLyrics(data, options) {
  const cleaned = cleanLyrics(data, options);
  return !!cleaned && (cleaned.lines.length > 0 || cleaned.instrumental);
}

export function timingStructure(data, options) {
  const cleaned = cleanLyrics(data, options);
  const times = (cleaned?.lines || []).map(line => line.timestamp).filter(Number.isFinite);
  return {vocalLines: cleaned?.lines.length || 0, timedLines: times.length,
    distinctTimes: new Set(times).size, instrumental: cleaned?.instrumental === true};
}
