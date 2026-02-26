import test from "node:test";
import assert from "node:assert/strict";
import {
  detectLanguage,
  getSupportedLanguages,
  isLanguageSupported,
  getRomanizationSystems,
  getDefaultRomanizationSystem
} from "../../api/utils/language-detection.js";

test("detectLanguage identifies representative script samples", async () => {
  const cases = [
    ["你好世界", "zh"],
    ["嘅咗咁", "yue"],
    ["こんにちは", "ja"],
    ["안녕하세요", "ko"],
    ["привет", "ru"],
    ["hello world", "en"]
  ];

  for (const [input, expected] of cases) {
    const detected = await detectLanguage(input);
    assert.equal(detected, expected, `Input ${input} should detect as ${expected}`);
  }
});

test("detectLanguage defaults to english for non-script characters", async () => {
  const detected = await detectLanguage("12345 !!!");
  assert.equal(detected, "en");
});

test("detectLanguage rejects invalid input", async () => {
  await assert.rejects(() => detectLanguage(""), /Invalid text input/);
  await assert.rejects(() => detectLanguage(null), /Invalid text input/);
});

test("language helper functions remain consistent", () => {
  const supported = getSupportedLanguages();
  assert.deepEqual(supported.sort(), ["en", "ja", "ko", "ru", "yue", "zh"]);
  assert.equal(isLanguageSupported("zh"), true);
  assert.equal(isLanguageSupported("xx"), false);
  assert.deepEqual(getRomanizationSystems("ru"), ["iso-9", "bgn-pcgn"]);
  assert.equal(getDefaultRomanizationSystem("ko"), "revised");
  assert.equal(getDefaultRomanizationSystem("unknown"), "none");
});
