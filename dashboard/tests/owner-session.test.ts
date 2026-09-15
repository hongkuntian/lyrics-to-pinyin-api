import test from "node:test";
import assert from "node:assert/strict";
import {
  ownerConfig,
  signOwnerToken,
  verifyOwnerToken,
  requireOrigin,
  cookieOptions,
} from "../src/lib/owner-session";
const env = {
  VERCEL_ENV: "production",
  LYRA_DASHBOARD_MODE: "production",
  LYRA_DASHBOARD_PROTECTION: "vercel-all",
  LYRA_DASHBOARD_DATABASE_URL: "reader",
  LYRA_DASHBOARD_ORIGIN: "https://dashboard.example",
  LYRA_DASHBOARD_SESSION_SECRET: "a".repeat(48),
  LYRA_DASHBOARD_OWNER_SUBJECT: "owner",
  LYRA_DASHBOARD_OAUTH_CLIENT_ID: "client",
  LYRA_DASHBOARD_OAUTH_CLIENT_SECRET: "secret",
  LYRA_DASHBOARD_OPERATOR_DATABASE_URL: "operator",
};
test("owner sessions reject forgery, expired tokens, other accounts and OAuth flow tokens", async () => {
  const config = ownerConfig(env)!;
  const time = 1800000000,
    now = new Date(time * 1000);
  const token = await signOwnerToken(
    config,
    "session",
    { sub: "owner", sid: "session" },
    time,
  );
  assert.equal(
    (await verifyOwnerToken(config, "session", token, now))?.sub,
    "owner",
  );
  assert.equal(
    await verifyOwnerToken(config, "session", token + "x", now),
    null,
  );
  assert.equal(
    await verifyOwnerToken(
      config,
      "session",
      token,
      new Date((time + 3601) * 1000),
    ),
    null,
  );
  assert.equal(
    await verifyOwnerToken(
      { ...config, subject: "revoked" },
      "session",
      token,
      now,
    ),
    null,
  );
  assert.equal(
    await verifyOwnerToken(
      config,
      "session",
      await signOwnerToken(
        config,
        "session",
        { sub: "viewer", sid: "s" },
        time,
      ),
      now,
    ),
    null,
  );
  assert.equal(
    await verifyOwnerToken(
      config,
      "session",
      await signOwnerToken(config, "flow", { sub: "owner", sid: "s" }, time),
      now,
    ),
    null,
  );
  assert.equal(await verifyOwnerToken(config, "session", undefined, now), null);
  assert.throws(() => requireOrigin(config, "https://attacker.example"));
  assert.throws(() => requireOrigin(config, null));
  assert.doesNotThrow(() => requireOrigin(config, config.origin));
  assert.deepEqual(cookieOptions(config), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 3600,
  });
});
test("production and previews never accept fixture identity or incomplete controls configuration", () => {
  assert.equal(
    ownerConfig({ ...env, LYRA_DASHBOARD_SESSION_SECRET: undefined }),
    null,
  );
  assert.equal(
    ownerConfig({
      VERCEL_ENV: "preview",
      LYRA_DASHBOARD_FIXTURE_CONTROLS: "1",
    }),
    null,
  );
  assert.throws(() =>
    ownerConfig({
      VERCEL_ENV: "production",
      LYRA_DASHBOARD_FIXTURE_CONTROLS: "1",
    }),
  );
  assert.throws(() =>
    ownerConfig({ ...env, LYRA_DASHBOARD_ORIGIN: "http://dashboard.example" }),
  );
  assert.equal(
    ownerConfig({ LYRA_DASHBOARD_FIXTURE_CONTROLS: "1" })?.fixture,
    true,
  );
});
