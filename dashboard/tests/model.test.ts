import test from "node:test";
import assert from "node:assert/strict";
import {
  money,
  remaining,
  pageNumber,
  searchText,
  percent,
} from "../src/lib/model";
import { dataMode } from "../src/lib/config";
test("money remains exact beyond JavaScript safe integer range", () => {
  assert.equal(money("9007199254740993", 6), "$9007199254.740993");
  assert.equal(money("2659", 6), "$0.002659");
  assert.equal(remaining("1000000", "2659"), "997341");
  assert.equal(remaining("100", "101"), "0");
  assert.equal(percent("50", "100"), 50);
});
test("bounded search and pagination reject malformed input", () => {
  for (const value of ["bad", "-1", "0", "1.5", "Infinity"])
    assert.equal(pageNumber(value), 1);
  assert.equal(pageNumber("999999"), 10000);
  assert.equal(searchText("x".repeat(500)).length, 120);
});
test("production cannot fall back to sample data or use an unacknowledged configuration", () => {
  assert.equal(dataMode({}), "fixtures");
  assert.equal(dataMode({ VERCEL_ENV: "preview" }), "fixtures");
  assert.throws(() => dataMode({ VERCEL_ENV: "production" }));
  assert.throws(() =>
    dataMode({
      LYRA_DASHBOARD_MODE: "production",
      LYRA_DASHBOARD_DATABASE_URL: "test",
    }),
  );
  assert.throws(() =>
    dataMode({
      VERCEL_ENV: "preview",
      LYRA_DASHBOARD_MODE: "production",
      LYRA_DASHBOARD_DATABASE_URL: "test",
      LYRA_DASHBOARD_PROTECTION: "vercel-all",
    }),
  );
  assert.equal(
    dataMode({
      VERCEL_ENV: "production",
      LYRA_DASHBOARD_MODE: "production",
      LYRA_DASHBOARD_DATABASE_URL: "test",
      LYRA_DASHBOARD_PROTECTION: "vercel-all",
    }),
    "production",
  );
});
