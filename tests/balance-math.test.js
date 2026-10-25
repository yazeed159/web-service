// node --test tests/balance-math.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../js/balance-math.js");
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);

const entries = [{ date: "2026-01-01", amount: 1000 }, { date: "2026-02-01", amount: 500 }];
const trades = [
  { trade_date: "2026-01-05", pnl_after_comm: 100 },
  { trade_date: "2026-01-20", pnl_after_comm: -50 },
  { trade_date: "2026-02-10", pnl_after_comm: 30 },
];

test("period balance carries over from earlier periods", () => {
  const p1 = B.periodSummary(entries, trades, { start: "2026-01-01", end: "2026-02-01" });
  assert.equal(p1.carryIn, 0); assert.equal(p1.added, 1000); assert.equal(p1.pnl, 50); assert.equal(p1.endBalance, 1050);
  const p2 = B.periodSummary(entries, trades, { start: "2026-02-01", end: null });
  assert.equal(p2.carryIn, 1050); assert.equal(p2.added, 500); assert.equal(p2.pnl, 30); assert.equal(p2.endBalance, 1580);
});

test("a deposit made after the last trade still counts", () => {
  const p = B.periodSummary([...entries, { date: "2026-03-01", amount: 200 }], trades, { start: "2026-02-01", end: null });
  assert.equal(p.endBalance, 1780);
});

test("withdrawals reduce the balance and are not a loss in the return", () => {
  const e = [{ date: "2026-01-01", amount: 1000 }, { date: "2026-01-10", amount: -500 }];
  const t = [{ trade_date: "2026-01-05", pnl_after_comm: 100 }, { trade_date: "2026-01-12", pnl_after_comm: 55 }];
  const p = B.periodSummary(e, t, { start: "2026-01-01", end: null });
  assert.equal(p.endBalance, 655);
  // +10% on 1000 (equity 1100), withdraw 500 -> 600, then +55 on 600 -> 1.1 * (1 + 55/600) - 1
  close(p.twr, 1.1 * (1 + 55 / 600) - 1);
});

test("a deposit on a trading day is not counted as profit", () => {
  const e = [{ date: "2026-01-01", amount: 1000 }, { date: "2026-01-02", amount: 1000 }];
  const t = [{ trade_date: "2026-01-02", pnl_after_comm: 200 }];
  close(B.timeWeightedReturn(0, e, t), 0.1); // 200 on 2000, not 200 on 1000
});

test("twr is null with no trades, and skips days with an empty account", () => {
  assert.equal(B.timeWeightedReturn(0, [{ date: "2026-01-01", amount: 100 }], []), null);
  assert.equal(B.timeWeightedReturn(0, [], [{ trade_date: "2026-01-01", pnl_after_comm: 5 }]), null);
});

test("missing or garbage pnl is treated as zero", () => {
  const p = B.periodSummary([{ date: "2026-01-01", amount: 100 }], [{ trade_date: "2026-01-02", pnl_after_comm: null }, { trade_date: "2026-01-03" }], { start: "2026-01-01", end: null });
  assert.equal(p.endBalance, 100);
});

test("lowestBalance finds the dip below zero and its date", () => {
  const low = B.lowestBalance([{ date: "2026-01-01", amount: 100 }], [{ trade_date: "2026-01-05", pnl_after_comm: -60 }, { trade_date: "2026-01-06", pnl_after_comm: -70 }, { trade_date: "2026-01-07", pnl_after_comm: 200 }]);
  assert.deepEqual(low, { min: -30, date: "2026-01-06" });
});
test("lowestBalance: a withdrawal counts before that day's P&L, and empty history is null", () => {
  assert.deepEqual(B.lowestBalance([{ date: "2026-01-01", amount: 100 }, { date: "2026-01-02", amount: -150 }], []), { min: -50, date: "2026-01-02" });
  assert.equal(B.lowestBalance([], []), null);
  assert.ok(B.lowestBalance([{ date: "2026-01-01", amount: 100 }], [{ trade_date: "2026-01-02", pnl_after_comm: 10 }]).min >= 0);
});
