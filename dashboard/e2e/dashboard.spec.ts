import { test, expect } from "@playwright/test";
test("budget overview, filtered songs, pagination and repeated lyric occurrences", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".budget-value")).toContainText([
    "$0.0996",
    "$0.0996",
  ]);
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link", { name: "Songs", exact: true })
    .click();
  await page.getByRole("link", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page
    .getByRole("textbox", { name: "Search songs or artists" })
    .fill("夜航");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .getByRole("link", { name: "夜航练习 Lyra test ensemble", exact: true })
    .click();
  await expect(page.getByText("把微光装进口袋", { exact: true })).toHaveCount(
    2,
  );
  await expect(page.locator("#L0001 .lyric-translation")).toContainText(
    "Tuck a little light",
  );
  await expect(page.locator("#L0003")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("unknown jobs and report context render without executing report text", async ({
  page,
}) => {
  await page.goto("/jobs?state=unknown");
  await expect(
    page.getByText("provider_unavailable", { exact: true }),
  ).toBeVisible();
  await page.goto("/reports");
  await expect(page.getByText("Automatic review", {exact:true})).toBeVisible();
  await expect(page.getByText("Scheduled daily · Luna only", {exact:true})).toBeVisible();
  await page.getByRole("link", { name: /Fixture report/ }).click();
  await expect(page.locator(".lyric-focus")).toHaveAttribute("id", "L0003");
  await expect(
    page.getByText(/<script>window.injected=true<\/script>/),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, "injected")),
  ).toBeUndefined();
  await expect(page.getByText("Luna assessment", {exact:true})).toBeVisible();
  await expect(page.getByText("Recommendation: correct", {exact:true})).toBeVisible();
  await expect(page.getByText(/<script>window.modelInjected=true<\/script>/)).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "modelInjected"))).toBeUndefined();
  await expect(page.getByText("Published correction", {exact:true})).toBeVisible();
  await expect(page.getByText("Fresh comparison: correction preferred", {exact:true})).toBeVisible();
  await expect(page.getByText("Before: Put the brilliant sun in my pocket.", {exact:true})).toBeVisible();
  await expect(page.getByText("After: Tuck a little light into my pocket.", {exact:true})).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "comparisonInjected"))).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("link", { name: "Open full song" }).click();
  await expect(page).toHaveURL(/#L0003$/);
});
test("empty searches and missing records are useful states", async ({
  page,
}) => {
  await page.goto("/songs?q=no-such-song");
  await expect(
    page.getByRole("heading", { name: "No songs found" }),
  ).toBeVisible();
  await page.goto("/songs/" + "e".repeat(64));
  await expect(
    page.getByRole("heading", { name: "Record not found" }),
  ).toBeVisible();
});

test("empty and unavailable data states keep the workspace usable", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4333/");
  await expect(
    page.getByRole("heading", { name: "No translation requests yet" }),
  ).toBeVisible();
  await page.goto("http://127.0.0.1:4334/");
  await expect(
    page.getByRole("heading", { name: "Records are temporarily unavailable" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});
