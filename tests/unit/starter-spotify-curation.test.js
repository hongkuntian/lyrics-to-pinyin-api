import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const readJSON = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const pool = readJSON('../../api/data/starter-songs.json').languages;
const { schemaVersion, entries } = readJSON('../../curation/starter-spotify/recordings.json');
const approved = Object.values(pool).flat();

test('the curation accounts for every approved starter once in pool order', () => {
  assert.equal(schemaVersion, 1);
  assert.deepEqual(entries.map(row => row.starterId), approved.map(song => song.id));
  for (const songs of Object.values(pool)) {
    assert.ok(entries.some(row => row.status === 'verified' && songs.some(song => song.id === row.starterId)));
  }
});

test('the source evidence names each distinct approved Apple catalog ID', () => {
  for (const [index, row] of entries.entries()) {
    const recordings = approved[index].recordings;
    assert.deepEqual(row.apple.map(a => a.id), [...new Set(recordings.map(recording => recording.catalog_id))]);
    for (const a of row.apple) {
      const recording = recordings.find(value => value.catalog_id === a.id && value.storefront === a.storefront);
      assert.ok(recording, row.starterId);
      assert.equal(a.durationMs, Math.round(recording.duration * 1000), row.starterId);
      assert.equal(a.url, `https://music.apple.com/${a.storefront}/album/_/${a.albumId}?i=${a.id}`);
      assert.match(a.albumId, /^\d+$/);
      for (const key of ['title', 'artist', 'release']) assert.ok(a[key]?.trim(), row.starterId);
      for (const n of [a.discNumber, a.trackNumber]) assert.ok(Number.isSafeInteger(n) && n > 0);
    }
  }
});

test('only confirmed counterparts occupy the Spotify match field', () => {
  const ids = new Set();
  for (const row of entries) {
    assert.ok(['verified', 'held'].includes(row.status), row.starterId);
    assert.match(row.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(row.review.trim(), row.starterId);
    assert.ok(row.version.trim(), row.starterId);
    const verified = row.status === 'verified';
    assert.equal(Object.hasOwn(row, 'spotify'), verified, row.starterId);
    assert.equal(Object.hasOwn(row, 'candidate'), !verified, row.starterId);
    const t = verified ? row.spotify : row.candidate;
    assert.match(t.id, /^[a-zA-Z0-9]{22}$/);
    assert.ok(!ids.has(t.id), t.id);
    ids.add(t.id);
    assert.equal(t.url, `https://open.spotify.com/track/${t.id}`);
    assert.match(t.releaseUrl, /^https:\/\/open\.spotify\.com\/album\/[a-zA-Z0-9]{22}$/);
    assert.ok(t.release.trim() && t.title.trim() && t.artists.length && t.artists.every(a => a.trim()));
    for (const n of [t.durationMs, t.trackNumber]) assert.ok(Number.isSafeInteger(n) && n > 0);
    assert.equal(t.marketCheck.country, 'CA');
    assert.ok(['listed', 'unconfirmed'].includes(t.marketCheck.pageListing));
    for (const url of row.additionalSources ?? []) assert.equal(new URL(url).protocol, 'https:');
    if (verified) {
      // These rows cite the same release slot and running time on both public pages.
      for (const a of row.apple) {
        assert.equal(t.trackNumber, a.trackNumber, row.starterId);
        assert.equal(Math.round(t.durationMs / 1000), Math.round(a.durationMs / 1000), row.starterId);
      }
    }
  }
});

test('both release observations can be retraced from the receipt', () => {
  for (const { apple: [a], status, starterId, releaseEvidence: e } of entries) {
    assert.equal(e.appleLookup,
      `https://itunes.apple.com/lookup?country=${a.storefront}&id=${a.albumId}&entity=song&limit=200`, starterId);
    for (const date of [e.appleDate, e.spotifyDate]) assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.appleCredit.trim() && e.spotifyCredits.length && e.spotifyCredits.every(c => c.trim()), starterId);
    for (const n of [e.appleTrackCount, e.spotifyTrackCount]) assert.ok(Number.isInteger(n) && n > 0);
    if (status === 'verified' && e.appleTrackCount > 1) assert.ok(e.adjacent, starterId);
    if (e.adjacent) {
      assert.ok(['before', 'after'].includes(e.adjacent.side));
      assert.ok(e.adjacent.appleTitle.trim() && e.adjacent.spotifyTitle.trim(), starterId);
      for (const ms of [e.adjacent.appleDurationMs, e.adjacent.spotifyDurationMs]) assert.ok(Number.isInteger(ms) && ms > 0);
    }
  }
});
