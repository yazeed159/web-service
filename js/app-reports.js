(function () {
  "use strict";

  // Reports tab of index.html. Split out of the old app.js -- see the big
  // comment at the top of app-shared.js (loaded right before this file on
  // every navigation here) for how these files fit together. Reads/writes
  // shared trade data via `App.state` (including the temporary filtered-
  // subset swap in applyReportFiltersAndRender below -- see its comment);
  // registers its two entry points on `App.tabs.reports` so app-shared.js's
  // fetch-then-render pass can call them once data loads.

  // Report-only filter/view state -- never read outside this file.
  let reportFilters = { symbol: "", tags: [], durationMin: null, durationMax: null, setup: "all", dateFrom: "", dateTo: "" };
  let reportPeriodTimeframe = "monthly"; // daily | weekly | monthly | yearly -- see renderPeriodDistPerf

  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
      return `<text x="${labelW - 8}" y="${(y + barH / 2 + 4).toFixed(1)}" font-size="11" fill="var(--text-dim)" text-anchor="end">${escapeHtml(r.label)}</text>` +
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH}" rx="2" fill="${color}"><title>${tip}</title></rect>`;
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
    const distRows = present.map((b) => ({ label: b.label, value: b.trades.length, color: "var(--green)" }));
    const perfRows = present.map((b) => {
      const net = b.trades.reduce((s, t) => s + t.pnl_after_comm, 0);
      return { label: b.label, value: net, color: net >= 0 ? "var(--green)" : "var(--red)" };
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
    return `<svg viewBox="0 0 ${size} ${size}" width="100%" height="${size}" style="max-width:${size}px; display:block; margin:0 auto;">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--red)" stroke-width="${stroke}"/>
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--green)" stroke-width="${stroke}"
        stroke-dasharray="${winLen.toFixed(1)} ${circ.toFixed(1)}" stroke-dashoffset="${(circ * 0.25).toFixed(1)}" transform="scale(1,-1)" style="transform-origin:${c}px ${c}px;"/>
      <text x="${c}" y="${c - 4}" text-anchor="middle" font-size="22" font-weight="700" fill="var(--green)">${winPct.toFixed(1)}%</text>
      <text x="${c}" y="${c + 16}" text-anchor="middle" font-size="11" fill="var(--text-faint)">win rate</text>
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
    const pathD = coords.map((c, i) => (i === 0 ? "M" : "L") + c[0].toFixed(1) + "," + c[1].toFixed(1)).join(" ");
    const zeroY = H - PAD - ((0 - min) / range) * (H - PAD * 2);
    const fillD = pathD + ` L${coords[coords.length - 1][0].toFixed(1)},${zeroY.toFixed(1)} L0,${zeroY.toFixed(1)} Z`;
    const finalPositive = values[values.length - 1] >= 0;
    const gradId = "mlcGrad" + (mlcSeq++);
    const swatch = finalPositive ? "#2fd08a" : "#f2555a";

    container.innerHTML = `
      <div class="equity-chart-wrap mini-line-wrap">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%; height:${H}px; display:block;">
          <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" class="equity-zero" />
          <path d="${fillD}" fill="url(#${gradId})" />
          <path d="${pathD}" class="equity-path ${finalPositive ? "" : "neg"}" />
          <circle class="mlc-hover-dot" r="4" fill="var(--panel)" stroke="${finalPositive ? "var(--green)" : "var(--red)"}" stroke-width="2" style="display:none;" />
          <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${swatch}" stop-opacity="0.2" />
              <stop offset="100%" stop-color="${swatch}" stop-opacity="0" />
            </linearGradient>
          </defs>
        </svg>
        <div class="equity-crosshair mlc-crosshair"></div>
        <div class="equity-tooltip mlc-tooltip"></div>
      </div>`;

    const wrap = container.querySelector(".mini-line-wrap");
    const crosshair = container.querySelector(".mlc-crosshair");
    const tooltip = container.querySelector(".mlc-tooltip");
    const dot = container.querySelector(".mlc-hover-dot");

    function nearestIndex(clientX) {
      const rect = wrap.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return Math.round(frac * (series.length - 1));
    }
    function showAt(clientX) {
      const i = nearestIndex(clientX);
      const [cx, cy] = coords[i];
      const rect = wrap.getBoundingClientRect();
      const pxX = (cx / W) * rect.width;
      crosshair.style.display = "block";
      crosshair.style.left = `${pxX}px`;
      dot.style.display = "block";
      dot.setAttribute("cx", cx.toFixed(1));
      dot.setAttribute("cy", cy.toFixed(1));
      const p = series[i];
      tooltip.innerHTML = `<div class="eq-date">${escapeHtml(p.x)}</div><div class="eq-bal">${valueFmt(p.y)}</div>`;
      tooltip.style.display = "block";
      const ttWidth = tooltip.offsetWidth || 120;
      let left = pxX + 10;
      if (left + ttWidth > rect.width) left = pxX - ttWidth - 10;
      if (left < 0) left = 4;
      tooltip.style.left = `${left}px`;
    }
    function hide() {
      crosshair.style.display = "none";
      tooltip.style.display = "none";
      dot.style.display = "none";
    }
    wrap.addEventListener("pointermove", (e) => showAt(e.clientX), { signal: App.signal });
    wrap.addEventListener("pointerleave", hide, { signal: App.signal });
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
  const BREAKDOWN_PAGE_SIZE = 25;
  const breakdownTableState = new Map(); // elId -> { rowsHtml, shown }
  function renderPaginatedBreakdownTable(elId, entries, colLabel, rowHtmlFn) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!entries.length) {
      el.innerHTML = `<div class="empty-state small">No ${escapeHtml(colLabel.toLowerCase())} data yet.</div>`;
      return;
    }
    breakdownTableState.set(elId, { rowsHtml: entries.map(rowHtmlFn), shown: BREAKDOWN_PAGE_SIZE });
    el.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>${colLabel}</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody id="${elId}-tbody"></tbody></table></div>`;
    renderBreakdownTablePage(elId);
  }
  function renderBreakdownTablePage(elId) {
    const state = breakdownTableState.get(elId);
    const tbody = document.getElementById(`${elId}-tbody`);
    if (!state || !tbody) return;
    const shown = Math.min(state.shown, state.rowsHtml.length);
    const remaining = state.rowsHtml.length - shown;
    const moreHtml = remaining > 0
      ? `<tr class="report-row-more"><td colspan="4" style="text-align:center; padding:10px;"><button type="button" class="btn-load-more" data-load-more-table="${elId}">Load more (${remaining} left)</button></td></tr>`
      : "";
    tbody.innerHTML = state.rowsHtml.slice(0, shown).join("") + moreHtml;
    bindTradeToggles(tbody);
    const btn = tbody.querySelector("[data-load-more-table]");
    if (btn) {
      btn.addEventListener("click", () => {
        state.shown += BREAKDOWN_PAGE_SIZE;
        renderBreakdownTablePage(elId);
      }, { signal: App.signal });
    }
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

  // Reports → Compare tab controls (not gated behind trades having loaded —
  // periodStats() just returns an empty result until data arrives)
  const cmpApplyBtn = document.getElementById("cmp-apply");
  if (cmpApplyBtn) cmpApplyBtn.addEventListener("click", updateCompare, { signal: App.signal });
  ["cmp-a-start", "cmp-a-end", "cmp-b-start", "cmp-b-end"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", updateCompare, { signal: App.signal });
  });


  function matchesReportFilters(t) {
    if (reportFilters.symbol && !t.symbol.toLowerCase().includes(reportFilters.symbol.toLowerCase())) return false;
    if (reportFilters.setup !== "all" && t.setup_type !== reportFilters.setup) return false;
    if (reportFilters.tags.length) {
      const tags = t.lesson_tags || [];
      if (!reportFilters.tags.some((tag) => tags.includes(tag))) return false;
    }
    if (reportFilters.durationMin !== null || reportFilters.durationMax !== null) {
      const mins = App.durationMinutes(t);
      if (mins === null) return false;
      if (reportFilters.durationMin !== null && mins < reportFilters.durationMin) return false;
      if (reportFilters.durationMax !== null && mins > reportFilters.durationMax) return false;
    }
    if (reportFilters.dateFrom && t.trade_date < reportFilters.dateFrom) return false;
    if (reportFilters.dateTo && t.trade_date > reportFilters.dateTo) return false;
    return true;
  }
  // renderReports() (and everything it calls) reads the closured `trades`
  // variable. Rather than threading a filtered list through ~20 functions,
  // swap `trades` for the filtered subset for the duration of that
  // (synchronous) render pass, then restore it. Safe because nothing in
  // the reports render chain does anything async.
  function applyReportFiltersAndRender() {
    const fullTrades = App.state.trades;
    App.state.trades = fullTrades.filter(matchesReportFilters);
    renderReports();
    App.state.trades = fullTrades;
  }
  function initReportFilters() {
    const symbolInput = document.getElementById("report-filter-symbol");
    const setupSel = document.getElementById("report-filter-setup");
    const durMinInput = document.getElementById("report-filter-duration-min");
    const durMaxInput = document.getElementById("report-filter-duration-max");
    const dateFromInput = document.getElementById("report-filter-date-from");
    const dateToInput = document.getElementById("report-filter-date-to");
    const tagsToggle = document.getElementById("report-filter-tags-toggle");
    const tagsPanel = document.getElementById("report-filter-tags-panel");
    if (!symbolInput || !setupSel || !durMinInput || !durMaxInput || !dateFromInput || !dateToInput || !tagsToggle || !tagsPanel) return;

    const setups = Array.from(new Set(App.state.trades.map((t) => t.setup_type).filter(Boolean))).sort();
    setupSel.innerHTML =
      '<option value="all">All</option>' +
      setups.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(prettifyTag(s))}</option>`).join("");

    const tagSet = new Set();
    App.state.trades.forEach((t) => (t.lesson_tags || []).forEach((tag) => tagSet.add(tag)));
    const tags = Array.from(tagSet).sort();
    tagsPanel.innerHTML = tags.length
      ? tags.map((tag) => `<label><input type="checkbox" value="${escapeHtml(tag)}"> ${escapeHtml(prettifyTag(tag))}</label>`).join("")
      : '<div class="tags-panel-empty">No tags logged yet.</div>';

    // The actual span of logged trades -- what "Clear filters" resets the
    // date range back to, and what a fresh (no-URL-state) visit starts
    // from, instead of a frozen, hand-typed placeholder date.
    const defaultFrom = App.state.trades.length ? App.state.trades[0].trade_date : "";
    const defaultTo = App.state.trades.length ? App.state.trades[App.state.trades.length - 1].trade_date : "";

    // Restore a search from the URL if we're coming back here (Back
    // button from trade.html) instead of landing fresh -- same NavState
    // pattern used for the calendar/day-view above. Without this, every
    // trip into a trade and back reset the whole filter bar, and typing
    // the exact same search again was the only way to get back to where
    // you were.
    function parseNum(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
    reportFilters.symbol = NavState.get("rsym", "");
    reportFilters.setup = NavState.get("rsetup", "all");
    reportFilters.durationMin = parseNum(NavState.get("rdmin", ""));
    reportFilters.durationMax = parseNum(NavState.get("rdmax", ""));
    const urlTags = NavState.get("rtags", "");
    reportFilters.tags = urlTags ? urlTags.split(",").filter((t) => tags.includes(t)) : [];
    reportFilters.dateFrom = NavState.get("rfrom", defaultFrom);
    reportFilters.dateTo = NavState.get("rto", defaultTo);

    symbolInput.value = reportFilters.symbol;
    if (Array.from(setupSel.options).some((o) => o.value === reportFilters.setup)) setupSel.value = reportFilters.setup;
    else reportFilters.setup = setupSel.value = "all";
    durMinInput.value = reportFilters.durationMin === null ? "" : reportFilters.durationMin;
    durMaxInput.value = reportFilters.durationMax === null ? "" : reportFilters.durationMax;
    dateFromInput.value = reportFilters.dateFrom;
    dateToInput.value = reportFilters.dateTo;
    tagsPanel.querySelectorAll("input[type=checkbox]").forEach((cb) => { cb.checked = reportFilters.tags.includes(cb.value); });
    tagsToggle.textContent = reportFilters.tags.length ? `${reportFilters.tags.length} selected` : "All tags";

    // Writes the whole filter bar into the URL (via NavState) so it
    // survives the round trip through a trade page and back.
    function persistFilters() {
      NavState.set({
        rsym: reportFilters.symbol || null,
        rsetup: reportFilters.setup === "all" ? null : reportFilters.setup,
        rdmin: reportFilters.durationMin === null ? null : reportFilters.durationMin,
        rdmax: reportFilters.durationMax === null ? null : reportFilters.durationMax,
        rtags: reportFilters.tags.length ? reportFilters.tags.join(",") : null,
        rfrom: reportFilters.dateFrom === defaultFrom ? null : reportFilters.dateFrom,
        rto: reportFilters.dateTo === defaultTo ? null : reportFilters.dateTo,
      });
    }

    symbolInput.addEventListener("input", (e) => { reportFilters.symbol = e.target.value.trim(); }, { signal: App.signal });
    setupSel.addEventListener("change", (e) => { reportFilters.setup = e.target.value; }, { signal: App.signal });
    durMinInput.addEventListener("input", (e) => { reportFilters.durationMin = parseNum(e.target.value); }, { signal: App.signal });
    durMaxInput.addEventListener("input", (e) => { reportFilters.durationMax = parseNum(e.target.value); }, { signal: App.signal });
    dateFromInput.addEventListener("change", (e) => { reportFilters.dateFrom = e.target.value || defaultFrom; }, { signal: App.signal });
    dateToInput.addEventListener("change", (e) => { reportFilters.dateTo = e.target.value || defaultTo; }, { signal: App.signal });

    tagsToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      tagsPanel.classList.toggle("open");
    }, { signal: App.signal });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".tags-field")) tagsPanel.classList.remove("open");
    }, { signal: App.signal });
    tagsPanel.addEventListener("change", () => {
      const checked = Array.from(tagsPanel.querySelectorAll("input:checked")).map((cb) => cb.value);
      reportFilters.tags = checked;
      tagsToggle.textContent = checked.length ? `${checked.length} selected` : "All tags";
    }, { signal: App.signal });

    const clearBtn = document.getElementById("report-filter-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      reportFilters = { symbol: "", tags: [], durationMin: null, durationMax: null, setup: "all", dateFrom: defaultFrom, dateTo: defaultTo };
      symbolInput.value = "";
      setupSel.value = "all";
      durMinInput.value = "";
      durMaxInput.value = "";
      dateFromInput.value = defaultFrom;
      dateToInput.value = defaultTo;
      tagsPanel.querySelectorAll("input:checked").forEach((cb) => (cb.checked = false));
      tagsToggle.textContent = "All tags";
      persistFilters();
      applyReportFiltersAndRender();
    }, { signal: App.signal });

    const applyBtn = document.getElementById("report-filter-apply");
    if (applyBtn) applyBtn.addEventListener("click", () => {
      persistFilters();
      applyReportFiltersAndRender();
    }, { signal: App.signal });

    // Daily/Weekly/Monthly/Yearly rollup switcher for the "Trade
    // distribution & performance by <period>" charts -- same underlying
    // aggregation as before (renderPeriodDistPerf), just grouped by a
    // different date-key. Routed through applyReportFiltersAndRender()
    // (not called directly) so a timeframe switch still respects
    // whatever report filters (symbol/setup/duration/date/etc.) are active.
    const periodSelect = document.getElementById("report-period-select");
    if (periodSelect) {
      periodSelect.value = reportPeriodTimeframe;
      periodSelect.addEventListener("change", () => {
        reportPeriodTimeframe = periodSelect.value;
        applyReportFiltersAndRender();
      }, { signal: App.signal });
    }
  }
  function renderReports() {
    // Each of these owns its own, unrelated slice of the page (a
    // different tab/panel's worth of divs) -- one throwing on some
    // edge-case field shouldn't stop the other fifteen from running.
    // See safeRender()'s comment near the top of this file for why.
    App.safeRender(renderDetailedStats, "renderDetailedStats");
    App.safeRender(renderDetailSubtabs, "renderDetailSubtabs");
    App.safeRender(renderPeriodDistPerf, "renderPeriodDistPerf");
    App.safeRender(renderOverviewCumulativePnl, "renderOverviewCumulativePnl");
    App.safeRender(renderStreaks, "renderStreaks");
    App.safeRender(renderHighlights, "renderHighlights");
    App.safeRender(renderSymbolBreakdown, "renderSymbolBreakdown");
    App.safeRender(renderDowBreakdown, "renderDowBreakdown");
    App.safeRender(renderTimeOfDayBreakdown, "renderTimeOfDayBreakdown");
    App.safeRender(renderDurationBreakdown, "renderDurationBreakdown");
    App.safeRender(renderLeaderboards, "renderLeaderboards");
    App.safeRender(renderSectorCountryBreakdown, "renderSectorCountryBreakdown");
    App.safeRender(renderWinLossDays, "renderWinLossDays");
    App.safeRender(renderDrawdown, "renderDrawdown");
    App.safeRender(renderCompare, "renderCompare");
    App.safeRender(renderTagBreakdown, "renderTagBreakdown");
    App.safeRender(renderAdvanced, "renderAdvanced");
  }
  function renderStreaks() {
    // trades already sorted chronologically
    let best = 0, worst = 0, curWinRun = 0, curLossRun = 0;
    let trailingSign = 0, trailingRun = 0;
    App.state.trades.forEach((t) => {
      if (t.win) { curWinRun++; curLossRun = 0; best = Math.max(best, curWinRun); }
      else { curLossRun++; curWinRun = 0; worst = Math.max(worst, curLossRun); }
      if (t.win === (trailingSign === 1)) { trailingRun++; }
      else { trailingSign = t.win ? 1 : -1; trailingRun = 1; }
    });
    const currentLabel = trailingSign === 1 ? `${trailingRun}W` : trailingSign === -1 ? `${trailingRun}L` : "—";
    const currentColor = trailingSign === 1 ? "up" : trailingSign === -1 ? "down" : "";

    document.getElementById("streak-strip").innerHTML = `
      <div class="cell"><div class="label">Current streak</div><div class="value ${currentColor}">${currentLabel}</div></div>
      <div class="cell"><div class="label">Best win streak</div><div class="value up">${best}W</div></div>
      <div class="cell"><div class="label">Worst loss streak</div><div class="value down">${worst}L</div></div>
    `;
  }
  function renderHighlights() {
    const best = App.state.trades.reduce((a, b) => (b.pnl_after_comm > a.pnl_after_comm ? b : a), App.state.trades[0]);
    const worst = App.state.trades.reduce((a, b) => (b.pnl_after_comm < a.pnl_after_comm ? b : a), App.state.trades[0]);
    document.getElementById("highlight-pair").innerHTML = `
      <a class="highlight-card best" href="trade.html?id=${encodeURIComponent(best.id)}" style="text-decoration:none;">
        <div class="label">Best trade</div>
        <div class="sym">${escapeHtml(best.symbol)} <span class="dim" style="font-weight:400;font-size:12px;">${escapeHtml(best.trade_date)}</span></div>
        <div class="pnl up">${fmtMoney(best.pnl_after_comm)}</div>
      </a>
      <a class="highlight-card worst" href="trade.html?id=${encodeURIComponent(worst.id)}" style="text-decoration:none;">
        <div class="label">Worst trade</div>
        <div class="sym">${escapeHtml(worst.symbol)} <span class="dim" style="font-weight:400;font-size:12px;">${escapeHtml(worst.trade_date)}</span></div>
        <div class="pnl down">${fmtMoney(worst.pnl_after_comm)}</div>
      </a>
    `;
  }
  function renderSymbolBreakdown() {
    const bySym = new Map();
    App.state.trades.forEach((t) => {
      if (!bySym.has(t.symbol)) bySym.set(t.symbol, { trades: [], net: 0 });
      const e = bySym.get(t.symbol);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    const rows = Array.from(bySym.entries()).sort((a, b) => b[1].net - a[1].net);
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r[1].net)));

    renderPaginatedBreakdownTable("report-symbol", rows, "Symbol", ([sym, e]) => {
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      const smallSample = e.trades.length < 3;
      const uid = `report-trade-list-${reportRowSeq++}`;
      return `<tr class="report-row" data-trade-toggle="${uid}" style="cursor:pointer;">
        <td style="font-weight:600;">${escapeHtml(sym)}${smallSample ? ` <span class="pill" style="font-size:9.5px; padding:1px 6px;" title="Fewer than 3 trades — win rate isn't meaningful yet.">n=${e.trades.length}</span>` : ""}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>
      <tr class="report-row-detail"><td colspan="4" style="padding:0; border-bottom:none;">${tradeListHtml(e.trades, uid)}</td></tr>`;
    });
  }
  function renderDowBreakdown() {
    const byDow = new Map();
    App.state.trades.forEach((t) => {
      const dow = new Date(t.trade_date + "T12:00:00").getDay();
      if (!byDow.has(dow)) byDow.set(dow, { trades: [], net: 0 });
      const e = byDow.get(dow);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    const order = [1, 2, 3, 4, 5, 0, 6]; // Mon..Sun
    const present = order.filter((d) => byDow.has(d));
    const maxAbs = Math.max(1, ...present.map((d) => Math.abs(byDow.get(d).net)));

    const html = present.map((d) => {
      const e = byDow.get(d);
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      const uid = `report-trade-list-${reportRowSeq++}`;
      return `<tr class="report-row" data-trade-toggle="${uid}" style="cursor:pointer;">
        <td style="font-weight:600;">${DOW[d]}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>
      <tr class="report-row-detail"><td colspan="4" style="padding:0; border-bottom:none;">${tradeListHtml(e.trades, uid)}</td></tr>`;
    }).join("");

    const dowEl = document.getElementById("report-dow");
    dowEl.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>Day</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody>${html}</tbody></table></div>`;
    bindTradeToggles(dowEl);
  }
  // Buckets by ENTRY time, on the theory that when you got in is the
  // habit worth watching (chasing the open, forcing trades at lunch, etc).
  // Times are "HH:MM:SS" strings, which sort/compare correctly as text.
  const TOD_BUCKETS = [
    { label: "Open (9:30–9:45)", from: "09:30:00", to: "09:44:59" },
    { label: "Early (9:45–10:30)", from: "09:45:00", to: "10:29:59" },
    { label: "Mid-morning (10:30–11:30)", from: "10:30:00", to: "11:29:59" },
    { label: "Midday (11:30–14:00)", from: "11:30:00", to: "13:59:59" },
    { label: "Power hour (14:00–15:30)", from: "14:00:00", to: "15:29:59" },
    { label: "Close (15:30–16:00)", from: "15:30:00", to: "16:00:00" },
  ];
  function renderTimeOfDayBreakdown() {
    const buckets = TOD_BUCKETS.map((b) => ({ ...b, trades: [] }));
    const other = [];
    App.state.trades.forEach((t) => {
      const bucket = buckets.find((b) => t.entry_time >= b.from && t.entry_time <= b.to);
      if (bucket) bucket.trades.push(t);
      else other.push(t);
    });
    const present = buckets.filter((b) => b.trades.length);
    const maxAbs = Math.max(1, ...present.map((b) => Math.abs(b.trades.reduce((s, t) => s + t.pnl_after_comm, 0))));

    const rows = present.map((b) => {
      const net = b.trades.reduce((s, t) => s + t.pnl_after_comm, 0);
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (Math.abs(net) / maxAbs) * 100;
      const color = net >= 0 ? "var(--green)" : "var(--red)";
      const uid = `report-trade-list-${reportRowSeq++}`;
      return `<tr class="report-row" data-trade-toggle="${uid}" style="cursor:pointer;">
        <td style="font-weight:600;">${b.label}</td>
        <td class="mono dim">${b.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</span></td>
      </tr>
      <tr class="report-row-detail"><td colspan="4" style="padding:0; border-bottom:none;">${tradeListHtml(b.trades, uid)}</td></tr>`;
    }).join("");

    const el = document.getElementById("report-timeofday");
    if (!rows) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    el.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>Session</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    bindTradeToggles(el);
  }
  const DURATION_BUCKETS = [
    { label: "< 5 min", max: 5 },
    { label: "5–15 min", max: 15 },
    { label: "15–30 min", max: 30 },
    { label: "30–60 min", max: 60 },
    { label: "> 60 min", max: Infinity },
  ];
  function renderDurationBreakdown() {
    const buckets = DURATION_BUCKETS.map((b) => ({ ...b, trades: [] }));
    App.state.trades.forEach((t) => {
      const mins = App.durationMinutes(t);
      if (mins === null) return;
      const bucket = buckets.find((b) => mins <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    const maxCount = Math.max(1, ...buckets.map((b) => b.trades.length));

    const rows = buckets.filter((b) => b.trades.length).map((b) => {
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (b.trades.length / maxCount) * 100;
      const uid = `report-trade-list-${reportRowSeq++}`;
      return `<div class="bar-row" data-trade-toggle="${uid}" style="cursor:pointer;">
        <div class="bar-label">${b.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(0)}%;"></div></div>
        <div class="bar-count">${b.trades.length}x</div>
        <div style="width:52px; text-align:right; flex-shrink:0; color:${winRate >= 50 ? "var(--green)" : "var(--red)"};">${winRate.toFixed(0)}%</div>
      </div>
      ${tradeListHtml(b.trades, uid)}`;
    }).join("");

    const el = document.getElementById("report-duration");
    el.innerHTML = rows || `<div class="empty-state small">No data yet.</div>`;
    bindTradeToggles(el);
  }
  function symbolAgg() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!map.has(t.symbol)) map.set(t.symbol, { trades: [], net: 0 });
      const e = map.get(t.symbol);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return map;
  }
  function leaderboardRows(entries, valueFn, valueCls) {
    return entries.map(([sym, e]) => {
      const uid = `report-trade-list-${reportRowSeq++}`;
      return `
      <div class="bar-row" data-trade-toggle="${uid}" style="cursor:pointer;">
        <div class="bar-label" style="width:70px;">${escapeHtml(sym)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${e._pct}%;"></div></div>
        <div style="width:70px; text-align:right; flex-shrink:0;" class="${valueCls(e)}">${valueFn(e)}</div>
      </div>
      ${tradeListHtml(e.trades, uid)}`;
    }).join("");
  }
  function renderLeaderboards() {
    const map = symbolAgg();
    const entries = Array.from(map.entries());

    const byCount = entries.slice().sort((a, b) => b[1].trades.length - a[1].trades.length).slice(0, 5);
    const maxCount = Math.max(1, ...byCount.map(([, e]) => e.trades.length));
    byCount.forEach(([, e]) => (e._pct = Math.round((e.trades.length / maxCount) * 100)));
    const mostTradedEl = document.getElementById("report-most-traded");
    mostTradedEl.innerHTML =
      leaderboardRows(byCount, (e) => `${e.trades.length}x`, () => "dim") || `<div class="empty-state small">No data yet.</div>`;
    bindTradeToggles(mostTradedEl);

    const byNet = entries.slice().sort((a, b) => b[1].net - a[1].net).slice(0, 5);
    const maxAbsNet = Math.max(1, ...byNet.map(([, e]) => Math.abs(e.net)));
    byNet.forEach(([, e]) => (e._pct = Math.round((Math.abs(e.net) / maxAbsNet) * 100)));
    const mostProfitableEl = document.getElementById("report-most-profitable");
    mostProfitableEl.innerHTML =
      leaderboardRows(byNet, (e) => fmtMoney(e.net), (e) => (e.net >= 0 ? "up" : "down")) || `<div class="empty-state small">No data yet.</div>`;
    bindTradeToggles(mostProfitableEl);
  }
  // sector/country aren't in the documented index schema today (only
  // trade detail files carry symbol_info) -- this reads them from the
  // index row IF the publish step has been extended to copy them over
  // (same pattern as setup_type/lesson_tags), and just shows an empty
  // state otherwise rather than fetching every detail file to fill the
  // gap, which would defeat the whole point of the index existing.
  function groupByField(field) {
    const map = new Map();
    let anyPresent = false;
    App.state.trades.forEach((t) => {
      if (!t[field]) return;
      anyPresent = true;
      if (!map.has(t[field])) map.set(t[field], { trades: [], net: 0 });
      const e = map.get(t[field]);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return anyPresent ? map : null;
  }
  function renderBreakdownTable(elId, map, colLabel) {
    if (!map) {
      const el = document.getElementById(elId);
      if (el) el.innerHTML = `<div class="empty-state small">No ${escapeHtml(colLabel.toLowerCase())} data on these trades yet.</div>`;
      return;
    }
    const rows = Array.from(map.entries()).sort((a, b) => b[1].net - a[1].net);
    const maxAbs = Math.max(1, ...rows.map(([, e]) => Math.abs(e.net)));
    renderPaginatedBreakdownTable(elId, rows, colLabel, ([key, e]) => {
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      const uid = `report-trade-list-${reportRowSeq++}`;
      return `<tr class="report-row" data-trade-toggle="${uid}" style="cursor:pointer;">
        <td style="font-weight:600;">${escapeHtml(key)}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>
      <tr class="report-row-detail"><td colspan="4" style="padding:0; border-bottom:none;">${tradeListHtml(e.trades, uid)}</td></tr>`;
    });
  }
  function renderSectorCountryBreakdown() {
    renderBreakdownTable("report-sector", groupByField("sector"), "Sector");
    renderBreakdownTable("report-country", groupByField("country"), "Country");
  }
  function dailyAgg() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!map.has(t.trade_date)) map.set(t.trade_date, { trades: [], net: 0 });
      const e = map.get(t.trade_date);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return map;
  }
  function dayTableHtml(days) {
    if (!days.length) return `<div class="empty-state small">No data yet.</div>`;
    const rows = days.map((d) => {
      const uid = `report-trade-list-${reportRowSeq++}`;
      return `<tr class="report-row" data-trade-toggle="${uid}" style="cursor:pointer;">
        <td style="font-weight:600;">${d.date}</td>
        <td class="mono dim">${d.count}</td>
        <td class="mono ${d.net >= 0 ? "up" : "down"}">${fmtMoney(d.net)}</td>
      </tr>
      <tr class="report-row-detail"><td colspan="3" style="padding:0; border-bottom:none;">${tradeListHtml(d.trades, uid)}</td></tr>`;
    }).join("");
    return `<div class="table-scroll"><table class="report-table"><thead><tr><th>Date</th><th>Trades</th><th>Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function renderWinLossDays() {
    const map = dailyAgg();
    const days = Array.from(map.entries()).map(([date, e]) => ({ date, net: e.net, count: e.trades.length, trades: e.trades }));
    const summaryEl = document.getElementById("wld-summary");
    if (!days.length) {
      summaryEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      document.getElementById("wld-top-win").innerHTML = `<div class="empty-state small">No data yet.</div>`;
      document.getElementById("wld-top-loss").innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    const winDays = days.filter((d) => d.net > 0);
    const lossDays = days.filter((d) => d.net < 0);
    const avg = (arr) => (arr.length ? arr.reduce((s, d) => s + d.net, 0) / arr.length : 0);

    summaryEl.innerHTML = `
      <div class="streak-strip" style="grid-template-columns:repeat(4,1fr);">
        <div class="cell"><div class="label">Winning days</div><div class="value up">${winDays.length} (${((winDays.length / days.length) * 100).toFixed(0)}%)</div></div>
        <div class="cell"><div class="label">Losing days</div><div class="value down">${lossDays.length} (${((lossDays.length / days.length) * 100).toFixed(0)}%)</div></div>
        <div class="cell"><div class="label">Avg win day</div><div class="value up">${fmtMoney(avg(winDays))}</div></div>
        <div class="cell"><div class="label">Avg loss day</div><div class="value down">${fmtMoney(avg(lossDays))}</div></div>
      </div>`;

    const winEl = document.getElementById("wld-top-win");
    winEl.innerHTML = dayTableHtml(winDays.slice().sort((a, b) => b.net - a.net).slice(0, 8));
    bindTradeToggles(winEl);
    const lossEl = document.getElementById("wld-top-loss");
    lossEl.innerHTML = dayTableHtml(lossDays.slice().sort((a, b) => a.net - b.net).slice(0, 8));
    bindTradeToggles(lossEl);
  }
  // Walks the equity curve (real account balance -- `_balance`, see
  // computeAccountBalances in auth.js; already chronological) tracking the
  // running peak. A drawdown "period" runs from the last new high to the
  // next new high (or to the end of the data if it hasn't recovered).
  function computeDrawdownStats() {
    if (!App.state.trades.length) return null;
    let runPeak = App.state.trades[0]._balance;
    let runPeakTrade = App.state.trades[0];
    let runTroughTrade = App.state.trades[0];
    let inDD = false;
    const periods = [];
    let maxDD = 0, maxDDPeak = App.state.trades[0], maxDDTrough = App.state.trades[0];

    App.state.trades.forEach((t) => {
      if (t._balance >= runPeak) {
        if (inDD) {
          periods.push({ peak: runPeakTrade, trough: runTroughTrade, recover: t });
          inDD = false;
        }
        runPeak = t._balance;
        runPeakTrade = t;
        runTroughTrade = t;
      } else {
        inDD = true;
        if (t._balance < runTroughTrade._balance) runTroughTrade = t;
      }
      const dd = t._balance - runPeak;
      if (dd < maxDD) { maxDD = dd; maxDDPeak = runPeakTrade; maxDDTrough = t; }
    });
    if (inDD) periods.push({ peak: runPeakTrade, trough: runTroughTrade, recover: null });

    const last = App.state.trades[App.state.trades.length - 1];
    const currentDD = last._balance - runPeak;
    const maxDDPct = maxDDPeak._balance !== 0 ? (maxDD / Math.abs(maxDDPeak._balance)) * 100 : null;

    periods.forEach((p) => (p.size = p.trough._balance - p.peak._balance));
    periods.sort((a, b) => a.size - b.size);

    return { maxDD, maxDDPct, maxDDPeak, maxDDTrough, currentDD, periods };
  }
  function renderDrawdown() {
    renderCumulativeCharts();
    const d = computeDrawdownStats();
    const summaryEl = document.getElementById("dd-summary");
    const periodsEl = document.getElementById("dd-periods");
    if (!d) {
      summaryEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      periodsEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    summaryEl.innerHTML = `
      <div class="streak-strip" style="grid-template-columns:repeat(3,1fr);">
        <div class="cell"><div class="label">Max drawdown</div><div class="value down">${fmtMoney(d.maxDD)}${d.maxDDPct != null ? ` (${d.maxDDPct.toFixed(1)}%)` : ""}</div></div>
        <div class="cell"><div class="label">Current drawdown</div><div class="value ${d.currentDD < 0 ? "down" : ""}">${d.currentDD < 0 ? fmtMoney(d.currentDD) : "At peak"}</div></div>
        <div class="cell"><div class="label">Drawdown periods</div><div class="value">${d.periods.length}</div></div>
      </div>`;

    if (!d.periods.length) {
      periodsEl.innerHTML = `<div class="empty-state small">No drawdown periods — equity has only made new highs.</div>`;
      return;
    }
    const rows = d.periods.slice(0, 10).map((p) => `<tr>
        <td><a href="trade.html?id=${encodeURIComponent(p.peak.id)}">${p.peak.trade_date} <span class="dim" style="font-size:11px;">(${fmtMoney(p.peak._balance)})</span></a></td>
        <td><a href="trade.html?id=${encodeURIComponent(p.trough.id)}">${p.trough.trade_date} <span class="dim" style="font-size:11px;">(${fmtMoney(p.trough._balance)})</span></a></td>
        <td class="mono down">${fmtMoney(p.size)}</td>
        <td>${p.recover ? `<a href="trade.html?id=${encodeURIComponent(p.recover.id)}">${p.recover.trade_date}</a>` : `<span class="dim">Ongoing</span>`}</td>
      </tr>`).join("");
    periodsEl.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>Peak</th><th>Trough</th><th>Drawdown</th><th>Recovered</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function periodStats(startDate, endDate) {
    if (!startDate || !endDate) return null;
    const subset = App.state.trades.filter((t) => t.trade_date >= startDate && t.trade_date <= endDate);
    if (!subset.length) return null;
    const wins = subset.filter((t) => t.win);
    const losses = subset.filter((t) => !t.win);
    const net = subset.reduce((s, t) => s + t.pnl_after_comm, 0);
    const winRate = (wins.length / subset.length) * 100;
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl_after_comm, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_after_comm, 0) / losses.length : 0;
    const grossWinSum = wins.reduce((s, t) => s + t.pnl_after_comm, 0);
    const grossLossSum = Math.abs(losses.reduce((s, t) => s + t.pnl_after_comm, 0));
    const profitFactor = grossLossSum > 0 ? grossWinSum / grossLossSum : (grossWinSum > 0 ? Infinity : 0);
    return { n: subset.length, net, winRate, avgWin, avgLoss, profitFactor };
  }
  function periodStatsHtml(s) {
    if (!s) return `<div class="empty-state small">No trades in this range.</div>`;
    const pf = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);
    const rows = [
      ["Trades", s.n],
      ["Net P&amp;L", `<span class="${s.net >= 0 ? "up" : "down"}">${fmtMoney(s.net)}</span>`],
      ["Win rate", s.winRate.toFixed(0) + "%"],
      ["Avg win", fmtMoney(s.avgWin)],
      ["Avg loss", fmtMoney(s.avgLoss)],
      ["Profit factor", pf],
    ];
    return `<div class="kv-list">${rows.map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>`;
  }
  function updateCompare() {
    const aEl = document.getElementById("compare-a");
    const bEl = document.getElementById("compare-b");
    if (!aEl || !bEl) return;
    const aS = document.getElementById("cmp-a-start").value, aE = document.getElementById("cmp-a-end").value;
    const bS = document.getElementById("cmp-b-start").value, bE = document.getElementById("cmp-b-end").value;
    aEl.innerHTML = periodStatsHtml(periodStats(aS, aE));
    bEl.innerHTML = periodStatsHtml(periodStats(bS, bE));
  }
  function renderCompare() {
    if (!App.state.trades.length) { updateCompare(); return; }
    const aStartEl = document.getElementById("cmp-a-start");
    // Only seed defaults once — don't clobber a range the person already picked.
    if (aStartEl && !aStartEl.value) {
      const first = App.state.trades[0].trade_date, last = App.state.trades[App.state.trades.length - 1].trade_date;
      const midDate = App.state.trades[Math.floor(App.state.trades.length / 2)].trade_date;
      aStartEl.value = first;
      document.getElementById("cmp-a-end").value = midDate;
      document.getElementById("cmp-b-start").value = midDate;
      document.getElementById("cmp-b-end").value = last;
    }
    updateCompare();
  }
  function groupByTagArray(field) {
    const map = new Map();
    let any = false;
    App.state.trades.forEach((t) => {
      const tags = t[field];
      if (!tags || !tags.length) return;
      any = true;
      tags.forEach((tag) => {
        if (!map.has(tag)) map.set(tag, { trades: [], net: 0 });
        const e = map.get(tag);
        e.trades.push(t);
        e.net += t.pnl_after_comm;
      });
    });
    return any ? map : null;
  }
  function renderTagBreakdown() {
    renderBreakdownTable("tagb-setup", groupByField("setup_type"), "Setup");
    renderBreakdownTable("tagb-lessons", groupByTagArray("lesson_tags"), "Lesson tag");
  }
  function computeAdvancedStats() {
    if (!App.state.trades.length) return null;
    const s = App.computeStats();
    const n = App.state.trades.length;
    const commPctOfGross = s.grossPnl !== 0 ? (s.totalComm / Math.abs(s.grossPnl)) * 100 : null;
    const tradesPerDay = s.dayCount ? n / s.dayCount : null;

    const dayVals = Array.from(dailyAgg().values()).map((e) => e.net);
    const dayMean = dayVals.reduce((a, b) => a + b, 0) / dayVals.length;
    const daySd = stdev(dayVals);
    const dailySharpe = daySd ? dayMean / daySd : null;

    let curSign = 0, curStreakSum = 0, bestWinStreakSum = 0, worstLossStreakSum = 0;
    App.state.trades.forEach((t) => {
      const sign = t.pnl_after_comm >= 0 ? 1 : -1;
      if (sign === curSign) curStreakSum += t.pnl_after_comm;
      else { curSign = sign; curStreakSum = t.pnl_after_comm; }
      if (curSign === 1) bestWinStreakSum = Math.max(bestWinStreakSum, curStreakSum);
      else worstLossStreakSum = Math.min(worstLossStreakSum, curStreakSum);
    });

    const allHold = App.state.trades.map(durationMinutes).filter((v) => v != null);
    const avgHoldAll = allHold.length ? allHold.reduce((a, b) => a + b, 0) / allHold.length : null;

    return { commPctOfGross, tradesPerDay, dailySharpe, bestWinStreakSum, worstLossStreakSum, avgHoldAll };
  }
  function renderAdvanced() {
    const d = computeAdvancedStats();
    const el = document.getElementById("advanced-grid");
    if (!d) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const rows = [
      ["Commissions as % of Gross P&amp;L", d.commPctOfGross != null ? `<span class="v mono">${d.commPctOfGross.toFixed(1)}%</span>` : naCell("No gross P&L to compare against.")],
      ["Avg Trades per Trading Day", d.tradesPerDay != null ? `<span class="v mono">${d.tradesPerDay.toFixed(1)}</span>` : naCell("No trading days recorded.")],
      ["Daily Sharpe (un-annualized)", d.dailySharpe != null ? `<span class="v mono" title="Mean divided by standard deviation of daily net P&amp;L — not annualized, not risk-free-rate adjusted.">${d.dailySharpe.toFixed(2)}</span>` : naCell("Not enough trading days yet.")],
      ["Best Win Streak ($)", `<span class="v up mono">${fmtMoney(d.bestWinStreakSum)}</span>`],
      ["Worst Loss Streak ($)", `<span class="v down mono">${fmtMoney(d.worstLossStreakSum)}</span>`],
      ["Average Hold Time (all trades)", `<span class="v mono">${fmtDuration(d.avgHoldAll)}</span>`],
    ];
    el.innerHTML = rows.map(([k, v]) => `<div class="stat-line"><span class="k">${k}</span>${v}</div>`).join("");
  }
  // Small stats helpers shared by the grid below.
  function stdev(arr) {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }
  // Abramowitz-Stegun erf approximation, used only to turn a t-stat into
  // an approximate two-tailed p-value (normal approximation — fine for the
  // ballpark "how likely is this by chance" figure, not a rigorous test).
  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }
  function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }
  // Regression slope / standard-error-of-slope of the equity curve against
  // trade index — a rough, un-annualized "consistency of the equity curve"
  // figure in the same spirit as a K-Ratio, computed straight off
  // equity_after (nothing else in the schema tracks daily equity).
  function computeKRatio() {
    const y = App.state.trades.map((t) => t.equity_after);
    const n = y.length;
    if (n < 3) return null;
    const xMean = (n - 1) / 2;
    const yMean = y.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (i - xMean) * (y[i] - yMean); sxx += (i - xMean) ** 2; }
    if (sxx === 0) return null;
    const slope = sxy / sxx;
    let ssRes = 0;
    for (let i = 0; i < n; i++) { const pred = yMean + slope * (i - xMean); ssRes += (y[i] - pred) ** 2; }
    const df = n - 2;
    if (df <= 0) return null;
    const se = Math.sqrt(ssRes / df);
    const seSlope = se / Math.sqrt(sxx);
    return seSlope === 0 ? null : slope / seSlope;
  }
  function computeDetailedStats() {
    const s = App.computeStats();
    const n = App.state.trades.length;
    const pnls = App.state.trades.map((t) => t.pnl_after_comm);
    const largestGain = Math.max(...pnls);
    const largestLoss = Math.min(...pnls);
    const avgDailyGainLoss = s.dayCount ? s.netPnl / s.dayCount : 0;
    const avgTradeGainLoss = n ? s.netPnl / n : 0;

    const perShare = App.state.trades.filter((t) => t.shares).map((t) => t.pnl_after_comm / t.shares);
    const avgPerShare = perShare.length ? perShare.reduce((a, b) => a + b, 0) / perShare.length : null;

    const scratch = App.state.trades.filter((t) => t.pnl_after_comm === 0);
    const avgOf = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const holdWinAvg = avgOf(s.wins.map(durationMinutes).filter((v) => v != null));
    const holdLossAvg = avgOf(s.losses.map(durationMinutes).filter((v) => v != null));
    const holdScratchAvg = avgOf(scratch.map(durationMinutes).filter((v) => v != null));

    let bestWin = 0, bestLoss = 0, curWin = 0, curLoss = 0;
    App.state.trades.forEach((t) => {
      if (t.win) { curWin++; curLoss = 0; bestWin = Math.max(bestWin, curWin); }
      else { curLoss++; curWin = 0; bestLoss = Math.max(bestLoss, curLoss); }
    });

    const sd = stdev(pnls);
    const mean = n ? pnls.reduce((a, b) => a + b, 0) / n : 0;
    const sqn = n && sd ? Math.sqrt(n) * (mean / sd) : null;
    const tstat = n && sd ? mean / (sd / Math.sqrt(n)) : null;
    const pRandom = tstat != null ? 2 * (1 - normalCdf(Math.abs(tstat))) : null;

    const R = s.avgLoss !== 0 ? s.avgWin / Math.abs(s.avgLoss) : null;
    const winFrac = n ? s.wins.length / n : 0;
    const kelly = R ? (winFrac - (1 - winFrac) / R) * 100 : null;

    const kr = computeKRatio();

    return {
      ...s, n, largestGain, largestLoss, avgDailyGainLoss, avgTradeGainLoss, avgPerShare,
      scratchCount: scratch.length, holdWinAvg, holdLossAvg, holdScratchAvg,
      bestWin, bestLoss, sd, sqn, pRandom, kelly, kr,
    };
  }
  function moneyCell(v) {
    return `<span class="v mono ${v >= 0 ? "up" : "down"}">${fmtMoney(v)}</span>`;
  }
  function naCell(title) {
    return `<span class="v na" title="${escapeHtml(title)}">—</span>`;
  }
  function renderDetailedStats() {
    const d = computeDetailedStats();
    const winPct = d.n ? (d.wins.length / d.n) * 100 : 0;
    const lossPct = d.n ? (d.losses.length / d.n) * 100 : 0;

    const rows = [
      ["Total Gain/Loss", moneyCell(d.netPnl)],
      ["Largest Gain", moneyCell(d.largestGain)],
      ["Largest Loss", moneyCell(d.largestLoss)],
      ["Average Daily Gain/Loss", moneyCell(d.avgDailyGainLoss)],
      ["Average Daily Volume", naCell("Needs each symbol's daily market volume flattened onto data/trades.json — not in the schema yet.")],
      ["Average Per-share Gain/Loss", d.avgPerShare != null ? moneyCell(d.avgPerShare) : naCell("No trades with a share count.")],
      ["Average Trade Gain/Loss", moneyCell(d.avgTradeGainLoss)],
      ["Average Winning Trade", moneyCell(d.avgWin)],
      ["Average Losing Trade", moneyCell(d.avgLoss)],
      ["Total Number of Trades", `<span class="v">${d.n}</span>`],
      ["Number of Winning Trades", `<span class="v up">${d.wins.length} (${winPct.toFixed(1)}%)</span>`],
      ["Number of Losing Trades", `<span class="v down">${d.losses.length} (${lossPct.toFixed(1)}%)</span>`],
      ["Average Hold Time (scratch trades)", `<span class="v mono">${fmtDuration(d.holdScratchAvg)}</span>`],
      ["Average Hold Time (winning trades)", `<span class="v mono">${fmtDuration(d.holdWinAvg)}</span>`],
      ["Average Hold Time (losing trades)", `<span class="v mono">${fmtDuration(d.holdLossAvg)}</span>`],
      ["Number of Scratch Trades", `<span class="v">${d.scratchCount}</span>`],
      ["Max Consecutive Wins", `<span class="v up">${d.bestWin}</span>`],
      ["Max Consecutive Losses", `<span class="v down">${d.bestLoss}</span>`],
      ["Trade P&amp;L Standard Deviation", `<span class="v mono">$${d.sd.toFixed(2)}</span>`],
      ["System Quality Number (SQN)", d.sqn != null ? `<span class="v mono" title="PnL-based SQN, not R-multiple-based.">${d.sqn.toFixed(2)}</span>` : naCell("Not enough trades yet.")],
      ["Probability of Random Chance", d.pRandom != null ? `<span class="v mono" title="Approximate — normal-approximation two-tailed p-value.">${(d.pRandom * 100).toFixed(1)}%</span>` : naCell("Not enough trades yet.")],
      ["Kelly Percentage", d.kelly != null ? `<span class="v mono">${d.kelly.toFixed(1)}%</span>` : naCell("Needs both wins and losses to compute.")],
      ["K-Ratio", d.kr != null ? `<span class="v mono" title="Trade-level, un-annualized.">${d.kr.toFixed(2)}</span>` : naCell("Not enough trades yet.")],
      ["Profit Factor", `<span class="v mono">${d.profitFactor === Infinity ? "∞" : d.profitFactor.toFixed(2)}</span>`],
      ["Total Commissions", `<span class="v mono">$${d.totalComm.toFixed(2)}</span>`],
      ["Total Fees", naCell("Only commission is tracked in the current schema — no separate fees field.")],
      ["Average Position MAE", naCell("Needs intrabar adverse-excursion tracking not in the current schema.")],
      ["Average Position MFE", naCell("Needs intrabar favorable-excursion tracking not in the current schema.")],
    ];

    document.getElementById("detailed-stat-grid").innerHTML = rows
      .map(([k, v]) => `<div class="stat-line"><span class="k">${k}</span>${v}</div>`)
      .join("");
  }
  // ---------------------------------------------------------------
  // Shared bucket → report-table renderer for the sub-tabs below.
  // Takes [{label, trades:[...]}] and renders the same money/win%
  // table style as the existing symbol/day-of-week reports.
  // ---------------------------------------------------------------
  function bucketBreakdownTableHtml(buckets, labelHeader) {
    const present = buckets.filter((b) => b.trades.length);
    if (!present.length) return `<div class="empty-state small">No data yet.</div>`;
    const maxAbs = Math.max(1, ...present.map((b) => Math.abs(b.trades.reduce((s, t) => s + t.pnl_after_comm, 0))));
    const rows = present.map((b) => {
      const net = b.trades.reduce((s, t) => s + t.pnl_after_comm, 0);
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (Math.abs(net) / maxAbs) * 100;
      const color = net >= 0 ? "var(--green)" : "var(--red)";
      const uid = `report-trade-list-${reportRowSeq++}`;
      return `<tr class="report-row" data-trade-toggle="${uid}" style="cursor:pointer;">
        <td style="font-weight:600;">${escapeHtml(b.label)}</td>
        <td class="mono dim">${b.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</span></td>
      </tr>
      <tr class="report-row-detail"><td colspan="4" style="padding:0; border-bottom:none;">${tradeListHtml(b.trades, uid)}</td></tr>`;
    }).join("");
    return `<div class="table-scroll"><table class="report-table"><thead><tr><th>${escapeHtml(labelHeader)}</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // bucketBreakdownTableHtml returns markup with the toggle rows baked in,
  // but the click handlers still need binding after each caller drops the
  // string into the DOM via innerHTML — this wraps that so every call site
  // gets the same treatment in one line.
  function setBucketBreakdownHtml(elId, buckets, labelHeader) {
    const el = document.getElementById(elId);
    el.innerHTML = bucketBreakdownTableHtml(buckets, labelHeader);
    bindTradeToggles(el);
  }
  function renderDetailSubtabs() {
    App.safeRender(renderDetailDow, "renderDetailDow");
    App.safeRender(renderDetailHour, "renderDetailHour");
    App.safeRender(renderDetailPrice, "renderDetailPrice");
    App.safeRender(renderDetailSize, "renderDetailSize");
    App.safeRender(renderDetailSymbolTable, "renderDetailSymbolTable");
    App.safeRender(renderDetailSymbolTop20Bottom20, "renderDetailSymbolTop20Bottom20");
    App.safeRender(renderDetailSide, "renderDetailSide");
    App.safeRender(renderDetailSetup, "renderDetailSetup");
    App.safeRender(renderDetailLessons, "renderDetailLessons");
    App.safeRender(renderDetailWinLossRatio, "renderDetailWinLossRatio");
    App.safeRender(renderDetailExpectationBar, "renderDetailExpectationBar");
    App.safeRender(renderDetailDistribution, "renderDetailDistribution");
    App.safeRender(renderDetailExpectancy, "renderDetailExpectancy");
    App.safeRender(renderDetailCumulativePnl, "renderDetailCumulativePnl");
    App.safeRender(renderDetailRvol, "renderDetailRvol");
    App.safeRender(renderDetailAvgVol, "renderDetailAvgVol");
    App.safeRender(() => renderBreakdownTable("detail-float", groupByField("float_tag"), "Float"), "renderBreakdownTable(detail-float)");
  }
  // ---- Days/Times ----
  function renderDetailDow() {
    const byDow = new Map();
    App.state.trades.forEach((t) => {
      const dow = new Date(t.trade_date + "T12:00:00").getDay();
      if (!byDow.has(dow)) byDow.set(dow, { label: DOW[dow], trades: [] });
      byDow.get(dow).trades.push(t);
    });
    const order = [1, 2, 3, 4, 5, 0, 6];
    const buckets = order.filter((d) => byDow.has(d)).map((d) => byDow.get(d));
    setBucketBreakdownHtml("detail-dow", buckets, "Day");
  }
  function renderDetailHour() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      const label = t.entry_time.slice(0, 2) + ":00";
      if (!map.has(label)) map.set(label, { label, trades: [] });
      map.get(label).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
    setBucketBreakdownHtml("detail-hour", buckets, "Hour");
  }
  // ---- Price/Volume ----
  const PRICE_BUCKETS = [
    { label: "< $2", max: 2 }, { label: "$2 – $4.99", max: 4.99 }, { label: "$5 – $9.99", max: 9.99 },
    { label: "$10 – $19.99", max: 19.99 }, { label: "$20 – $49.99", max: 49.99 }, { label: "$50 – $99.99", max: 99.99 },
    { label: "$100 – $199.99", max: 199.99 }, { label: "$200 – $499.99", max: 499.99 }, { label: "$500+", max: Infinity },
  ];
  function renderDetailPrice() {
    const buckets = PRICE_BUCKETS.map((b) => ({ ...b, trades: [] }));
    App.state.trades.forEach((t) => {
      const bucket = buckets.find((b) => t.entry_price <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    renderPairedHistogram("detail-price-dist", "detail-price-perf", buckets, { labelW: 96 });
  }
  const SIZE_BUCKETS = [
    { label: "< 20", max: 20 }, { label: "20 – 49", max: 49 }, { label: "50 – 99", max: 99 },
    { label: "100 – 500", max: 500 }, { label: "500 – 1,000", max: 1000 }, { label: "1,000 – 2,500", max: 2500 },
    { label: "2,500 – 5,000", max: 5000 }, { label: "5,000 – 10,000", max: 10000 }, { label: "10,000+", max: Infinity },
  ];
  function renderDetailSize() {
    const buckets = SIZE_BUCKETS.map((b) => ({ ...b, trades: [] }));
    App.state.trades.forEach((t) => {
      const bucket = buckets.find((b) => t.shares <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    renderPairedHistogram("detail-size-dist", "detail-size-perf", buckets, { labelW: 96 });
  }
  // ---- Instrument ----
  function renderDetailSymbolTable() {
    const map = symbolAgg();
    const buckets = Array.from(map.entries())
      .map(([sym, e]) => ({ label: sym, trades: e.trades }))
      .sort((a, b) => b.trades.length - a.trades.length)
      .slice(0, 10);
    setBucketBreakdownHtml("detail-symbol", buckets, "Symbol");
  }
  // Performance by symbol, Top 20 / Bottom 20 by net P&L -- Tradervue's
  // signature Instrument-tab chart. Every symbol with at least one
  // trade is eligible; a symbol only ever appears on one side (its own
  // net P&L is either >= 0 or < 0, never both).
  function renderDetailSymbolTop20Bottom20() {
    const map = symbolAgg();
    const entries = Array.from(map.entries()).map(([sym, e]) => ({
      label: sym, net: e.net, trades: e.trades,
    }));
    const winners = entries.filter((e) => e.net >= 0).sort((a, b) => b.net - a.net).slice(0, 20);
    const losers = entries.filter((e) => e.net < 0).sort((a, b) => a.net - b.net).slice(0, 20).reverse();

    const chartFor = (elId, rows, color) => {
      const el = document.getElementById(elId);
      if (!el) return;
      if (!rows.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
      el.innerHTML = svgAxisBarChart(
        rows.map((r) => ({ label: r.label, value: r.net, color })),
        { fmt: fmtAxisMoney, labelW: 60, barHeight: 15 }
      );
    };
    chartFor("detail-symbol-top20", winners, "var(--green)");
    chartFor("detail-symbol-bottom20", losers, "var(--red)");
  }
  function renderDetailSide() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      const side = t.side || "unknown";
      if (!map.has(side)) map.set(side, { label: side, trades: [] });
      map.get(side).trades.push(t);
    });
    setBucketBreakdownHtml("detail-side", Array.from(map.values()), "Side");
  }
  // ---- Market Behavior ----
  function renderDetailSetup() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!t.setup_type) return;
      if (!map.has(t.setup_type)) map.set(t.setup_type, { label: t.setup_type, trades: [] });
      map.get(t.setup_type).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => b.trades.length - a.trades.length);
    setBucketBreakdownHtml("detail-setup", buckets, "Setup");
  }
  function renderDetailLessons() {
    const counts = new Map();
    App.state.trades.forEach((t) => (t.lesson_tags || []).forEach((tag) => {
      if (!counts.has(tag)) counts.set(tag, { count: 0, trades: [] });
      const e = counts.get(tag);
      e.count++;
      e.trades.push(t);
    }));
    const entries = Array.from(counts.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
    const el = document.getElementById("detail-lessons");
    if (!entries.length) { el.innerHTML = `<div class="empty-state small">No lesson tags logged yet.</div>`; return; }
    const maxCount = Math.max(...entries.map(([, e]) => e.count));
    el.innerHTML = entries.map(([tag, e]) => {
      const uid = `report-trade-list-${reportRowSeq++}`;
      return `
      <div class="bar-row" data-trade-toggle="${uid}" style="cursor:pointer;">
        <div class="bar-label">${escapeHtml(tag.replace(/_/g, " "))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${((e.count / maxCount) * 100).toFixed(0)}%;"></div></div>
        <div class="bar-count">${e.count}x</div>
      </div>
      ${tradeListHtml(e.trades, uid)}`;
    }).join("");
    bindTradeToggles(el);
  }
  // ---- Win/Loss/Expectation ----
  const PNL_BUCKETS = [
    { label: "< -$500", neg: true, test: (v) => v < -500 },
    { label: "-$500 to -$200", neg: true, test: (v) => v >= -500 && v < -200 },
    { label: "-$200 to -$50", neg: true, test: (v) => v >= -200 && v < -50 },
    { label: "-$50 to $0", neg: true, test: (v) => v >= -50 && v < 0 },
    { label: "$0 to $50", neg: false, test: (v) => v >= 0 && v < 50 },
    { label: "$50 to $200", neg: false, test: (v) => v >= 50 && v < 200 },
    { label: "$200 to $500", neg: false, test: (v) => v >= 200 && v < 500 },
    { label: "> $500", neg: false, test: (v) => v >= 500 },
  ];
  function renderDetailDistribution() {
    const buckets = PNL_BUCKETS.map((b) => ({ ...b, count: 0, trades: [] }));
    App.state.trades.forEach((t) => {
      const b = buckets.find((b) => b.test(t.pnl_after_comm));
      if (b) { b.count++; b.trades.push(t); }
    });
    const present = buckets.filter((b) => b.count);
    const el = document.getElementById("detail-distribution");
    if (!present.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const maxCount = Math.max(...present.map((b) => b.count));
    el.innerHTML = present.map((b) => {
      const uid = `report-trade-list-${reportRowSeq++}`;
      return `
      <div class="bar-row" data-trade-toggle="${uid}" style="cursor:pointer;">
        <div class="bar-label" style="width:130px;">${b.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${((b.count / maxCount) * 100).toFixed(0)}%;background:${b.neg ? "var(--red)" : "var(--green)"};"></div></div>
        <div class="bar-count">${b.count}x</div>
      </div>
      ${tradeListHtml(b.trades, uid)}`;
    }).join("");
    bindTradeToggles(el);
  }
  // ---- Liquidity ----
  // relative_volume is a raw multiplier on each trade row (1.0 = 100% of
  // 30-day average volume) -- real numeric buckets, matching Tradervue's
  // own "% of Nd avg" scale.
  const RVOL_BUCKETS = [
    { label: "25% – 49%", max: 0.49 }, { label: "50% – 74%", max: 0.74 }, { label: "75% – 99%", max: 0.99 },
    { label: "100% – 124%", max: 1.24 }, { label: "125% – 149%", max: 1.49 }, { label: "150% – 199%", max: 1.99 },
    { label: "200% – 299%", max: 2.99 }, { label: "300% – 499%", max: 4.99 }, { label: "500%+", max: Infinity },
  ];
  function renderDetailRvol() {
    const withRvol = App.state.trades.filter((t) => typeof t.relative_volume === "number" && isFinite(t.relative_volume));
    const buckets = RVOL_BUCKETS.map((b) => ({ ...b, trades: [] }));
    const under = { label: "< 25%", trades: [] };
    withRvol.forEach((t) => {
      if (t.relative_volume < 0.25) { under.trades.push(t); return; }
      const bucket = buckets.find((b) => t.relative_volume <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    const all = under.trades.length ? [under, ...buckets] : buckets;
    renderPairedHistogram("detail-rvol-dist", "detail-rvol-perf", all, { labelW: 92 });
  }
  // No raw 30-day-average-volume number is carried on the trades index
  // (only trade.js's per-trade detail fetch sees that) -- so this uses
  // the index's own avg_volume_tag categories rather than fabricating
  // Tradervue's exact dollar-volume tiers off data that isn't there.
  function renderDetailAvgVol() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!t.avg_volume_tag) return;
      if (!map.has(t.avg_volume_tag)) map.set(t.avg_volume_tag, []);
      map.get(t.avg_volume_tag).push(t);
    });
    const buckets = Array.from(map.entries()).map(([label, ts]) => ({ label: prettifyTag(label), trades: ts }));
    renderPairedHistogram("detail-avgvol-dist", "detail-avgvol-perf", buckets, { labelW: 92 });
  }
  // ---- Win/Loss/Expectation ----
  function renderDetailWinLossRatio() {
    const d = computeDetailedStats();
    const donutEl = document.getElementById("detail-winloss-donut");
    const cmpEl = document.getElementById("detail-winloss-compare");
    if (!donutEl || !cmpEl) return;
    if (!d.n) {
      donutEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      cmpEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    const winPct = (d.wins.length / d.n) * 100;
    donutEl.innerHTML = svgDonutChart(winPct) + `<div style="text-align:center; color:var(--text-faint); font-size:11.5px; margin-top:4px;">${d.wins.length} wins · ${d.losses.length} losses</div>`;
    const grossWin = d.wins.reduce((s, t) => s + t.pnl_after_comm, 0);
    const grossLoss = d.losses.reduce((s, t) => s + t.pnl_after_comm, 0);
    cmpEl.innerHTML = svgAxisBarChart(
      [{ label: "Gain", value: grossWin, color: "var(--green)" }, { label: "Loss", value: grossLoss, color: "var(--red)" }],
      { fmt: fmtAxisMoney, labelW: 56, barHeight: 34 }
    );
  }
  function renderDetailExpectationBar() {
    const d = computeDetailedStats();
    const el = document.getElementById("detail-expectation-bar");
    if (!el) return;
    if (!d.n) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const winRateFrac = d.wins.length / d.n, lossRateFrac = d.losses.length / d.n;
    const expectancy = winRateFrac * d.avgWin + lossRateFrac * d.avgLoss;
    el.innerHTML = svgAxisBarChart(
      [{ label: "Expectation", value: expectancy, color: expectancy >= 0 ? "var(--green)" : "var(--red)" }],
      { fmt: fmtAxisMoney, labelW: 84, barHeight: 34 }
    ) + `<div style="text-align:center; color:var(--text-faint); font-size:11.5px; margin-top:2px;">Expected P&amp;L per trade</div>`;
  }
  function renderDetailExpectancy() {
    const d = computeDetailedStats();
    const el = document.getElementById("detail-expectancy");
    if (!d.n) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const winRateFrac = d.wins.length / d.n;
    const lossRateFrac = d.losses.length / d.n;
    const expectancy = winRateFrac * d.avgWin + lossRateFrac * d.avgLoss;
    const ratio = d.avgLoss !== 0 ? d.avgWin / Math.abs(d.avgLoss) : null;
    const rows = [
      ["Win rate", (winRateFrac * 100).toFixed(1) + "%"],
      ["Avg win / avg loss ratio", ratio != null ? ratio.toFixed(2) : "—"],
      ["Expectancy per trade", fmtMoney(expectancy)],
      ["Kelly percentage", d.kelly != null ? d.kelly.toFixed(1) + "%" : "—"],
    ];
    el.innerHTML = `<div class="kv-list">${rows.map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>`;
  }
  // Tradervue-style Daily/Weekly/Monthly/Yearly rollup switcher (see
  // #report-period-select). All four timeframes are the exact same
  // group-by-date-key-then-net-P&L aggregation Monthly already did --
  // only periodKey() below changes per timeframe. Monthly stays the
  // default so existing behavior/screenshots don't shift.
  const PERIOD_NOUN = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
  // Returns the bucket key + display label for one trade's trade_date
  // under the given timeframe. Weekly buckets by the Monday that starts
  // ISO week the trade falls in (labeled as that Monday's date, so bars
  // read left-to-right in real chronological order same as the other
  // timeframes) -- "T12:00:00" avoids the DST/UTC-rollover edge cases
  // the rest of this file already works around when parsing trade_date.
  function periodKey(dateStr, timeframe) {
    if (!dateStr) return null;
    if (timeframe === "yearly") return dateStr.slice(0, 4);
    if (timeframe === "monthly") return dateStr.slice(0, 7);
    if (timeframe === "daily") return dateStr;
    // weekly
    const d = new Date(dateStr + "T12:00:00");
    const dow = d.getDay(); // 0=Sun..6=Sat
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + mondayOffset);
    return `${d.getFullYear()}-${App.pad2(d.getMonth() + 1)}-${App.pad2(d.getDate())}`;
  }
  function renderPeriodDistPerf() {
    const timeframe = reportPeriodTimeframe || "monthly";
    const noun = PERIOD_NOUN[timeframe] || "month";

    const labelEl = document.getElementById("report-period-label");
    if (labelEl) labelEl.innerHTML = `Trade distribution &amp; performance by ${noun}`;
    const distTitleEl = document.getElementById("report-period-dist-title");
    if (distTitleEl) distTitleEl.textContent = `Trade distribution by ${noun}`;
    const perfTitleEl = document.getElementById("report-period-perf-title");
    if (perfTitleEl) perfTitleEl.textContent = `Performance by ${noun}`;

    const map = new Map();
    App.state.trades.forEach((t) => {
      const key = periodKey(t.trade_date, timeframe);
      if (!key) return;
      if (!map.has(key)) map.set(key, { label: key, trades: [] });
      map.get(key).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
    renderPairedHistogram("report-month-dist", "report-month-perf", buckets, { labelW: 64, barHeight: 15 });
  }
  function renderCumulativeCharts() {
    const pnlEl = document.getElementById("dd-cum-pnl");
    const ddEl = document.getElementById("dd-cum-drawdown");
    if (!pnlEl || !ddEl) return;
    if (!App.state.trades.length) {
      pnlEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      ddEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    // Use the real account balance (`_balance` -- Settings ledger +
    // cumulative P&L, see computeAccountBalances in auth.js) so a deposit
    // or withdrawal moves these charts the same way it already moves the
    // Max/Current drawdown figures and Drawdown periods table above.
    const startBalance = App.state.trades[0]._balance - (App.state.trades[0].pnl_after_comm || 0);
    const cumPnl = App.state.trades.map((t) => t._balance - startBalance);
    let runPeak = -Infinity;
    const drawdown = cumPnl.map((v) => { runPeak = Math.max(runPeak, v); return v - runPeak; });
    renderMiniLineChart(pnlEl, App.state.trades.map((t, i) => ({ x: t.trade_date, y: cumPnl[i] })));
    renderMiniLineChart(ddEl, App.state.trades.map((t, i) => ({ x: t.trade_date, y: drawdown[i] })));
  }
  // ================================================================
  // REPORTS — Overview: Cumulative P&L with its own 30/60/90/All toggle
  // (Detailed's Win/Loss/Expectation cumulative chart below reuses the
  // page's already-selected date range instead, since it sits alongside
  // panels that don't have their own toggle either.)
  // ================================================================
  let overviewCumRange = "90"; // "30" | "60" | "90" | "all"
  function overviewCumSubset() {
    if (overviewCumRange === "all" || !App.state.trades.length) return App.state.trades;
    const days = parseInt(overviewCumRange, 10);
    const anchor = new Date(App.state.trades[App.state.trades.length - 1].trade_date + "T12:00:00");
    const cutoff = new Date(anchor);
    cutoff.setDate(cutoff.getDate() - days);
    const subset = App.state.trades.filter((t) => new Date(t.trade_date + "T12:00:00") >= cutoff);
    return subset.length ? subset : App.state.trades;
  }
  function bindOverviewCumRangeToggle() {
    const wrap = document.getElementById("ov-cumpnl-range-toggle");
    if (!wrap || wrap.dataset.bound) return;
    wrap.dataset.bound = "1";
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn) return;
      overviewCumRange = btn.dataset.range;
      wrap.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      renderOverviewCumulativePnl();
    }, { signal: App.signal });
  }
  function renderOverviewCumulativePnl() {
    bindOverviewCumRangeToggle();
    const el = document.getElementById("report-cum-pnl");
    if (!el) return;
    const subset = overviewCumSubset();
    if (!subset.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    let running = 0;
    const series = subset.map((t) => { running += t.pnl_after_comm; return { x: t.trade_date, y: running }; });
    renderMiniLineChart(el, series);
  }
  // Win/Loss/Expectation's own Cumulative P&L -- tracks whatever `trades`
  // currently holds (the page's overall date range / filters), same as
  // its sibling panels in that grid.
  function renderDetailCumulativePnl() {
    const el = document.getElementById("detail-cum-pnl");
    if (!el) return;
    if (!App.state.trades.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    let running = 0;
    const series = App.state.trades.map((t) => { running += t.pnl_after_comm; return { x: t.trade_date, y: running }; });
    renderMiniLineChart(el, series);
  }

  App.tabs.reports.initReportFilters = initReportFilters;
  App.tabs.reports.applyReportFiltersAndRender = applyReportFiltersAndRender;
})();
