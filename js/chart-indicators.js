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

  // ---- Phone / touch helpers ------------------------------------------
  // lightweight-charts' default is to capture EVERY touch that starts on
  // the canvas (vertTouchDrag), so on a phone a chart that fills most of
  // the viewport becomes a scroll trap: you swipe down to keep reading and
  // the chart pans/scales instead. On phones we hand vertical swipes back
  // to the page (horizontal drag + pinch still work on the chart), and
  // offer a fullscreen mode where the chart gets every gesture.
  // "Phone" = a narrow portrait screen OR a short touch screen (a phone
  // turned sideways is wider than 760px but only ~360-430px tall, and
  // still needs the phone chart treatment).
  const LANDSCAPE_PHONE_MQ = "(orientation: landscape) and (max-height: 500px) and (pointer: coarse)";
  function isLandscapePhone() {
    try { return window.matchMedia(LANDSCAPE_PHONE_MQ).matches; } catch (e) { return false; }
  }
  function isPhone() {
    try { return window.matchMedia("(max-width: 760px)").matches || isLandscapePhone(); } catch (e) { return window.innerWidth <= 760; }
  }
  // Same sizing buildStandardChart uses for a phone-sized chart.
  function phoneChartHeight(baseH) {
    return Math.min(baseH || 380, Math.max(260, Math.round(window.innerHeight * 0.5)));
  }
  // Option fragment for ANY createChart() call (also used by the small
  // equity / edge-analysis charts that don't go through buildStandardChart).
  //   - default: horizontal drag pans the chart, a vertical swipe goes back
  //     to the page (so a tall chart is never a scroll trap).
  //   - capture (Practice's live tape): one finger owns the chart, the page
  //     does not scroll underneath it. Pair with the .chart-touch-capture
  //     class (touch-action: none) that buildStandardChart adds.
  // Both: pinch zooms; a long press (~0.25s) drops the crosshair and
  // dragging moves it; lifting the finger clears it, so a stale crosshair
  // never freezes the OHLC/indicator readout while the tape keeps playing.
  function touchChartOpts(mode) {
    if (!isPhone()) return {};
    const exit = (window.LightweightCharts && LightweightCharts.TrackingModeExitMode &&
      LightweightCharts.TrackingModeExitMode.OnTouchEnd);
    return {
      handleScroll: { horzTouchDrag: true, vertTouchDrag: false, pressedMouseMove: true },
      handleScale: { pinch: true, axisPressedMouseMove: { time: true, price: true } },
      kineticScroll: { touch: mode !== "capture", mouse: false },
      trackingMode: { exitMode: typeof exit === "number" ? exit : 0 },
    };
  }

  // Fullscreen toggle (every screen size; drawing tools live in fullscreen --
  // see chart-draw.js). Pins the chart container over the
  // whole viewport, gives it every gesture, and resizes the chart to the
  // real viewport height (so landscape works too). A spacer holds the
  // container's place in the page so the scroll position doesn't jump.
  function attachFullscreen(el, chart, baseHeight, fsOpts) {
    fsOpts = fsOpts || {};
    // `host` is the element that actually gets pinned over the viewport. By
    // default that's the chart itself, but trade.js passes a wrapper holding
    // the candle chart AND the MACD pane under it, so the whole stack goes
    // fullscreen together instead of the MACD pane being left behind/covered.
    const host = fsOpts.host || el;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chart-fs-btn";
    btn.setAttribute("aria-label", "Expand chart to fullscreen");
    btn.textContent = "\u2922";
    el.appendChild(btn);

    // Zoom / fit / jump-to-trade buttons. Pinch-zooming a 280px chart with a
    // thumb is fiddly, so these give one-tap control (phones only; CSS hides
    // them on desktop where the wheel works).
    const zoomBar = document.createElement("div");
    zoomBar.className = "chart-zoom-tools";
    function zoomBtn(label, aria, onClick) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chart-zoom-btn";
      b.setAttribute("aria-label", aria); b.textContent = label;
      b.addEventListener("click", (e) => { e.stopPropagation(); try { onClick(); } catch (err) {} });
      zoomBar.appendChild(b);
      return b;
    }
    function zoomBy(f) {
      const ts = chart.timeScale();
      const r = ts.getVisibleLogicalRange();
      if (!r) return;
      const mid = (r.from + r.to) / 2;
      const half = ((r.to - r.from) / 2) * f;
      if (half < 2.5 && f < 1) return; // don't zoom in past ~5 bars
      ts.setVisibleLogicalRange({ from: mid - half, to: mid + half });
    }
    zoomBtn("\u2212", "Zoom out", () => zoomBy(1 / 0.6));
    zoomBtn("+", "Zoom in", () => zoomBy(0.6));
    zoomBtn("\u21BA", "Reset zoom", () => {
      if (typeof fsOpts.onResetPrice === "function") { try { fsOpts.onResetPrice(); } catch (e) {} }
      chart.priceScale("right").applyOptions({ autoScale: true });
      chart.timeScale().fitContent();
    });
    if (typeof fsOpts.onFocus === "function") zoomBtn("\u25CE", "Zoom to this trade", fsOpts.onFocus);
    el.appendChild(zoomBar);

    // Extra controls that only show while fullscreen (e.g. timeframe pills,
    // which otherwise live outside the pinned chart and become unreachable).
    const fsOnlyBar = document.createElement("div");
    fsOnlyBar.className = "chart-fs-only";
    el.appendChild(fsOnlyBar);
    let spacer = null;
    let on = false;
    let pushed = false;   // did opening fullscreen add a history entry (so Back closes it)?
    let freed = [];       // ancestors whose containing-block props we neutralised
    // position:fixed is relative to the nearest ancestor with transform /
    // filter / backdrop-filter / perspective / contain / will-change, NOT the
    // viewport. Card panels here carry backdrop-filter and a reveal animation
    // that leaves a transform behind, which pinned the "fullscreen" chart
    // inside its own card. Neutralise those on the ancestors while fullscreen
    // is open and put them back exactly afterwards.
    function freeAncestors() {
      freed = [];
      for (let a = host.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        // A running/forwards-filled transform *animation* also traps fixed
        // descendants even if an !important rule forces transform:none.
        const animated = cs.animationName && cs.animationName !== "none";
        const traps = animated ||
          (cs.transform && cs.transform !== "none") ||
          (cs.filter && cs.filter !== "none") ||
          (cs.backdropFilter && cs.backdropFilter !== "none") ||
          (cs.perspective && cs.perspective !== "none") ||
          (cs.willChange && /transform|filter|perspective|contain/.test(cs.willChange)) ||
          (cs.contain && /paint|layout|strict|content/.test(cs.contain));
        if (!traps) continue;
        let spent = false;
        try { const an = a.getAnimations(); spent = animated && an.length > 0 && an.every((x) => x.playState === "finished"); } catch (e) {}
        freed.push({ a, css: a.getAttribute("style"), spent: animated });
        if (animated) {
          // Freezing the animation at its end state: a "reveal" entrance ends at
          // opacity 1 / no transform, so pin exactly that.
          a.style.setProperty("animation", "none", "important");
          a.style.setProperty("opacity", "1", "important");
        }
        a.style.setProperty("transform", "none", "important");
        a.style.setProperty("filter", "none", "important");
        a.style.setProperty("backdrop-filter", "none", "important");
        a.style.setProperty("-webkit-backdrop-filter", "none", "important");
        a.style.setProperty("perspective", "none", "important");
        a.style.setProperty("will-change", "auto", "important");
        a.style.setProperty("contain", "none", "important");
      }
    }
    function restoreAncestors() {
      freed.forEach(({ a, css, spent }) => {
        if (css === null) a.removeAttribute("style"); else a.setAttribute("style", css);
        // A finished entrance animation would replay (flash) if restored; its
        // end state is opacity 1 / no transform, so leave that pinned.
        if (spent) {
          a.style.setProperty("animation", "none");
          a.style.setProperty("opacity", "1");
          a.style.setProperty("transform", "none");
        }
      });
      freed = [];
    }
    function fit() {
      try {
        chart.applyOptions({
          width: el.clientWidth,
          height: on ? Math.max(200, el.clientHeight || window.innerHeight) : baseHeight,
        });
        if (on) chart.timeScale().fitContent();
      } catch (e) {}
      if (typeof fsOpts.onFit === "function") { try { fsOpts.onFit(on); } catch (e) {} }
    }
    function setFs(next, fromPop) {
      if (next === on) return;
      on = next;
      if (on) {
        spacer = document.createElement("div");
        spacer.style.height = host.offsetHeight + "px";
        host.parentNode.insertBefore(spacer, host);
        freeAncestors();
        // Android/browser Back should close the chart, not leave the page.
        try { history.pushState({ chartFs: 1 }, ""); pushed = true; } catch (e) { pushed = false; }
        host.classList.add("chart-fs");
        document.documentElement.classList.add("chart-fs-lock");
        btn.textContent = "\u2715";
        btn.setAttribute("aria-label", "Close fullscreen chart");
        try { chart.applyOptions({ handleScroll: { vertTouchDrag: true } }); } catch (e) {}
        if (fsOpts.draw) { try { fsOpts.draw.setActive(true); } catch (e) {} }
      } else {
        if (fsOpts.draw) { try { fsOpts.draw.setActive(false); } catch (e) {} }
        host.classList.remove("chart-fs");
        document.documentElement.classList.remove("chart-fs-lock");
        restoreAncestors();
        if (pushed && !fromPop) { pushed = false; try { history.back(); } catch (e) {} }
        pushed = false;
        if (spacer && spacer.parentNode) spacer.parentNode.removeChild(spacer);
        spacer = null;
        btn.textContent = "\u2922";
        btn.setAttribute("aria-label", "Expand chart to fullscreen");
        try { chart.applyOptions({ handleScroll: { vertTouchDrag: false } }); } catch (e) {}
      }
      fit();
      requestAnimationFrame(fit); // viewport units settle a frame later on mobile Safari
    }
    btn.addEventListener("click", () => setFs(!on));
    const onKey = (e) => {
      if (e.key !== "Escape" || !on) return;
      // First Esc backs out of a drawing tool / selection; the next one closes fullscreen.
      if (fsOpts.draw) { try { if (fsOpts.draw.escape()) return; } catch (err) {} }
      setFs(false);
    };
    const onPop = () => { if (on) setFs(false, true); };
    const onRot = () => setTimeout(fit, 250);
    // Turning the phone sideways while this chart is on screen opens it
    // fullscreen (a 280px-tall strip is useless in landscape); turning back
    // closes it again -- but only if the rotation opened it, so a chart the
    // person opened themselves stays open.
    let autoFs = false;
    let lsMq = null;
    const onLandscape = () => {
      if (fsOpts.autoLandscape === false) return;
      if (isLandscapePhone()) {
        if (on) return;
        const r = host.getBoundingClientRect();
        const vis = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
        if (r.height > 0 && vis > r.height * 0.4 && document.documentElement.contains(host)) { autoFs = true; setFs(true); }
      } else {
        if (autoFs && on) setFs(false);
        autoFs = false;
      }
    };
    try {
      lsMq = window.matchMedia(LANDSCAPE_PHONE_MQ);
      if (lsMq.addEventListener) lsMq.addEventListener("change", onLandscape);
      else if (lsMq.addListener) lsMq.addListener(onLandscape);
    } catch (e) {}
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    window.addEventListener("orientationchange", onRot);
    return {
      fit,
      isOn: () => on,
      exit() { if (on) setFs(false); },
      addFsTool(node) { fsOnlyBar.appendChild(node); },
      dispose() {
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("popstate", onPop);
        window.removeEventListener("orientationchange", onRot);
        try {
          if (lsMq && lsMq.removeEventListener) lsMq.removeEventListener("change", onLandscape);
          else if (lsMq && lsMq.removeListener) lsMq.removeListener(onLandscape);
        } catch (e) {}
        if (on) setFs(false);
        if (btn.parentNode) btn.parentNode.removeChild(btn);
        if (zoomBar.parentNode) zoomBar.parentNode.removeChild(zoomBar);
        if (fsOnlyBar.parentNode) fsOnlyBar.parentNode.removeChild(fsOnlyBar);
      },
    };
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
      btn.dataset.minutes = String(minutes);
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

  // Keeps every timeframe switcher on the page (the inline one and the one
  // inside fullscreen) showing the same active interval.
  function syncTimeframeSwitchers(minutes) {
    document.querySelectorAll(".tf-switcher .tf-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.minutes === String(minutes));
    });
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

    const ct = window.chartThemeColors ? window.chartThemeColors() : { text: "#8b98a5", grid: "#1c2127", border: "#232830" };
    // On a phone the 88-92px price-scale gutter eats ~25% of a 360-390px
    // screen, and a fixed 380-420px canvas is most of the viewport height.
    const phone = isPhone();
    const minW = phone ? Math.min(opts.minimumWidth || 88, 60) : (opts.minimumWidth || 88);
    const baseH = opts.height || 380;
    const chartH = phone ? phoneChartHeight(baseH) : baseH;
    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: ct.text, fontSize: phone ? 10 : 12 },
      grid: { vertLines: { color: ct.grid }, horzLines: { color: ct.grid } },
      rightPriceScale: { borderColor: ct.border, minimumWidth: minW },
      timeScale: { borderColor: ct.border, timeVisible: true, secondsVisible: false, rightOffset: phone ? 3 : 0 },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      ...touchChartOpts(opts.touchMode),
    };
    // Pin the container to the height the chart is actually created at. On
    // phones chartH is ~half the screen but CSS capped the container at 280px,
    // so the canvas overflowed and its bottom (time axis) was covered by the
    // pane underneath.
    el.style.height = chartH + "px";
    if (phone) {
      // Long-press must not open the browser's text-selection / image menu.
      el.classList.add("chart-touch");
      if (opts.touchMode === "capture") el.classList.add("chart-touch-capture");
      el.addEventListener("contextmenu", (e) => e.preventDefault());
    }
    const chart = LightweightCharts.createChart(el, { ...commonOpts, width: el.clientWidth, height: chartH });
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

    // ---- Vertical (price) zoom ------------------------------------------
    // The mouse wheel only zoomed time, and dragging the thin price axis was
    // the only way to scale price. Wheel over the price axis now zooms the
    // price range around the cursor; double-click the axis to auto-fit again.
    // Implemented as an autoscale override so the library keeps owning the
    // scale (drag-pan, axis drag and pinch all still work and take over).
    const priceZoom = { manual: null, margins: null };
    series.applyOptions({
      autoscaleInfoProvider: (orig) => {
        const r = orig();
        if (!priceZoom.manual) return r;
        return { priceRange: { minValue: priceZoom.manual.min, maxValue: priceZoom.manual.max }, margins: { above: 0, below: 0 } };
      },
    });
    function resetPriceZoom() {
      if (!priceZoom.manual) return;
      priceZoom.manual = null;
      if (priceZoom.margins) chart.priceScale("right").applyOptions({ scaleMargins: priceZoom.margins });
      series.applyOptions({});
    }
    function inPriceAxis(e) {
      const rect = el.getBoundingClientRect();
      const axisW = chart.priceScale("right").width() || minW;
      return e.clientX >= rect.right - axisW - 2 && e.clientX <= rect.right;
    }
    // Zoom the price range by factor f (<1 zooms in) around the pane-relative
    // y (defaults to the middle). Shared by wheel, buttons and two-finger pinch.
    function zoomPriceBy(f, y) {
      const rect = el.getBoundingClientRect();
      const paneH = rect.height - (chart.timeScale().height() || 0);
      const top = series.coordinateToPrice(0), bot = series.coordinateToPrice(paneH);
      const at = series.coordinateToPrice(Math.max(0, Math.min(paneH, y == null ? paneH / 2 : y)));
      if (top == null || bot == null || at == null || top === bot) return false;
      const hi = Math.max(top, bot), lo = Math.min(top, bot);
      const nHi = at + (hi - at) * f, nLo = at - (at - lo) * f;
      if (!(nHi - nLo > 1e-9)) return false;
      if (!priceZoom.manual) {
        priceZoom.margins = { top: (opts.priceScaleMargins || { top: 0.12 }).top, bottom: (opts.priceScaleMargins || { bottom: 0.2 }).bottom };
        chart.priceScale("right").applyOptions({ scaleMargins: { top: 0, bottom: 0 } });
      }
      priceZoom.manual = { min: nLo, max: nHi };
      chart.priceScale("right").applyOptions({ autoScale: true });
      series.applyOptions({});
      return true;
    }
    el.addEventListener("wheel", (e) => {
      if (!inPriceAxis(e)) return;
      e.preventDefault(); e.stopPropagation();
      const f = Math.pow(1.0015, Math.max(-200, Math.min(200, e.deltaY))); // scroll up = zoom in
      zoomPriceBy(f, e.clientY - el.getBoundingClientRect().top);
    }, { passive: false, capture: true });
    // Swipe on the price axis (right-hand strip): one finger up = zoom price in,
    // down = zoom out. Mirrors dragging the axis with a mouse; works on phones.
    (function () {
      let sw = null;
      const axisHit = (t) => { const r = el.getBoundingClientRect(); const w = (chart.priceScale("right").width() || minW) + 14; return t.clientX >= r.right - w && t.clientX <= r.right; };
      el.addEventListener("touchstart", (e) => {
        if (e.touches.length === 1 && axisHit(e.touches[0])) {
          sw = { y: e.touches[0].clientY };
          e.preventDefault(); e.stopImmediatePropagation();
        } else sw = null;
      }, { passive: false, capture: true });
      el.addEventListener("touchmove", (e) => {
        if (!sw) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.touches.length !== 1) return;
        const y = e.touches[0].clientY, dy = y - sw.y;
        sw.y = y;
        if (dy) zoomPriceBy(Math.exp(dy * 0.012), (el.clientHeight - (chart.timeScale().height() || 0)) / 2);
      }, { passive: false, capture: true });
      const end = (e) => { if (sw) { e.stopImmediatePropagation(); sw = null; } };
      el.addEventListener("touchend", end, { capture: true });
      el.addEventListener("touchcancel", end, { capture: true });
    })();
    // Two-finger pinch: a mostly-VERTICAL pinch zooms price (the library's own
    // pinch only ever scales time). Decided once at touch start; a horizontal
    // pinch is left to the library untouched.
    (function () {
      let pv = null; // { dist, mid } while a vertical pinch is active
      const two = (t) => ({ dx: Math.abs(t[0].clientX - t[1].clientX), dy: Math.abs(t[0].clientY - t[1].clientY), my: (t[0].clientY + t[1].clientY) / 2 });
      el.addEventListener("touchstart", (e) => {
        if (e.touches.length !== 2) { pv = null; return; }
        const m = two(e.touches);
        if (m.dy > m.dx * 1.2 && m.dy > 24) {
          pv = { dist: m.dy };
          e.preventDefault(); e.stopImmediatePropagation();
        } else pv = null;
      }, { passive: false, capture: true });
      el.addEventListener("touchmove", (e) => {
        if (!pv) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.touches.length !== 2) return;
        const m = two(e.touches);
        if (m.dy < 8) return;
        zoomPriceBy(pv.dist / m.dy, m.my - el.getBoundingClientRect().top); // fingers apart -> zoom in
        pv.dist = m.dy;
      }, { passive: false, capture: true });
      const end = (e) => { if (pv) { e.stopImmediatePropagation(); if (e.touches.length < 2) pv = null; } };
      el.addEventListener("touchend", end, { capture: true });
      el.addEventListener("touchcancel", end, { capture: true });
    })();
    el.addEventListener("dblclick", (e) => { if (inPriceAxis(e)) { resetPriceZoom(); chart.priceScale("right").applyOptions({ autoScale: true }); } });

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
    // Fullscreen + drawing tools on every screen size (fullscreen used to be
    // phone-only). The draw layer is created first so fullscreen can hand it
    // Esc / open / close; it asks `fs` lazily whether fullscreen is on.
    let fs = null;
    const draw = (opts.fullscreen !== false && window.ChartDraw)
      ? window.ChartDraw.attach({ chart, series, el, drawKey: opts.drawKey, isFs: () => !!(fs && fs.isOn()) })
      : null;
    fs = (opts.fullscreen !== false) ? attachFullscreen(el, chart, chartH, {
      host: opts.fullscreenHost, onFit: opts.onFullscreenFit, onResetPrice: resetPriceZoom, onFocus: opts.onFocus,
      autoLandscape: opts.autoLandscape, draw,
    }) : null;
    // A ResizeObserver tied to the container (rather than a page-level
    // window "resize" listener) disposes cleanly along with everything
    // else in teardownStandardChart() -- no separate "have I already
    // attached this?" bookkeeping for callers to get wrong, which is what
    // led to trade.js's old resize-listener leak on every "Show full day"
    // rebuild.
    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => {
        try {
          if (fs && fs.isOn()) fs.fit();
          else chart.applyOptions({ width: el.clientWidth });
        } catch (e) {}
        if (typeof opts.onResize === "function") { try { opts.onResize(); } catch (e) {} }
      });
      ro.observe(el);
    }
    return { chart, series, volSeries, vwapSeries, ema9Series, ema20Series, ema200Series, priceLineRefs, resizeObserver: ro, renderOverlay, handleState, fullscreen: fs, draw };
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
    try { if (handle.fullscreen) handle.fullscreen.dispose(); } catch (e) {}
    try { if (handle.draw) handle.draw.dispose(); } catch (e) {}
    try { handle.chart.remove(); } catch (e) {}
  }

  window.ChartIndicators = {
    resampleBars,
    indicatorRowsHtml,
    buildTimeframeSwitcher,
    syncTimeframeSwitchers,
    buildStandardChart,
    teardownStandardChart,
    isPhone,
    isLandscapePhone,
    phoneChartHeight,
    touchChartOpts,
  };
})();
