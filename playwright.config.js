// playwright.config.js
//
// Points at BASE_URL (your deployed site, or a local static server) --
// see tests/README.md for how to set it and for the one thing these
// tests assume about auth.
const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.BASE_URL || "http://localhost:8788",
    trace: "on-first-retry",
    // If your pages require a logged-in Supabase session (see
    // tests/README.md), point this at a saved storage state:
    //   storageState: process.env.STORAGE_STATE || undefined,
    storageState: process.env.STORAGE_STATE || undefined,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
