// Research only. Nothing under api/ imports this module.
import {createHash} from 'node:crypto';
import fetch from 'node-fetch';
import {LRCAPI} from '../../api/music-apis/lrclib.js';
import {NeteaseAPI} from '../../api/music-apis/netease.js';
import {KugouAPI} from '../../api/music-apis/kugou.js';
import {parseLRC} from '../../api/utils/lrc.js';
import {cleanLyrics, timingStructure} from '../../api/utils/lyric-quality.js';
import {lyricsFingerprint} from '../../api/utils/rejected-lyrics.js';

export const providerNames = ['lrclib', 'netease', 'kugou', 'lyrics-ovh',
  'musicbrainz', 'musicae', 'musixmatch-apple', 'musixmatch-isrc'];
const constructors = {lrclib: LRCAPI, netease: NeteaseAPI, kugou: KugouAPI};
const skipped = reason => ({status: 'skipped', reason});

export function summarizeLyrics(data, song, expected) {
  const rawLines = data?.lines || [];
  const cleaned = cleanLyrics(data, {duration: expected.duration});
  const lines = cleaned?.lines || [];
  const hash = lines.length ? lyricsFingerprint(lines) : null;
  const verdict = !lines.length ? 'no_lyrics'
    : expected.rejectedHashes?.includes(hash) ? 'known_wrong_version'
    : hash === expected.referenceHash ? 'reference_text_match'
    : expected.referenceHash ? 'different_text_needs_review' : 'unreviewed_text';
  // Return metadata and hashes only, never lyric bodies or entire upstream objects.
  return {
    status: lines.length ? 'lyrics_returned' : 'no_lyrics', verdict,
    recording: song ? Object.fromEntries(['id','title','artist','album','duration','isrc']
      .filter(k => song[k] != null).map(k => [k, song[k]])) : null,
    durationDelta: Number.isFinite(song?.duration) && Number.isFinite(expected.duration)
      ? Math.round((song.duration - expected.duration) * 1000) / 1000 : null,
    ...timingStructure(cleaned, {duration: expected.duration}),
    outOfRangeTimestamps: rawLines.filter(l => Number.isFinite(l.timestamp)
      && (l.timestamp < 0 || (Number.isFinite(expected.duration) && l.timestamp > expected.duration))).length,
    textSha256: hash,
    timelineSha256: lines.length ? createHash('sha256')
      .update(JSON.stringify(lines.map(l => [l.timestamp ?? null, l.text]))).digest('hex') : null,
    firstTimestamp: lines.find(l => Number.isFinite(l.timestamp))?.timestamp ?? null,
    lastTimestamp: [...lines].reverse().find(l => Number.isFinite(l.timestamp))?.timestamp ?? null,
  };
}

