(function () {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const content = document.getElementById("trade-content");

  // Sibling (prev/next) nav needs the full index, sorted the same way the
  // publish pipeline sorts it (trade_date + entry_time). Fetching it is
  // best-effort — if it 404s or is missing, the page still renders fine
  // without nav arrows.
  let siblingsPromise = fetch("data/trades.json")
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => [])
    .then((rows) =>
      (Array.isArray(rows) ? rows : []).slice().sort((a, b) =>
        (a.trade_date + a.entry_time).localeCompare(b.trade_date + b.entry_time)
      )
    );

  if (!id) {
    content.innerHTML = `<div class="empty-state">No trade id in the URL — go back and pick one from the journal.</div>`;
  } else {
    Promise.all([
      fetch(`data/trades/${encodeURIComponent(id)}.json`).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
      siblingsPromise,
    ])
      .then(([trade, siblings]) => renderTrade(trade, siblings))
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

  // Feedback ("was this LLM call right?") is stored client-side only —
  // there's no write-back to the published JSON, so this is a per-browser
  // scratchpad, not a synced record. Keyed by trade id + field name so a
  // stats page can read `journal-feedback:*` and tally accuracy.
  const FEEDBACK_PREFIX = "journal-feedback:";
  function getFeedback(tradeId, field) {
    try {
      return localStorage.getItem(FEEDBACK_PREFIX + tradeId + ":" + field) || "";
    } catch (_) {
      return "";
    }
  }
  function setFeedback(tradeId, field, value) {
    try {
      localStorage.setItem(FEEDBACK_PREFIX + tradeId + ":" + field, value);
    } catch (_) {}
  }
  function feedbackWidget(tradeId, field) {
    const current = getFeedback(tradeId, field);
    const btn = (val, glyph) => `<button type="button" class="fb-btn${current === val ? " active" : ""}" data-fb-trade="${escapeHtml(tradeId)}" data-fb-field="${field}" data-fb-value="${val}" style="all:unset; cursor:pointer; padding:2px 6px; font-size:11px; border-radius:4px; border:1px solid rgba(255,255,255,.12); ${current === val ? "background:rgba(255,255,255,.14);" : ""}">${glyph}</button>`;
    return `<span class="fb-widget" style="display:inline-flex; gap:4px; margin-top:4px;">${btn("good", "👍")}${btn("bad", "👎")}</span>`;
  }
  function wireFeedbackWidgets(root) {
    root.querySelectorAll("[data-fb-trade]").forEach((el) => {
      el.addEventListener("click", () => {
        const tradeId = el.getAttribute("data-fb-trade");
        const field = el.getAttribute("data-fb-field");
        const value = el.getAttribute("data-fb-value");
        const already = getFeedback(tradeId, field) === value;
        setFeedback(tradeId, field, already ? "" : value);
        root.querySelectorAll(`[data-fb-trade="${tradeId}"][data-fb-field="${field}"]`).forEach((b) => {
          b.style.background = !already && b.getAttribute("data-fb-value") === value ? "rgba(255,255,255,.14)" : "";
        });
      });
    });
  }

  function siblingNav(trade, siblings) {
    if (!Array.isArray(siblings) || !siblings.length) return "";
    const key = (t) => (t.trade_date || "") + (t.entry_time || "");
    const idx = siblings.findIndex((r) => r.id === trade.id);
    const prev = idx > 0 ? siblings[idx - 1] : null;
    const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null;
    const link = (row, label, dir) =>
      row
        ? `<a href="trade.html?id=${encodeURIComponent(row.id)}" class="trade-nav-link" style="color:#8b98a5; text-decoration:none; font-size:12.5px; display:flex; align-items:center; gap:4px;">${dir === "prev" ? "←" : ""}${escapeHtml(label)}${dir === "next" ? "→" : ""}</a>`
        : `<span style="color:#3a4149; font-size:12.5px;">${dir === "prev" ? "←" : ""}${escapeHtml(label)}${dir === "next" ? "→" : ""}</span>`;
    return `<div class="trade-sibling-nav" style="display:flex; justify-content:space-between; margin-bottom:10px;">
      ${link(prev, prev ? `${prev.symbol} · ${prev.trade_date}` : "No earlier trade", "prev")}
      ${link(next, next ? `${next.symbol} · ${next.trade_date}` : "No later trade", "next")}
    </div>`;
  }

  function renderTrade(trade, siblings) {
    document.title = `${trade.symbol} — trade.log`;
    const win = trade.win;

    content.innerHTML = `
      ${siblingNav(trade, siblings || [])}
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
            <span class="legend-item"><span class="legend-swatch" style="background:rgba(47,208,138,0.55)"></span>better entry</span>
            <span class="legend-item"><span class="legend-swatch" style="background:rgba(242,85,90,0.55)"></span>better exit</span>
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
        <div class="card better-card" style="padding:14px 16px;">
          <h2 style="font-size:12.5px; margin:0 0 8px; text-transform:uppercase; letter-spacing:.03em; opacity:.75;">What you should've done</h2>
          ${betterRow("Entry", trade.better_entry, trade.id, "better_entry")}
          ${betterRow("Exit", trade.better_exit, trade.id, "better_exit")}
          ${!trade.better_entry && !trade.better_exit ? `<div class="no-better" style="font-size:12px; opacity:.7;">No better entry/exit flagged — this trade lined up with the plan.</div>` : ""}
        </div>

        <div class="card">
          <h2>Lessons from this trade</h2>
          ${Array.isArray(trade.lessons) && trade.lessons.length
            ? `<ul class="lessons-list" style="margin:0; padding-left:18px;">${trade.lessons.map((l, i) => lessonItem(l, trade.id, i)).join("")}</ul>`
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
    wireFeedbackWidgets(content);
  }

  function rrStrip(trade) {
    if (!trade.suggested_stop && !trade.suggested_target && !trade.risk_reward) return "";
    return `<div class="rr-strip">
      ${trade.suggested_stop ? `<span><span class="k">Stop</span><span class="v down">$${Number(trade.suggested_stop).toFixed(2)}</span></span>` : ""}
      ${trade.suggested_target ? `<span><span class="k">Target</span><span class="v up">$${Number(trade.suggested_target).toFixed(2)}</span></span>` : ""}
      ${trade.risk_reward ? `<span><span class="k">R:R</span><span class="v">${escapeHtml(trade.risk_reward)}</span></span>` : ""}
    </div>`;
  }

  function betterRow(label, b, tradeId, field) {
    if (!b || !b.price) return "";
    const how = b.how_to_know
      ? `<div class="how-to-know" style="font-size:11px; opacity:.65; margin-top:2px;">How you'd know: ${escapeHtml(b.how_to_know)}</div>`
      : "";
    return `<div class="better-row" style="display:flex; gap:10px; align-items:baseline; padding:6px 0; border-bottom:1px solid rgba(255,255,255,.06);">
      <div class="tag" style="font-size:10px; font-weight:700; letter-spacing:.03em; opacity:.65; min-width:38px; flex-shrink:0;">${label.toUpperCase()}</div>
      <div class="content" style="flex:1; min-width:0;">
        <div class="price-line" style="font-size:12.5px; font-weight:600;">$${Number(b.price).toFixed(2)}${b.time ? ` @ ${escapeHtml(String(b.time).split("T").pop())}` : ""}</div>
        ${b.reason ? `<div class="reason" style="font-size:11.5px; opacity:.75; margin-top:1px;">${escapeHtml(b.reason)}</div>` : ""}
        ${how}
        ${tradeId ? feedbackWidget(tradeId, field) : ""}
      </div>
    </div>`;
  }

  function lessonItem(l, tradeId, i) {
    if (typeof l === "string") return `<li style="margin-bottom:6px; font-size:12.5px;">${escapeHtml(l)}</li>`;
    const how = l.how_to_know
      ? `<div style="font-size:11px; opacity:.65; margin-top:2px;">How you'd know: ${escapeHtml(l.how_to_know)}</div>`
      : "";
    const tagBadge = l.tag
      ? `<span class="lesson-tag" style="display:inline-block; font-size:10px; font-weight:600; letter-spacing:.02em; text-transform:uppercase; padding:1px 6px; border-radius:3px; background:rgba(91,147,240,.15); color:#5b93f0; margin-left:6px; vertical-align:middle;">${escapeHtml(String(l.tag).replace(/_/g, " "))}</span>`
      : "";
    return `<li style="margin-bottom:8px; font-size:12.5px;">${escapeHtml(l.lesson || l.text || "")}${tagBadge}${how}${tradeId ? feedbackWidget(tradeId, "lesson_" + i) : ""}</li>`;
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
    const histData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd_hist, color: b.macd_hist >= 0 ? "#2fd08a" : "#f2555a" }));

    const candleEl = document.getElementById("candle-chart");
    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: "#8b98a5" },
      grid: { vertLines: { color: "#1c2127" }, horzLines: { color: "#1c2127" } },
      rightPriceScale: { borderColor: "#232830" },
      timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };
    const candleChart = LightweightCharts.createChart(candleEl, { ...commonOpts, width: candleEl.clientWidth, height: 420 });

    const candleSeries = candleChart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
    });
    candleSeries.setData(candleData);

    // The right price scale autoscales to candle highs/lows only. As you
    // zoom in, the visible range tightens around just the candles in view,
    // and the entry/exit pointer markers (drawn a fixed pixel offset off
    // their exact fill price) can end up right at the pane edge. Reserving
    // extra top/bottom margin gives them permanent headroom so they're
    // never fighting the autoscale for room, at any zoom level.
    candleChart.priceScale("right").applyOptions({
      scaleMargins: { top: 0.14, bottom: 0.18 },
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
    // actually happened in. Floor-matching (last bar whose start time is
    // <= the fill time) is the correct rule for start-labeled bars.
    function barAt(unixTime) {
      let best = bars[0];
      for (const b of bars) {
        if (toUnix(b.t) <= unixTime) best = b;
        else break;
      }
      return best;
    }

    // Small, clear pointer markers instead of a label box + connector stem
    // + full-width dashed price line: just a tiny triangle sitting right on
    // the exact fill point, pointing straight at it. Nothing else on the
    // chart competes with it for attention, and it never gets orphaned from
    // its own price line the way the old label system could. Hover it for
    // the exact price/time (native tooltip, zero extra chart clutter).
    function buildPointer(time, price, color, label) {
      const wrap = candleEl;
      wrap.style.position = "relative";
      let overlay = wrap.querySelector(".fill-pointer-overlay");
      if (!overlay) {
        overlay = document.createElement("div");
        overlay.className = "fill-pointer-overlay";
        overlay.style.cssText = "position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:2;";
        wrap.appendChild(overlay);
      }
      const el = document.createElement("div");
      el.title = `${label} $${price.toFixed(2)}`;
      el.style.cssText = `
        position:absolute; width:0; height:0; pointer-events:auto;
        border-left:6px solid transparent; border-right:6px solid transparent;
        filter: drop-shadow(0 0 1.5px #0b0d10) drop-shadow(0 0 1.5px #0b0d10);
      `;
      overlay.appendChild(el);
      return el;
    }

    const entryBar = barAt(toUnix(`${trade.trade_date} ${trade.entry_time}`));
    const exitBar = barAt(toUnix(`${trade.trade_date} ${trade.exit_time}`));
    const pointers = [
      // Entry: triangle sits just above the fill, tip pointing down onto it.
      { time: toUnix(entryBar.t), price: trade.entry_price, color: "#2fd08a", label: "ENTRY", above: true,
        el: buildPointer(toUnix(entryBar.t), trade.entry_price, "#2fd08a", "ENTRY") },
      // Exit: triangle sits just below the fill, tip pointing up onto it.
      { time: toUnix(exitBar.t), price: trade.exit_price, color: "#f2555a", label: "EXIT", above: false,
        el: buildPointer(toUnix(exitBar.t), trade.exit_price, "#f2555a", "EXIT") },
    ];
    // A zero-size div with only border-bottom set renders a triangle whose
    // TIP sits at the box edge (top) and whose flat BASE extends downward
    // from there; border-top-only is the mirror image, tip at the box edge
    // (bottom), base extending upward. So to get the tip -- not the base --
    // resting on the price, "above" markers (tip pointing down) need
    // border-top, and "below" markers (tip pointing up) need border-bottom.
    pointers.forEach((p) => {
      p.el.style.borderTop = p.above ? `9px solid ${p.color}` : "";
      p.el.style.borderBottom = p.above ? "" : `9px solid ${p.color}`;
    });

    function repositionPointers() {
      pointers.forEach((p) => {
        const x = candleChart.timeScale().timeToCoordinate(p.time);
        const y = candleSeries.priceToCoordinate(p.price);
        if (x === null || y === null) {
          p.el.style.display = "none";
          return;
        }
        p.el.style.display = "block";
        p.el.style.left = `${x}px`;
        // The box edge is where the triangle's tip lives (see border setup
        // above), so putting it at y puts the tip exactly on the price; the
        // shape itself extends 9px above (entry) or below (exit) from there.
        p.el.style.top = `${y}px`;
        p.el.style.transform = "translateX(-50%)";
      });
    }

    candleChart.timeScale().subscribeVisibleLogicalRangeChange(repositionPointers);
    window.addEventListener("resize", repositionPointers);
    // priceToCoordinate depends on the right price scale's own autoscale,
    // which isn't settled until after setData/fitContent run -- a couple
    // of follow-up passes catch that instead of racing it.
    repositionPointers();
    requestAnimationFrame(repositionPointers);
    setTimeout(repositionPointers, 0);

    candleSeries.createPriceLine({
      price: trade.entry_price,
      color: "#2fd08a",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: "",
    });
    candleSeries.createPriceLine({
      price: trade.exit_price,
      color: "#f2555a",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      axisLabelVisible: true,
      title: "",
    });

    // Fainter dotted lines for the LLM's suggested better entry/exit, each
    // labeled with the how_to_know signal (truncated) so the chart itself
    // hints at *why*, not just *where* — the full text still lives in the
    // "What you should've done" card for anyone who wants it.
    function truncate(s, n) {
      if (!s) return "";
      return s.length > n ? s.slice(0, n - 1) + "…" : s;
    }
    if (trade.better_entry && trade.better_entry.price) {
      candleSeries.createPriceLine({
        price: Number(trade.better_entry.price),
        color: "rgba(47,208,138,0.55)",
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true,
        title: truncate(trade.better_entry.how_to_know || "better entry", 28),
      });
    }
    if (trade.better_exit && trade.better_exit.price) {
      candleSeries.createPriceLine({
        price: Number(trade.better_exit.price),
        color: "rgba(242,85,90,0.55)",
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true,
        title: truncate(trade.better_exit.how_to_know || "better exit", 28),
      });
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
