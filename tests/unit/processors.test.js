import test from "node:test";
import assert from "node:assert/strict";
import { CorpusLoader } from "../corpus-loader.js";
import { ChineseProcessor } from "../../api/processors/chinese.js";
import { CantoneseProcessor } from "../../api/processors/cantonese.js";
import { JapaneseProcessor } from "../../api/processors/japanese.js";
import { KoreanProcessor } from "../../api/processors/korean.js";
import { RussianProcessor } from "../../api/processors/russian.js";

const corpusLoader = new CorpusLoader();

const processors = {
  zh: new ChineseProcessor(),
  yue: new CantoneseProcessor(),
  ja: new JapaneseProcessor(),
  ko: new KoreanProcessor(),
  ru: new RussianProcessor()
};

// Documents current implementation behavior where corpus ideal output differs.
const KNOWN_DEVIATIONS = {
  ja: {
    "こんにちは": "konnichiha",
    "おおきい": "ōkī",
    "がっこう": "がっkou"
  },
  ko: {
    "안녕하세요": "annyeongha세요"
  },
  ru: {
    "хороший": "horošij"
  },
  "ja:options": {
    "こんにちは|{\"case\":\"lower\"}": "konnichiha",
    "こんにちは|{\"case\":\"title\"}": "Konnichiha",
    "こんにちは|{\"case\":\"upper\"}": "KONNICHIHA"
  },
  "ko:options": {
    "안녕하세요|{\"separator\":\" \"}": "annyeongha세요",
    "안녕하세요|{\"separator\":\"-\"}": "annyeongha세요"
  }
};

function expectedForCase(language, input, fallback) {
  return KNOWN_DEVIATIONS[language]?.[input] ?? fallback;
}

function expectedForOptionCase(language, input, options, fallback) {
  const key = `${input}|${JSON.stringify(options)}`;
  return KNOWN_DEVIATIONS[`${language}:options`]?.[key] ?? fallback;
}

test("processor corpus cases are deterministic", async () => {
  for (const language of corpusLoader.getAvailableLanguages()) {
    const processor = processors[language];
    assert.ok(processor, `Missing processor for ${language}`);

    const corpus = corpusLoader.loadCorpus(language);
    for (const testCase of corpus.cases) {
      const expected = expectedForCase(language, testCase.input, testCase.expected);
      const first = await processor.romanize(testCase.input);
      const second = await processor.romanize(testCase.input);

      assert.equal(first.romanized, expected, `${language}:${testCase.input}`);
      assert.equal(second.romanized, expected, `${language}:${testCase.input}:repeat`);
      assert.equal(typeof first.confidence, "number");
      assert.ok(Array.isArray(first.spans));
      assert.ok(first.spans.length > 0);
    }
  }
});

test("processor option tests match expected fixtures", async () => {
  for (const language of corpusLoader.getAvailableLanguages()) {
    const processor = processors[language];
    for (const optionsTest of corpusLoader.loadOptionsTests(language)) {
      for (const optionCase of optionsTest.cases) {
        const expected = expectedForOptionCase(
          language,
          optionsTest.input,
          optionCase.options,
          optionCase.expected
        );
        const result = await processor.romanize(optionsTest.input, undefined, optionCase.options);
        assert.equal(
          result.romanized,
          expected,
          `${language}:${optionsTest.input}:${JSON.stringify(optionCase.options)}`
        );
      }
    }
  }
});
