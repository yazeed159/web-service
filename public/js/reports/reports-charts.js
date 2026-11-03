(function () {
  "use strict";
  const R = (App.reports = App.reports || {});
  const { DRILL_PAGE, closeInline, drillAttr, drillRegistry, paintDrillPanel, toggleExec, toggleInline } = R;

  const reportsRoot = document.getElementById("tab-reports");
  if (reportsRoot) {
    reportsRoot.addEventListener("click", (e) => {
      const execBtn = e.target.closest(".drill-exec-toggle");
      if (execBtn) { toggleExec(execBtn); return; }
      const closeBtn = e.target.closest(".drill-inline-close");
      const more = e.target.closest(".drill-more, .drill-reveal");
      const panel = (closeBtn || more) && (closeBtn || more).closest(".drill-inline-row, .drill-inline-wrap");
      if (panel && panel._drill) {
        if (more && more.classList.contains("drill-reveal")) {
          panel._drill.revealed = true;
          paintDrillPanel(panel);
        } else if (closeBtn) {
          const owner = panel._drill.owner;
          closeInline(owner);
          if (owner && owner.focus && document.contains(owner)) { try { owner.focus({ preventScroll: true }); } catch (err) { owner.focus(); } }
        } else {
          panel._drill.shown += more && more.dataset.step === "all" ? 1e9 : Number(more && more.dataset.step) || DRILL_PAGE;
          panel.removeAttribute("data-fresh"); // only a newly opened panel staggers its rows in
          paintDrillPanel(panel);
        }
        return;
      }
      const el = e.target.closest("[data-drill]");
      if (!el || !reportsRoot.contains(el)) return;
      // A real link / control inside a drillable row keeps doing its own thing.
      const ctl = e.target.closest("a, button, input, select, textarea, label");
      if (ctl && ctl !== el && el.contains(ctl)) return;
      toggleInline(el, drillRegistry.get(el.getAttribute("data-drill")));
    }, { signal: App.signal });
    reportsRoot.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const el = e.target.closest && e.target.closest("[data-drill]");
      if (!el || e.target !== el) return;
      e.preventDefault();
      toggleInline(el, drillRegistry.get(el.getAttribute("data-drill")));
    }, { signal: App.signal });
  }

  // ----------------------------------------------------------------
  // Reports — Tradervue-style axis bar charts, donut, and equity-curve
  // charts. Plain inline SVG (no charting library) so these stay cheap
  // to render inside a list of report panels.
  // ----------------------------------------------------------------
  function fmtAxisMoney(v) {
    const abs = Math.abs(v);
    const s = abs >= 1000 ? "$" + (abs / 1000).toFixed(abs >= 10000 ? 0 : 1) + "k" : "$" + Math.round(abs);
    return (v < 0 ? "-" : "") + s;
  }
  function fmtAxisCount(v) { return String(Math.round(v)); }
  // rows: [{label, value, color}]. Draws horizontal bars from a shared
  // zero-line, with a labeled numeric axis underneath -- same shape as
  // Tradervue's "Distribution by X" / "Performance by X" pairs.
  function svgAxisBarChart(rows, opts) {
    opts = opts || {};
    const width = opts.width || 480;
    const barH = opts.barHeight || 20;
    const gap = 9;
    const labelW = opts.labelW || 108;
    const rightPad = 10;
    const rowH = barH + gap;
    const topPad = 4, bottomPad = 24;
    const plotW = Math.max(60, width - labelW - rightPad);
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
    const hasNeg = rows.some((r) => r.value < 0);
    const height = topPad + rows.length * rowH + bottomPad;
    const fmt = opts.fmt || ((v) => String(v));
    const zeroX = hasNeg ? plotW / 2 : 0;
    const scale = (hasNeg ? plotW / 2 : plotW) / maxAbs;

    const gridCount = hasNeg ? 4 : 4;
    let axis = "";
    for (let i = 0; i <= gridCount; i++) {
      const frac = i / gridCount;
      const x = hasNeg ? frac * plotW : frac * plotW;
      const val = hasNeg ? (frac * 2 - 1) * maxAbs : frac * maxAbs;
      const gx = (labelW + x).toFixed(1);
      axis += `<line x1="${gx}" y1="${topPad}" x2="${gx}" y2="${(topPad + rows.length * rowH).toFixed(1)}" stroke="var(--border)" stroke-width="1" opacity="0.6"/>`;
      axis += `<text x="${gx}" y="${(topPad + rows.length * rowH + 16).toFixed(1)}" font-size="10" fill="var(--text-faint)" text-anchor="middle">${escapeHtml(fmt(val))}</text>`;
    }
    const bars = rows.map((r, i) => {
      const y = topPad + i * rowH;
      const barW = Math.max(Math.abs(r.value) * scale, r.value === 0 ? 0 : 1.5);
      const x = hasNeg ? (r.value >= 0 ? labelW + zeroX : labelW + zeroX - barW) : labelW;
      const color = r.color || "var(--green)";
      const tip = `${escapeHtml(r.label)}: ${escapeHtml(fmt(r.value))}`;
      const inner = `<text x="${labelW - 8}" y="${(y + barH / 2 + 4).toFixed(1)}" font-size="11" fill="var(--text-dim)" text-anchor="end">${escapeHtml(r.label)}</text>` +
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH}" rx="2" fill="${color}"><title>${tip}${r.trades && r.trades.length ? " \u2014 click for trades" : ""}</title></rect>`;
      // Rows that carry `trades` become clickable (whole row is the hit area).
      const da = drillAttr(r.drillTitle || r.label, r.trades, { sub: r.drillSub || opts.context });
      if (!da) return inner;
      return `<g class="drillable"${da}><rect x="0" y="${(y - gap / 2).toFixed(1)}" width="${width}" height="${rowH}" fill="transparent"/>${inner}</g>`;
    }).join("");
    const zeroLine = hasNeg ? `<line x1="${(labelW + zeroX).toFixed(1)}" y1="${topPad}" x2="${(labelW + zeroX).toFixed(1)}" y2="${(topPad + rows.length * rowH).toFixed(1)}" stroke="var(--text-faint)" stroke-width="1.3"/>` : "";
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="overflow:visible; display:block;">${axis}${bars}${zeroLine}</svg>`;
  }
  // buckets: [{label, trades}]. Renders the "count" side into distElId
  // and the "net P&L" side into perfElId -- the paired chart Tradervue
  // shows for price, size, symbol, and volume breakdowns.
  function renderPairedHistogram(distElId, perfElId, buckets, opts) {
    const distEl = document.getElementById(distElId), perfEl = document.getElementById(perfElId);
    if (!distEl || !perfEl) return;
    const present = buckets.filter((b) => b.trades.length);
    if (!present.length) {
      distEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      perfEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    const distRows = present.map((b) => ({ label: b.label, value: b.trades.length, color: "var(--green)", trades: b.trades }));
    const perfRows = present.map((b) => {
      const net = b.trades.reduce((s, t) => s + t.pnl_after_comm, 0);
      return { label: b.label, value: net, color: net >= 0 ? "var(--green)" : "var(--red)", trades: b.trades };
    });
    distEl.innerHTML = svgAxisBarChart(distRows, Object.assign({ fmt: fmtAxisCount }, opts));
    perfEl.innerHTML = svgAxisBarChart(perfRows, Object.assign({ fmt: fmtAxisMoney }, opts));
  }
  function svgDonutChart(winPct, opts) {
    opts = opts || {};
    const size = opts.size || 220, stroke = opts.stroke || 34;
    const r = (size - stroke) / 2, c = size / 2;
    const circ = 2 * Math.PI * r;
    const winLen = (winPct / 100) * circ;
    const lossAttr = ""; // win/loss lists are just Journal filters -- not clickable
    const winAttr = "";
    // The hole in the middle opens every trade (the ring segments open just the winners / losers).
    const allAttr = "";
    return `<svg viewBox="0 0 ${size} ${size}" width="100%" height="${size}" style="max-width:${size}px; display:block; margin:0 auto;">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--red)" stroke-width="${stroke}"${lossAttr}/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--green)" stroke-width="${stroke}"
        stroke-dasharray="${winLen.toFixed(1)} ${circ.toFixed(1)}" stroke-dashoffset="${(circ * 0.25).toFixed(1)}" transform="scale(1,-1)" style="transform-origin:${c}px ${c}px;"${winAttr}/>
      <circle cx="${c}" cy="${c}" r="${(r - stroke / 2 - 2).toFixed(1)}" fill="transparent"${allAttr}/>
      <text x="${c}" y="${c - 4}" text-anchor="middle" font-size="22" font-weight="700" fill="var(--green)" style="pointer-events:none;">${winPct.toFixed(1)}%</text>
      <text x="${c}" y="${c + 16}" text-anchor="middle" font-size="11" fill="var(--text-faint)" style="pointer-events:none;">win rate</text>
    </svg>`;
  }
  // Interactive line/area chart -- same crosshair + tooltip UX as the
  // dashboard's equity curve (bindEquityInteractivity below), generalized
  // so any number of independent instances can live on one page at once
  // (Reports has several: Drawdown tab's two charts, Overview's
  // date-range-toggle one, Win/Loss/Expectation's). Renders its own
  // wrap/svg/crosshair/tooltip markup straight into `container` and binds
  // events scoped to that element, rather than assuming fixed page-wide
  // ids the way the dashboard's singleton chart does.
  // series: [{ x: <label shown in tooltip>, y: <number> }, ...] in
  // chronological order.
  let mlcSeq = 0;
  // Splits a polyline into pieces that never cross the threshold line --
  // used so a chart can color each stretch by whether IT is above/below
  // zero, instead of painting the whole curve by only its final value.
  // Every (x1,y1)-(x2,y2) pair from `coords` is classified by the sign of
  // its two `values` relative to thresholdValue; a pair that actually
  // crosses gets split at the interpolated crossing point (thresholdY) so
  // the color switches exactly where the data does, not at the nearest
  // sampled point.
  function splitSignedSegments(coords, values, thresholdY, thresholdValue) {
    const segs = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i], [x2, y2] = coords[i + 1];
      const v1 = values[i], v2 = values[i + 1];
      const pos1 = v1 >= thresholdValue, pos2 = v2 >= thresholdValue;
      if (pos1 === pos2) {
        segs.push({ x1, y1, x2, y2, positive: pos1 });
      } else {
        const t = (thresholdValue - v1) / (v2 - v1);
        const xm = x1 + (x2 - x1) * t;
        segs.push({ x1, y1, x2: xm, y2: thresholdY, positive: pos1 });
        segs.push({ x1: xm, y1: thresholdY, x2, y2, positive: pos2 });
      }
    }
    return segs;
  }
  function renderMiniLineChart(container, series, opts) {
    opts = opts || {};
    if (!container) return;
    if (!series.length) { container.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const valueFmt = opts.valueFmt || fmtMoney;
    const W = 1000, H = opts.height || 130, PAD = 8;

    const values = series.map((p) => p.y);
    const min = Math.min(0, ...values), max = Math.max(0, ...values);
    const range = max - min || 1;
    const coords = series.map((p, i) => {
      const x = series.length > 1 ? (i / (series.length - 1)) * W : 0;
      const y = H - PAD - ((p.y - min) / range) * (H - PAD * 2);
      return [x, y];
    });
    const zeroY = H - PAD - ((0 - min) / range) * (H - PAD * 2);
    const finalPositive = values[values.length - 1] >= 0;

    const segs = coords.length > 1 ? splitSignedSegments(coords, values, zeroY, 0) : [];
    const fmt1 = (n) => n.toFixed(1);
    const strokeMarkup = segs.length
      ? segs.map((s) => `<path d="M${fmt1(s.x1)},${fmt1(s.y1)} L${fmt1(s.x2)},${fmt1(s.y2)}" class="equity-path ${s.positive ? "" : "neg"}" />`).join("")
      : `<path d="M${fmt1(coords[0][0])},${fmt1(coords[0][1])} L${fmt1(coords[0][0])},${fmt1(coords[0][1])}" class="equity-path ${finalPositive ? "" : "neg"}" />`;
    const fillMarkup = segs.map((s) => `<path d="M${fmt1(s.x1)},${fmt1(s.y1)} L${fmt1(s.x2)},${fmt1(s.y2)} L${fmt1(s.x2)},${fmt1(zeroY)} L${fmt1(s.x1)},${fmt1(zeroY)} Z" fill="${s.positive ? "#2fd08a" : "#f2555a"}" fill-opacity="0.14" />`).join("");

    container.innerHTML = `
      <div class="equity-chart-wrap mini-line-wrap">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:${H}px; display:block;">
          <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" class="equity-zero" />
          ${fillMarkup}
          ${strokeMarkup}
          <circle class="mlc-hover-dot" r="4" fill="var(--panel)" stroke="${finalPositive ? "var(--green)" : "var(--red)"}" stroke-width="2" style="display:none;" />
        </svg>
        <div class="equity-crosshair mlc-crosshair"></div>
        <div class="equity-tooltip mlc-tooltip"></div>
      </div>`;

    const wrap = container.querySelector(".mini-line-wrap");
    const crosshair = container.querySelector(".mlc-crosshair");
    const tooltip = container.querySelector(".mlc-tooltip");
    const dot = container.querySelector(".mlc-hover-dot");
    const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    const tradeAt = (i) => (opts.trades && opts.trades[i]) || null; // series[i] <-> opts.trades[i]

    // One AbortController per render: re-rendering this container (range toggle,
    // filters) drops the previous chart's listeners instead of stacking them.
    if (container._mlcCtl) container._mlcCtl.abort();
    const ctl = (container._mlcCtl = new AbortController());
    (opts.signal || App.signal).addEventListener("abort", () => ctl.abort(), { once: true, signal: ctl.signal });
    const sig = ctl.signal;

    let shownIdx = -1;
    function nearestIndex(clientX) {
      const rect = wrap.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return Math.round(frac * (series.length - 1));
    }
    function showAt(clientX) {
      const i = nearestIndex(clientX);
      shownIdx = i;
      const [cx, cy] = coords[i];
      const rect = wrap.getBoundingClientRect();
      const pxX = (cx / W) * rect.width;
      crosshair.style.display = "block";
      crosshair.style.left = `${pxX}px`;
      dot.style.display = "block";
      dot.setAttribute("cx", cx.toFixed(1));
      dot.setAttribute("cy", cy.toFixed(1));
      dot.setAttribute("stroke", values[i] >= 0 ? "var(--green)" : "var(--red)");
      const p = series[i];
      const t = tradeAt(i);
      let html = `<div class="eq-date">${escapeHtml(p.x)}</div><div class="eq-bal">${valueFmt(p.y)}</div>`;
      if (t) {
        html += `<div class="eq-trade">${escapeHtml(t.symbol)} <span class="${t.pnl_after_comm >= 0 ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</span></div>`;
        html += `<div class="eq-hint">${coarse ? "Tap again to open trade" : "Click to open trade"} \u2192</div>`;
      }
      tooltip.innerHTML = html;
      tooltip.style.display = "block";
      const ttWidth = tooltip.offsetWidth || 120;
      let left = pxX + 10;
      if (left + ttWidth > rect.width) left = pxX - ttWidth - 10;
      if (left < 0) left = 4;
      tooltip.style.left = `${left}px`;
    }
    function hide() {
      shownIdx = -1;
      crosshair.style.display = "none";
      tooltip.style.display = "none";
      dot.style.display = "none";
    }

    // Mouse: hover as before. Touch: press and hold (~200ms) then drag to scrub
    // along the curve; a quick swipe still scrolls the page. A plain tap shows
    // that point, and tapping the same point again opens the trade.
    wrap.addEventListener("pointermove", (e) => { if (e.pointerType !== "touch") showAt(e.clientX); }, { signal: sig });
    wrap.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") hide(); }, { signal: sig });

    let holdTimer = null, scrubbing = false, suppressClick = false;
    let sx = 0, sy = 0, lastX = 0;
    const endHold = () => { clearTimeout(holdTimer); holdTimer = null; };
    wrap.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { endHold(); return; }
      sx = lastX = e.touches[0].clientX; sy = e.touches[0].clientY;
      endHold();
      holdTimer = setTimeout(() => {
        holdTimer = null; scrubbing = true;
        wrap.classList.add("scrubbing");
        try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) {}
        showAt(lastX);
      }, 200);
    }, { passive: true, signal: sig });
    wrap.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (!t) return;
      lastX = t.clientX;
      if (scrubbing) {
        if (e.cancelable) e.preventDefault(); // keep the page from scrolling while scrubbing
        showAt(t.clientX);
      } else if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) {
        endHold(); // finger moved before the hold registered: it is a scroll
      }
    }, { passive: false, signal: sig });
    const touchDone = () => {
      endHold();
      if (scrubbing) {
        scrubbing = false;
        wrap.classList.remove("scrubbing");
        suppressClick = true; // the click synthesised on release must not open the trade
        setTimeout(() => { suppressClick = false; }, 400);
      }
    };
    wrap.addEventListener("touchend", touchDone, { signal: sig });
    wrap.addEventListener("touchcancel", touchDone, { signal: sig });
    wrap.addEventListener("contextmenu", (e) => { if (coarse) e.preventDefault(); }, { signal: sig });
    // Tapping anywhere else clears the readout left on screen.
    document.addEventListener("touchstart", (e) => { if (!wrap.contains(e.target)) hide(); }, { passive: true, signal: sig });

    // Click / tap goes straight to that trade's page (no dropdown). On a phone
    // the first tap only shows the point; tapping the same point again opens it.
    wrap.addEventListener("click", (e) => {
      if (suppressClick) return;
      const i = nearestIndex(e.clientX);
      const t = tradeAt(i);
      if (!t || !t.id) return;
      if (coarse && shownIdx !== i) { showAt(e.clientX); return; }
      window.location.href = `trade.html?id=${encodeURIComponent(t.id)}`;
    }, { signal: sig });
  }
  // ----------------------------------------------------------------
  // Reports — click-to-expand trade lists (same pattern as patterns.html's
  // tag-trade-list: click a leaderboard/breakdown row to reveal the exact
  // trades behind it, each linking straight to trade.html?id=...).
  //
  // Rendered TRADE_LIST_PAGE_SIZE at a time with a "Load more" button
  // rather than dumping every trade behind a symbol/tag/day into the DOM
  // at once -- a heavily-traded symbol or a "loss days" bucket can run
  // into the hundreds, and that was making those sections (collapsed or
  // not) enormous.
  // ----------------------------------------------------------------
  // tradeListItemHtml/tradeListMoreHtml/tradeListHtml/
  // TRADE_LIST_PAGE_SIZE/tradeListState/bindTradeToggles all now in
  // utils.js (identical here to edge-analysis.js/patterns.html/
  // stats.html's copies, minus their URL-sync step -- see utils.js).
  // Shared "key -> {trades, net}" breakdown table with a Load More button
  // -- used by Overview's "By symbol" and the Sector/Country tables. A
  // busy account can have hundreds of symbols; rendering a <tr> for every
  // one of them at once (even those collapsed) is exactly what was
  // making the Reports page slow to load. Same fix as tradeListHtml's
  // Load More above, just at the row level instead of the nested
  // trade-list level.
  const BREAKDOWN_PAGE_SIZE = 5; // first page; see moreButtonsHtml for the buttons
  const breakdownTableState = new Map(); // elId -> { rowsHtml, shown }
  function renderPaginatedBreakdownTable(elId, entries, colLabel, rowHtmlFn) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!entries.length) {
      el.innerHTML = `<div class="empty-state small">No ${escapeHtml(colLabel.toLowerCase())} data yet.</div>`;
      return;
    }
    breakdownTableState.set(elId, { rowsHtml: entries.map(rowHtmlFn), shown: BREAKDOWN_PAGE_SIZE });
    el.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">${colLabel}</th><th scope="col">Trades</th><th scope="col">Win %</th><th scope="col">Net P&amp;L</th></tr></thead><tbody id="${elId}-tbody"></tbody></table></div>`;
    renderBreakdownTablePage(elId);
  }
  function renderBreakdownTablePage(elId) {
    const state = breakdownTableState.get(elId);
    const tbody = document.getElementById(`${elId}-tbody`);
    if (!state || !tbody) return;
    const shown = Math.min(state.shown, state.rowsHtml.length);
    const remaining = state.rowsHtml.length - shown;
    const moreHtml = remaining > 0
      ? `<tr class="report-row-more"><td colspan="4" style="text-align:center; padding:10px;">${window.moreButtonsHtml(`data-load-more-table="${elId}"`, remaining, state.rowsHtml.length)}</td></tr>`
      : "";
    tbody.innerHTML = state.rowsHtml.slice(0, shown).join("") + moreHtml;
    bindTradeToggles(tbody);
    tbody.querySelectorAll("[data-load-more-table]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.shown += window.moreStep(btn, state.rowsHtml.length - shown);
        renderBreakdownTablePage(elId);
      }, { signal: App.signal });
    });
  }

  // ----------------------------------------------------------------
  // Reports sub-tab / top-level-tab / Compare-controls wiring (was loose
  // top-level code in the old app.js's shared "TAB NAVIGATION" section --
  // moved here since all of it is Reports-only).
  // ----------------------------------------------------------------
  // Reports → Detailed stats sub-tabs (separate from the main sidebar tabs)
  document.querySelectorAll(".subtab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".subtab-panel").forEach((p) => p.classList.toggle("active", p.id === "subtab-" + btn.dataset.subtab));
    }, { signal: App.signal });
  });

  // Reports → top-level tabs (Overview / Detailed / Win vs Loss Days / Drawdown / Compare / Tag Breakdown / Advanced)
  document.querySelectorAll(".toptab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toptab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".toptab-panel").forEach((p) => p.classList.toggle("active", p.id === "toptab-" + btn.dataset.toptab));
    }, { signal: App.signal });
  });
  Object.assign(R, { fmtAxisMoney, renderMiniLineChart, renderPaginatedBreakdownTable, renderPairedHistogram, svgAxisBarChart, svgDonutChart });
})();
