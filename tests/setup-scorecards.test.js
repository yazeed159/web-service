// node --test tests/setup-scorecards.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/setup-scorecards.js");
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);

test("time buckets follow the premarket split", () => {
  assert.equal(S.bucketOf("05:59:00").id, "pm_early");
  assert.equal(S.bucketOf("07:00:00").id, "pm_late");
  assert.equal(S.bucketOf("09:29:59").id, "pm_late");
  assert.equal(S.bucketOf("09:30:00").id, "open");
  assert.equal(S.bucketOf("10:30:00").id, "midday");
  assert.equal(S.bucketOf("16:00:00").id, "after");
  assert.equal(S.bucketOf("03:00:00"), null);
  assert.equal(S.bucketOf(null), null);
});

test("stats: win rate, expectancy, profit factor, hold time", () => {
  const s = S.stats([
    { pnl_after_comm: 100, entry_time: "09:35:00", exit_time: "09:40:00" },
    { pnl_after_comm: -50, entry_time: "09:45:00", exit_time: "09:47:00" },
    { pnl_after_comm: 50, entry_time: "10:00:00", exit_time: "10:03:00" },
  ]);
  assert.equal(s.n, 3); close(s.winRate, 2 / 3); close(s.expectancy, 100 / 3);
  close(s.profitFactor, 3); close(s.avgHoldMin, (5 + 2 + 3) / 3); close(s.avgWin, 75); close(s.avgLoss, -50);
});

test("build groups by setup, splits by time, ignores untagged trades", () => {
  const trades = [
    { setup_type: "red_to_green", pnl_after_comm: 10, entry_time: "09:31:00", exit_time: "09:35:00" },
    { setup_type: "red_to_green", pnl_after_comm: -5, entry_time: "11:00:00", exit_time: "11:05:00" },
    { setup_type: "ema9_dip_buy", pnl_after_comm: 7, entry_time: "08:00:00", exit_time: "08:10:00" },
    { pnl_after_comm: 99, entry_time: "09:31:00", exit_time: "09:35:00" },
  ];
  const rows = S.build(trades);
  assert.equal(rows.length, 2); assert.equal(rows[0].setup, "red_to_green"); assert.equal(rows[0].n, 2);
  assert.equal(rows[0].byTime.find((b) => b.bucket === "open").n, 1);
  assert.equal(rows[0].byTime.find((b) => b.bucket === "midday").expectancy, -5);
  assert.deepEqual(S.build(trades, ["ema9_dip_buy"]).map((r) => r.setup), ["ema9_dip_buy"]);
});

test("profit factor is Infinity with only winners and null with no trades", () => {
  assert.equal(S.stats([{ pnl_after_comm: 5 }]).profitFactor, Infinity);
  assert.equal(S.stats([]).winRate, null);
});
