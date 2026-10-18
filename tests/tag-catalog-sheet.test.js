// Regression test: clicking a tag pill must never lock the page. Needs jsdom (npm i -D jsdom); skipped without it.
// Run with:  node --test tests/tag-catalog-sheet.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

let hasJsdom = true;
try { require.resolve("jsdom"); } catch (e) { hasJsdom = false; }

test("tag sheet opens once per click (no re-open loop), old/AI tags get a sheet", { skip: !hasJsdom && "jsdom not installed" }, () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "fixtures/tag-sheet-check.js")], { timeout: 10000, encoding: "utf8" });
  assert.equal(r.error && r.error.code, undefined, "the check hung (page lock-up): " + (r.error || ""));
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
