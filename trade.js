(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const content = document.getElementById("trade-content");

  if (!id) {
    content.innerHTML = `<div class="loading-line">no trade id in the URL — go back and pick one from the table.</div>`;
  } else {
    fetch(`data/trades/${encodeURIComponent(id)}.json`)
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(renderTrade)
      .catch((err) => {
        content.innerHTML = `<div class="loading-line">couldn't load this trade (${escapeHtml(String(err.message))}).</div>`;
      });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtPct(v) {
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }
  function toUnix(t) {
    // "YYYY-MM-DDTHH:MM:SS" naive local -> treat as-is (bars are already in ET wall-clock)
    return Math.floor(new Date(t.replace(" ", "T") + "").getTime() / 1000);
  }

  function renderTrade(trade) {
    document.title = `${trade.symbol} — trade.log`;
    const win = trade.win;

    content.innerHTML = `
      <div class="trade-head">
        <h1>
          ${trade.symbol}
          <span class="verdict-badge ${win ? "up" : "down"}">${win ? "WIN" : "LOSS"} · ${fmtPct(trade.pnl_pct)}</span>
        </h1>
        <div class="trade-meta">
          ${trade.trade_date} &nbsp;·&nbsp; entry ${trade.entry_time} @ $${trade.entry_price.toFixed(2)}
          &nbsp;→&nbsp; exit ${trade.exit_time} @ $${trade.exit_price.toFixed(2)}
        </div>
      </div>

      <div class="chart-panel">
        <div class="chart-toolbar">
          <div class="legend">
            <span class="legend-item"><span class="legend-swatch" style="background:#ffb648"></span>VWAP</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#9aa8a1"></span>EMA9</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#4fd7d0"></span>EMA20</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#33e08a"></span>entry</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#ff5f5f"></span>exit</span>
          </div>
          <div>scroll to zoom · drag to pan</div>
        </div>
        <div id="candle-chart"></div>
        <div id="macd-chart"></div>
      </div>

      <div class="detail-grid">
        <div class="card">
          <h2>verdict</h2>
          <div class="verdict-text">${escapeHtml(trade.verdict || "No verdict recorded.")}</div>
        </div>
        <div class="card">
          <h2>indicators at entry</h2>
          <div class="indicator-grid">
            ${indicatorRow("VWAP", trade.indicators.vwap_at_entry, trade.indicators.entry_vs_vwap)}
            ${indicatorRow("EMA9", trade.indicators.ema9_at_entry, trade.indicators.entry_vs_ema9)}
            ${indicatorRow("EMA20", trade.indicators.ema20_at_entry, trade.indicators.entry_vs_ema20)}
            ${indicatorRow("MACD", trade.indicators.macd_at_entry)}
            ${indicatorRow("Signal", trade.indicators.macd_signal_at_entry)}
            ${indicatorRow("Hist", trade.indicators.macd_hist_at_entry)}
          </div>
        </div>
      </div>
    `;

    buildCharts(trade);
  }

  function indicatorRow(label, value, rel) {
    const relTxt = rel ? `<span class="${rel === "above" ? "up" : "down"}">${rel}</span>` : "";
    return `<div class="indicator-row"><span class="k">${label}</span><span class="mono">$${Number(value).toFixed(2)} ${relTxt}</span></div>`;
  }

  function buildCharts(trade) {
    const bars = trade.bars;
    const candleData = bars.map((b) => ({ time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c }));
    const volData = bars.map((b) => ({ time: toUnix(b.t), value: b.v, color: b.c >= b.o ? "rgba(51,224,138,0.45)" : "rgba(255,95,95,0.45)" }));
    const vwapData = bars.map((b) => ({ time: toUnix(b.t), value: b.vwap }));
    const ema9Data = bars.map((b) => ({ time: toUnix(b.t), value: b.ema9 }));
    const ema20Data = bars.map((b) => ({ time: toUnix(b.t), value: b.ema20 }));
    const macdData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd }));
    const signalData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd_signal }));
    const histData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd_hist, color: b.macd_hist >= 0 ? "rgba(51,224,138,0.6)" : "rgba(255,95,95,0.6)" }));

    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: "#7d938a", fontFamily: "IBM Plex Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: "#1a2521" }, horzLines: { color: "#1a2521" } },
      rightPriceScale: { borderColor: "#23342c" },
      timeScale: { borderColor: "#23342c", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };

    const candleEl = document.getElementById("candle-chart");
    const candleChart = LightweightCharts.createChart(candleEl, {
      ...commonOpts,
      width: candleEl.clientWidth,
      height: 420,
    });

    const candleSeries = candleChart.addCandlestickSeries({
      upColor: "#33e08a", downColor: "#ff5f5f", borderVisible: false,
      wickUpColor: "#33e08a", wickDownColor: "#ff5f5f",
    });
    candleSeries.setData(candleData);

    const volSeries = candleChart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    candleChart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(volData);

    const vwapSeries = candleChart.addLineSeries({ color: "#ffb648", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    vwapSeries.setData(vwapData);
    const ema9Series = candleChart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ema9Series.setData(ema9Data);
    const ema20Series = candleChart.addLineSeries({ color: "#4fd7d0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ema20Series.setData(ema20Data);

    candleSeries.setMarkers([
      { time: toUnix(`${trade.trade_date} ${trade.entry_time}`), position: "belowBar", color: "#33e08a", shape: "arrowUp", text: `ENTRY $${trade.entry_price.toFixed(2)}` },
      { time: toUnix(`${trade.trade_date} ${trade.exit_time}`), position: "aboveBar", color: "#ff5f5f", shape: "arrowDown", text: `EXIT $${trade.exit_price.toFixed(2)}` },
    ]);

    const macdEl = document.getElementById("macd-chart");
    const macdChart = LightweightCharts.createChart(macdEl, {
      ...commonOpts,
      width: macdEl.clientWidth,
      height: 110,
      timeScale: { ...commonOpts.timeScale, visible: true },
    });
    const histSeries = macdChart.addHistogramSeries({ priceFormat: { type: "price", precision: 3 } });
    histSeries.setData(histData);
    const macdSeries = macdChart.addLineSeries({ color: "#4fd7d0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    macdSeries.setData(macdData);
    const signalSeries = macdChart.addLineSeries({ color: "#ffb648", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    signalSeries.setData(signalData);

    // Sync the two time scales so panning/zooming the price chart moves MACD with it.
    candleChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) macdChart.timeScale().setVisibleLogicalRange(range);
    });
    macdChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (range) candleChart.timeScale().setVisibleLogicalRange(range);
    });

    candleChart.timeScale().fitContent();
    macdChart.timeScale().fitContent();

    window.addEventListener("resize", () => {
      candleChart.applyOptions({ width: candleEl.clientWidth });
      macdChart.applyOptions({ width: macdEl.clientWidth });
    });
  }

  // ---------- Clock ----------
  function tickClock() {
    const now = new Date();
    const et = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    }).format(now);
    const el = document.getElementById("clock");
    if (el) el.textContent = et + " ET";
  }
  tickClock();
  setInterval(tickClock, 1000);
})();
