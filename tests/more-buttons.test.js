// The one "show more" rule used by every Reports list (js/utils.js).
// Run: node --test tests/more-buttons.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "utils.js"), "utf8");
const start = src.indexOf("window.moreButtonsHtml = function");
const end = src.indexOf("window.tradeListMoreHtml = function");
const window = { TRADE_LIST_PAGE_SIZE: 5 };
new Function("window", src.slice(start, end))(window);

const labels = (html) => [...html.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
const steps = (html) => [...html.matchAll(/data-step="([^"]+)"/g)].map((m) => m[1]);

test("up to 15 in total: Show 5 more + Show all", () => {
  assert.deepStrictEqual(labels(window.moreButtonsHtml("", 10, 15)), ["Show 5 more", "Show all (10)"]);
});
test("5 or fewer left: only Show all", () => {
  assert.deepStrictEqual(labels(window.moreButtonsHtml("", 3, 8)), ["Show all (3)"]);
});
test("more than 15 in total: Load 20 more + Load all", () => {
  assert.deepStrictEqual(labels(window.moreButtonsHtml("", 35, 40)), ["Load 20 more", "Load all (35)"]);
  assert.deepStrictEqual(steps(window.moreButtonsHtml("", 35, 40)), ["20", "all"]);
});
test("more than 15 in total but 20 or fewer left: only Load all", () => {
  assert.deepStrictEqual(labels(window.moreButtonsHtml("", 11, 16)), ["Load all (11)"]);
});
test("moreStep reads the button and never overshoots", () => {
  const btn = (v) => ({ getAttribute: () => v });
  assert.strictEqual(window.moreStep(btn("5"), 3), 3);
  assert.strictEqual(window.moreStep(btn("20"), 35), 20);
  assert.strictEqual(window.moreStep(btn("all"), 35), 35);
});
