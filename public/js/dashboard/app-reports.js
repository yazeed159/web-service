(function () {
  "use strict";
  const R = (App.reports = App.reports || {});
  const { ADV_DEFAULTS, renderReports, updateCompare } = R;

  let reportFilters = { symbol: "", tags: [], durationMin: null, durationMax: null, setup: "all", dateFrom: "", dateTo: "", ...ADV_DEFAULTS, days: [] };
  let updateFiltersToggle = function () {}; // set by initReportFilters (phone filter bar summary)
  let reportPeriodTimeframe = "monthly"; // daily | weekly | monthly | yearly -- see renderPeriodDistPerf

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

    // ---- Advanced filters. A trade missing the field being filtered on
    // (no price / no entry time recorded) can't satisfy the filter, so it's
    // left out -- same rule the duration filter above uses.
    const f = reportFilters;
    if (f.side !== "all" && String(t.side || "").toLowerCase() !== f.side) return false;
    if (f.result !== "all" && Boolean(t.win) !== (f.result === "win")) return false;
    if (!inNumRange(t.pnl_after_comm, f.pnlMin, f.pnlMax)) return false;
    if (!inNumRange(t.entry_price, f.priceMin, f.priceMax)) return false;
    if (!inNumRange(t.shares, f.sharesMin, f.sharesMax)) return false;
    if (f.timeFrom || f.timeTo) {
      const hm = typeof t.entry_time === "string" ? t.entry_time.slice(0, 5) : "";
      if (!hm) return false;
      if (f.timeFrom && hm < f.timeFrom) return false;
      if (f.timeTo && hm > f.timeTo) return false;
    }
    if (f.days.length) {
      // Build the date from its parts (local time) -- new Date("YYYY-MM-DD")
      // is UTC midnight and can land on the previous weekday in some zones.
      const [y, m, d] = String(t.trade_date).split("-").map(Number);
      if (!f.days.includes(new Date(y, m - 1, d).getDay())) return false;
    }
    return true;
  }
  function inNumRange(v, lo, hi) {
    if (lo === null && hi === null) return true;
    const n = v == null || v === "" ? NaN : Number(v);
    if (!Number.isFinite(n)) return false;
    return (lo === null || n >= lo) && (hi === null || n <= hi);
  }
  // renderReports() (and everything it calls) reads the closured `trades`
  // variable. Rather than threading a filtered list through ~20 functions,
  // swap `trades` for the filtered subset for the duration of that
  // (synchronous) render pass, then restore it. Safe because nothing in
  // the reports render chain does anything async.
  function applyReportFiltersAndRender() {
    const fullTrades = App.state.trades;
    App.state.trades = fullTrades.filter(matchesReportFilters);
    // try/finally: if a render throws, state.trades must still go back to
    // the full list -- the Day View and Dashboard read it too.
    try {
      renderReports();
    } finally {
      App.state.trades = fullTrades;
    }
  }
  // initReportFilters() runs once per render pass that (re)builds the filter
  // bar -- and Reports can render twice on arrival (the cached on-device
  // snapshot first, then the fresh network data). Each run used to stack a
  // second set of listeners on the SAME buttons, so on a phone the Filters
  // button opened the sheet and the duplicate closed it again in the same tap
  // (and Advanced, Tags and the weekday chips cancelled themselves out the
  // same way). Every run now drops the previous run's listeners first; they
  // still all die with App.signal when the page is torn down.
  let filterInitCtl = null;
  function freshFilterSignal() {
    if (filterInitCtl) filterInitCtl.abort();
    const ctl = (filterInitCtl = new AbortController());
    App.signal.addEventListener("abort", () => ctl.abort(), { once: true, signal: ctl.signal });
    return ctl.signal;
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
    const sig = freshFilterSignal();

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

    // ---- "Advanced" filter panel (opened by the Advanced button).
    const advBtn = document.getElementById("report-filter-advanced");
    const advPanel = document.getElementById("report-advanced-panel");
    const advEls = advPanel ? {
      side: document.getElementById("report-filter-side"),
      result: document.getElementById("report-filter-result"),
      pnlMin: document.getElementById("report-filter-pnl-min"),
      pnlMax: document.getElementById("report-filter-pnl-max"),
      priceMin: document.getElementById("report-filter-price-min"),
      priceMax: document.getElementById("report-filter-price-max"),
      sharesMin: document.getElementById("report-filter-shares-min"),
      sharesMax: document.getElementById("report-filter-shares-max"),
      timeFrom: document.getElementById("report-filter-time-from"),
      timeTo: document.getElementById("report-filter-time-to"),
    } : null;
    const dowChips = advPanel ? Array.from(advPanel.querySelectorAll(".dow-chip")) : [];
    const advNumKeys = ["pnlMin", "pnlMax", "priceMin", "priceMax", "sharesMin", "sharesMax"];
    // URL keys for each advanced filter (kept short, like rsym / rdmin above).
    const ADV_URL = { side: "rside", result: "rres", pnlMin: "rpmin", pnlMax: "rpmax", priceMin: "rprmin", priceMax: "rprmax",
      sharesMin: "rshmin", sharesMax: "rshmax", timeFrom: "rtfrom", timeTo: "rtto" };
    function advancedActiveCount() {
      const f = reportFilters;
      const pair = (a, b) => (f[a] !== null || f[b] !== null ? 1 : 0);
      return (f.side !== "all" ? 1 : 0) + (f.result !== "all" ? 1 : 0)
        + pair("pnlMin", "pnlMax") + pair("priceMin", "priceMax") + pair("sharesMin", "sharesMax")
        + (f.timeFrom || f.timeTo ? 1 : 0) + (f.days.length ? 1 : 0);
    }
    // "Advanced" -> "Advanced · 2" (and highlighted) while any extra filter is set,
    // so a collapsed panel can't be silently narrowing the reports.
    function updateAdvancedBadge() {
      if (!advBtn) return;
      const n = advancedActiveCount();
      advBtn.textContent = n ? `Advanced · ${n}` : "Advanced";
      advBtn.classList.toggle("active", n > 0);
    }
    function syncAdvancedInputs() {
      if (!advEls) return;
      advEls.side.value = reportFilters.side;
      advEls.result.value = reportFilters.result;
      advNumKeys.forEach((k) => { advEls[k].value = reportFilters[k] === null ? "" : reportFilters[k]; });
      advEls.timeFrom.value = reportFilters.timeFrom;
      advEls.timeTo.value = reportFilters.timeTo;
      dowChips.forEach((c) => c.classList.toggle("on", reportFilters.days.includes(Number(c.dataset.dow))));
      updateAdvancedBadge();
    }
    if (advPanel) {
      const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
      reportFilters.side = oneOf(NavState.get(ADV_URL.side, "all"), ["all", "long", "short"], "all");
      reportFilters.result = oneOf(NavState.get(ADV_URL.result, "all"), ["all", "win", "loss"], "all");
      advNumKeys.forEach((k) => { reportFilters[k] = parseNum(NavState.get(ADV_URL[k], "")); });
      const hhmm = (v) => (/^\d{2}:\d{2}$/.test(v) ? v : "");
      reportFilters.timeFrom = hhmm(NavState.get(ADV_URL.timeFrom, ""));
      reportFilters.timeTo = hhmm(NavState.get(ADV_URL.timeTo, ""));
      const urlDays = NavState.get("rdow", "");
      reportFilters.days = urlDays ? urlDays.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) : [];
      syncAdvancedInputs();
      // Coming back to a page with advanced filters in the URL: show them.
      if (advancedActiveCount() > 0) { advPanel.classList.add("open"); advBtn.setAttribute("aria-expanded", "true"); }
    }

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
        ...(advPanel ? {
          [ADV_URL.side]: reportFilters.side === "all" ? null : reportFilters.side,
          [ADV_URL.result]: reportFilters.result === "all" ? null : reportFilters.result,
          [ADV_URL.pnlMin]: reportFilters.pnlMin, [ADV_URL.pnlMax]: reportFilters.pnlMax,
          [ADV_URL.priceMin]: reportFilters.priceMin, [ADV_URL.priceMax]: reportFilters.priceMax,
          [ADV_URL.sharesMin]: reportFilters.sharesMin, [ADV_URL.sharesMax]: reportFilters.sharesMax,
          [ADV_URL.timeFrom]: reportFilters.timeFrom || null, [ADV_URL.timeTo]: reportFilters.timeTo || null,
          rdow: reportFilters.days.length ? reportFilters.days.join(",") : null,
        } : {}),
      });
    }

    // Advanced panel: open/close, and keep reportFilters in step with the inputs.
    if (advBtn && advPanel) {
      advBtn.addEventListener("click", () => {
        const open = advPanel.classList.toggle("open");
        advBtn.setAttribute("aria-expanded", String(open));
      }, { signal: sig });
      advEls.side.addEventListener("change", (e) => { reportFilters.side = e.target.value; updateAdvancedBadge(); }, { signal: sig });
      advEls.result.addEventListener("change", (e) => { reportFilters.result = e.target.value; updateAdvancedBadge(); }, { signal: sig });
      advNumKeys.forEach((k) => {
        advEls[k].addEventListener("input", (e) => { reportFilters[k] = parseNum(e.target.value); updateAdvancedBadge(); }, { signal: sig });
      });
      ["timeFrom", "timeTo"].forEach((k) => {
        const onTime = (e) => { reportFilters[k] = e.target.value || ""; updateAdvancedBadge(); };
        advEls[k].addEventListener("input", onTime, { signal: sig });
        advEls[k].addEventListener("change", onTime, { signal: sig });
      });
      dowChips.forEach((chip) => chip.addEventListener("click", () => {
        const d = Number(chip.dataset.dow);
        reportFilters.days = reportFilters.days.includes(d) ? reportFilters.days.filter((x) => x !== d) : reportFilters.days.concat(d);
        chip.classList.toggle("on", reportFilters.days.includes(d));
        updateAdvancedBadge();
      }, { signal: sig }));
    }

    // ---- Phone filter bar: one summary row that opens the whole form (basic + Advanced fields).
    const rftBtn = document.getElementById("rpt-filters-toggle");
    const rftSheet = document.getElementById("rpt-filter-sheet");
    const rftCount = document.getElementById("rpt-filters-count");
    const rftSum = document.getElementById("rpt-filters-sum");
    const shortDate = (iso) => { const d = new Date(iso + "T00:00:00"); return isNaN(d) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
    updateFiltersToggle = function () {
      if (!rftBtn) return;
      const f = reportFilters;
      const n = (f.symbol ? 1 : 0) + (f.setup !== "all" ? 1 : 0) + (f.tags.length ? 1 : 0)
        + (f.durationMin !== null || f.durationMax !== null ? 1 : 0)
        + (f.dateFrom !== defaultFrom || f.dateTo !== defaultTo ? 1 : 0) + advancedActiveCount();
      rftCount.textContent = n ? String(n) : "";
      rftBtn.classList.toggle("has-active", n > 0);
      rftSum.textContent = f.dateFrom && f.dateTo ? `${shortDate(f.dateFrom)} \u2013 ${shortDate(f.dateTo)}` : "All dates";
    };
    function setSheet(open) {
      if (!rftBtn || !rftSheet) return;
      rftSheet.classList.toggle("open", open);
      rftBtn.setAttribute("aria-expanded", String(open));
    }
    if (rftBtn && rftSheet) {
      rftBtn.addEventListener("click", () => setSheet(!rftSheet.classList.contains("open")), { signal: sig });
      // Apply / Clear both re-render; on a phone that should also fold the form away so the results are in view.
      ["report-filter-apply", "report-filter-clear"].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.addEventListener("click", () => setSheet(false), { signal: sig });
      });
    }
    updateFiltersToggle();
    // Desktop: same summary button, folded until opened; the open form floats over the page (see .rpt-filter-wrap).
    // Click elsewhere / Esc folds it away.
    document.addEventListener("click", (e) => { if (rftSheet && rftSheet.classList.contains("open") && !e.target.closest(".rpt-filter-wrap")) setSheet(false); }, { signal: sig });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && rftSheet && rftSheet.classList.contains("open")) setSheet(false); }, { signal: sig });

    symbolInput.addEventListener("input", (e) => { reportFilters.symbol = e.target.value.trim(); }, { signal: sig });
    setupSel.addEventListener("change", (e) => { reportFilters.setup = e.target.value; }, { signal: sig });
    durMinInput.addEventListener("input", (e) => { reportFilters.durationMin = parseNum(e.target.value); }, { signal: sig });
    durMaxInput.addEventListener("input", (e) => { reportFilters.durationMax = parseNum(e.target.value); }, { signal: sig });
    dateFromInput.addEventListener("change", (e) => { reportFilters.dateFrom = e.target.value || defaultFrom; }, { signal: sig });
    dateToInput.addEventListener("change", (e) => { reportFilters.dateTo = e.target.value || defaultTo; }, { signal: sig });

    tagsToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      tagsPanel.classList.toggle("open");
    }, { signal: sig });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".tags-field")) tagsPanel.classList.remove("open");
    }, { signal: sig });
    tagsPanel.addEventListener("change", () => {
      const checked = Array.from(tagsPanel.querySelectorAll("input:checked")).map((cb) => cb.value);
      reportFilters.tags = checked;
      tagsToggle.textContent = checked.length ? `${checked.length} selected` : "All tags";
    }, { signal: sig });

    const clearBtn = document.getElementById("report-filter-clear");
    if (clearBtn) clearBtn.addEventListener("click", () => {
      reportFilters = { symbol: "", tags: [], durationMin: null, durationMax: null, setup: "all", dateFrom: defaultFrom, dateTo: defaultTo, ...ADV_DEFAULTS, days: [] };
      syncAdvancedInputs();
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
    }, { signal: sig });

    const applyBtn = document.getElementById("report-filter-apply");
    if (applyBtn) applyBtn.addEventListener("click", () => {
      persistFilters();
      applyReportFiltersAndRender();
    }, { signal: sig });

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
      }, { signal: sig });
    }
  }
  Object.assign(R, { applyReportFiltersAndRender, initReportFilters });
  Object.defineProperty(R, "updateFiltersToggle", { get: () => updateFiltersToggle, configurable: true });
  Object.defineProperty(R, "reportPeriodTimeframe", { get: () => reportPeriodTimeframe, configurable: true });
})();
