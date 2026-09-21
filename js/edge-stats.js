// edge-stats.js -- pure statistics helpers for the Edge Analysis page:
// t-test + bootstrap confidence ranges, trade-shuffle (Monte Carlo)
// simulation, and MAE/MFE excursion math with stop/target sweeps.
//
// No DOM, no network, no globals besides `window.EdgeStats` (or
// `module.exports` under Node, which is how tests/edge-stats.test.js runs
// it). Everything that involves randomness takes a seed, so a page reload
// shows the same numbers instead of jittering.
(function (root) {
  "use strict";

  // ---------- small utilities ----------
  // mulberry32: tiny, fast, seedable PRNG. Plenty for resampling.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function mean(a) {
    if (!a.length) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  }
  function sd(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }
  // Linear-interpolated percentile of an ASCENDING-sorted array, q in [0,1].
  // Infinity-safe: interpolating between two equal infinities returns that
  // infinity instead of NaN.
  function percentile(sorted, q) {
    const n = sorted.length;
    if (!n) return NaN;
    if (n === 1) return sorted[0];
    const pos = Math.min(Math.max(q, 0), 1) * (n - 1);
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi || sorted[lo] === sorted[hi]) return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }
  function profitFactor(a) {
    let gp = 0, gl = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] > 0) gp += a[i]; else if (a[i] < 0) gl -= a[i]; }
    if (gl === 0) return gp > 0 ? Infinity : NaN;
    return gp / gl;
  }

  // ---------- Student t (regularized incomplete beta, Numerical Recipes) ----------
  function lgamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
      -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5;
    tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (let j = 0; j < 6; j++) ser += c[j] / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  function betacf(a, b, x) {
    const MAXIT = 300, EPS = 3e-12, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }
  function betai(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2)
      ? bt * betacf(a, b, x) / a
      : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  // Two-sided p-value for a t statistic with `df` degrees of freedom.
  function tTwoSidedP(t, df) {
    if (!isFinite(t)) return 0;
    return betai(df / 2, 0.5, df / (df + t * t));
  }
  // Critical |t| such that the two-sided p equals `alpha` (bisection).
  function tCritical(df, alpha) {
    let lo = 0, hi = 1000;
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      if (tTwoSidedP(mid, df) > alpha) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // One-sample t-test of mean P&L against zero, plus a 95% CI for the mean.
  function tTest(values, alpha) {
    alpha = alpha == null ? 0.05 : alpha;
    const n = values.length;
    if (n < 3) return null;
    const m = mean(values), s = sd(values);
    if (!(s > 0)) return null;
    const se = s / Math.sqrt(n), df = n - 1;
    const t = m / se;
    const crit = tCritical(df, alpha);
    return { n, mean: m, sd: s, se, df, t, p: tTwoSidedP(t, df), ci: [m - crit * se, m + crit * se] };
  }

  // Wilson score interval for a proportion (default 95%).
  function wilson(k, n, z) {
    z = z || 1.959964;
    if (!n) return null;
    const p = k / n, z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = (p + z2 / (2 * n)) / denom;
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
    return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
  }

  // Percentile bootstrap of expectancy (mean P&L per trade) and profit
  // factor: resample the trades with replacement, recompute both, and read
  // the alpha/2 and 1-alpha/2 percentiles of each.
  function bootstrapTradeStats(values, opts) {
    opts = opts || {};
    const iterations = opts.iterations || 5000;
    const alpha = opts.alpha == null ? 0.05 : opts.alpha;
    const n = values.length;
    if (n < 5) return null;
    const rand = mulberry32(opts.seed == null ? 12345 : opts.seed);
    const means = new Float64Array(iterations);
    const pfs = [];
    let pfUndefined = 0;
    for (let it = 0; it < iterations; it++) {
      let sum = 0, gp = 0, gl = 0;
      for (let k = 0; k < n; k++) {
        const v = values[(rand() * n) | 0];
        sum += v;
        if (v > 0) gp += v; else if (v < 0) gl -= v;
      }
      means[it] = sum / n;
      if (gl === 0) { if (gp > 0) pfs.push(Infinity); else pfUndefined++; }
      else pfs.push(gp / gl);
    }
    means.sort();
    pfs.sort((a, b) => a - b);
    const lo = alpha / 2, hi = 1 - alpha / 2;
    return {
      iterations,
      expectancy: { point: mean(values), lo: percentile(means, lo), hi: percentile(means, hi) },
      profitFactor: {
        point: profitFactor(values),
        lo: pfs.length ? percentile(pfs, lo) : NaN,
        hi: pfs.length ? percentile(pfs, hi) : NaN,
        infiniteShare: pfs.length ? pfs.filter((v) => v === Infinity).length / pfs.length : 0,
        undefinedCount: pfUndefined,
      },
    };
  }

  // ---------- trade-shuffle simulation ----------
  // pnls[i] is trade i's P&L; lose[i] is 1 when it counts as a losing trade
  // (same definition the rest of the page uses), else 0. Each run shuffles
  // the trade ORDER (total P&L never changes) and records the deepest
  // drawdown (in $, measured from the running peak, which starts at 0) and
  // the longest losing streak. Also keeps the first `fanRuns` equity paths
  // to build percentile bands.
  function pathStats(pnls, lose, order) {
    let cum = 0, peak = 0, dd = 0, cur = 0, best = 0;
    for (let k = 0; k < order.length; k++) {
      const i = order ? order[k] : k;
      cum += pnls[i];
      if (cum > peak) peak = cum;
      if (peak - cum > dd) dd = peak - cum;
      if (lose[i]) { cur++; if (cur > best) best = cur; } else cur = 0;
    }
    return { maxDD: dd, streak: best, total: cum };
  }
  function shuffleSimulation(pnls, lose, opts) {
    opts = opts || {};
    const n = pnls.length;
    if (n < 5) return null;
    const runs = opts.runs || 5000;
    const fanRuns = Math.min(runs, opts.fanRuns || Math.max(200, Math.min(1000, Math.floor(2e6 / n))));
    const rand = mulberry32(opts.seed == null ? 987654 : opts.seed);
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const natural = idx.slice();
    const actual = pathStats(pnls, lose, natural);

    const dds = new Float64Array(runs);
    const streaks = new Int32Array(runs);
    const fan = new Float32Array(fanRuns * n);
    for (let r = 0; r < runs; r++) {
      for (let i = n - 1; i > 0; i--) {
        const j = (rand() * (i + 1)) | 0;
        const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
      }
      let cum = 0, peak = 0, dd = 0, cur = 0, best = 0;
      const keep = r < fanRuns;
      for (let k = 0; k < n; k++) {
        const i = idx[k];
        cum += pnls[i];
        if (cum > peak) peak = cum;
        if (peak - cum > dd) dd = peak - cum;
        if (lose[i]) { cur++; if (cur > best) best = cur; } else cur = 0;
        if (keep) fan[r * n + k] = cum;
      }
      dds[r] = dd;
      streaks[r] = best;
    }

    const qs = [0.05, 0.25, 0.5, 0.75, 0.95];
    const bands = qs.map(() => new Array(n));
    const col = new Float32Array(fanRuns);
    for (let k = 0; k < n; k++) {
      for (let r = 0; r < fanRuns; r++) col[r] = fan[r * n + k];
      col.sort();
      for (let b = 0; b < qs.length; b++) bands[b][k] = percentile(col, qs[b]);
    }

    dds.sort();
    streaks.sort();
    let ddAtLeast = 0, streakAtLeast = 0;
    for (let r = 0; r < runs; r++) {
      if (dds[r] >= actual.maxDD - 1e-9) ddAtLeast++;
      if (streaks[r] >= actual.streak) streakAtLeast++;
    }
    const streakCounts = {};
    for (let r = 0; r < runs; r++) streakCounts[streaks[r]] = (streakCounts[streaks[r]] || 0) + 1;
    return {
      n, runs, fanRuns, actual,
      maxDD: { median: percentile(dds, 0.5), p90: percentile(dds, 0.9), p95: percentile(dds, 0.95), p99: percentile(dds, 0.99) },
      streak: { median: percentile(streaks, 0.5), p90: percentile(streaks, 0.9), p95: percentile(streaks, 0.95), p99: percentile(streaks, 0.99), max: streaks[runs - 1] },
      // share of shuffles at least as bad as the real ordering
      actualDDShare: ddAtLeast / runs,
      actualStreakShare: streakAtLeast / runs,
      streakCounts,
      bands: { p5: bands[0], p25: bands[1], p50: bands[2], p75: bands[3], p95: bands[4] },
    };
  }

  // ---------- MAE / MFE ----------
  // bars: ascending 1-minute (or other) candles labeled by START time, with
  // o/h/l/c. tsOf maps a bar's `t` to a comparable number (unix seconds).
  // entryTs / exitTs are the fill times in the same units. Uses floor-match
  // (last bar starting at or before the fill), the same rule trade.js uses,
  // because a fill at 09:59:48 happened inside the 09:59 bar.
  //
  // Returns adverse (mae) and favorable (mfe) excursion in PRICE units per
  // share, both >= 0, or null when the bars can't support it. Every bar
  // from entry-bar to exit-bar inclusive must have numeric h and l --
  // close-only bars are rejected rather than quietly degraded.
  function computeExcursion(bars, entryTs, exitTs, entryPrice, side, tsOf) {
    if (!Array.isArray(bars) || !bars.length) return null;
    if (![entryTs, exitTs, entryPrice].every(Number.isFinite)) return null;
    let entryIdx = -1, exitIdx = -1;
    for (let i = 0; i < bars.length; i++) {
      const ts = tsOf(bars[i].t);
      if (!Number.isFinite(ts)) return null;
      if (ts <= entryTs) entryIdx = i;
      if (ts <= exitTs) exitIdx = i; else break;
    }
    if (entryIdx === -1) return null; // no bar covers the entry
    if (exitIdx < entryIdx) exitIdx = entryIdx;
    let hi = -Infinity, lo = Infinity;
    for (let i = entryIdx; i <= exitIdx; i++) {
      const h = bars[i].h, l = bars[i].l;
      if (!Number.isFinite(h) || !Number.isFinite(l)) return null;
      if (h > hi) hi = h;
      if (l < lo) lo = l;
    }
    const isShort = side === "short";
    const mfe = Math.max(0, isShort ? entryPrice - lo : hi - entryPrice);
    const mae = Math.max(0, isShort ? hi - entryPrice : entryPrice - lo);
    return { mae, mfe, bars: exitIdx - entryIdx + 1 };
  }

  // Rows: {mae, mfe, pnl (gross $/share actually realized), shares, win}.
  // Stop sweep: a trade whose MAE reached the stop distance is assumed
  // stopped at exactly -stop; otherwise its real result stands.
  function stopSweep(rows, levels) {
    const winners = rows.filter((r) => r.win);
    const actualTotal = rows.reduce((s, r) => s + r.pnl * r.shares, 0);
    return levels.map((s) => {
      let simTotal = 0, winnersStopped = 0, losersImproved = 0;
      for (const r of rows) {
        if (r.mae >= s) {
          simTotal += -s * r.shares;
          if (r.win) winnersStopped++;
          else if (r.pnl < -s) losersImproved++;
        } else simTotal += r.pnl * r.shares;
      }
      return {
        level: s, winnersStopped, winnerShare: winners.length ? winnersStopped / winners.length : 0,
        losersImproved, delta: simTotal - actualTotal, simTotal,
      };
    });
  }
  // Target sweep: a trade whose MFE reached the target is assumed to take
  // profit at exactly +target (capping bigger winners); otherwise unchanged.
  function targetSweep(rows, levels) {
    const actualTotal = rows.reduce((s, r) => s + r.pnl * r.shares, 0);
    return levels.map((t) => {
      let simTotal = 0, reached = 0;
      for (const r of rows) {
        if (r.mfe >= t) { simTotal += t * r.shares; reached++; }
        else simTotal += r.pnl * r.shares;
      }
      return { level: t, reachedShare: rows.length ? reached / rows.length : 0, delta: simTotal - actualTotal, simTotal };
    });
  }

  const api = {
    mulberry32, mean, sd, percentile, profitFactor,
    tTwoSidedP, tCritical, tTest, wilson, bootstrapTradeStats,
    pathStats, shuffleSimulation,
    computeExcursion, stopSweep, targetSweep,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EdgeStats = api;
})(typeof window !== "undefined" ? window : globalThis);
