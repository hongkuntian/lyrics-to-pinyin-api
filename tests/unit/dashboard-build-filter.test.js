import test from "node:test";
import assert from "node:assert/strict";
import { shouldSkip } from "../../scripts/ignore-vercel-build.mjs";
test("dashboard-only updates skip backend deploys and mixed updates still build", () => {
  assert.equal(
    shouldSkip("backend", ["dashboard/src/app/page.tsx", "docs/DASHBOARD.md"]),
    true,
  );
  for (const path of [
    "api/song-library.js",
    "db/002-dashboard-views.sql",
    "scripts/ignore-vercel-build.mjs",
    "unexpected.file",
  ])
    assert.equal(
      shouldSkip("backend", ["dashboard/src/app/page.tsx", path]),
      false,
    );
  assert.equal(
    shouldSkip("unrecognized", ["dashboard/src/app/page.tsx"]),
    false,
  );
});
