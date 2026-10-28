// tests/helpers/fixtures.js
//
// Playwright `test` with an in-memory fake Supabase wired in (no network, no
// account, no STORAGE_STATE). It reuses tests/browser-harness/fake_supabase.js
// -- the same fake the Python harness drives -- so both stay in step.
//
//   const { test, expect } = require("./helpers/fixtures");
//   test.use({ seed: { trades: [trade({ symbol: "ABCD" })] } });
//   test("...", async ({ page }) => { await page.goto("/journal.html"); ... });
//
// Option (test.use): seed = { trades: rows for the `trades` table, kv: `user_kv`
// rows, local: { storageKey: jsonValue } seeded into localStorage once }.
// It's one object on purpose: Playwright reads a 2-element array passed to
// test.use as a [value, options] fixture tuple and silently drops the 2nd trade.
const base = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const FAKE = fs.readFileSync(path.join(__dirname, "..", "browser-harness", "fake_supabase.js"), "utf8");
// lightweight-charts is only needed to *draw* charts; a no-op proxy keeps pages that import it alive.
const CHARTS_STUB = "(function(){const mk=()=>new Proxy(function(){},{get:(t,k)=>k===Symbol.toPrimitive?()=>0:mk(),apply:()=>mk(),construct:()=>mk()});window.LightweightCharts=new Proxy({},{get:(t,k)=>mk()});})()";

const test = base.test.extend({
  seed: [{}, { option: true }],
  // Collected so specs can assert no uncaught JS errors on top of what they render.
  pageErrors: async ({ page }, use) => {
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await use(errs);
  },
  page: async ({ page, context, seed }, use) => {
    const { trades = [], kv = [], local = {} } = seed;
    // Hermetic: anything that isn't the local server is refused.
    await context.route((u) => !/^http:\/\/(localhost|127\.0\.0\.1)/.test(u.toString()), (r) => r.abort());
    await context.route("**/vendor/supabase.js", (r) => r.fulfill({ body: FAKE, contentType: "application/javascript" }));
    await context.route("**/vendor/lightweight-charts.js", (r) => r.fulfill({ body: CHARTS_STUB, contentType: "application/javascript" }));
    // Seed before any page script runs. localStorage seeds only apply on first load
    // so a reload inside a test sees what the page itself saved.
    await page.addInitScript(({ trades, kv, local }) => {
      window.__seedTrades = trades; window.__seedKv = kv;
      for (const k of Object.keys(local)) if (localStorage.getItem(k) === null) localStorage.setItem(k, JSON.stringify(local[k]));
    }, { trades, kv, local });
    await use(page);
  },
});

module.exports = { test, expect: base.expect };
