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
  // toUnix() moved to utils.js (loads first on every page now), so this
  // file's chart code below calls the global one.
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

  // Exact markup/colors trade.js's overlay, report.js's overlay, and the
  // inlined version in share-export.js all use -- kept in one place so
  // the three never drift from each other.
  function indicatorRowsHtml(vwap, ema9, ema20, ema200) {
    return (
      `<div class="row"><span class="k">VWAP</span><span class="v" style="color:#e8a94c">${fmtPrice(vwap)}</span></div>` +
      `<div class="row"><span class="k">EMA9</span><span class="v" style="color:#9aa8a1">${fmtPrice(ema9)}</span></div>` +
      `<div class="row"><span class="k">EMA20</span><span class="v" style="color:#5b93f0">${fmtPrice(ema20)}</span></div>` +
      `<div class="row"><span class="k">EMA200</span><span class="v" style="color:#b57bee">${fmtPrice(ema200)}</span></div>`
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

  // Builds the standard candles + volume + VWAP/EMA9/EMA20/EMA200 chart
  // that trade.js, practice.js, rewind.js, report.js, and quiz.js each
  // used to hand-roll (~80-100 near-identical lines per caller, down to
  // the exact same color hex codes). This is that boilerplate, pulled
  // into one place: creating the chart, adding the four series, wiring
  // the crosshair-tracked info overlay, and observing the container for
  // resize -- so a fix here (like the toUnix() used for every series'
  // `time` field) can't drift out of sync between callers the way it did
  // when quiz.js kept its own copy.
  //
  // `bars` is an array of { t, o, h, l, c, v, vwap, ema9, ema20, ema200 }
  // (a bar with `_forming: true` gets painted in the in-progress amber
  // color, same convention practice.js/rewind.js/quiz.js already used).
  //
  // `opts` (all optional):
  //   height              - chart height in px (default 380)
  //   minimumWidth        - right price scale minimum width (default 88)
  //   priceScaleMargins   - { top, bottom } for the right (price) scale
  //   volScaleMargins     - { top, bottom } for the volume sub-scale
  //   showLastValueLine   - candle series' built-in dashed last-value line
  //                         (default true; pass false once there are no
  //                         more forming ticks and it'd just be a stray
  //                         unlabeled line, e.g. a completed-round recap)
  //   overlay             - build the top-left crosshair-tracked info
  //                         overlay (default true)
  //   floatLabel          - pre-formatted float-shares string to show as
  //                         a "Float" row above Vol in the overlay (the
  //                         caller formats it -- fmtShares is page-local,
  //                         not shared -- omit for no Float row)
  //   markers             - passed straight to series.setMarkers()
  //   priceLines          - array of createPriceLine() option objects;
  //                         each becomes priceLineRefs[pl.key || index]
  //                         on the returned handle
  //   onResize            - called after the chart's own width is
  //                         reapplied on resize, e.g. to resize a
  //                         companion chart or reposition overlays that
  //                         track pixel coordinates
  //
  // Returns a handle: { chart, series, volSeries, vwapSeries, ema9Series,
  // ema20Series, ema200Series, priceLineRefs, resizeObserver, renderOverlay,
  // handleState }. Pass it to teardownStandardChart() when done with it --
  // don't just chart.remove() directly, or the ResizeObserver (and any
  // pointerRo/eodRo a caller stashed on the handle) leaks.
  function buildStandardChart(el, bars, opts) {
    opts = opts || {};
    if (typeof LightweightCharts === "undefined") {
      // The charting library loads from an external CDN with `defer`, so on
      // a slow connection it's possible to reach this before it's finished.
      // Fail with a clear, actionable message instead of a bare
      // "LightweightCharts is not defined" crash that leaves the card stuck.
      throw new Error("Chart library hasn't finished loading yet — wait a moment and try again.");
    }
    el.innerHTML = "";
    const candleData = bars.map((b) => {
      const point = { time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c };
      if (b._forming) { point.color = "rgba(232,169,76,0.55)"; point.borderColor = "#e8a94c"; point.wickColor = "#e8a94c"; }
      return point;
    });
    const volData = bars.map((b) => ({
      time: toUnix(b.t), value: b.v,
      color: b._forming ? "rgba(232,169,76,0.4)" : (b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)"),
    }));
    const vwapData = bars.filter((b) => b.vwap != null).map((b) => ({ time: toUnix(b.t), value: b.vwap }));
    const ema9Data = bars.filter((b) => b.ema9 != null).map((b) => ({ time: toUnix(b.t), value: b.ema9 }));
    const ema20Data = bars.filter((b) => b.ema20 != null).map((b) => ({ time: toUnix(b.t), value: b.ema20 }));
    const ema200Data = bars.filter((b) => b.ema200 != null).map((b) => ({ time: toUnix(b.t), value: b.ema200 }));

    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: "#8b98a5" },
      grid: { vertLines: { color: "#1c2127" }, horzLines: { color: "#1c2127" } },
      rightPriceScale: { borderColor: "#232830", minimumWidth: opts.minimumWidth || 88 },
      timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };
    const chart = LightweightCharts.createChart(el, { ...commonOpts, width: el.clientWidth, height: opts.height || 380 });
    const series = chart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
      priceLineVisible: opts.showLastValueLine !== false,
    });
    series.setData(candleData);
    chart.priceScale("right").applyOptions({ scaleMargins: opts.priceScaleMargins || { top: 0.12, bottom: 0.2 } });

    const volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    chart.priceScale("vol").applyOptions({ scaleMargins: opts.volScaleMargins || { top: 0.85, bottom: 0 } });
    volSeries.setData(volData);

    const vwapSeries = chart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    vwapSeries.setData(vwapData);
    const ema9Series = chart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ema9Series.setData(ema9Data);
    const ema20Series = chart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ema20Series.setData(ema20Data);
    const ema200Series = chart.addLineSeries({ color: "#b57bee", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ema200Series.setData(ema200Data);

    // Top-left info overlay: optional float row, plus a live volume/VWAP/
    // EMA9/EMA20/EMA200 readout that tracks the crosshair the way a broker
    // platform's OHLCV legend does, falling back to the most recent bar's
    // values whenever nothing is hovered (including mid-playback, since
    // callers that progressively feed bars in also keep handleState's
    // lastVol/lastVwap/etc. current as the tape plays).
    let renderOverlay = () => {};
    let handleState = null;
    if (opts.overlay !== false) {
      el.style.position = "relative";
      let infoOverlay = el.querySelector(".chart-info-overlay");
      if (!infoOverlay) {
        infoOverlay = document.createElement("div");
        infoOverlay.className = "chart-info-overlay";
        el.appendChild(infoOverlay);
      }
      const floatRow = opts.floatLabel
        ? `<div class="row"><span class="k">Float</span><span class="v">${opts.floatLabel}</span></div>`
        : "";
      const volRowHtml = (vol, color) =>
        `<div class="row"><span class="k">Vol</span><span class="v${color ? ` ${color}` : ""}">${vol == null ? "—" : Number(vol).toLocaleString()}</span></div>`;
      renderOverlay = (vol, upDown, vwapVal, ema9Val, ema20Val, ema200Val) => {
        infoOverlay.innerHTML = floatRow + volRowHtml(vol, upDown) + indicatorRowsHtml(vwapVal, ema9Val, ema20Val, ema200Val);
      };
      const lastBar = bars.length ? bars[bars.length - 1] : null;
      handleState = {
        lastVol: lastBar ? lastBar.v : null,
        lastVwap: lastBar ? lastBar.vwap : null,
        lastEma9: lastBar ? lastBar.ema9 : null,
        lastEma20: lastBar ? lastBar.ema20 : null,
        lastEma200: lastBar ? lastBar.ema200 : null,
      };
      renderOverlay(handleState.lastVol, "", handleState.lastVwap, handleState.lastEma9, handleState.lastEma20, handleState.lastEma200);
      chart.subscribeCrosshairMove((param) => {
        const volBar = param.seriesData && param.seriesData.get(volSeries);
        const vwapBar = param.seriesData && param.seriesData.get(vwapSeries);
        const ema9Bar = param.seriesData && param.seriesData.get(ema9Series);
        const ema20Bar = param.seriesData && param.seriesData.get(ema20Series);
        const ema200Bar = param.seriesData && param.seriesData.get(ema200Series);
        const upDown = volBar ? (volBar.color && volBar.color.indexOf("47,208,138") !== -1 ? "up" : volBar.color && volBar.color.indexOf("232,169,76") !== -1 ? "" : "down") : "";
        renderOverlay(
          volBar ? volBar.value : handleState.lastVol, upDown,
          vwapBar ? vwapBar.value : handleState.lastVwap,
          ema9Bar ? ema9Bar.value : handleState.lastEma9,
          ema20Bar ? ema20Bar.value : handleState.lastEma20,
          ema200Bar ? ema200Bar.value : handleState.lastEma200
        );
      });
    }

    if (opts.markers && opts.markers.length) series.setMarkers(opts.markers);
    const priceLineRefs = {};
    (opts.priceLines || []).forEach((pl, i) => {
      priceLineRefs[pl.key || i] = series.createPriceLine(pl);
    });

    chart.timeScale().fitContent();
    // A ResizeObserver tied to the container (rather than a page-level
    // window "resize" listener) disposes cleanly along with everything
    // else in teardownStandardChart() -- no separate "have I already
    // attached this?" bookkeeping for callers to get wrong, which is what
    // led to trade.js's old resize-listener leak on every "Show full day"
    // rebuild.
    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => {
        try { chart.applyOptions({ width: el.clientWidth }); } catch (e) {}
        if (typeof opts.onResize === "function") { try { opts.onResize(); } catch (e) {} }
      });
      ro.observe(el);
    }
    return { chart, series, volSeries, vwapSeries, ema9Series, ema20Series, ema200Series, priceLineRefs, resizeObserver: ro, renderOverlay, handleState };
  }

  // Tears down a handle from buildStandardChart(). Callers that stash
  // extra observers on the handle (pointerRo/eodRo -- trade.js's and
  // quiz.js's pointer-repositioning and end-of-data-line observers) get
  // those disconnected here too, so there's one place that knows how to
  // fully dispose a standard chart instance rather than each caller
  // re-deriving its own teardown order.
  function teardownStandardChart(handle) {
    if (!handle) return;
    try { if (handle.resizeObserver) handle.resizeObserver.disconnect(); } catch (e) {}
    try { if (handle.pointerRo) handle.pointerRo.disconnect(); } catch (e) {}
    try { if (handle.eodRo) handle.eodRo.disconnect(); } catch (e) {}
    try { handle.chart.remove(); } catch (e) {}
  }

  window.ChartIndicators = {
    resampleBars,
    indicatorRowsHtml,
    buildTimeframeSwitcher,
    buildStandardChart,
    teardownStandardChart,
  };
})();
