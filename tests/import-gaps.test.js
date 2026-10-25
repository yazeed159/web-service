// node --test tests/import-gaps.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { findGaps } = require("../js/import-gaps.js");

test("finds quiet stretches of at least minDays, oldest first", () => {
  const g = findGaps(["2025-01-10", "2025-01-12", "2025-06-01", "2025-06-02", "2026-03-05"], 30);
  assert.deepEqual(g.map((x) => [x.from, x.to]), [["2025-01-12", "2025-06-01"], ["2025-06-02", "2026-03-05"]]);
  assert.equal(g[0].days, 140);
});
test("ignores duplicates, junk and short breaks", () => {
  assert.deepEqual(findGaps(["2025-01-01", "2025-01-01", "nope", "2025-01-20"], 30), []);
  assert.deepEqual(findGaps([], 30), []);
  assert.equal(findGaps(["2025-01-01", "2025-01-31"], 30).length, 1); // exactly 30 days counts
});
