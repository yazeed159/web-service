(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const content = document.getElementById("trade-content");

  if (!id) {
    content.innerHTML = `<div class="empty-state">No trade id in the URL — go back and pick one from the journal.</div>`;
  } else {
    fetch(`data/trades/${encodeURIComponent(id)}.json`)
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(renderTrade)
      .catch((err) => {
        content.innerHTML = `
          <div class="empty-state">
            Couldn't load this trade (${escapeHtml(String(err.message))}).<br>
            <span style="font-size:12.5px">Expected a file at <code>data/trades/${escapeHtml(id)}.json</code> — if the pipeline's publish step for this trade hasn't run successfully yet, that file won't exist.</span>
          </div>`;
      });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMoney(v) {
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toFixed(2);
  }
  function toUnix(t) {
    return Math.floor(new Date(t.replace(" ", "T") + "").getTime() / 1000);
  }

  function renderTrade(trade) {
    document.title = `${trade.symbol} — trade.log`;
    const win = trade.win;

    content.innerHTML = `
      <div class="trade-head">
        <h1>
          ${trade.symbol}
          <span class="verdict-badge ${win ? "up" : "down"}">${win ? "WIN" : "LOSS"} · ${fmtMoney(trade.pnl_after_comm)}</span>
        </h1>
        <div class="trade-meta">
          ${trade.trade_date} &nbsp;·&nbsp; entry ${trade.entry_time} @ $${trade.entry_price.toFixed(2)}
          &nbsp;→&nbsp; exit ${trade.exit_time} @ $${trade.exit_price.toFixed(2)}
          &nbsp;·&nbsp; ${trade.shares} sh &nbsp;·&nbsp; held ${trade.time_in_trade || "—"}
        </div>
      </div>

      <div class="pnl-breakdown">
        <div class="cell">
          <div class="label">Gross P&amp;L</div>
          <div class="value ${trade.pnl_before_comm >= 0 ? "up" : "down"}">${fmtMoney(trade.pnl_before_comm)}</div>
        </div>
        <div class="cell">
          <div class="label">Commission</div>
          <div class="value">-$${trade.commission.toFixed(2)}</div>
        </div>
        <div class="cell">
          <div class="label">Net P&amp;L</div>
          <div class="value ${trade.pnl_after_comm >= 0 ? "up" : "down"}">${fmtMoney(trade.pnl_after_comm)}</div>
        </div>
      </div>

      <div class="chart-panel">
        <div class="chart-toolbar">
          <div class="legend">
            <span class="legend-item"><span class="legend-swatch" style="background:#e8a94c"></span>VWAP</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#9aa8a1"></span>EMA9</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#5b93f0"></span>EMA20</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#2fd08a"></span>entry</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#f2555a"></span>exit</span>
          </div>
          <div>Scroll to zoom · drag to pan</div>
        </div>
        <div id="candle-chart"></div>
        <div id="macd-chart"></div>
      </div>

      <div class="detail-grid">
        <div class="card">
          <h2>Verdict</h2>
          <div class="verdict-text">${escapeHtml(trade.verdict || "No verdict recorded.")}</div>
          ${trade.setup_type ? `<span class="setup-tag">${escapeHtml(trade.setup_type)}</span>` : ""}
        </div>
        <div class="card">
          <h2>Indicators at entry</h2>
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
    const relTxt = rel ? ` <span class="${rel === "above" ? "up" : "down"}">${rel}</span>` : "";
    return `<div class="indicator-row"><span class="k">${label}</span><span class="v">$${Number(value).toFixed(2)}${relTxt}</span></div>`;
  }

  function buildCharts(trade) {
    const bars = trade.bars;
    const candleData = bars.map((b) => ({ time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c }));
    const volData = bars.map((b) => ({ time: toUnix(b.t), value: b.v, color: b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" }));
    const vwapData = bars.map((b) => ({ time: toUnix(b.t), value: b.vwap }));
    const ema9Data = bars.map((b) => ({ time: toUnix(b.t), value: b.ema9 }));
    const ema20Data = bars.map((b) => ({ time: toUnix(b.t), value: b.ema20 }));
    const macdData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd }));
    const signalData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd_signal }));
    const histData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd_hist, color: b.macd_hist >= 0 ? "rgba(47,208,138,0.55)" : "rgba(242,85,90,0.55)" }));

    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: "#8b92a0", fontFamily: "IBM Plex Mono, monospace", fontSize: 11 },
      grid: { vertLines: { color: "#1a1e24" }, horzLines: { color: "#1a1e24" } },
      rightPriceScale: { borderColor: "#232830" },
      timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };

    const candleEl = document.getElementById("candle-chart");
    const candleChart = LightweightCharts.createChart(candleEl, { ...commonOpts, width: candleEl.clientWidth, height: 420 });

    const candleSeries = candleChart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
    });
    candleSeries.setData(candleData);

    const volSeries = candleChart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    candleChart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(volData);

    candleChart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(vwapData);
    candleChart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema9Data);
    candleChart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema20Data);

    candleSeries.setMarkers([
      { time: toUnix(`${trade.trade_date} ${trade.entry_time}`), position: "inBar", color: "#2fd08a", shape: "circle", size: 0.55 },
      { time: toUnix(`${trade.trade_date} ${trade.exit_time}`), position: "inBar", color: "#f2555a", shape: "circle", size: 0.55 },
    ]);

    // Markers alone only anchor to a bar, not an exact price -- add dashed
    // price lines at the literal entry/exit fill so they read precisely,
    // not just "somewhere near that candle."
    candleSeries.createPriceLine({
      price: trade.entry_price,
      color: "#2fd08a",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: "entry",
    });
    candleSeries.createPriceLine({
      price: trade.exit_price,
      color: "#f2555a",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: "exit",
    });

    const macdEl = document.getElementById("macd-chart");
    const macdChart = LightweightCharts.createChart(macdEl, { ...commonOpts, width: macdEl.clientWidth, height: 110 });
    macdChart.addHistogramSeries({ priceFormat: { type: "price", precision: 3 } }).setData(histData);
    macdChart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(macdData);
    macdChart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(signalData);

    candleChart.timeScale().subscribeVisibleLogicalRangeChange((range) => { if (range) macdChart.timeScale().setVisibleLogicalRange(range); });
    macdChart.timeScale().subscribeVisibleLogicalRangeChange((range) => { if (range) candleChart.timeScale().setVisibleLogicalRange(range); });

    candleChart.timeScale().fitContent();
    macdChart.timeScale().fitContent();

    window.addEventListener("resize", () => {
      candleChart.applyOptions({ width: candleEl.clientWidth });
      macdChart.applyOptions({ width: macdEl.clientWidth });
    });
  }
})();
