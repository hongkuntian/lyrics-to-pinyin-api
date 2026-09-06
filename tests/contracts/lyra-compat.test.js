import test from "node:test";
import assert from "node:assert/strict";
import { createMusicRomanizeHandler } from "../../api/music-romanize.js";
import { createMockReq, createMockRes } from "../helpers/mock-http.js";

function assertLyraCompatibility(payload) {
  // Mirrors decode-critical fields in Lyra/Lyra/LyricsResponse.swift.
  assert.equal(typeof payload.song.title.original, "string");
  assert.equal(typeof payload.song.title.romanized, "string");
  assert.equal(typeof payload.song.artist.original, "string");
  assert.equal(typeof payload.song.artist.romanized, "string");
  assert.equal(Number.isInteger(payload.song.id), true);
  assert.equal(typeof payload.song.language, "string");
  assert.equal(typeof payload.song.romanization_system, "string");
  assert.equal(Array.isArray(payload.lines), true);
  assert.equal(typeof payload.quality.synced, "boolean");
  assert.equal(typeof payload.metadata.timestamp, "string");
  assert.equal(typeof payload.metadata.version, "string");
  assert.equal(payload.metadata.version, "2.2.0");
  assert.ok(payload.song.album === null || typeof payload.song.album === "string");
  assert.ok(payload.song.duration === null || typeof payload.song.duration === "number");
}

test("music endpoint response stays compatible with Lyra decode model", async () => {
  const api = {
    name: "LyraCompatAPI",
    async searchSong() {
      return { id: 12345, title: "稻香", artist: "周杰伦" };
    },
    async getLyrics() {
      return {
        lines: [
          { text: "你好", timestamp: 0.5 },
          { text: "世界", timestamp: null }
        ]
      };
    }
  };

  const processor = {
    name: "CompatProcessor",
    async romanize(text) {
      return { romanized: `${text}-r`, system: "pinyin", confidence: 0.95 };
    }
  };

  const handler = createMusicRomanizeHandler({
    getAvailableAPIsFn: () => [api],
    getProcessorFn: () => processor,
    logger: { error() {}, log() {} }
  });

  const req = createMockReq({ body: { artist: "周杰伦", title: "稻香", language: "zh" } });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assertLyraCompatibility(res.body);
});
