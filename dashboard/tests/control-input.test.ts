import test from "node:test";
import assert from "node:assert/strict";
import { parseOwnerInput } from "../src/lib/control-input";
const requestID = "10000000-0000-4000-8000-000000000001";
function form(values: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}
test("control forms cannot set budgets or supply operator identity and preserve bigint versions", () => {
  const values = {
    kind: "control",
    requestID,
    version: "9007199254740993",
    control: "reviews",
    enabled: "true",
  };
  assert.deepEqual(
    parseOwnerInput(
      form({ ...values, actor: "attacker", daily_micros: "999999" }),
    ),
    { ...values, enabled: true },
  );
  for (const input of [
    { ...values, control: "daily_micros" },
    { ...values, enabled: "yes" },
    { ...values, version: "9223372036854775808" },
    { ...values, version: "1.2" },
  ])
    assert.throws(() => parseOwnerInput(form(input)));
  const duplicate = form(values);
  duplicate.append("enabled", "false");
  assert.throws(() => parseOwnerInput(duplicate));
});
test("rollback binds source, document, expected head and saved revision, with a bounded reason", () => {
  const values = {
    kind: "rollback",
    requestID,
    document: "a".repeat(64),
    source: "b".repeat(64),
    expected: requestID,
    restore: requestID,
    reason: " A reason ",
  };
  assert.equal(parseOwnerInput(form(values)).kind, "rollback");
  for (const patch of [
    { source: "bad" },
    { document: "bad" },
    { expected: "bad" },
    { restore: "bad" },
    { reason: " " },
    { reason: "x".repeat(2001) },
  ])
    assert.throws(() => parseOwnerInput(form({ ...values, ...patch })));
});
