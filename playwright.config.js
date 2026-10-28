// playwright.config.js
//
// Points at BASE_URL (your deployed site, or a local static server) --
// see tests/README.md for how to set it and for the one thing these
// tests assume about auth.
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  // *.test.js are node:test unit tests (npm run test:unit); Playwright only owns *.spec.js.
  testMatch: "**/*.spec.js",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.BASE_URL || "http://127.0.0.1:8788",
    trace: "on-first-retry",
    // If your pages require a logged-in Supabase session (see
    // tests/README.md), point this at a saved storage state:
    //   storageState: process.env.STORAGE_STATE || undefined,
    storageState: process.env.STORAGE_STATE || undefined,
    // The fake-backend specs must never be served a cached PWA shell.
    serviceWorkers: "block",
  },
  // No BASE_URL -> serve this checkout ourselves (zero-dependency static server).
  webServer: process.env.BASE_URL ? undefined : {
    command: "node tests/helpers/static-server.js 8788",
    url: "http://127.0.0.1:8788/index.html",
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
