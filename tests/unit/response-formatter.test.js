import test from "node:test";
import assert from "node:assert/strict";
import {
  formatResponse,
  formatErrorResponse,
  formatMusicResponse,
  validateRomanizationRequest
} from "../../api/utils/response-formatter.js";

test("formatResponse returns expected envelope", () => {
  const result = formatResponse({
    original: "你好",
    romanized: "nǐ hǎo",
    language: "zh",
    romanization_system: "pinyin",
    confidence: 0.95,
    metadata: { processor: "ChineseProcessor" }
  });

  assert.equal(result.original, "你好");
  assert.equal(result.romanized, "nǐ hǎo");
  assert.equal(result.language, "zh");
  assert.equal(result.romanization_system, "pinyin");
  assert.equal(result.confidence, 0.95);
  assert.equal(result.metadata.version, "2.0.0");
  assert.equal(result.metadata.processor, "ChineseProcessor");
  assert.ok(Number.isFinite(Date.parse(result.metadata.timestamp)));
});

test("formatErrorResponse wraps error metadata", () => {
  const result = formatErrorResponse(new Error("Boom"), 503);
  assert.equal(result.error.message, "Boom");
  assert.equal(result.error.code, 503);
  assert.equal(result.error.version, "2.0.0");
  assert.ok(Number.isFinite(Date.parse(result.error.timestamp)));
});

test("formatMusicResponse returns song/lines/quality shape", () => {
  const result = formatMusicResponse(
    { title: "稻香", artist: "周杰伦", id: 1, source: "NeteaseAPI" },
    {
      title: "dào xiāng",
      artist: "zhōu jié lún",
      language: "zh",
      system: "pinyin",
      lines: [{ original: "你好", romanized: "nǐ hǎo", timestamp: 1.23 }]
    }
  );

  assert.equal(result.song.title.romanized, "dào xiāng");
  assert.equal(result.song.artist.romanized, "zhōu jié lún");
  assert.equal(result.quality.synced, true);
  assert.equal(result.metadata.source, "NeteaseAPI");
  assert.ok(Number.isFinite(Date.parse(result.metadata.timestamp)));
});

test("validateRomanizationRequest catches invalid payloads", () => {
  const result = validateRomanizationRequest({
    language: "bad",
    romanization_system: "bad-system",
    options: { tone_style: "bad" }
  });

  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((msg) => msg.includes("Either 'text'")));
  assert.ok(result.errors.some((msg) => msg.includes("Invalid script code")));
  assert.ok(result.errors.some((msg) => msg.includes("Invalid romanization system")));
  assert.ok(result.errors.some((msg) => msg.includes("tone_style")));
});

test("numeric provider text IDs remain compatible without changing opaque identity", () => {
  for(const [input,expected] of [[1,1],["98440486",98440486],["0",0],["00123","00123"],["9007199254740993","9007199254740993"],["9ZJOV1WT-6A","9ZJOV1WT-6A"]]) {
    assert.equal(formatMusicResponse({id:input,title:"Fixture",artist:"Artist"},{title:"Fixture",artist:"Artist",lines:[]}).song.id,expected);
  }
});
