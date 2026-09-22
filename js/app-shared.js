(function () {
  "use strict";

  // index.html's Dashboard/Day View/Reports tabs used to be one 2,686-line
  // app.js. Split along those tab boundaries into four files, always
  // loaded together in this order (see SPA_PAGES.index in
  // page-transition.js, and the <script> tags in index.html):
  //   app-shared.js    (this file) -- teardown/fetch/state/nav/helpers
  //   app-dashboard.js -- stat cards, trader score, mini calendar, equity
  //                       curve, recent trades
  //   app-dayview.js   -- the full Day View calendar + day-detail panel
  //   app-reports.js   -- everything under the Reports tab
  //
  // The three tab files never talk to each other directly -- they only
  // read/call things off `window.App`, which this file builds below and
  // which is guaranteed to exist by the time they run (page-transition.js
  // loads "owned" scripts strictly in order, awaiting each one's load
  // event before appending the next -- see runPageScripts there). Each
  // tab file registers its entry points onto `App.tabs.<tab>` so this
  // file's fetch-then-render orchestrator (below) can call into them.
  //
  // page-transition.js's SPA router re-inserts all four scripts fresh
  // (brand new <script> elements) on every hop that lands on index.html --
  // that's necessary, since the freshly-swapped .tab-panel/nav-item DOM
  // needs its listeners rebound and its data re-rendered -- but a plain
  // re-insertion doesn't unbind anything the PREVIOUS copies set up.
  // Bounce between two pages that both route here (e.g. Journal -> Reports
  // -> Journal -> Reports) and every hop would stack one more full set of
  // nav listeners on top of the last, plus one more concurrent trades
  // fetch + render pass -- all still wired to whatever DOM existed at the
  // moment each copy loaded.
  //
  // Fix: every addEventListener anywhere in these four files is registered
  // with `App.signal`, and window.__appTeardown() (called by
  // page-transition.js right before it loads fresh copies) aborts it --
  // detaching every listener this navigation's copies own in one shot.
  // `cancelled` stops this copy's in-flight fetch/render work from
  // touching the DOM if it resolves after that teardown.
  if (window.__appTeardown) window.__appTeardown();
  const abortController = new AbortController();
  const signal = abortController.signal;
  let cancelled = false;
  window.__appTeardown = function () {
    cancelled = true;
    abortController.abort();
  };

  // Shared mutable state + helpers used by app-dashboard.js /
  // app-dayview.js / app-reports.js. `state` is a single object so a
  // property write here (e.g. app-reports.js's applyReportFiltersAndRender
  // temporarily swapping state.trades for a filtered subset, then
  // restoring it -- see app-reports.js) is immediately visible to every
  // other file, the same way the old single-closure `trades` variable was.
  const state = {
    trades: [],
    hasCapitalLedger: false, // set once trades load -- see the fetch below
    calYear: null,
    calMonth: null, // 0-indexed
    selectedDay: null,
  };

  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  // Day View calendar: markets are closed Sat/Sun, so those columns are
  // dropped in favor of a weekly total box. Also used by the dashboard's
  // mini calendar (buildMonthGridHtml below is shared by both).
  const WEEKDAYS_MF = ["Mon", "Tue", "Wed", "Thu", "Fri"];

  const statGrid = document.getElementById("stat-grid");

  // Runs `fn`, and if it throws, logs the real error to the console
  // (so it's debuggable) instead of letting it bubble up and abort
  // whatever section-rendering sequence called it. Every render* call
  // in the pipeline below is wrapped in this -- previously one bad
  // field on one trade (missing/empty in a way a single renderX
  // didn't expect) would throw, and since renderReports() etc. call
  // 10-16 render functions back-to-back synchronously, that exception
  // aborted every render call still queued after it. Only the outer
  // .catch() would fire, and it only ever touched 3 elements
  // (recent-trades/statGrid/last-updated) -- every other section's
  // "Loading…" placeholder (detail-*, wld-*, dd-*, compare-*, tagb-*,
  // report-*, ...) was simply never reached again and sat there
  // looking stuck forever, even though the underlying data was fine.
  function safeRender(fn, label) {
    try {
      fn();
    } catch (err) {
      console.error(`[app.js] ${label} failed:`, err);
    }
  }
  // Final safety net: after every render attempt above has run (in
  // whatever order, whichever ones threw), sweep the DOM for any
  // "Loading…" placeholder that never got replaced -- whether from a
  // renderX we forgot to wrap, one that updates a different element
  // than expected, or a future bug we haven't hit yet -- and turn it
  // into a visible, honest "couldn't load" state instead of leaving
  // the person staring at a spinner that will never resolve.
  function clearStrandedLoadingStates() {
    document.querySelectorAll(".loading-line").forEach((el) => {
      const container = el.parentElement || el;
      container.innerHTML = '<div class="empty-state small">Couldn\'t load this section — check the console for details.</div>';
    });
  }
  // bindTradeToggles() now in utils.js (loads first on every page).
  function pad2(n) { return String(n).padStart(2, "0"); }
  function dateKey(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }
  function computeStats(list) {
    list = list || state.trades;
    const wins = list.filter((t) => t.win);
    const losses = list.filter((t) => !t.win);
    const winRate = list.length ? (wins.length / list.length) * 100 : 0;
    const grossPnl = list.reduce((s, t) => s + t.pnl_before_comm, 0);
    const totalComm = list.reduce((s, t) => s + t.commission, 0);
    const netPnl = list.reduce((s, t) => s + t.pnl_after_comm, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl_after_comm, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_after_comm, 0) / losses.length : 0;
    const grossWinSum = wins.reduce((s, t) => s + t.pnl_after_comm, 0);
    const grossLossSum = Math.abs(losses.reduce((s, t) => s + t.pnl_after_comm, 0));
    const profitFactor = grossLossSum > 0 ? grossWinSum / grossLossSum : (grossWinSum > 0 ? Infinity : 0);

    const byDay = new Map();
    list.forEach((t) => {
      if (!byDay.has(t.trade_date)) byDay.set(t.trade_date, 0);
      byDay.set(t.trade_date, byDay.get(t.trade_date) + t.pnl_after_comm);
    });
    const dayVals = Array.from(byDay.values());
    const winDays = dayVals.filter((v) => v > 0).length;
    const dayWinRate = dayVals.length ? (winDays / dayVals.length) * 100 : 0;

    return { wins, losses, winRate, grossPnl, totalComm, netPnl, avgWin, avgLoss, profitFactor, dayWinRate, dayCount: dayVals.length, count: list.length };
  }
  function pnlByDay() {
    const map = new Map();
    state.trades.forEach((t) => {
      if (!map.has(t.trade_date)) map.set(t.trade_date, { net: 0, gross: 0, comm: 0, count: 0, trades: [] });
      const e = map.get(t.trade_date);
      e.net += t.pnl_after_comm;
      e.gross += t.pnl_before_comm;
      e.comm += t.commission || 0;
      e.count += 1;
      e.trades.push(t);
    });
    return map;
  }
  // Builds the same Mon-Fri-plus-weekly-total grid markup used by the Day
  // View calendar (see renderCalendar below), so any other calendar on the
  // site -- like the dashboard's "This month" glance -- can look and total
  // up identically instead of drifting out of sync with its own mini
  // version. `opts.clickable` wires up data-day/has-trades/selected for a
  // calendar that opens a day-detail panel (Day View); the dashboard glance
  // renders the exact same cells read-only. `opts.compact` drops the
  // gross/commission sublines so each cell/week-box only shows net P&L +
  // trade count -- paired with the .cal-mini CSS class for a smaller grid.
  function buildMonthGridHtml(y, m, opts) {
    opts = opts || {};
    const map = pnlByDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    let html = "";
    WEEKDAYS_MF.forEach((d) => (html += `<div class="cal-dow">${d}</div>`));
    html += `<div class="cal-dow cal-week-dow">Week</div>`;

    // Full Mon-Sun weeks covering the month, so every week gets a complete
    // row and the leading/trailing partial week still lines up correctly.
    const firstOfMonth = new Date(y, m, 1);
    const leadMonDow = (firstOfMonth.getDay() + 6) % 7; // 0=Mon..6=Sun
    const trailMonDow = (new Date(y, m, daysInMonth).getDay() + 6) % 7;
    const gridStart = new Date(y, m, 1 - leadMonDow);
    const gridEnd = new Date(y, m, daysInMonth + (6 - trailMonDow));

    // Tradervue-style heatmap: cell color intensity scales with how big
    // that day's P&L was relative to the biggest day *visible in this
    // grid*, instead of every win/loss day getting the same flat tint.
    // Scoped to gridStart..gridEnd (not the whole account history) so a
    // quiet month still shows visible contrast between its own good and
    // bad days, rather than everything pinning near zero next to one
    // all-time outlier day. Floors at 0.22 so even a small day is still
    // visibly colored -- fading to nothing at the low end reads as "no
    // data", not "small". Weeks get their own scale/floor since week
    // totals run bigger than single days.
    let maxAbsDay = 0;
    for (let cur = new Date(gridStart); cur <= gridEnd; cur.setDate(cur.getDate() + 1)) {
      const entry = map.get(dateKey(cur.getFullYear(), cur.getMonth(), cur.getDate()));
      if (entry) maxAbsDay = Math.max(maxAbsDay, Math.abs(entry.net));
    }
    const dayIntensity = (net) => (maxAbsDay ? Math.max(0.22, Math.min(1, Math.abs(net) / maxAbsDay)).toFixed(2) : "0.6");

    const weeks = [];
    for (let cur = new Date(gridStart); cur <= gridEnd; ) {
      let weekNet = 0, weekGross = 0, weekComm = 0, weekTrades = 0, weekHas = false, weekHasInMonth = false;
      let rowHtml = "";
      for (let i = 0; i < 7; i++) {
        const dow = (cur.getDay() + 6) % 7; // 0=Mon..6=Sun -- markets are closed Sat/Sun, so those days aren't worth a column
        const inMonth = cur.getMonth() === m && cur.getFullYear() === y;
        const key = dateKey(cur.getFullYear(), cur.getMonth(), cur.getDate());
        // Look up the entry regardless of which month `cur` actually falls
        // in. The leading/trailing days of a week can belong to the
        // adjacent month (e.g. the Mon/Tue before a month that starts on a
        // Wednesday) -- those days still happened and still belong to that
        // week, so they must count toward the week total for the week to
        // be correct. They're deliberately NOT counted anywhere else: the
        // month P&L/gross/trading-day stats above the grid are computed by
        // a separate loop restricted to `daysInMonth` of *this* month, so
        // spillover days never leak into those totals -- only into the
        // per-week rollups here.
        const entry = map.get(key);
        if (dow < 5) {
          if (inMonth) weekHasInMonth = true;
          if (entry) { weekNet += entry.net; weekGross += entry.gross; weekComm += entry.comm; weekTrades += entry.count; weekHas = true; }
          let cls = "cal-cell";
          if (!inMonth) cls += " other-month";
          if (entry) cls += (entry.net >= 0 ? " win" : " loss") + (opts.clickable ? " has-trades" : "");
          if (opts.clickable && key === opts.selectedDay) cls += " selected";
          const dayAttr = opts.clickable && entry ? ` data-day="${key}"` : "";
          const dayStyle = entry ? ` style="--pnl-i:${dayIntensity(entry.net)}"` : "";
          rowHtml += `<div class="${cls}"${dayAttr}${dayStyle}>
            <span class="date-num">${cur.getDate()}</span>
            ${entry ? `<span class="cell-pnl">${fmtMoney(entry.net)}</span><span class="cell-count">${entry.count} trade${entry.count === 1 ? "" : "s"}</span>${opts.compact ? "" : `<span class="cell-subline">Gross <span class="${entry.gross >= 0 ? "up" : "down"}">${fmtMoney(entry.gross)}</span></span><span class="cell-subline">Comm $${entry.comm.toFixed(2)}</span>`}` : ""}
          </div>`;
        }
        cur.setDate(cur.getDate() + 1);
      }
      weeks.push({ rowHtml, weekNet, weekGross, weekComm, weekTrades, weekHas, weekHasInMonth });
    }

    // A week whose Mon-Fri cells are entirely outside this month can only
    // happen at the very ends of the grid (e.g. the month starts on a
    // Saturday, so the week containing the 1st has no in-month weekday at
    // all -- it's really the tail end of last month's own calendar). That
    // week belongs to the adjacent month's view, not this one, so trim it
    // off the front/back rather than showing a whole extra week that has
    // nothing to do with the month being viewed.
    while (weeks.length && !weeks[0].weekHasInMonth) weeks.shift();
    while (weeks.length && !weeks[weeks.length - 1].weekHasInMonth) weeks.pop();

    const maxAbsWeek = weeks.reduce((mx, w) => (w.weekHas ? Math.max(mx, Math.abs(w.weekNet)) : mx), 0);
    const weekIntensity = (net) => (maxAbsWeek ? Math.max(0.22, Math.min(1, Math.abs(net) / maxAbsWeek)).toFixed(2) : "0.6");

    weeks.forEach((week, idx) => {
      const weekIndex = idx + 1;
      const weekBoxCls = "cal-week-box" + (week.weekHas ? (week.weekNet >= 0 ? " win" : " loss") : "");
      const weekStyle = week.weekHas ? ` style="--pnl-i:${weekIntensity(week.weekNet)}"` : "";
      html += week.rowHtml + `<div class="${weekBoxCls}"${weekStyle}>
        <span class="week-label">Week ${weekIndex}</span>
        ${week.weekHas ? `<span class="week-pnl">${fmtMoney(week.weekNet)}</span><span class="week-count">${week.weekTrades} trade${week.weekTrades === 1 ? "" : "s"}</span>${opts.compact ? "" : `<span class="week-subline">Gross <span class="${week.weekGross >= 0 ? "up" : "down"}">${fmtMoney(week.weekGross)}</span></span><span class="week-subline">Comm $${week.weekComm.toFixed(2)}</span>`}` : `<span class="week-empty">—</span>`}
      </div>`;
    });
    return html;
  }
  function bindTradeRows(container) {
    container.querySelectorAll("tr[data-id]").forEach((row) => {
      const url = `trade.html?id=${encodeURIComponent(row.dataset.id)}`;
      // These rows are <tr>s, not real <a> links, so the browser's native
      // "open in new tab" behaviors (middle/scroll-wheel click, ctrl/cmd-click)
      // never fired -- only a plain left click did anything. Wire those up
      // explicitly so the rows behave like the trade links everywhere else
      // on the site.
      row.style.cursor = "pointer";
      row.tabIndex = 0;
      row.setAttribute("role", "link");
      row.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) {
          window.open(url, "_blank", "noopener");
        } else {
          window.location.href = url;
        }
      }, { signal });
      row.addEventListener("auxclick", (e) => {
        if (e.button === 1) { // middle / scroll-wheel button
          e.preventDefault();
          window.open(url, "_blank", "noopener");
        }
      }, { signal });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter") window.location.href = url;
      }, { signal });
    });
  }
  // Duration comes from entry_time/exit_time (both "HH:MM:SS" on the
  // same trade_date), not a separate field -- the index doesn't carry
  // time_in_trade, so it's computed here the same way the detail page
  // would show it.
  function durationMinutes(t) {
    // A trade with a missing/blank entry_time or exit_time (e.g. one
    // backfilled from a CSV that had no execution times) has no duration
    // -- return null for it, the same as a zero/negative span, instead of
    // throwing on null.split(). That throw used to abort the whole Day View
    // trade table (and several Reports sections) for any day containing
    // such a trade.
    const toSec = (s) => {
      if (typeof s !== "string" || !s) return NaN;
      const [h, m, sec] = s.split(":").map(Number);
      return h * 3600 + m * 60 + (sec || 0);
    };
    const diff = toSec(t.exit_time) - toSec(t.entry_time);
    return diff > 0 ? diff / 60 : null; // NaN > 0 is false -> null
  }

  // fmtDuration() now in utils.js (loads first on every page). NOTE: the
  // canonical version renders totals under 60 seconds as e.g. "45s" instead
  // of rounding down to "0m" -- this file's old copy had the "0m" bug that
  // fmtDurationPrecise below was written to fix for the Day View table;
  // swapping in the canonical fmtDuration fixes the same bug for every
  // other caller here (the average-hold-time stats above) too.

  // Same idea as fmtDuration, but keeps seconds instead of rounding them
  // away -- used for the Day View trade table, where a lot of these small-
  // cap scalps are held for single-digit seconds and fmtDuration's
  // round-to-the-minute made every one of them read "0m".
  function fmtDurationPrecise(mins) {
    if (mins == null || isNaN(mins)) return "—";
    const totalSec = Math.round(mins * 60);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function renderEmptyEverywhere() {
    const luNo = document.getElementById("last-updated"); if (luNo) luNo.textContent = "No trades yet";
    statGrid.innerHTML = "";
    const heroEl = document.getElementById("dash-hero");
    if (heroEl) heroEl.innerHTML = '<div class="empty-state small">No trades logged yet — once your pipeline publishes, your Net P&amp;L and recent form will show up here.</div>';
    document.getElementById("score-wrap").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("mini-cal").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("recent-trades").innerHTML = '<div class="empty-state small">No trades logged yet.</div>';
    document.getElementById("equity-total").textContent = "";
    document.getElementById("equity-stats").innerHTML = "";
    document.getElementById("cal-grid").innerHTML = '<div class="empty-state">No trades logged yet.</div>';
    document.getElementById("cal-summary-strip").innerHTML = "";
    document.getElementById("cal-month-label").textContent = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });
    document.getElementById("streak-strip").innerHTML = "";
    document.getElementById("highlight-pair").innerHTML = "";
    document.getElementById("report-symbol").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-dow").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-timeofday").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-duration").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-most-traded").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-most-profitable").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-sector").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-country").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("detailed-stat-grid").innerHTML = "";
    [
      "detail-dow", "detail-hour", "detail-price-dist", "detail-price-perf", "detail-size-dist", "detail-size-perf",
      "detail-symbol", "detail-side", "detail-symbol-top20", "detail-symbol-bottom20",
      "detail-setup", "detail-lessons", "detail-distribution", "detail-expectancy", "detail-expectation-bar",
      "detail-winloss-donut", "detail-winloss-compare",
      "detail-rvol-dist", "detail-rvol-perf", "detail-avgvol-dist", "detail-avgvol-perf", "detail-float",
      "report-month-dist", "report-month-perf", "dd-cum-pnl", "dd-cum-drawdown",
      "report-cum-pnl", "detail-cum-pnl",
    ].forEach((id) => { const el = document.getElementById(id); if (el) el.innerHTML = '<div class="empty-state small">No data yet.</div>'; });
    [
      "wld-summary", "wld-top-win", "wld-top-loss", "dd-summary", "dd-periods",
      "compare-table", "tagb-setup", "tagb-lessons",
      "insights-breakeven", "insights-timesize", "insights-behavior", "insights-rules", "insights-concentration",
    ].forEach((id) => { const el = document.getElementById(id); if (el) el.innerHTML = '<div class="empty-state small">No data yet.</div>'; });
    document.getElementById("advanced-grid").innerHTML = "";
  }


  window.App = {
    signal,
    state,
    MONTHS,
    safeRender,
    pad2,
    dateKey,
    computeStats,
    pnlByDay,
    buildMonthGridHtml,
    bindTradeRows,
    durationMinutes,
    fmtDurationPrecise,
    // Populated by app-dashboard.js / app-dayview.js / app-reports.js as
    // each loads (always immediately after this file -- see the big
    // comment at the top of this file). The fetch-then-render pass below
    // calls through these rather than by bare name, since those functions
    // live in other files' closures now.
    tabs: { dashboard: {}, dayview: {}, reports: {} },
  };

  // ----------------------------------------------------------------
  // Loading with automatic recovery.
  //
  // This used to be a single fetch: if it failed for ANY reason (a network
  // blip, a token that expired while the tab slept, a gateway hiccup) every
  // section turned into "Couldn't load this section" and stayed that way
  // until a manual refresh. Now: auth.js already retries the query itself
  // (see withClockSkewRetry); if it STILL fails, the page keeps its
  // placeholders, shows a banner with a Retry button, retries by itself on
  // a backoff, and retries immediately when the network comes back or the
  // tab is refocused. Failures while DRAWING (a real bug) are told apart
  // from failures while FETCHING, so a bug never loops forever.
  // ----------------------------------------------------------------
  let loadTries = 0;
  let retryTimer = null;
  let loadInFlight = false;
  let loadFailed = false;
  const MAX_AUTO_RETRIES = 6;

  function bannerHost() { return document.querySelector(".main") || document.body; }
  function showLoadBanner(html) {
    let el = document.getElementById("load-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "load-banner";
      el.setAttribute("role", "status");
      el.style.cssText = "margin:12px 0; padding:11px 14px; border:1px solid rgba(232,169,76,.45); background:var(--amber-soft,rgba(232,169,76,.12)); color:var(--text); border-radius:10px; font-size:13px; display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap;";
      const host = bannerHost();
      host.insertBefore(el, host.firstChild);
    }
    el.innerHTML = html;
    const btn = el.querySelector("[data-retry]");
    if (btn) btn.addEventListener("click", () => loadAndRender(true));
  }
  function hideLoadBanner() {
    const el = document.getElementById("load-banner");
    if (el) el.remove();
  }
  function markPlaceholdersRetrying() {
    document.querySelectorAll(".loading-line").forEach((el) => { el.textContent = "Couldn't load yet — retrying…"; });
  }

  function onLoadFailed(err) {
    loadFailed = true;
    const msg = escapeHtml(String((err && err.message) || err || "unknown error"));
    const luEl = document.getElementById("last-updated");
    if (luEl) luEl.textContent = "Reconnecting…";
    markPlaceholdersRetrying();
    const willRetry = loadTries < MAX_AUTO_RETRIES;
    showLoadBanner(
      `<span>Couldn't load your trades (${msg}). ${willRetry ? "Retrying automatically…" : "Automatic retries used up."}</span>` +
      `<button type="button" class="btn-advanced" data-retry>Retry now</button>`
    );
    if (willRetry) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => loadAndRender(false), Math.min(3000 * Math.pow(2, loadTries), 30000));
    } else {
      const lu2 = document.getElementById("last-updated");
      if (lu2) lu2.textContent = "No data";
    }
  }

  function onRenderFailed(err) {
    console.error("[app.js] render failed:", err);
    showLoadBanner(
      `<span>Something went wrong drawing this page (${escapeHtml(String((err && err.message) || err))}). Your data loaded fine.</span>` +
      `<button type="button" class="btn-advanced" onclick="location.reload()">Reload</button>`
    );
    clearStrandedLoadingStates();
  }

  function loadAndRender(manual) {
    if (cancelled || loadInFlight) return;
    loadInFlight = true;
    clearTimeout(retryTimer);
    if (manual) loadTries = 0; else loadTries++;
    Promise.all([window.fetchTradesIndex(), window.fetchCapitalLedger()]).then((results) => {
      loadInFlight = false;
      if (cancelled) return;
      loadFailed = false;
      hideLoadBanner();
      try { renderAll(results[0], results[1]); } catch (err) { onRenderFailed(err); }
    }, (err) => {
      loadInFlight = false;
      if (cancelled) return;
      onLoadFailed(err);
    });
  }
  // Retry right away when connectivity returns or the tab comes back to the
  // foreground (laptop wake, Wi-Fi switch) instead of waiting out the backoff.
  window.addEventListener("online", () => { if (loadFailed) loadAndRender(true); }, { signal });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && loadFailed) loadAndRender(true);
  }, { signal });
  App.retryLoad = () => loadAndRender(true);

  function renderAll(data, ledger) {
      // (A newer copy of this script loaded by a later SPA navigation may
      // have torn this one down -- loadAndRender already bailed if so.)
      state.trades = data.slice().sort((a, b) => (a.trade_date + a.entry_time).localeCompare(b.trade_date + b.entry_time));
      if (!state.trades.length) {
        renderEmptyEverywhere();
        return;
      }
      // Real account-balance figure per trade (starting capital/deposits
      // from the Settings ledger + cumulative P&L) -- kept on `_balance`
      // rather than overwriting `equity_after`; see computeAccountBalances
      // in auth.js. With no ledger entries this is identical to equity_after.
      const balances = window.computeAccountBalances(state.trades, ledger);
      state.trades.forEach((t, i) => { t._balance = balances[i]; });
      state.hasCapitalLedger = ledger.length > 0;
      const last = state.trades[state.trades.length - 1];
      const lastUpdatedEl = document.getElementById("last-updated");
      if (lastUpdatedEl) lastUpdatedEl.textContent = "Through " + last.trade_date;
      const dateRangeEl = document.getElementById("date-range");
      if (dateRangeEl) dateRangeEl.textContent =
        state.trades[0].trade_date === last.trade_date ? last.trade_date : `${state.trades[0].trade_date} → ${last.trade_date}`;

      const lastDate = new Date(last.trade_date + "T12:00:00");
      state.calYear = lastDate.getFullYear();
      state.calMonth = lastDate.getMonth();

      // Restore day-view position from the URL if we're coming back here
      // (Back button from trade.html) rather than landing fresh -- see
      // NavState in nav.js. Falls back to the defaults above if the URL
      // has nothing (or garbage) in it.
      const urlYear = parseInt(NavState.get("cy"), 10);
      const urlMonth = parseInt(NavState.get("cm"), 10);
      if (Number.isInteger(urlYear) && Number.isInteger(urlMonth) && urlMonth >= 0 && urlMonth <= 11) {
        state.calYear = urlYear;
        state.calMonth = urlMonth;
      }
      state.selectedDay = NavState.get("day", null);

      safeRender(App.tabs.dashboard.renderStats, "renderStats");
      safeRender(App.tabs.dashboard.renderScore, "renderScore");
      safeRender(App.tabs.dashboard.renderMiniCal, "renderMiniCal");
      safeRender(App.tabs.dashboard.renderEquity, "renderEquity");
      safeRender(App.tabs.dashboard.renderRecentTrades, "renderRecentTrades");
      safeRender(App.tabs.dayview.renderCalendar, "renderCalendar");
      if (state.selectedDay) {
        const entry = pnlByDay().get(state.selectedDay);
        if (entry) safeRender(() => App.tabs.dayview.showDayDetail(state.selectedDay, entry), "showDayDetail (restored)");
        else state.selectedDay = null; // stale/invalid day from an old URL -- nothing to show
      }
      safeRender(App.tabs.reports.initReportFilters, "initReportFilters");
      safeRender(App.tabs.reports.applyReportFiltersAndRender, "applyReportFiltersAndRender");
      clearStrandedLoadingStates();
  }
  loadAndRender(true);

  // ================================================================
  // TAB NAVIGATION
  // ================================================================
  const TAB_TITLES = { dashboard: "Dashboard", dayview: "Day View", reports: "Reports" };

  function setTab(tab) {
    document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === "tab-" + tab);
    });
    document.getElementById("page-title").textContent = TAB_TITLES[tab] || "Dashboard";
    document.getElementById("sidebar").classList.remove("mobile-open");
  }

  // Clicking a tab used to call setTab() directly without touching the URL,
  // so the address bar stayed on whatever hash the page happened to load
  // with. That meant: click Trade View, open a trade, hit Back -- the
  // browser restores index.html at that same stale hash (usually none),
  // which boots straight back to Dashboard instead of the tab you were
  // actually on. Updating location.hash on every tab change gives each
  // tab its own history entry, so Back actually returns to it.
  function goToTab(tab) {
    if ((location.hash || "").replace(/^#/, "") === tab) {
      setTab(tab); // hash isn't changing, so hashchange won't fire -- apply directly
    } else {
      location.hash = tab;
    }
  }
  document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => goToTab(btn.dataset.tab), { signal });
  });
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => goToTab(btn.dataset.goto), { signal });
  });

  // Other pages (backtester.html, journal.html, report.html, etc.) link
  // here as index.html#reports / index.html#dayview / etc. Without this,
  // the page always boots onto "dashboard" regardless of the hash, and
  // the tab you actually wanted only appeared after a second, redundant
  // click on the sidebar. Read the hash on load, and again if it changes
  // (e.g. the user lands here, then clicks another #-link while already
  // on this page), so the very first click always lands on the right tab.
  const VALID_TABS = Object.keys(TAB_TITLES);
  function tabFromHash() {
    const h = (location.hash || "").replace(/^#/, "");
    return VALID_TABS.includes(h) ? h : "dashboard";
  }
  setTab(tabFromHash());
  window.addEventListener("hashchange", () => setTab(tabFromHash()), { signal });
})();