export async function probe(provider, track, {env = {}, fetchFn = fetch,
  timeoutMs = 15000, budget = {remaining: 40}, now = Date.now} = {}) {
  if (!providerNames.includes(provider)) throw new Error('Unknown experiment provider');
  const key = provider === 'musicae' ? env.RAPIDAPI_KEY : env.MUSIXMATCH_API_KEY;
  if ((provider === 'musicae' || provider.startsWith('musixmatch')) && !key) return skipped('missing_api_key');
  if (['musicae','musicbrainz','musixmatch-isrc'].includes(provider) && !track.isrc) return skipped('missing_verified_isrc');
  if (provider === 'musixmatch-apple' && !track.catalogID) return skipped('missing_catalog_id');
  if (budget.stopped) return skipped(budget.stopped);
  if (budget.remaining <= 0) return skipped('request_budget_exhausted');
  const start = now(), trace = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const transport = async (address, init = {}) => {
    if (budget.stopped || budget.remaining <= 0) throw Object.assign(new Error(), {code: 'request_budget_exhausted'});
    budget.remaining--;
    const url = new URL(address);
    const entry = {endpoint: url.origin + url.pathname};
    trace.push(entry);
    const r = await fetchFn(address, {...init, signal: controller.signal, redirect: 'error', size: 1024 * 1024});
    entry.status = r.status;
    if (r.status === 429) budget.stopped = 'provider_rate_limited';
    if ([401,403].includes(r.status)) budget.stopped = 'provider_access_denied';
    return r;
  };
  const json = async (address, headers = {}) => {
    const r = await transport(address, {headers: {'User-Agent':
      'LyraProviderExperiment/1.0 (https://github.com/hongkuntian/lyrics-to-pinyin-api)', ...headers}});
    if (!r.ok) throw Object.assign(new Error(), {status: r.status});
    return r.json();
  };
  try {
    let result;
    if (constructors[provider]) {
      const api = new constructors[provider]();
      const context = {...track, signal: controller.signal, fetchFn: transport};
      const song = await api.searchSong(track.artist, track.title, context);
      const lyrics = song ? await api.getLyrics(song.id, {...context, song}) : null;
      result = summarizeLyrics(lyrics, song, track);
    } else if (provider === 'lyrics-ovh') {
      const d = await json(`https://api.lyrics.ovh/v1/${encodeURIComponent(track.artist)}/${encodeURIComponent(track.title)}`);
      result = summarizeLyrics({source: provider, lines: parseLRC(d.lyrics || '')}, null, track);
    } else if (provider === 'musicbrainz') {
      const d = await json(`https://musicbrainz.org/ws/2/isrc/${encodeURIComponent(track.isrc)}?fmt=json&inc=artist-credits+releases`);
      result = {status: 'metadata_only', recordings: (d.recordings || []).map(r => ({
        id: r.id, title: r.title, duration: r.length == null ? null : r.length / 1000,
        artist: (r['artist-credit'] || []).map(a => a.name + (a.joinphrase || '')).join(''),
        albums: (r.releases || []).map(a => a.title),
      }))};
    } else if (provider === 'musicae') {
      const d = await json(`https://dj-track-audio-analysis-api.p.rapidapi.com/v2/tracks/${encodeURIComponent(track.isrc)}/lyrics`,
        {'X-RapidAPI-Key': key, 'X-RapidAPI-Host': 'dj-track-audio-analysis-api.p.rapidapi.com'});
      if (!d || typeof d !== 'object' || (!('synced_lyrics' in d) && !('plain_lyrics' in d))) {
        result = {status: 'unexpected_response_schema'};
      } else {
        result = summarizeLyrics({source: provider, lines: parseLRC(d.synced_lyrics || d.plain_lyrics || '')},
          {id: d.id, title: d.name, artist: d.artists?.join(' / '), isrc: d.isrc}, track);
        result.identityEvidence = 'ISRC supplied; endpoint does not establish how lyrics were matched internally';
      }
    } else {
      const identity = provider === 'musixmatch-apple' ? {track_itunes_id: track.catalogID} : {track_isrc: track.isrc};
      const params = new URLSearchParams({...identity, subtitle_format: 'lrc', apikey: key});
      const d = await json(`https://api.musixmatch.com/ws/1.1/track.subtitle.get?${params}`);
      const code = d.message?.header?.status_code;
      if (code !== 200) {
        if ([401,402,403,429].includes(code)) budget.stopped = 'provider_access_or_quota_denied';
        result = {status: 'provider_api_error', providerStatus: code ?? null};
      } else {
        const subtitle = d.message?.body?.subtitle;
        result = summarizeLyrics({source: provider, lines: parseLRC(subtitle?.subtitle_body || '')}, null, track);
        result.identityEvidence = 'Identifier-only request; lyric endpoint does not echo recording metadata';
      }
    }
    return {...result, requests: trace.length, elapsedMs: now() - start, trace};
  } catch (error) {
    // Error messages, URLs and response bodies can contain keys, cookies or lyrics.
    // Deliberately serialize a finite vocabulary instead of upstream exceptions.
    const reason = controller.signal.aborted ? 'timeout'
      : error.code === 'recording_mismatch' ? 'recording_mismatch'
      : error.code === 'request_budget_exhausted' ? 'request_budget_exhausted'
      : Number.isInteger(error.status) ? `http_${error.status}` : 'request_failed';
    return {status: 'error', reason, requests: trace.length, elapsedMs: now() - start, trace};
  } finally { clearTimeout(timer); }
}
