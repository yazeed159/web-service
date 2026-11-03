(function () {
  "use strict";
  const R = (window.RewindKit = window.RewindKit || {});

  // ---------------------------------------------------------------
  // chart building — a slimmed-down version of trade.js's chart, since
  // the quiz only needs candles + volume + VWAP/EMA overlays, cropped
  // to whatever the current stage should reveal.
  // ---------------------------------------------------------------
  // A touch shorter on narrow phones so the chart doesn't eat the whole
  // screen before you've even reached the prompt/buttons below it --
  // still tall enough to read candle shapes, just not the full desktop
  // height. Checked at build time only (not on resize/rotate).
  function mobileChartHeight(base) {
    return window.innerWidth <= 480 ? Math.round(base * 0.8) : base;
  }
  function buildChart(el, bars, opts) {
    opts = opts || {};
    // Keep the library's built-in dashed "last value" price line on by
    // default -- it's what tracks the moving price live as ticks print
    // (matching practice.js), turning amber while a bar is forming since
    // that's the bar's own borderColor at that moment. opts.priceLines
    // (entry/stop/etc.) are separate, fixed-price lines and don't
    // conflict. The post-round recap chart passes showLastValueLine:
    // false, though -- there are no more forming ticks by then, so this
    // would just be a stray, unlabeled line sitting on the last bar's
    // close with no explanation, on top of the real entry/exit/stop
    // lines that already say what matters.
    return window.ChartIndicators.buildStandardChart(el, bars, {
      ...opts,
      height: mobileChartHeight(opts.height || 380),
    });
  }
  // teardownChart() now in utils.js (loads first on every page).

  // Pushes a bar's final OHLC/volume/overlay values onto an already-built
  // chart in place -- used when a watch-stage bar finishes playing so the
  // just-completed candle switches from the orange "forming" look to its
  // normal closed color without tearing down and rebuilding the chart
  // (which is what used to reset the view every ~4.5s).
  function finalizeBarOnChart(chartHandle, bar) {
    if (!chartHandle) return;
    const t = toUnix(bar.t);
    try {
      chartHandle.series.update({ time: t, open: bar.o, high: bar.h, low: bar.l, close: bar.c });
      if (chartHandle.volSeries) {
        chartHandle.volSeries.update({ time: t, value: bar.v, color: bar.c >= bar.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" });
      }
      if (bar.vwap != null && chartHandle.vwapSeries) chartHandle.vwapSeries.update({ time: t, value: bar.vwap });
      if (bar.ema9 != null && chartHandle.ema9Series) chartHandle.ema9Series.update({ time: t, value: bar.ema9 });
      if (bar.ema20 != null && chartHandle.ema20Series) chartHandle.ema20Series.update({ time: t, value: bar.ema20 });
      if (bar.ema200 != null && chartHandle.ema200Series) chartHandle.ema200Series.update({ time: t, value: bar.ema200 });
      if (chartHandle.handleState) {
        chartHandle.handleState.lastVol = bar.v;
        chartHandle.handleState.lastVwap = bar.vwap;
        chartHandle.handleState.lastEma9 = bar.ema9;
        chartHandle.handleState.lastEma20 = bar.ema20;
        chartHandle.handleState.lastEma200 = bar.ema200;
        if (chartHandle.renderOverlay) chartHandle.renderOverlay(bar.v, bar.c >= bar.o ? "up" : "down", bar.vwap, bar.ema9, bar.ema20, bar.ema200);
      }
    } catch (e) { /* chart already torn down */ }
  }

  // Vertical marker pinned to the last bar we actually have data for, so
  // during bar-by-bar playback it's obvious how much chart is left instead
  // of only finding out once the question ends.
  function attachEndOfDataLine(container, chartHandle, endTime) {
    const { chart } = chartHandle;
    container.style.position = container.style.position || "relative";
    const line = document.createElement("div");
    line.className = "quiz-eod-line";
    line.innerHTML = `<span class="quiz-eod-label">End of data</span>`;
    container.appendChild(line);
    function reposition() {
      try {
        const x = chart.timeScale().timeToCoordinate(endTime);
        if (x == null) { line.style.display = "none"; return; }
        line.style.display = "block";
        line.style.left = `${x}px`;
      } catch (e) { line.style.display = "none"; }
    }
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(reposition); ro.observe(container); }
    chart.timeScale().subscribeVisibleLogicalRangeChange(reposition);
    reposition();
    requestAnimationFrame(reposition);
    setTimeout(reposition, 0);
    chartHandle.eodRo = ro;
  }

  // ---------------------------------------------------------------
  // exact-price pointer triangles -- the same look used on trade.html,
  // instead of lightweight-charts' native markers (which snap to a fixed
  // offset above/below the candle's own high/low, not the exact fill
  // price). A pointer's tip sits exactly where its price line is, so
  // there's only ever one thing marking a given price.
  //
  // Each pointer also owns a hover/tap tooltip with the exact price --
  // same behavior as trade.html. The tooltip is appended to `container`
  // directly rather than the (clipped) overlay, so it's never cut off at
  // the chart's edge.
  // ---------------------------------------------------------------
  const POINTER_H = 9;
  function attachPointers(container, chartHandle, pointerDefs) {
    const { chart, series } = chartHandle;
    container.style.position = "relative";
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:2;";
    container.appendChild(overlay);

    const pointers = pointerDefs.map((p) => {
      const el = document.createElement("div");
      el.style.cssText = `
        position:absolute; width:0; height:0; pointer-events:auto;
        border-left:6px solid transparent; border-right:6px solid transparent;
        filter: drop-shadow(0 0 1.5px #0b0d10) drop-shadow(0 0 1.5px #0b0d10);
        border-top:${p.above ? `${POINTER_H}px solid ${p.color}` : "0"};
        border-bottom:${p.above ? "0" : `${POINTER_H}px solid ${p.color}`};
      `;
      overlay.appendChild(el);

      let tooltip = null;
      if (p.tooltip) {
        tooltip = document.createElement("div");
        tooltip.className = "pointer-tooltip";
        tooltip.dataset.open = "0";
        tooltip.style.cssText = `
          position:absolute; display:none; width:180px; max-width:60vw;
          background:#181b22; border:1px solid ${p.color}; border-radius:8px;
          padding:8px 10px; font-size:12px; line-height:1.5; color:#eceef2;
          box-shadow:0 6px 20px rgba(0,0,0,.45); z-index:5; pointer-events:none;
        `;
        tooltip.textContent = p.tooltip;
        container.appendChild(tooltip);

        const openTooltip = () => {
          container.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
          tooltip.dataset.open = "1";
          tooltip.style.display = "block";
          reposition();
        };
        const closeTooltip = () => { tooltip.dataset.open = "0"; tooltip.style.display = "none"; };
        el.addEventListener("mouseenter", openTooltip);
        el.addEventListener("mouseleave", closeTooltip);
        // Tap-to-toggle so touch users (no mouseenter) can still reach it.
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (tooltip.dataset.open === "1") closeTooltip(); else openTooltip();
        });
      }

      return { ...p, el, tooltip };
    });

    // When two pointers land on (near enough) the same bar and price --
    // e.g. your test entry filled at the exact same price/bar as the real
    // entry, which happens on almost every "perfect fill" -- they'd stack
    // exactly on top of each other, and whichever was appended last would
    // fully cover (and block hover/tap on) the one underneath.
    //
    // Used to fan colliding pointers out sideways (offsetX), but that
    // shifts the marker's X position away from the bar it's actually
    // pinned to -- at a normal zoom level a candle is only a few pixels
    // wide, so even one collision could push a pointer onto a neighboring
    // candle entirely, which read as the pointer being "bugged" and
    // floating off to the side. Stacking vertically instead (offsetY, in
    // the same above/below direction the pointer already points) keeps X
    // exactly pinned to the correct bar always -- collisions just stack
    // like a small ladder further from the candle, never sideways from it.
    const CLUSTER_PX = 10;
    const FAN_PX = 14;
    function reposition() {
      try {
        const computed = pointers.map((p) => ({
          p,
          x: chart.timeScale().timeToCoordinate(p.time),
          y: series.priceToCoordinate(p.price),
        }));
        const placed = [];
        computed.forEach((item) => {
          if (item.x == null || item.y == null) { item.offsetY = 0; return; }
          const mates = placed.filter((u) => u.p.above === item.p.above && Math.abs(u.x - item.x) < CLUSTER_PX && Math.abs(u.y - item.y) < CLUSTER_PX);
          item.offsetY = mates.length * FAN_PX;
          placed.push(item);
        });
        computed.forEach(({ p, x, y, offsetY }) => {
          if (x == null || y == null) {
            p.el.style.display = "none";
            if (p.tooltip) { p.tooltip.style.display = "none"; p.tooltip.dataset.open = "0"; }
            return;
          }
          p.el.style.display = "block";
          p.el.style.left = `${x}px`;
          const stackedY = p.above ? y - (offsetY || 0) : y + (offsetY || 0);
          const pointerTop = p.above ? stackedY - POINTER_H : stackedY;
          p.el.style.top = `${pointerTop}px`;
          p.el.style.transform = "translateX(-50%)";
          if (p.tooltip && p.tooltip.dataset.open === "1") {
            p.tooltip.style.left = `${x + 8}px`;
            p.tooltip.style.top = `${p.above ? pointerTop - 8 : pointerTop + POINTER_H + 8}px`;
            p.tooltip.style.transform = p.above ? "translateY(-100%)" : "none";
          }
        });
      } catch (e) { /* chart already torn down */ }
    }

    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(reposition); ro.observe(container); }
    chart.timeScale().subscribeVisibleLogicalRangeChange(reposition);
    reposition();
    requestAnimationFrame(reposition);
    setTimeout(reposition, 0);
    chartHandle.pointerRo = ro;
  }

  // Any click outside a pointer tooltip closes whichever one is pinned
  // open -- otherwise a tapped-open tooltip would just sit there covering
  // the chart. Registered once here (not inside attachPointers) so it
  // doesn't pile up a duplicate listener on every question.
  document.addEventListener("click", () => {
    document.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
  });
  Object.assign(R, { attachEndOfDataLine, attachPointers, buildChart, finalizeBarOnChart });
})();
