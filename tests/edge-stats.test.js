// Unit tests for js/edge-stats.js. Run with:  node --test tests/edge-stats.test.js
// (no browser, no Supabase). Reference t-distribution values come from scipy.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../js/edge-stats.js");

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ""} expected ${b}, got ${a}`);

test("t-distribution p-values and critical values match scipy", () => {
  close(S.tTwoSidedP(2.0, 10), 0.07338803477074037, 1e-9, "p(2.0,10)");
  close(S.tTwoSidedP(0.5, 3), 0.651447964848151, 1e-9, "p(0.5,3)");
  close(S.tTwoSidedP(6, 120), 2.1483038193060425e-8, 1e-12, "p(6,120)");
  close(S.tCritical(29, 0.05), 2.045229642132703, 1e-6, "crit(29)");
  close(S.tCritical(10, 0.05), 2.228138851986274, 1e-6, "crit(10)");
});

test("tTest: mean, CI, and refusal on degenerate input", () => {
  const r = S.tTest([10, -5, 8, -2, 7, 3, -4, 9, 1, 6]);
  close(r.mean, 3.3, 1e-12);
  assert.ok(r.ci[0] < r.mean && r.mean < r.ci[1]);
  assert.equal(r.df, 9);
  assert.equal(S.tTest([1, 1, 1]), null); // zero variance
  assert.equal(S.tTest([1, 2]), null);    // too few
});

test("wilson interval brackets the point estimate", () => {
  const w = S.wilson(29, 100);
  close(w.p, 0.29, 1e-12);
  assert.ok(w.lo < 0.29 && w.hi > 0.29);
  close(w.lo, 0.2102, 2e-3);
  close(w.hi, 0.3852, 2e-3);
});

test("bootstrap is deterministic per seed and brackets the point estimate", () => {
  const vals = [];
  for (let i = 0; i < 100; i++) vals.push(i % 10 < 3 ? 40 + (i % 7) : -10 - (i % 3));
  const a = S.bootstrapTradeStats(vals, { seed: 7, iterations: 2000 });
  const b = S.bootstrapTradeStats(vals, { seed: 7, iterations: 2000 });
  assert.deepEqual(a, b);
  assert.ok(a.expectancy.lo < a.expectancy.point && a.expectancy.point < a.expectancy.hi);
  assert.ok(a.profitFactor.lo < a.profitFactor.point && a.profitFactor.point < a.profitFactor.hi);
  // bootstrap SE of the mean should be close to sd/sqrt(n)
  const se = S.sd(vals) / Math.sqrt(vals.length);
  close((a.expectancy.hi - a.expectancy.lo) / (2 * 1.96), se, se * 0.15, "bootstrap SE");
});

test("bootstrap handles all-winners (infinite profit factor) without NaN", () => {
  const r = S.bootstrapTradeStats([1, 2, 3, 4, 5, 6], { seed: 1, iterations: 500 });
  assert.equal(r.profitFactor.hi, Infinity);
  assert.equal(r.profitFactor.infiniteShare, 1);
});

test("shuffle simulation: fixed total, deterministic, sensible streaks", () => {
  // 29% winners, fixed-size: +30 / -10
  const pnls = [], lose = [];
  for (let i = 0; i < 200; i++) { const w = i % 100 < 29; pnls.push(w ? 30 : -10); lose.push(w ? 0 : 1); }
  const a = S.shuffleSimulation(pnls, lose, { runs: 2000, seed: 3 });
  const b = S.shuffleSimulation(pnls, lose, { runs: 2000, seed: 3 });
  assert.deepEqual(a.streak, b.streak);
  // every equity path ends at the same total
  const total = pnls.reduce((s, v) => s + v, 0);
  close(a.bands.p50[pnls.length - 1], total, 1e-3);
  close(a.bands.p5[pnls.length - 1], total, 1e-3);
  // with p(loss)=0.71 over 200 trades the median longest streak is ~10-14
  assert.ok(a.streak.median >= 8 && a.streak.median <= 16, `median streak ${a.streak.median}`);
  assert.ok(a.streak.p95 >= a.streak.median && a.maxDD.p95 >= a.maxDD.median);
});

test("shuffle simulation: independent Python-style cross-check on streak length", () => {
  // Expected longest run of losses in n Bernoulli(q) trials ~ ln(n*(1-q)) / ln(1/q)
  // (asymptotic); with q=0.71, n=1000 that is ~ 16.6 -> allow a generous band.
  const n = 1000, pnls = [], lose = [];
  for (let i = 0; i < n; i++) { const w = i % 100 < 29; pnls.push(w ? 3 : -1); lose.push(w ? 0 : 1); }
  const r = S.shuffleSimulation(pnls, lose, { runs: 1500, seed: 11 });
  assert.ok(r.streak.median >= 13 && r.streak.median <= 20, `median streak ${r.streak.median}`);
});

test("computeExcursion: long, short, floor-matching and rejection cases", () => {
  const tsOf = (t) => Date.parse(t.replace(" ", "T") + "Z") / 1000;
  const bars = [
    { t: "2026-09-01 09:30:00", o: 10, h: 10.2, l: 9.9, c: 10.1 },
    { t: "2026-09-01 09:31:00", o: 10.1, h: 10.6, l: 9.7, c: 10.4 },
    { t: "2026-09-01 09:32:00", o: 10.4, h: 10.5, l: 10.3, c: 10.4 },
    { t: "2026-09-01 09:33:00", o: 10.4, h: 11.5, l: 10.4, c: 11.4 }, // after exit
  ];
  const at = (hms) => tsOf(`2026-09-01 ${hms}`);
  // long, entered 09:30:48 (inside the 09:30 bar), exited 09:32:10
  const long = S.computeExcursion(bars, at("09:30:48"), at("09:32:10"), 10.0, "long", tsOf);
  close(long.mfe, 0.6, 1e-9); close(long.mae, 0.3, 1e-9);
  assert.equal(long.bars, 3);
  // short from same entry: adverse is the high, favorable is the low
  const short = S.computeExcursion(bars, at("09:30:48"), at("09:32:10"), 10.0, "short", tsOf);
  close(short.mae, 0.6, 1e-9); close(short.mfe, 0.3, 1e-9);
  // bars after the exit must not leak in
  assert.ok(long.mfe < 1.5);
  // entry before first bar -> null; close-only bars -> null (never degrade silently)
  assert.equal(S.computeExcursion(bars, at("09:00:00"), at("09:32:10"), 10, "long", tsOf), null);
  const closeOnly = bars.map((b) => ({ t: b.t, c: b.c }));
  assert.equal(S.computeExcursion(closeOnly, at("09:30:48"), at("09:32:10"), 10, "long", tsOf), null);
  // exit earlier than entry bar collapses to the entry bar
  const odd = S.computeExcursion(bars, at("09:31:10"), at("09:30:10"), 10.1, "long", tsOf);
  assert.equal(odd.bars, 1);
});

test("stop and target sweeps", () => {
  const rows = [
    { mae: 0.02, mfe: 0.30, pnl: 0.25, shares: 100, win: true },
    { mae: 0.15, mfe: 0.40, pnl: 0.30, shares: 100, win: true },   // winner a tight stop would kill
    { mae: 0.20, mfe: 0.05, pnl: -0.20, shares: 100, win: false }, // loser, stop == its loss
    { mae: 0.50, mfe: 0.01, pnl: -0.50, shares: 100, win: false }, // loser a 0.10 stop would cut
  ];
  const [tight] = S.stopSweep(rows, [0.10]);
  assert.equal(tight.winnersStopped, 1);
  close(tight.winnerShare, 0.5, 1e-12);
  assert.equal(tight.losersImproved, 2);
  // sim: -10 (stopped winner) ... compute expected by hand
  // t2: -0.10*100 = -10 ; t3: -10 ; t4: -10 ; t1 untouched: +25  => -5
  // actual = 25+30-20-50 = -15, so the stop improves the total by 10
  close(tight.simTotal, -5, 1e-9); close(tight.delta, 10, 1e-9);
  const [tgt] = S.targetSweep(rows, [0.30]);
  // reached: t1 (0.30 -> +30, was 25), t2 (0.40 -> +30, was 30) ; others unchanged
  close(tgt.reachedShare, 0.5, 1e-12);
  close(tgt.delta, 5, 1e-9);
});
