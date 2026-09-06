import test from "node:test";
import assert from "node:assert/strict";
import { createRomanizeHandler } from "../../api/romanize.js";
import { createMockReq, createMockRes } from "../helpers/mock-http.js";

test("returns 405 for non-POST requests", async () => {
  const handler = createRomanizeHandler({ logger: { error() {} } });
  const req = createMockReq({ method: "GET", body: {} });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: "Only POST allowed" });
});

test("returns 400 when text is missing", async () => {
  const handler = createRomanizeHandler({ logger: { error() {} } });
  const req = createMockReq({ body: {} });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "Missing 'text' parameter" });
});

test("returns 400 for unsupported scripts and exposes supported scripts", async () => {
  const handler = createRomanizeHandler({
    getProcessorFn: () => null,
    getSupportedScriptsFn: () => ["zh", "yue", "ja", "ko", "ru"],
    logger: { error() {} }
  });
  const req = createMockReq({ body: { text: "hello", language: "xx" } });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Script 'xx' is not supported");
  assert.deepEqual(res.body.supported_scripts, ["zh", "yue", "ja", "ko", "ru"]);
});

test("returns cached response on cache hit", async () => {
  let processorCalled = false;
  const cachedPayload = { original: "你好", romanized: "nǐ hǎo" };

  const handler = createRomanizeHandler({
    redis: {},
    getCachedFn: async () => cachedPayload,
    getProcessorFn: () => ({
      name: "ShouldNotRun",
      async romanize() {
        processorCalled = true;
        return { romanized: "x", system: "pinyin", confidence: 1 };
      }
    }),
    logger: { error() {} }
  });

  const req = createMockReq({ body: { text: "你好", language: "zh" } });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, cachedPayload);
  assert.equal(processorCalled, false);
});

test("computes and stores response on cache miss", async () => {
  let setCachedCalled = false;
  const handler = createRomanizeHandler({
    redis: {},
    getCachedFn: async () => null,
    setCachedFn: async () => {
      setCachedCalled = true;
    },
    getProcessorFn: () => ({
      name: "TestProcessor",
      async romanize(text) {
        return { romanized: `${text}-romanized`, system: "pinyin", confidence: 0.9 };
      }
    }),
    logger: { error() {} }
  });

  const req = createMockReq({ body: { text: "你好", language: "zh" } });
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.original, "你好");
  assert.equal(res.body.romanized, "你好-romanized");
  assert.equal(res.body.metadata.processor, "TestProcessor");
  assert.equal(setCachedCalled, true);
});

test('optional cache timeouts do not delay text romanization repeatedly or block writes', async () => {
  let reads = 0;
  const background = [];
  const redis = { get() { reads++; return new Promise(() => {}); } };
  const handler = createRomanizeHandler({
    redis, cacheTimeoutMs: 5, waitUntilFn: p => background.push(p),
    getProcessorFn: () => ({name: 'Fixture', romanize: async text => ({romanized: text,system:'pinyin'})}),
    logger: {error(){},info(){}}
  });
  for (let i=0;i<2;i++) {
    const res=createMockRes();
    await handler(createMockReq({body:{text:'你好',language:'zh'}}),res);
    assert.equal(res.statusCode,200);
  }
  assert.equal(reads,1);
  assert.equal(background.length,0);
});
