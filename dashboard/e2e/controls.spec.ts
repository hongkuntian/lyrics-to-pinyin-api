import { test, expect } from "@playwright/test";
const song = "1".padStart(64, "0"),
  original = "20000000-0000-4000-8000-000000000001";
test("owner controls preserve budgets, reject stale pages, and lock after sign-out", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/automation");
  await expect(
    page.getByRole("button", { name: "Pause report review" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Unlock sample controls" }).click();
  await expect(
    page.getByText("Owner controls unlocked", { exact: true }),
  ).toBeVisible();
  const stale = await context.newPage();
  await stale.goto("/automation");
  await page.getByRole("button", { name: "Pause report review" }).click();
  await expect(
    page.getByRole("button", { name: "Resume report review" }),
  ).toBeEnabled();
  await expect(
    page.getByText("Report review paused", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("$1.00/day · $5.00/month", { exact: true }),
  ).toBeVisible();
  await stale
    .getByRole("button", { name: "Pause correction publication" })
    .click();
  await expect(
    stale.getByRole("alert").filter({ hasText: "changed since you opened" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resume report review" }).click();
  await expect(
    page.getByRole("button", { name: "Pause report review" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Lock controls" }).click();
  await expect(
    page.getByRole("button", { name: "Pause report review" }),
  ).toBeDisabled();
  await stale.getByRole("button", { name: "Pause paid work" }).click();
  await expect(
    stale.getByRole("alert").filter({ hasText: "Sign in as the owner" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await stale.close();
});
test("saved version comparison restores exactly once and preserves the previous versions", async ({
  page,
}) => {
  await page.goto(`/songs/${song}/revisions/${original}`);
  await expect(
    page.getByRole("button", { name: "Restore this version" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Unlock sample controls" }).click();
  await page.goto(`/songs/${song}/revisions/${original}`);
  await expect(
    page.getByText("Put a faint light in my pocket.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Reason for restoring" })
    .fill(
      "Prefer the previous wording. <script>window.rollbackInjected=true</script>",
    );
  await page.getByRole("button", { name: "Restore this version" }).click();
  await expect(
    page.getByText("This wording already matches the current translation.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Song & history" }).click();
  await expect(page.locator("#L0001 .lyric-translation")).toHaveText(
    "Put a faint light in my pocket.",
  );
  await expect(
    page.getByRole("link", { name: "Version 3 · Restored" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Version 2 · Correction" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Version 1 · Original translation" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, "rollbackInjected")),
  ).toBeUndefined();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.goto("/automation");
  await expect(
    page.getByText("Restored translation as version 3", { exact: true }),
  ).toHaveCount(1);
});
test("owner sign-in rejects cross-origin posts and unknown callbacks", async ({
  request,
}) => {
  expect(
    (
      await request.post("/auth/login", {
        headers: { origin: "https://attacker.example" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (await request.get("/auth/callback?code=fake&state=fake")).status(),
  ).toBe(403);
});
