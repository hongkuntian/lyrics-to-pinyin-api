import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4331", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: [
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 4331",
      url: "http://127.0.0.1:4331",
      env: {LYRA_DASHBOARD_FIXTURE_CONTROLS:"1"},
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 4333",
      url: "http://127.0.0.1:4333",
      env: { LYRA_DASHBOARD_MODE: "empty" },
    },
    {
      command: "npm run start -- --hostname 127.0.0.1 --port 4334",
      url: "http://127.0.0.1:4334/icon.svg",
      env: { LYRA_DASHBOARD_MODE: "error" },
      ignoreHTTPSErrors: true,
    },
  ],
});
