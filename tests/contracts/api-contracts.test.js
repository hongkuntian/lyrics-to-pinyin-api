import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRomanizeHandler } from "../../api/romanize.js";
import { createMusicRomanizeHandler } from "../../api/music-romanize.js";
import { createMockReq, createMockRes } from "../helpers/mock-http.js";
import { validateSchema } from "./schema-validator.js";

const contractsDir = join(process.cwd(), "contracts");

function loadSchema(fileName) {
  return JSON.parse(readFileSync(join(contractsDir, fileName), "utf8"));
}

const romanizeSuccessSchema = loadSchema("romanize-success.schema.json");
const musicSuccessSchema = loadSchema("music-romanize-success.schema.json");
const errorSchema = loadSchema("error.schema.json");

function assertSchemaMatch(schema, payload) {
  const errors = validateSchema(schema, payload);
  assert.deepEqual(errors, [], `Schema validation failed:\n${errors.join("\n")}`);
}

test("romanize success response matches contract schema", async () => {
  const handler = createRomanizeHandler({
    getProcessorFn: () => ({
      name: "ContractProcessor",
      async romanize(text) {
        return { romanized: `${text}-r`, system: "pinyin", confidence: 0.91 };
      }
    }),
    logger: { error() {} }
  });

  const req = createMockReq({ body: { text: "你好", language: "zh" } });
  const res = createMockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assertSchemaMatch(romanizeSuccessSchema, res.body);
});

test("romanize error response matches contract schema", async () => {
  const handler = createRomanizeHandler({ logger: { error() {} } });
  const req = createMockReq({ body: {} });
  const res = createMockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assertSchemaMatch(errorSchema, res.body);
});

test("music success response matches contract schema", async () => {
  const api = {
    name: "ContractMusicAPI",
    async searchSong() {
      return { id: 123, title: "稻香", artist: "周杰伦" };
    },
    async getLyrics() {
      return { lines: [{ text: "你好", timestamp: 1.23 }] };
    }
  };
  const processor = {
    name: "ContractProcessor",
    async romanize(text) {
      return { romanized: `${text}-r`, system: "pinyin", confidence: 0.91 };
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
  assertSchemaMatch(musicSuccessSchema, res.body);
});

test("music error response matches contract schema", async () => {
  const handler = createMusicRomanizeHandler({ logger: { error() {}, log() {} } });
  const req = createMockReq({ body: { artist: "周杰伦" } });
  const res = createMockRes();
  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assertSchemaMatch(errorSchema, res.body);
});

test("catalog alias identity is an additive typed response contract", async () => {
  const original={artist:'Eric Chou',title:'Unbreakable Love',duration:258.264,catalog_id:'1321295664'};
  const localized={artist:'周興哲',title:'永不失聯的愛',duration:258.264};
  const api={name:'Fixture',searchSong:async artist=>artist===localized.artist ? {...localized,id:1}:null,getLyrics:async()=>({lines:[{text:'一起唱',timestamp:0}]})};
  const handler=createMusicRomanizeHandler({redis:null,getAvailableAPIsFn:()=>[api],resolveCatalogAliasesFn:async()=>[localized],logger:{error(){}}});
  const res=createMockRes();
  await handler(createMockReq({body:original}),res);
  assert.equal(res.statusCode,200);
  assertSchemaMatch(musicSuccessSchema,res.body);
  assert.deepEqual(res.body.metadata.recording_match,{method:'catalog_alias',...original});
});
