import test from 'node:test';
import assert from 'node:assert/strict';
import {probe, summarizeLyrics} from './compare.mjs';
import {lyricsFingerprint} from '../../api/utils/rejected-lyrics.js';

const track = {artist: 'Test Artist', title: 'Test Song', duration: 180,
  isrc: 'GBXXX2600001', catalogID: '123456789'};
const response = (data, status = 200) => ({status, ok: status < 400, json: async () => data});
const lines = [{text: 'Invented test words', timestamp: 1}, {text: 'Second test line', timestamp: 15}];

test('reference equality does not claim timestamp accuracy or include lyrics', () => {
  const result = summarizeLyrics({lines}, {duration: 179.8},
    {...track, referenceHash: lyricsFingerprint(lines)});
  assert.equal(result.verdict, 'reference_text_match');
  assert.equal(result.durationDelta, -0.2);
  assert.equal(result.timedLines, 2);
  assert.ok(!JSON.stringify(result).includes('Invented'));
  const differentTiming = summarizeLyrics({lines: lines.map(l => ({...l, timestamp: l.timestamp + 5}))}, null,
    {...track, referenceHash: lyricsFingerprint(lines)});
  assert.equal(result.textSha256, differentTiming.textSha256);
  assert.notEqual(result.timelineSha256, differentTiming.timelineSha256);
});

test('reject reference wins and unreviewed lyrics are not counted as correct', () => {
  assert.equal(summarizeLyrics({lines}, null, {...track,
    rejectedHashes: [lyricsFingerprint(lines)]}).verdict, 'known_wrong_version');
  assert.equal(summarizeLyrics({lines}, null, track).verdict, 'unreviewed_text');
  assert.equal(summarizeLyrics({lines}, null, {...track, referenceHash: 'different'}).verdict,
    'different_text_needs_review');
});

test('out-of-range timestamps remain visible in evaluation', () => {
  const result = summarizeLyrics({lines: [{text: 'test', timestamp: 200}]}, null, track);
  assert.equal(result.outOfRangeTimestamps, 1);
  assert.equal(result.timedLines, 0);
});

test('unconfigured providers make no requests', async () => {
  const fetchFn = () => { throw new Error('must not request'); };
  assert.equal((await probe('musicae', track, {fetchFn})).reason, 'missing_api_key');
  assert.equal((await probe('musicae', {...track, isrc: undefined},
    {env: {RAPIDAPI_KEY: 'private'}, fetchFn})).reason, 'missing_verified_isrc');
});

test('Musixmatch Apple request uses only the identifier and never logs the API key', async () => {
  let requested;
  const result = await probe('musixmatch-apple', track, {
    env: {MUSIXMATCH_API_KEY: 'private-test-key'},
    fetchFn: async (url, init) => {
      requested = new URL(url);
      assert.equal(init.redirect, 'error');
      return response({message: {header: {status_code: 200}, body: {
        subtitle: {subtitle_body: '[00:01.00]Invented test words'},
      }}});
    },
  });
  assert.equal(requested.searchParams.get('track_itunes_id'), track.catalogID);
  assert.equal(requested.searchParams.get('q_track'), null);
  assert.equal(result.status, 'lyrics_returned');
  assert.equal(result.recording, null);
  assert.ok(!JSON.stringify(result).includes('private-test-key'));
});

test('upstream error text cannot leak keys or lyric bodies', async () => {
  const result = await probe('musixmatch-isrc', track, {
    env: {MUSIXMATCH_API_KEY: 'private-test-key'},
    fetchFn: async () => { throw new Error('URL?apikey=private-test-key full lyric text'); },
  });
  assert.equal(result.reason, 'request_failed');
  assert.ok(!JSON.stringify(result).includes('private-test-key'));
});

test('quota or plan denial stops subsequent probes without retries', async () => {
  const budget = {remaining: 5};
  let calls = 0;
  const options = {budget, env: {MUSIXMATCH_API_KEY: 'private'}, fetchFn: async () => {
    calls++; return response({message: {header: {status_code: 402}}});
  }};
  assert.equal((await probe('musixmatch-apple', track, options)).providerStatus, 402);
  assert.equal((await probe('musixmatch-apple', track, options)).status, 'skipped');
  assert.equal(calls, 1);
});

test('Musicae request budget and schema validation prevent false success', async () => {
  const budget = {remaining: 1};
  const options = {budget, env: {RAPIDAPI_KEY: 'private'}, fetchFn: async () => response({message: 'Not subscribed'})};
  assert.equal((await probe('musicae', track, options)).status, 'unexpected_response_schema');
  assert.equal((await probe('musicae', track, options)).reason, 'request_budget_exhausted');
});
