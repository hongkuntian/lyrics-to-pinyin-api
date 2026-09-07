import test from "node:test";
import assert from "node:assert/strict";
import { createMusicRomanizeHandler } from "../../api/music-romanize.js";
import { createMockReq, createMockRes } from "../helpers/mock-http.js";

function createProcessor() {
  return {
    name: "MusicTestProcessor",
    async romanize(text) {
      return { romanized: `${text}-r`, system: "pinyin", confidence: 0.9 };
    }
  };
}

test("returns 405 for non-POST requests", async () => {
  const handler = createMusicRomanizeHandler({resolveCatalogAliasesFn:async()=>[], logger: { error() {}, log() {} } });
  const req = createMockReq({ method: "GET", body: {} });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: "Only POST allowed" });
});

test("returns 400 when artist or title is missing", async () => {
  const handler = createMusicRomanizeHandler({resolveCatalogAliasesFn:async()=>[], logger: { error() {}, log() {} } });
  const req = createMockReq({ body: { artist: "Jay Chou" } });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Missing 'artist' or 'title' parameter" });
});

test("returns 400 when no API is available for script", async () => {
  const handler = createMusicRomanizeHandler({resolveCatalogAliasesFn:async()=>[],
    getAvailableAPIsFn: () => [],
    getSupportedMusicAPIsFn: () => [{ script: "zh", platforms: ["netease"] }],
    logger: { error() {}, log() {} }
  });
  const req = createMockReq({ body: { artist: "X", title: "Y", language: "ru" } });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "No music API available for script 'ru' and platform 'undefined'");
  assert.deepEqual(res.body.supported_combinations, [{ script: "zh", platforms: ["netease"] }]);
});

test("returns 404 when song is not found across fallbacks", async () => {
  const apiA = { name: "API-A", async searchSong() { return null; } };
  const apiB = { name: "API-B", async searchSong() { return null; } };
  const handler = createMusicRomanizeHandler({resolveCatalogAliasesFn:async()=>[],
    getAvailableAPIsFn: () => [apiA, apiB],
    logger: { error() {}, log() {} }
  });
  const req = createMockReq({ body: { artist: "X", title: "Y", language: "zh" } });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "Song not found");
  assert.equal(res.body.details, "Tried API-A, API-B");
});

test("returns 404 when lyrics are missing for found song", async () => {
  const api = {
    name: "API-A",
    async searchSong() {
      return { id: "1", title: "Song", artist: "Artist" };
    },
    async getLyrics() {
      return null;
    }
  };
  const handler = createMusicRomanizeHandler({resolveCatalogAliasesFn:async()=>[],
    getAvailableAPIsFn: () => [api],
    getProcessorFn: () => createProcessor(),
    logger: { error() {}, log() {} }
  });
  const req = createMockReq({ body: { artist: "Artist", title: "Song", language: "zh" } });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Lyrics not found" });
});

test("returns cached payload on cache hit", async () => {
  const cached = { song: { id: "cached" }, lines: [], metadata: { version: "2.3.0" } };
  const handler = createMusicRomanizeHandler({resolveCatalogAliasesFn:async()=>[],
    redis: {},
    getCachedFn: async () => cached,
    logger: { error() {}, log() {} }
  });
  const req = createMockReq({ body: { artist: "X", title: "Y", language: "zh" } });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, cached);
});

test("uses fallback APIs and returns formatted response", async () => {
  const primaryAPI = { name: "PrimaryAPI", async searchSong() { return null; } };
  const backupAPI = {
    name: "BackupAPI",
    async searchSong() {
      return { id: 1, title: "稻香", artist: "周杰伦" };
    },
    async getLyrics() {
      return { lines: [{ text: "你好", timestamp: 1.2 }, { text: "世界", timestamp: null }] };
    }
  };

  const handler = createMusicRomanizeHandler({resolveCatalogAliasesFn:async()=>[],
    getAvailableAPIsFn: () => [primaryAPI, backupAPI],
    getProcessorFn: () => createProcessor(),
    logger: { error() {}, log() {} }
  });
  const req = createMockReq({
    body: { artist: "周杰伦", title: "稻香", language: "zh", options: { case: "lower" } }
  });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.song.title.romanized, "稻香-r");
  assert.equal(res.body.song.artist.romanized, "周杰伦-r");
  assert.equal(res.body.song.language, "zh");
  assert.equal(res.body.lines.length, 2);
  assert.equal(res.body.lines[0].romanized, "你好-r");
});


test("accepts complete ensemble credits while retaining a bounded artist field", async () => {
  const artist = Array.from({length: 60}, (_, i) => `Performer ${i}`).join(', ');
  let received;
  const api = { name: 'Fixture', async searchSong(value) { received = value; return null; } };
  const handler = createMusicRomanizeHandler({redis: null, resolveCatalogAliasesFn: async () => [], getAvailableAPIsFn: () => [api], logger: {error() {}}});
  const result = createMockRes();
  await handler(createMockReq({body: {artist, title: 'Ensemble song', language: 'en'}}), result);
  assert.equal(result.statusCode, 404);
  assert.equal(received, artist);
  const oversized = createMockRes();
  await handler(createMockReq({body: {artist: 'x'.repeat(1025), title: 'Song'}}), oversized);
  assert.equal(oversized.statusCode, 400);
});
