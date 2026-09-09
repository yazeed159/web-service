// chart-indicators.js
// Shared helpers for trade.js / report.js's price charts:
//   - resampleBars(): turns the 1-minute bars we already fetched into
//     5m/15m/1h candles client-side, recomputing EMA9/EMA20/MACD on the
//     resampled closes (no extra network call).
//   - indicatorRowsHtml(): the VWAP/EMA9/EMA20 rows for the top-left hover
//     overlay, shared so trade.js, report.js, and the inlined copy in
//     share-export.js all render identical markup/colors.
//   - buildTimeframeSwitcher(): the 1m/5m/15m/1h pill-button control
//     (styled by the .tf-switcher/.tf-btn rules in common.css).
(function () {
  "use strict";

  // Bars come in as { t: "YYYY-MM-DD HH:MM:SS", ... } with no timezone --
  // same string shape trade.js's own toUnix() parses by appending "Z".
  // We parse/format the same way here so a resampled bar's `t` lines up
  // with how toUnix() will read it back downstream.
  function toUnix(t) {
    return Math.floor(new Date(t.replace(" ", "T") + "Z").getTime() / 1000);
  }
  function fromUnix(ts) {
    const d = new Date(ts * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    );
  }

  // Standard recursive EMA, seeded with the first value (rather than an
  // n-bar SMA) so it's defined from bar 1 -- with only a session's worth
  // of 1-minute bars to resample from, a handful of 5m/15m/1h candles is
  // common, and an SMA seed would leave those early bars null.
  function computeEma(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length).fill(null);
    let ema = null;
    for (let i = 0; i < values.length; i++) {
      ema = ema === null ? values[i] : values[i] * k + ema * (1 - k);
      out[i] = ema;
    }
    return out;
  }

  // Groups 1-minute bars into `minutes`-sized buckets aligned to clock
  // boundaries (00, :05, :10... for 5m), the way a broker platform's
  // timeframe switch works, rather than just chunking every N raw bars.
  function resampleBars(bars, minutes) {
    if (!bars || !bars.length || minutes <= 1) return bars || [];
    const bucketSec = minutes * 60;
    const groups = [];
    let current = null;
    let currentBucketStart = null;

    for (const b of bars) {
      const ts = toUnix(b.t);
      const bucketStart = Math.floor(ts / bucketSec) * bucketSec;
      if (currentBucketStart === null || bucketStart !== currentBucketStart) {
        if (current) groups.push(current);
        currentBucketStart = bucketStart;
        current = { startTs: bucketStart, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, vwap: b.vwap };
      } else {
        current.h = Math.max(current.h, b.h);
        current.l = Math.min(current.l, b.l);
        current.c = b.c;
        current.v += b.v || 0;
        // VWAP is already session-cumulative on the raw 1m bars, so the
        // resampled candle just carries forward whatever the last raw bar
        // in the bucket had -- no recompute needed.
        current.vwap = b.vwap;
      }
    }
    if (current) groups.push(current);

    const closes = groups.map((g) => g.c);
    const ema9Arr = computeEma(closes, 9);
    const ema20Arr = computeEma(closes, 20);
    // Same recursive EMA as EMA9/EMA20 above, just seeded on the resampled
    // closes rather than carried over from the server's 1m-bar EMA200 --
    // on wider timeframes (15m/1h) with only a handful of resampled bars
    // this will read as flatter/less "warmed up" than the 1m chart's
    // EMA200, same caveat that already applies to EMA9/EMA20 here.
    const ema200Arr = computeEma(closes, 200);
    const emaFastArr = computeEma(closes, 12);
    const emaSlowArr = computeEma(closes, 26);
    const macdArr = closes.map((_, i) => emaFastArr[i] - emaSlowArr[i]);
    const signalArr = computeEma(macdArr, 9);

    return groups.map((g, i) => ({
      t: fromUnix(g.startTs),
      o: g.o,
      h: g.h,
      l: g.l,
      c: g.c,
      v: g.v,
      vwap: g.vwap,
      ema9: ema9Arr[i],
      ema20: ema20Arr[i],
      ema200: ema200Arr[i],
      macd: macdArr[i],
      macd_signal: signalArr[i],
      macd_hist: macdArr[i] - signalArr[i],
    }));
  }

  function fmtPrice(v) {
    return v == null || isNaN(v) ? "—" : Number(v).toFixed(2);
  }

  // Exact markup/colors trade.js's overlay, report.js's overlay, and the
  // inlined version in share-export.js all use -- kept in one place so
  // the three never drift from each other.
  function indicatorRowsHtml(vwap, ema9, ema20, ema200) {
    return (
      `<div class="row"><span class="k">VWAP</span><span class="v" style="color:#d97b3f">${fmtPrice(vwap)}</span></div>` +
      `<div class="row"><span class="k">EMA9</span><span class="v" style="color:#a3a68a">${fmtPrice(ema9)}</span></div>` +
      `<div class="row"><span class="k">EMA20</span><span class="v" style="color:#6fa3c9">${fmtPrice(ema20)}</span></div>` +
      `<div class="row"><span class="k">EMA200</span><span class="v" style="color:#a884b0">${fmtPrice(ema200)}</span></div>`
    );
  }

  // Builds a .tf-switcher pill control. `active` is the currently-selected
  // interval in minutes (1/5/15/60); `onSelect(minutes)` fires on click.
  // The switcher owns its own active-button styling so callers don't have
  // to re-render it every time the interval changes.
  function buildTimeframeSwitcher({ active, onSelect }) {
    const wrap = document.createElement("div");
    wrap.className = "tf-switcher";
    const options = [
      [1, "1m"],
      [5, "5m"],
      [15, "15m"],
      [60, "1h"],
    ];
    options.forEach(([minutes, label]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tf-btn" + (minutes === active ? " active" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => {
        wrap.querySelectorAll(".tf-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        onSelect(minutes);
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  window.ChartIndicators = {
    resampleBars,
    indicatorRowsHtml,
    buildTimeframeSwitcher,
  };
})();
