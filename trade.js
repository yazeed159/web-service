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

    // The right price scale autoscales to candle highs/lows only. As you
    // zoom in, the visible range tightens around just the candles in view,
    // and the ENTRY/EXIT overlay labels (drawn a fixed pixel offset off
    // their exact fill price) can end up right at the pane edge. Reserving
    // extra top/bottom margin gives them permanent headroom so they're
    // never fighting the autoscale for room, at any zoom level.
    candleChart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.18, bottom: 0.22 },
    });

    const volSeries = candleChart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    candleChart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(volData);

    candleChart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(vwapData);
    candleChart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema9Data);
    candleChart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema20Data);

    // Find the candle a marker's timestamp falls ON, so we can compare the
    // fill price against THAT candle's actual high/low instead of guessing
    // position from the role (entry vs exit).
    //
    // Bars are 1-minute candles labeled by their START time (e.g. "09:59:00"
    // covers 09:59:00-09:59:59). Fill times carry seconds ("09:59:48"). A
    // *nearest*-by-absolute-diff match picks whichever bar boundary is
    // numerically closest -- for anything in the second half of the minute
    // (:31-:59) that's the START of the NEXT bar, not the one the fill
    // actually happened in. That's what was putting every arrow one candle
    // late. Floor-matching (last bar whose start time is <= the fill time)
    // is the correct rule for start-labeled bars.
    function barAt(unixTime) {
      let best = bars[0];
      for (const b of bars) {
        if (toUnix(b.t) <= unixTime) best = b;
        else break;
      }
      return best;
    }

    // Which side of the candle the label sits on: above with the stem
    // pointing down if the fill is in the upper half of that candle's
    // high/low range, below with the stem pointing up otherwise. This is
    // purely cosmetic (which side looks less cramped) -- it does NOT
    // determine vertical position on the chart, unlike lightweight-charts'
    // own aboveBar/belowBar markers.
    function side(price, bar) {
      const mid = (bar.h + bar.l) / 2;
      return price >= mid ? "above" : "below";
    }

    // lightweight-charts v4 series markers (setMarkers with aboveBar /
    // belowBar) do NOT place at an arbitrary price -- they snap to a fixed
    // pixel offset off the CANDLE's own high/low, full stop. The price you
    // pass in only picks which side the marker goes on. So an exit whose
    // fill candle sits far from the fill price (price already having moved
    // on by the time that 1-min bar prints) rendered its arrow nowhere near
    // the actual $ level -- e.g. an exit at $14.01 landing down at $13.30
    // because that's where the 07:11 candle happened to be trading.
    //
    // Fix: skip setMarkers for entry/exit and draw plain DOM labels instead,
    // positioned with the chart's own timeToCoordinate/priceToCoordinate --
    // so the label sits at the literal fill price, on the correct candle in
    // time, and stays correct across zoom/pan since we recompute on every
    // range change.
    function buildFillOverlay(points) {
      const wrap = candleEl;
      wrap.style.position = "relative";
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:2;";
      wrap.appendChild(overlay);

      const els = points.map((p) => {
        const el = document.createElement("div");
        el.style.cssText = `
          position:absolute; transform:translate(-50%, ${p.side === "above" ? "-100%" : "0"});
          display:flex; flex-direction:column; align-items:center;
          font:600 10px "IBM Plex Mono", monospace; color:#0b0d10; white-space:nowrap;
        `;
        const tag = `<span style="background:${p.color}; padding:1px 5px; border-radius:3px;">${p.text}</span>`;
        const stem = `<span style="width:1px; height:14px; background:${p.color};"></span>`;
        el.innerHTML = p.side === "above" ? tag + stem : stem + tag;
        overlay.appendChild(el);
        return el;
      });

      function reposition() {
        points.forEach((p, i) => {
          const x = candleChart.timeScale().timeToCoordinate(p.time);
          const y = candleSeries.priceToCoordinate(p.price);
          const el = els[i];
          if (x === null || y === null) {
            el.style.display = "none";
            return;
          }
          el.style.display = "flex";
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        });
      }

      candleChart.timeScale().subscribeVisibleLogicalRangeChange(reposition);
      window.addEventListener("resize", reposition);
      // priceToCoordinate depends on the right price scale's own autoscale,
      // which isn't settled until after setData/fitContent run -- a couple
      // of follow-up passes catch that instead of racing it.
      reposition();
      requestAnimationFrame(reposition);
      setTimeout(reposition, 0);
    }

    // Better-entry/better-exit are intentionally NOT drawn on the chart --
    // they're hypothetical fills, not things that actually happened on this
    // candle series, and plotting them next to the real entry/exit labels
    // would read as if they were. The price + time + reasoning for each
    // still shows in the "What you should've done" card below.
    const entryBar = barAt(toUnix(`${trade.trade_date} ${trade.entry_time}`));
    const exitBar = barAt(toUnix(`${trade.trade_date} ${trade.exit_time}`));
    buildFillOverlay([
      { time: toUnix(entryBar.t), price: trade.entry_price, color: "#2fd08a", text: "ENTRY", side: side(trade.entry_price, entryBar) },
      { time: toUnix(exitBar.t), price: trade.exit_price, color: "#f2555a", text: "EXIT", side: side(trade.exit_price, exitBar) },
    ]);

    // Dashed price lines at the literal entry/exit fill so the level reads
    // precisely across the whole width of the chart, not just at the label.
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
