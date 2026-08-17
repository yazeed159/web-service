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
            <span class="legend-item"><span class="legend-swatch" style="background:#22d3ee"></span>better entry</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#f472b6"></span>better exit</span>
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
          ${rrStrip(trade)}
          ${trade.walk_away_rule ? `<div class="walk-away"><b>Walk-away rule:</b> ${escapeHtml(trade.walk_away_rule)}</div>` : ""}
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

        <div class="card better-card">
          <h2>What you should've done</h2>
          ${betterRow("Entry", trade.better_entry)}
          ${betterRow("Exit", trade.better_exit)}
          ${!trade.better_entry && !trade.better_exit ? `<div class="no-better">No better entry/exit flagged — this trade lined up with the plan.</div>` : ""}
        </div>

        <div class="card">
          <h2>Lessons from this trade</h2>
          ${Array.isArray(trade.lessons) && trade.lessons.length
            ? `<ul class="lessons-list">${trade.lessons.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
            : `<div class="no-better">No lessons recorded for this trade.</div>`}
        </div>

        ${trade.symbol_info && (trade.symbol_info.name || trade.symbol_info.description) ? `
        <div class="card symbol-card" style="grid-column: 1 / -1;">
          <h2>About ${escapeHtml(trade.symbol)}</h2>
          <div class="sym-head"><span class="sym-name">${escapeHtml(trade.symbol_info.name || trade.symbol)}</span></div>
          <div class="sym-meta-row">
            ${trade.symbol_info.country ? `<span class="pill">${escapeHtml(trade.symbol_info.country)}</span>` : ""}
            ${trade.symbol_info.sector ? `<span class="pill">${escapeHtml(trade.symbol_info.sector)}</span>` : ""}
          </div>
          <div class="sym-desc">${escapeHtml(trade.symbol_info.description || "")}</div>
        </div>` : ""}
      </div>
    `;

    buildCharts(trade);
  }

  function rrStrip(trade) {
    if (!trade.suggested_stop && !trade.suggested_target && !trade.risk_reward) return "";
    return `<div class="rr-strip">
      ${trade.suggested_stop ? `<span><span class="k">Stop</span><span class="v down">$${Number(trade.suggested_stop).toFixed(2)}</span></span>` : ""}
      ${trade.suggested_target ? `<span><span class="k">Target</span><span class="v up">$${Number(trade.suggested_target).toFixed(2)}</span></span>` : ""}
      ${trade.risk_reward ? `<span><span class="k">R:R</span><span class="v">${escapeHtml(trade.risk_reward)}</span></span>` : ""}
    </div>`;
  }

  function betterRow(label, b) {
    if (!b || !b.price) return "";
    return `<div class="better-row">
      <div class="tag">${label.toUpperCase()}</div>
      <div class="content">
        <div class="price-line">$${Number(b.price).toFixed(2)}${b.time ? ` @ ${escapeHtml(String(b.time).split("T").pop())}` : ""}</div>
        <div class="reason">${escapeHtml(b.reason || "")}</div>
      </div>
    </div>`;
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

    // Find the candle a marker's timestamp falls on (nearest by time), so we
    // can compare the fill price against THAT candle's actual high/low
    // instead of guessing position from the role (entry vs exit).
    function barAt(unixTime) {
      let best = bars[0], bestDiff = Infinity;
      for (const b of bars) {
        const diff = Math.abs(toUnix(b.t) - unixTime);
        if (diff < bestDiff) { best = b; bestDiff = diff; }
      }
      return best;
    }

    // Precise placement: if the fill sits in the upper half of its candle's
    // high/low range, the marker goes ABOVE the candle with the arrow
    // pointing down onto the price; if it's in the lower half, the marker
    // goes BELOW with the arrow pointing up onto the price. This is
    // independent of whether it's an entry or an exit -- a high entry gets
    // an above-candle arrow, a low entry gets a below-candle arrow, and the
    // same logic applies to exits and the better-entry/exit markers.
    function placement(price, bar) {
      const mid = (bar.h + bar.l) / 2;
      return price >= mid
        ? { position: "aboveBar", shape: "arrowDown" }
        : { position: "belowBar", shape: "arrowUp" };
    }

    function buildMarker(time, price, color, text) {
      return { time, color, size: 0.55, text, ...placement(price, barAt(time)) };
    }

    const markers = [
      buildMarker(toUnix(`${trade.trade_date} ${trade.entry_time}`), trade.entry_price, "#2fd08a", "ENTRY"),
      buildMarker(toUnix(`${trade.trade_date} ${trade.exit_time}`), trade.exit_price, "#f2555a", "EXIT"),
    ];
    if (trade.better_entry && trade.better_entry.price && trade.better_entry.time) {
      const t = toUnix(trade.better_entry.time.replace("T", " "));
      markers.push(buildMarker(t, trade.better_entry.price, "#22d3ee", "BETTER ENTRY"));
    }
    if (trade.better_exit && trade.better_exit.price && trade.better_exit.time) {
      const t = toUnix(trade.better_exit.time.replace("T", " "));
      markers.push(buildMarker(t, trade.better_exit.price, "#f472b6", "BETTER EXIT"));
    }
    markers.sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(markers);

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
    if (trade.better_entry && trade.better_entry.price) {
      candleSeries.createPriceLine({ price: trade.better_entry.price, color: "#22d3ee", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "better entry" });
    }
    if (trade.better_exit && trade.better_exit.price) {
      candleSeries.createPriceLine({ price: trade.better_exit.price, color: "#f472b6", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "better exit" });
    }
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
