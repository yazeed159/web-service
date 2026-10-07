(function () {
  "use strict";

  // Webhook for the optional "Support & Resistance" box below --
  // fires an n8n workflow that reads the symbol's prior daily bars and
  // returns support/resistance levels. Only ever called when the person
  // clicks the button on a trade page; never runs automatically, so it
  // never spends API tokens on its own. Point this at your own n8n
  // instance the same way #import-trades-link in trade.html is pointed at
  // its form URL. The actual URL lives in config.js (window.N8N_SR_URL) so
  // it only has to be set in one place.
  const SR_ANALYSIS_URL = window.N8N_SR_URL || "";

  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const content = document.getElementById("trade-content");

  // Set once buildCharts() creates the candlestick chart, so the S/R
  // button (added further down, after the chart already exists on the
  // page) can draw price lines onto it without re-plumbing chart creation.
  let srCandleSeries = null;
  // Tracked so buildCharts() can dispose the previous chart instance when
  // it's re-run with a wider bars array (see the "Show full day" button
  // below), and so the resize handler always resizes whichever chart is
  // actually live instead of one that's already been torn down.
  let currentCandleChart = null;
  let currentMacdChart = null;
  // Handle returned by ChartIndicators.buildStandardChart() for whichever
  // candle chart is currently live -- torn down (which also disconnects
  // its ResizeObserver) at the top of buildCharts() before a "Show full
  // day" rebuild creates the next one, instead of the old approach of a
  // single window "resize" listener attached once and left running
  // forever, reading module state to find whatever chart was current.
  let currentChartHandle = null;
  let tooltipCloseListenerAttached = false;
  // repositionPointers is redefined fresh on every buildCharts() call (it
  // closes over that call's own pointer DOM nodes / candleSeries), so
  // unlike tooltipCloseListenerAttached above this can't just be a
  // set-once flag -- the *old* handler has to actually be replaced, or
  // "Show full day" rebuilding the chart would keep calling a stale
  // repositionPointers pointing at the previous call's now-disposed chart
  // whenever buildStandardChart's onResize fires, alongside the new one.
  let pointersResizeHandler = null;
  let pointerWatchRaf = 0; // rAF id of the price-scale watcher that keeps pointers pinned during vertical zoom/pan
  // Which timeframe the candle chart is currently resampled to (1/5/15/60
  // minutes). Kept at module scope, not inside buildCharts, so it
  // survives a "Show full day" rebuild -- switching to 5m and then
  // loading the full day keeps showing 5m instead of silently resetting.
  let currentInterval = 1;

  // "Better entry / better exit" pointers are optional on the chart (they
  // crowd it when a trade also has several real fills). The checked /
  // unchecked state is saved in localStorage so it stays how you left it.
  const BETTER_KEY = "tl_show_better_markers";
  let showBetter = false;
  try { showBetter = localStorage.getItem(BETTER_KEY) === "1"; } catch (e) { /* storage blocked: stays off */ }
  // Set by buildCharts() to its own repositionPointers (which reads
  // showBetter), so the toggle button can re-apply visibility live.
  let betterToggleHandler = null;
  function syncBetterUi() {
    const btn = document.getElementById("better-toggle-btn");
    if (btn) {
      btn.setAttribute("aria-pressed", showBetter ? "true" : "false");
      btn.style.borderColor = showBetter ? "#8b7cf6" : "";
      btn.style.color = showBetter ? "#c9c1ff" : "";
      const box = document.getElementById("better-box");
      if (box) box.textContent = showBetter ? "\u2713" : "";
    }
    document.querySelectorAll(".legend-better").forEach((el) => { el.style.display = showBetter ? "" : "none"; });
  }

  // "Show full day" -- widens the chart past the narrow window that got
  // stored with this trade, by pulling the rest of that symbol's session
  // from chart_service.py's /full-day-bars route. That route shares its
  // Polygon fetch + cache with /generate-chart (keyed by symbol+trade_date
  // -- see chart_service.py's _get_cached_raw_bars), so this only ever
  // costs a Polygon call the FIRST time anyone asks for that symbol+day;
  // a second trade that happened to trade the same symbol that day, or a
  // repeat click here, is served from that cache. sessionStorage below is
  // just a second, client-side layer of the same idea -- re-opening the
  // same trade (or a sibling trade sharing the symbol+day) in this tab
  // doesn't even make the network round trip twice.
  // FULL_DAY_CACHE_PREFIX/fetchFullDayBars() now in utils.js (loads first
  // on every page).

  // POST helper for chart_service.py routes that need to know who's
  // asking (currently just /fetch-float) -- attaches the logged-in
  // person's Supabase access token, same pattern as backtester.js's
  // authedHeaders(). window.AUTH_READY (see auth.js) resolves once per
  // page load and is safe to .then() repeatedly.
  function authedPost(path, body) {
    const base = (window.CHART_SERVICE_URL || "").replace(/\/+$/, "");
    if (!base) return Promise.reject(new Error("CHART_SERVICE_URL isn't set in config.js"));
    return window.AUTH_READY.then((session) => {
      if (!session) throw new Error("Please log in first.");
      return fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "ngrok-skip-browser-warning": "true",
          "Authorization": "Bearer " + session.access_token,
        },
        body: JSON.stringify(body),
      });
    }).then((r) => r.json().then((data) => {
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
      return data;
    }));
  }

  // Every drawSrLevelsOnChart() call adds new createPriceLine()s without
  // ever removing the last batch -- clicking "Analyze support/resistance"
  // more than once (re-running after the first result, or just curiosity)
  // stacked a fresh set of support/resistance lines on top of the old
  // ones every time. Support lines are the same green (#2fd08a) as the
  // real entry price line, so a second run could leave what looked like
  // two overlapping green "entry" lines on the chart. Tracked here so
  // drawSrLevelsOnChart can clear its own previous lines first.
  let srPriceLines = [];

  // Set once the trade detail JSON loads, so the "Share trade" button
  // (static markup, lives outside #trade-content so it survives re-renders)
  // has something to export. Wired up here rather than inside renderTrade
  // so it only has to be attached once.
  let currentTrade = null;
  const shareBtn = document.getElementById("share-trade-btn");
  if (shareBtn) {
    shareBtn.addEventListener("click", () => {
      if (!currentTrade || !window.TradeLogShare) return;
      const label = document.getElementById("share-trade-label");
      try {
        const html = TradeLogShare.buildTradeSharePage(currentTrade);
        const filename = `trade-${TradeLogShare.slug(currentTrade.symbol)}-${TradeLogShare.slug(currentTrade.trade_date)}.html`;
        TradeLogShare.download(filename, html);
        if (label) { label.textContent = "Downloaded!"; setTimeout(() => (label.textContent = "Share trade"), 1600); }
      } catch (e) {
        if (label) { label.textContent = "Couldn't export"; setTimeout(() => (label.textContent = "Share trade"), 1600); }
      }
    });
  }

  // Sibling (prev/next) nav needs the full index, sorted the same way the
  // publish pipeline sorts it (trade_date + entry_time). Fetching it is
  // best-effort — if it 404s or is missing, the page still renders fine
  // without nav arrows.
  let siblingsPromise = window.fetchTradesIndex()
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
      window.fetchTradeDetail(id).then((trade) => {
        if (!trade) throw new Error("Not found");
        return trade;
      }),
      siblingsPromise,
    ])
      .then(([trade, siblings]) => { currentTrade = trade; renderTrade(trade, siblings); })
      .catch((err) => {
        content.innerHTML = `
          <div class="empty-state">
            Couldn't load this trade (${escapeHtml(String(err.message))}).<br>
            <span style="font-size:12.5px">If the pipeline's publish step for this trade hasn't run successfully yet, it won't be in your Supabase trades/trade_details tables.</span>
          </div>`;
      });
  }

// escapeHtml() now in utils.js (loads first on every page).
// fmtMoney() now in utils.js (loads first on every page).
  // ¢/share = the raw price move, not the P&L -- entry $8.33 -> exit $8.45
  // is +12.0¢/share no matter what the commission or share count did to
  // the dollar P&L. Short trades invert the sign (a lower exit is the win).
  // This intentionally does NOT take pnl_after_comm/shares -- that's a
  // different number (net P&L per share) that happens to collapse to the
  // same thing only when commission is 0, which is why it looked "right"
  // often enough to ship before someone noticed it wasn't.
  function centsPerShareValue(entryPrice, exitPrice, side) {
    const dir = String(side || "").toLowerCase() === "short" ? -1 : 1;
    return dir * (exitPrice - entryPrice) * 100;
  }
  function centsPerShare(entryPrice, exitPrice, side) {
    const cents = centsPerShareValue(entryPrice, exitPrice, side);
    const sign = cents >= 0 ? "+" : "-";
    return sign + Math.abs(cents).toFixed(1) + "¢";
  }
// toUnix() now in utils.js (loads first on every page).
  // Compact share-count formatting for the About card -- 18,500,000 -> "18.5M".
// fmtShares() now in utils.js (loads first on every page).

  // "Mar 4" (plus the year when it isn't this year) from a YYYY-MM-DD string.
  function shortDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || "");
    if (!m) return d || "";
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const opts = { month: "short", day: "numeric" };
    if (dt.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return dt.toLocaleDateString(undefined, opts);
  }
  function longDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || "");
    if (!m) return d || "";
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }

  // Previous / next trade buttons (older <- this -> newer), filled into the
  // static #trade-pager slot so the "All trades" link and Share button next
  // to it keep their one-time wiring. Left/right arrow keys do the same thing.
  function renderPager(trade, siblings) {
    const host = document.getElementById("trade-pager");
    if (!host) return;
    if (!Array.isArray(siblings) || !siblings.length) { host.innerHTML = ""; return; }
    const idx = siblings.findIndex((r) => r.id === trade.id);
    if (idx < 0) { host.innerHTML = ""; return; }
    const prev = idx > 0 ? siblings[idx - 1] : null;
    const next = idx < siblings.length - 1 ? siblings[idx + 1] : null;
    const chev = (dir) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="${dir === "prev" ? "15 18 9 12 15 6" : "9 18 15 12 9 6"}"></polyline></svg>`;
    const btn = (row, dir) => {
      const word = dir === "prev" ? "Previous" : "Next";
      const sub = row ? `${escapeHtml(row.symbol)} · ${escapeHtml(shortDate(row.trade_date))}` : (dir === "prev" ? "Oldest trade" : "Latest trade");
      const inner = `${dir === "prev" ? chev(dir) : ""}<span class="th-nav-txt"><span class="th-nav-word">${word}</span><span class="th-nav-sub">${sub}</span></span>${dir === "next" ? chev(dir) : ""}`;
      return row
        ? `<a class="th-nav ${dir}" data-dir="${dir}" href="trade.html?id=${encodeURIComponent(row.id)}" title="${word} trade (${dir === "prev" ? "\u2190" : "\u2192"})">${inner}</a>`
        : `<span class="th-nav ${dir} is-off" aria-disabled="true">${inner}</span>`;
    };
    host.innerHTML = `<nav class="th-pager" aria-label="Trade navigation">
      ${btn(prev, "prev")}
      <span class="th-pos mono" title="Position among all your trades, oldest first">${idx + 1}<span class="th-pos-of"> / ${siblings.length}</span></span>
      ${btn(next, "next")}
    </nav>`;
  }

  // \u2190 / \u2192 step through trades, unless you're typing somewhere.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const a = document.querySelector(`#trade-pager a.th-nav[data-dir="${e.key === "ArrowLeft" ? "prev" : "next"}"]`);
    if (a) { e.preventDefault(); a.click(); }
  });

  // Your own journal entry for this trade (plan, setup, mistakes, rules,
  // notes) -- see trade-notes.js. Saves on every change, debounced for text.
  function renderJournalCard(trade) {
    const host = document.getElementById("journal-card");
    if (!host) return;
    const entry = Object.assign(
      { plan_stop: null, plan_target: null, setup: "", mistakes: [], followed_rules: null, notes: "" },
      window.TradeNotes.get(trade.id) || {}
    );
    const tags = window.TradeNotes.knownTags();
    const chip = (label, on, attr) =>
      `<button type="button" class="pill tagpill jn-chip${on ? " on" : ""}" ${attr}="${escapeHtml(label)}" style="cursor:pointer; ${on ? "background:var(--primary); color:#fff; border-color:var(--primary);" : ""}">${escapeHtml(label)}</button>`;
    const inputStyle = "background:var(--panel-2); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:6px 8px; font-size:13px; width:100%; box-sizing:border-box;";
    const lbl = "font-size:11.5px; color:var(--text-faint); display:block; margin-bottom:4px;";

    host.innerHTML = `
      <div class="card" style="margin-bottom:16px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
          <div style="font-weight:600;">Your journal</div>
          <span id="jn-status" style="font-size:11.5px; color:var(--text-faint);"></span>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:14px;">
          <div><label style="${lbl}">Planned stop ($)</label><input id="jn-stop" type="number" step="0.01" min="0" inputmode="decimal" style="${inputStyle}" value="${entry.plan_stop ?? ""}"></div>
          <div><label style="${lbl}">Planned target ($)</label><input id="jn-target" type="number" step="0.01" min="0" inputmode="decimal" style="${inputStyle}" value="${entry.plan_target ?? ""}"></div>
          <div><label style="${lbl}">Followed my rules?</label>
            <div id="jn-rules" style="display:flex; gap:6px;">
              ${chip("Yes", entry.followed_rules === true, "data-rules")}${chip("No", entry.followed_rules === false, "data-rules")}
            </div>
          </div>
        </div>
        <div id="jn-metrics" style="display:flex; gap:16px; flex-wrap:wrap; font-size:12.5px; margin-bottom:14px;"></div>
        <div style="margin-bottom:12px;">
          <label style="${lbl}">Setup</label>
          <div id="jn-setups" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
            ${tags.setups.map((t) => chip(t, entry.setup === t, "data-setup")).join("")}
            <input id="jn-setup-new" placeholder="+ custom" style="${inputStyle} width:110px;">
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <label style="${lbl}">Mistakes</label>
          <div id="jn-mistakes" style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
            ${tags.mistakes.map((t) => chip(t, entry.mistakes.includes(t), "data-mistake")).join("")}
            <input id="jn-mistake-new" placeholder="+ custom" style="${inputStyle} width:110px;">
          </div>
        </div>
        <div>
          <label style="${lbl}">Notes</label>
          <textarea id="jn-notes" rows="3" placeholder="Why you took it, what you felt, what you'd change…" style="${inputStyle} resize:vertical;">${escapeHtml(entry.notes)}</textarea>
        </div>
      </div>`;

    const $ = (id) => document.getElementById(id);
    const statusEl = $("jn-status");
    let timer = null;

    function paintMetrics() {
      const m = window.TradeNotes.metrics(trade, entry);
      const parts = [];
      if (m.risk_dollars != null) parts.push(`Risk <b>$${m.risk_dollars.toFixed(2)}</b> (${(m.risk_per_share * 100).toFixed(1)}¢/sh)`);
      if (m.planned_rr != null) parts.push(`Planned R:R <b>${m.planned_rr.toFixed(2)}</b>`);
      if (m.r_multiple != null) parts.push(`Realised <b class="${m.r_multiple >= 0 ? "up" : "down"}">${m.r_multiple >= 0 ? "+" : ""}${m.r_multiple.toFixed(2)}R</b>`);
      if (entry.plan_stop && m.risk_per_share == null) parts.push(`<span style="color:var(--red);">Stop must be on the losing side of entry ($${trade.entry_price.toFixed(2)})</span>`);
      $("jn-metrics").innerHTML = parts.join("<span style=\"color:var(--border);\">|</span>");
    }
    function persist(immediate) {
      clearTimeout(timer);
      const run = () => {
        window.TradeNotes.save(trade.id, entry);
        if (immediate && window.Haptics) window.Haptics.play("success");
        statusEl.textContent = "Saved";
        setTimeout(() => { if (statusEl.textContent === "Saved") statusEl.textContent = ""; }, 1500);
      };
      if (immediate) run(); else { statusEl.textContent = "Saving…"; timer = setTimeout(run, 500); }
    }

    // Inline validation as you type -- negative stop/target used to save
    // silently (min="0" on a number input doesn't actually block typed
    // negatives) and just quietly break the risk/R:R math above. Flag it
    // right on the field instead of leaving the metrics row to look
    // wrong with no explanation; still lets you keep typing/save once
    // corrected rather than blocking on a submit that doesn't exist here.
    function validatePlanField(inputEl, value) {
      const bad = value != null && value < 0;
      if (window.setFieldError) window.setFieldError(inputEl, bad ? "Can't be negative." : "");
      return !bad;
    }
    $("jn-stop").addEventListener("input", (e) => {
      entry.plan_stop = e.target.value === "" ? null : Number(e.target.value);
      validatePlanField(e.target, entry.plan_stop);
      paintMetrics(); persist();
    });
    $("jn-target").addEventListener("input", (e) => {
      entry.plan_target = e.target.value === "" ? null : Number(e.target.value);
      validatePlanField(e.target, entry.plan_target);
      paintMetrics(); persist();
    });
    $("jn-notes").addEventListener("input", (e) => { entry.notes = e.target.value; persist(); });

    host.querySelectorAll("[data-rules]").forEach((b) => b.addEventListener("click", () => {
      const v = b.getAttribute("data-rules") === "Yes";
      entry.followed_rules = entry.followed_rules === v ? null : v;
      persist(true); renderJournalCard(trade);
    }));
    host.querySelectorAll("[data-setup]").forEach((b) => b.addEventListener("click", () => {
      const v = b.getAttribute("data-setup");
      entry.setup = entry.setup === v ? "" : v;
      persist(true); renderJournalCard(trade);
    }));
    host.querySelectorAll("[data-mistake]").forEach((b) => b.addEventListener("click", () => {
      const v = b.getAttribute("data-mistake");
      entry.mistakes = entry.mistakes.includes(v) ? entry.mistakes.filter((x) => x !== v) : entry.mistakes.concat(v);
      persist(true); renderJournalCard(trade);
    }));
    $("jn-setup-new").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.value.trim()) return;
      entry.setup = e.target.value.trim(); persist(true); renderJournalCard(trade);
    });
    $("jn-mistake-new").addEventListener("keydown", (e) => {
      const v = e.target.value.trim();
      if (e.key !== "Enter" || !v) return;
      if (!entry.mistakes.includes(v)) entry.mistakes.push(v);
      persist(true); renderJournalCard(trade);
    });
    paintMetrics();
  }

  function renderTrade(trade, siblings) {
    document.title = `${trade.symbol} — trade.log`;
    const win = trade.win;

    content.innerHTML = `
      <section class="th-card">
        <div class="th-id">
          <div class="th-title-row">
            <h1 class="th-symbol">${escapeHtml(trade.symbol)}</h1>
            <span class="verdict-badge th-verdict ${win ? "up" : "down"}">${win ? "WIN" : "LOSS"} · ${fmtMoney(trade.pnl_after_comm)}</span>
          </div>
          <div class="th-sub">
            <span>${escapeHtml(longDate(trade.trade_date))}</span>
            ${trade.side ? `<span class="th-sep"></span><span>${escapeHtml(String(trade.side).charAt(0).toUpperCase() + String(trade.side).slice(1).toLowerCase())}</span>` : ""}
            ${trade.fill_count > 1 ? `<span class="th-sep"></span><span title="Entry/Exit Price below are quantity-weighted averages across these fills">${trade.fill_count} fills</span>` : ""}
          </div>
        </div>
        <div class="th-grade" id="grade-row">
          <span class="th-grade-label">Execution grade</span>
          <span id="grade-widget">${window.TradeGrade ? window.TradeGrade.starsHtml(window.TradeGrade.get(trade), { interactive: true, size: 20 }) : ""}</span>
          <span id="grade-label" class="th-grade-note"></span>
        </div>
        <div class="th-track">
          <div class="th-leg">
            <span class="th-leg-k"><i class="th-dot entry"></i>Entry</span>
            <span class="th-leg-p">$${trade.entry_price.toFixed(2)}</span>
            <span class="th-leg-t">${trade.entry_time || "—"}</span>
          </div>
          <div class="th-mid">
            <span class="th-line"></span>
            <span class="th-held"><b>${trade.time_in_trade || "—"}</b> held<span class="th-sep"></span><b>${trade.shares != null ? Number(trade.shares).toLocaleString() : "—"}</b> sh</span>
            <span class="th-line th-line-end"></span>
          </div>
          <div class="th-leg th-leg-right">
            <span class="th-leg-k"><i class="th-dot exit"></i>Exit</span>
            <span class="th-leg-p">$${trade.exit_price.toFixed(2)}</span>
            <span class="th-leg-t">${trade.exit_time || "—"}</span>
          </div>
        </div>
      </section>

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
        <div class="cell">
          <div class="label">Shares</div>
          <div class="value">${trade.shares != null ? trade.shares.toLocaleString() : "—"}</div>
        </div>
        <div class="cell">
          <div class="label">&cent;/Share</div>
          <div class="value ${trade.shares && centsPerShareValue(trade.entry_price, trade.exit_price, trade.side) < 0 ? "down" : "up"}">${trade.shares ? centsPerShare(trade.entry_price, trade.exit_price, trade.side) : "—"}</div>
        </div>
      </div>

      <div class="chart-panel">
        <div class="chart-toolbar">
          <div class="legend">
            <span class="legend-item"><span class="legend-swatch" style="background:#e8a94c"></span>VWAP</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#9aa8a1"></span>EMA9</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#5b93f0"></span>EMA20</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#b57bee"></span>EMA200</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#2fd08a"></span>entry</span>
            <span class="legend-item"><span class="legend-swatch" style="background:#f2555a"></span>exit</span>
            <span class="legend-item legend-better" style="${showBetter ? "" : "display:none;"}"><span class="legend-swatch" style="background:#8b7cf6"></span>better entry</span>
            <span class="legend-item legend-better" style="${showBetter ? "" : "display:none;"}"><span class="legend-swatch" style="background:#ec6cad"></span>better exit</span>
          </div>
          <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; row-gap:8px;" id="chart-controls">
            <span class="chart-hint">Scroll to zoom · drag to pan</span>
            <a class="icon-btn icon-btn-visible" id="replay-btn" title="Rewind this trade" style="width:auto; padding:4px 10px; font-size:11.5px; gap:5px; text-decoration:none;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              Rewind
            </a>
            <a class="icon-btn icon-btn-visible" id="practice-btn" title="Practice trading this symbol" style="width:auto; padding:4px 10px; font-size:11.5px; gap:5px; text-decoration:none;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
              Practice
            </a>
            ${(trade.better_entry && trade.better_entry.price) || (trade.better_exit && trade.better_exit.price) ? `
            <button type="button" class="icon-btn icon-btn-visible" id="better-toggle-btn" aria-pressed="${showBetter ? "true" : "false"}" title="Show or hide the better entry / better exit pointers on the chart (remembered)" style="width:auto; padding:4px 10px; font-size:11.5px; gap:6px; ${showBetter ? "border-color:#8b7cf6; color:#c9c1ff;" : ""}">
              <span id="better-box" style="display:inline-flex; width:13px; height:13px; box-sizing:border-box; border:1.5px solid currentColor; border-radius:3px; align-items:center; justify-content:center; font-size:10px; line-height:1;">${showBetter ? "\u2713" : ""}</span>
              Better entry/exit
            </button>` : ""}
            <button class="icon-btn icon-btn-visible" id="full-day-btn" title="Load this symbol's whole session so you can zoom/pan out past the trade window" style="width:auto; padding:4px 10px; font-size:11.5px; gap:5px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><path d="M15 3h6v6"></path><path d="M9 21H3v-6"></path><path d="M21 3l-7 7"></path><path d="M3 21l7-7"></path></svg>
              Full day
            </button>
            <button class="icon-btn icon-btn-visible" id="export-chart-btn" title="Export chart as PNG" style="width:auto; padding:4px 10px; font-size:11.5px; gap:5px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              PNG
            </button>
          </div>
        </div>
        <div class="chart-stack" id="chart-stack">
          <div id="candle-chart"></div>
          <div id="macd-resizer" title="Drag to resize the MACD pane (double-click to reset)" role="separator" aria-orientation="horizontal"><span></span></div>
          <div id="macd-chart"></div>
        </div>
      </div>

      <div class="detail-grid">
        <div class="card">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
            <h2 style="margin:0;">Verdict</h2>
            <button class="icon-btn icon-btn-visible" id="copy-verdict-btn" title="Copy verdict text" style="width:auto; padding:4px 10px; font-size:11.5px; gap:5px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              <span id="copy-verdict-label">Copy</span>
            </button>
          </div>
          <div class="verdict-text">${escapeHtml(trade.verdict || "No verdict recorded.")}</div>
          ${trade.setup_type ? `<span class="setup-tag" style="${window.setupTagStyleAttr(trade.setup_type)}">${escapeHtml(trade.setup_type)}</span>` : ""}
          ${rrStrip(trade)}
          ${trade.walk_away_rule ? `<div class="walk-away"><b>Walk-away rule:</b> ${escapeHtml(trade.walk_away_rule)}</div>` : ""}
        </div>
        <div class="card better-card" style="padding:14px 16px;">
          <h2 style="font-size:12.5px; margin:0 0 8px; text-transform:uppercase; letter-spacing:.03em; opacity:.75;">What you should've done</h2>
          ${betterRow("Entry", trade.better_entry)}
          ${betterRow("Exit", trade.better_exit)}
          ${!trade.better_entry && !trade.better_exit ? `<div class="no-better" style="font-size:12px; opacity:.7;">No better entry/exit flagged — this trade lined up with the plan.</div>` : ""}
        </div>

        <div class="card">
          <h2>Lessons from this trade</h2>
          ${Array.isArray(trade.lessons) && trade.lessons.length
            ? `<ul class="lessons-list" style="margin:0; padding-left:18px;">${trade.lessons.map((l) => lessonItem(l)).join("")}</ul>`
            : `<div class="no-better">No lessons recorded for this trade.</div>`}
        </div>

        ${fillsCard(trade)}

        ${hasSymbolInfo(trade) || !hasFloat(trade) ? `
        <div class="card symbol-card" style="grid-column: 1 / -1;">
          <h2>About ${escapeHtml(trade.symbol)}</h2>
          ${hasSymbolInfo(trade) ? `<div class="sym-head"><span class="sym-name">${escapeHtml(trade.symbol_info.name || trade.symbol)}</span></div>` : ""}
          <div class="sym-meta-row">
            ${trade.symbol_info && trade.symbol_info.country ? `<span class="pill">${escapeHtml(trade.symbol_info.country)}</span>` : ""}
            ${trade.symbol_info && trade.symbol_info.sector ? `<span class="pill">${escapeHtml(trade.symbol_info.sector)}</span>` : ""}
            ${volumeFloatPills(trade)}
            ${!hasFloat(trade) ? (trade._floatChecked
              ? `<span class="pill" style="opacity:.6;" title="Polygon has no share count on file for this symbol">Float unavailable</span>`
              : `<button type="button" class="icon-btn icon-btn-visible" id="get-float-btn" title="Look up this symbol's float from Polygon (one-time per symbol)" style="width:auto; padding:3px 10px; font-size:11px;">Get float</button>`
            ) : ""}
          </div>
          ${hasSymbolInfo(trade) ? `<div class="sym-desc">${escapeHtml(trade.symbol_info.description || "")}</div>` : ""}
        </div>` : ""}

        <div class="card sr-box" style="grid-column: 1 / -1;">
          <div class="sr-head">
            <div>
              <h2 style="margin:0;">Support &amp; Resistance</h2>
              <div class="sr-sub">Reads this symbol's prior daily bars (before this trade) and draws support/resistance lines on the chart above. Off by default — click to run it whenever you want a read.</div>
            </div>
            <button class="sr-run-btn" id="sr-run-btn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"></path><path d="M18.4 8.6 12 15l-3-3-4 4"></path></svg>
              Analyze support/resistance
            </button>
          </div>
          <div id="sr-result"></div>
        </div>
      </div>

      <div id="journal-card"></div>
    `;

    renderPager(trade, siblings || []);
    buildCharts(trade);
    if (window.TradeNotes) renderJournalCard(trade);

    // Self-graded execution quality (1-5 stars, separate from win/loss --
    // see grade.js). Persists to localStorage immediately on click; the
    // small label next to the stars just echoes what was picked so it
    // isn't purely a hover tooltip.
    const gradeRow = document.getElementById("grade-row");
    if (gradeRow && window.TradeGrade) {
      const gradeLabelEl = document.getElementById("grade-label");
      const current = window.TradeGrade.get(trade);
      const paintLabel = (g) => { gradeLabelEl.textContent = g ? window.TradeGrade.label(g) : "Not graded — click a star"; };
      paintLabel(current);
      window.TradeGrade.attachInteractive(gradeRow, trade.id, current, (next) => {
        trade.grade = next; // keep in sync for this render (siblingNav/etc. don't read it, but future code might)
        paintLabel(next);
      });
    }

    const copyBtn = document.getElementById("copy-verdict-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        const label = document.getElementById("copy-verdict-label");
        const text = trade.verdict || "";
        const done = () => { label.textContent = "Copied!"; setTimeout(() => (label.textContent = "Copy"), 1500); };
        const fail = () => { label.textContent = "Couldn't copy"; setTimeout(() => (label.textContent = "Copy"), 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, fail);
        } else {
          // Fallback for browsers without the async Clipboard API.
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); done(); } catch (e) { fail(); }
          document.body.removeChild(ta);
        }
      });
    }

    const srBtn = document.getElementById("sr-run-btn");
    if (srBtn) {
      srBtn.addEventListener("click", () => runSupportResistance(trade, srBtn));
    }

    // "Get float" -- on-demand replacement for the float lookup
    // chart_service.py's /generate-chart used to run automatically on
    // every trade (see compute_volume_float_stats' docstring). Costs a
    // live Polygon call only the first time ANYONE asks about this
    // symbol (see float_shares_store.py); after that it's served from
    // cache. /fetch-float also saves the result onto this trade's row in
    // Supabase, so re-opening it later shows the float without another
    // click -- update the in-memory trade object here too so the pills,
    // the chart's info overlay, and a re-render (e.g. "Show full day")
    // all reflect it immediately without a page reload.
    const getFloatBtn = document.getElementById("get-float-btn");
    if (getFloatBtn) {
      getFloatBtn.addEventListener("click", () => {
        if (getFloatBtn.disabled) return;
        getFloatBtn.disabled = true;
        const original = getFloatBtn.textContent;
        getFloatBtn.textContent = "Looking up…";
        authedPost("/fetch-float", { trade_id: trade.id, symbol: trade.symbol })
          .then((data) => {
            trade.indicators = Object.assign({}, trade.indicators, {
              float_shares: data.float_shares,
              float_tag: data.float_tag,
            });
            // Marks this as "already tried this page load" so a symbol
            // Polygon genuinely has no share count for (float_shares
            // comes back null -- see float_shares_store.py's docstring)
            // shows "Float unavailable" instead of the button looping
            // back forever. Not persisted -- a fresh page load (or the
            // symbol getting data later) can always try again.
            trade._floatChecked = true;
            if (currentTrade) {
              currentTrade.indicators = trade.indicators;
              currentTrade._floatChecked = true;
            }
            renderTrade(trade, siblings);
          })
          .catch((err) => {
            getFloatBtn.textContent = original;
            getFloatBtn.disabled = false;
            getFloatBtn.title = "Couldn't fetch float: " + err.message;
          });
      });
    }

    const betterBtn = document.getElementById("better-toggle-btn");
    if (betterBtn) {
      betterBtn.addEventListener("click", () => {
        showBetter = !showBetter;
        try { localStorage.setItem(BETTER_KEY, showBetter ? "1" : "0"); } catch (e) { /* ignore */ }
        syncBetterUi();
        if (betterToggleHandler) betterToggleHandler();
      });
    }

    const fullDayBtn = document.getElementById("full-day-btn");
    if (fullDayBtn) {
      fullDayBtn.addEventListener("click", () => {
        if (fullDayBtn.disabled) return;
        fullDayBtn.disabled = true;
        const original = fullDayBtn.innerHTML;
        fullDayBtn.innerHTML = "Loading…";
        fetchFullDayBars(trade.symbol, trade.trade_date)
          .then((fullBars) => {
            if (!fullBars.length) throw new Error("No bars came back");
            buildCharts(trade, fullBars);
            fullDayBtn.innerHTML = "Full day loaded";
          })
          .catch((err) => {
            fullDayBtn.innerHTML = original;
            fullDayBtn.disabled = false;
            fullDayBtn.title = "Couldn't load the full day: " + err.message;
          });
      });
    }
  }

  // Manual, on-demand only -- fires the SR_ANALYSIS_URL webhook, which
  // reads the symbol's prior daily bars and (optionally) an LLM call to
  // pick out support/resistance levels. Nothing here runs unless the
  // person clicks the button, so a page view alone never costs an API call.
  let srRequestInFlight = false;
  function runSupportResistance(trade, btn) {
    if (srRequestInFlight) return;
    srRequestInFlight = true;
    const resultEl = document.getElementById("sr-result");
    const originalLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "Analyzing…";
    resultEl.innerHTML = `<div class="sr-status">Reading ${escapeHtml(trade.symbol)}'s prior daily bars and computing levels — this can take a few seconds…</div>`;

    fetch(SR_ANALYSIS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: trade.symbol, trade_date: trade.trade_date, lookback_days: 40 }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        renderSrResult(data);
        drawSrLevelsOnChart(data);
      })
      .catch((err) => {
        resultEl.innerHTML = `<div class="sr-status error">Couldn't get support/resistance levels (${escapeHtml(String(err.message))}). Make sure SR_ANALYSIS_URL at the top of trade.js is pointed at your analysis service.</div>`;
      })
      .finally(() => {
        srRequestInFlight = false;
        btn.disabled = false;
        btn.innerHTML = originalLabel;
      });
  }

  // Shared with drawSrLevelsOnChart so the on-chart label matches the
  // "from" text shown in the card below (e.g. "3x touched", or whatever
  // label the LLM/webhook gave the level).
  function srLevelNote(lv) {
    return lv.label || (lv.touches ? lv.touches + "x touched" : "");
  }

  // The LLM-authored label can be a full sentence ("Tested three times
  // and lines up with the 50-day MA..."), which is fine in the sr-result
  // list below but overwhelms the chart's price-line tag. Keep the tag
  // to a short phrase and let the full text live in the list instead.
  function srChartTag(lv) {
    const note = srLevelNote(lv);
    if (!note) return "";
    const cut = note.split(/[.;,]/)[0].trim();
    const words = cut.split(/\s+/);
    let short = words.slice(0, 5).join(" ");
    if (words.length > 5 || short.length < cut.length) short += "…";
    return short.length > 28 ? short.slice(0, 27).trim() + "…" : short;
  }

  function renderSrResult(data) {
    const resultEl = document.getElementById("sr-result");
    const support = Array.isArray(data.support) ? data.support : [];
    const resistance = Array.isArray(data.resistance) ? data.resistance : [];
    if (!support.length && !resistance.length) {
      resultEl.innerHTML = `<div class="sr-status">No clear levels came back for this symbol.</div>`;
      return;
    }
    const levelRow = (lv) => `<div class="lvl-row"><span>$${Number(lv.price).toFixed(2)}</span><span class="note">${escapeHtml(srLevelNote(lv))}</span></div>`;
    resultEl.innerHTML = `
      ${data.summary ? `<div class="sr-summary">${escapeHtml(data.summary)}</div>` : ""}
      <div class="sr-levels">
        <div class="col">
          <div class="col-label resistance">Resistance</div>
          ${resistance.length ? resistance.map(levelRow).join("") : `<div class="lvl-row"><span class="note">None found</span></div>`}
        </div>
        <div class="col">
          <div class="col-label support">Support</div>
          ${support.length ? support.map(levelRow).join("") : `<div class="lvl-row"><span class="note">None found</span></div>`}
        </div>
      </div>
      ${data.source === "computed_fallback" ? `<div class="sr-status">Showing computer-detected pivot levels (the level read didn't come back cleanly).</div>` : ""}
    `;
  }

  // Drawn as solid price lines on the same candlestick series used for the
  // entry/exit/better-entry markers, distinct colors from those (green/red
  // dashed = actual fills, purple/pink dotted = LLM's better fill) so all
  // four line types stay visually distinguishable on one chart.
  function drawSrLevelsOnChart(data) {
    if (!srCandleSeries) return;
    // Clear whatever this function drew last time before adding the new
    // batch -- see the note on srPriceLines above -- so re-running the
    // analysis replaces the lines instead of stacking a duplicate set on
    // top of them.
    srPriceLines.forEach((line) => srCandleSeries.removePriceLine(line));
    srPriceLines = [];
    const support = Array.isArray(data.support) ? data.support : [];
    const resistance = Array.isArray(data.resistance) ? data.resistance : [];
    resistance.forEach((lv) => {
      const tag = srChartTag(lv);
      srPriceLines.push(srCandleSeries.createPriceLine({
        price: Number(lv.price), color: "#f2555a", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true, lineVisible: false,
        title: tag ? `resistance (${tag})` : "resistance",
      }));
    });
    support.forEach((lv) => {
      const tag = srChartTag(lv);
      srPriceLines.push(srCandleSeries.createPriceLine({
        price: Number(lv.price), color: "#2fd08a", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.LargeDashed, axisLabelVisible: true, lineVisible: false,
        title: tag ? `support (${tag})` : "support",
      }));
    });
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
    const how = b.how_to_know
      ? `<div class="how-to-know" style="font-size:11px; opacity:.65; margin-top:2px;">How you'd know: ${escapeHtml(b.how_to_know)}</div>`
      : "";
    return `<div class="better-row" style="display:flex; gap:10px; align-items:baseline; padding:6px 0; border-bottom:1px solid rgba(255,255,255,.06);">
      <div class="tag" style="font-size:10px; font-weight:700; letter-spacing:.03em; opacity:.65; min-width:38px; flex-shrink:0;">${label.toUpperCase()}</div>
      <div class="content" style="flex:1; min-width:0;">
        <div class="price-line" style="font-size:12.5px; font-weight:600;">$${Number(b.price).toFixed(2)}${b.time ? ` @ ${escapeHtml(String(b.time).split("T").pop())}` : ""}</div>
        ${b.reason ? `<div class="reason" style="font-size:11.5px; opacity:.75; margin-top:1px;">${escapeHtml(b.reason)}</div>` : ""}
        ${how}
      </div>
    </div>`;
  }

  // One trade = one whole position (flat -> flat). Its `fills` are the FIFO
  // matched pieces; this folds them back into the real executions you made:
  // every add (entry) and every reduce (exit), merged by time + price, with
  // the position size left after each one.
  function executionsOf(trade) {
    const fills = Array.isArray(trade.fills) ? trade.fills : [];
    if (!fills.length) return [];
    const isLong = String(trade.side || "long").toLowerCase() !== "short";
    const agg = new Map();
    const add = (kind, time, price, qty) => {
      if (!time || price == null) return;
      const k = `${kind}|${time}|${Number(price).toFixed(4)}`;
      const cur = agg.get(k) || { kind, time: String(time), price: Number(price), qty: 0 };
      cur.qty += Number(qty) || 0;
      agg.set(k, cur);
    };
    fills.forEach((f) => {
      add("entry", f.entry_time, f.entry_price, f.qty);
      add("exit", f.exit_time, f.exit_price, f.qty);
    });
    const list = [...agg.values()].sort((a, b) =>
      a.time < b.time ? -1 : a.time > b.time ? 1 : (a.kind === b.kind ? 0 : a.kind === "entry" ? -1 : 1));
    // Partial fills of ONE order (same side, a few seconds apart, usually at
    // slightly different prices) are a single action, not several. Fold them
    // into one execution at the quantity-weighted average price, so a pointer
    // means "I added" / "I reduced" -- not "the market gave me another price".
    const secs = (t) => { const m = String(t).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0)) : NaN; };
    const ORDER_GAP_S = 5;
    const merged = [];
    list.forEach((e) => {
      const prev = merged[merged.length - 1];
      if (prev && prev.kind === e.kind && secs(e.time) - prev._lastSecs <= ORDER_GAP_S) {
        prev._cost += e.price * e.qty;
        prev.qty += e.qty;
        prev.price = prev.qty ? prev._cost / prev.qty : prev.price;
        prev.fillCount += 1;
        prev.parts.push({ time: e.time, price: e.price, qty: e.qty });
        prev.minPrice = Math.min(prev.minPrice, e.price);
        prev.maxPrice = Math.max(prev.maxPrice, e.price);
        prev._lastSecs = secs(e.time);
      } else {
        merged.push(Object.assign({}, e, { _cost: e.price * e.qty, fillCount: 1, parts: [{ time: e.time, price: e.price, qty: e.qty }], minPrice: e.price, maxPrice: e.price, _lastSecs: secs(e.time) }));
      }
    });
    list.length = 0;
    merged.forEach((e) => list.push(e));
    let pos = 0;
    let entryN = 0;
    list.forEach((e) => {
      pos += e.kind === "entry" ? e.qty : -e.qty;
      e.posAfter = Math.max(0, Math.round(pos * 1e6) / 1e6);
      if (e.kind === "entry") {
        entryN += 1;
        e.role = entryN === 1 ? "Open" : "Add";
        e.action = isLong ? "BUY" : "SELL SHORT";
      } else {
        e.role = e.posAfter <= 0 ? "Close" : "Trim";
        e.action = isLong ? "SELL" : "BUY TO COVER";
      }
    });
    return list;
  }
  function fmtQty(n) {
    return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  // Fills: every add (entry) and reduce (exit) that made up this trade, and for
  // each one EXACTLY how many shares filled at each price. Always shown, and sits
  // in the grid cell beside "Lessons".
  function fillsCard(trade) {
    const ex = executionsOf(trade);
    if (!ex.length) return "";
    const px = (v) => "$" + Number(v).toFixed(Number(v) < 1 ? 4 : 2);
    const rows = ex.map((e, i) => {
      const entry = e.kind === "entry";
      const color = entry ? "#2fd08a" : "#f2555a";
      // same price (and second) -> one line; different price -> its own line
      const byLevel = new Map();
      e.parts.forEach((pt) => {
        const k = `${pt.time}|${Number(pt.price).toFixed(4)}`;
        const cur = byLevel.get(k) || { time: pt.time, price: pt.price, qty: 0 };
        cur.qty += pt.qty;
        byLevel.set(k, cur);
      });
      const levels = [...byLevel.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.price - b.price));
      const levelRows = levels.map((l) => `
          <div style="display:grid; grid-template-columns: 1fr auto auto; gap:12px; font-size:12.5px; padding:2px 0;" class="mono">
            <span><b style="color:${color};">${fmtQty(l.qty)}</b> <span style="opacity:.6;">sh</span></span>
            <span>@ <b>${px(l.price)}</b></span>
            <span style="opacity:.6;">${escapeHtml(l.time)}</span>
          </div>`).join("");
      return `
      <div class="fill-row" style="padding:10px 0; ${i < ex.length - 1 ? "border-bottom:1px solid var(--border-soft);" : ""}">
        <div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px; font-size:12.5px; margin-bottom:6px;">
          <span><span style="opacity:.45; margin-right:6px;">${i + 1}</span><b style="color:${color};">${e.role.toUpperCase()}</b> <span style="opacity:.8;">${escapeHtml(e.action)}</span> \u00b7 <b>${fmtQty(e.qty)} sh</b>${levels.length > 1 ? ` @ avg <b>${px(e.price)}</b>` : ""}</span>
          <span style="font-size:11.5px; opacity:.6; white-space:nowrap;">position after: ${fmtQty(e.posAfter)} sh</span>
        </div>
        <div style="padding-left:16px; border-left:2px solid ${color}55;">${levelRows}</div>
      </div>`;
    }).join("");
    return `
        <div class="card fills-card">
          <h2 style="margin:0 0 2px;">Fills (${ex.length})</h2>
          ${rows}
        </div>`;
  }

  function hasSymbolInfo(trade) {
    return !!(trade.symbol_info && (trade.symbol_info.name || trade.symbol_info.description));
  }
  // Float is no longer fetched automatically (see chart_service.py's
  // compute_volume_float_stats docstring) -- this just checks whether
  // it's already been looked up and saved for this trade, so renderTrade
  // knows whether to show the "Get float" button.
  function hasFloat(trade) {
    return !!(trade.indicators || {}).float_shares;
  }

  // Float / avg-volume / relative-volume pills for the About card. Reads
  // from trade.indicators (see chart_service.py compute_volume_float_stats
  // -- these fields land there via /generate-chart, not on a separate
  // top-level key) and shows raw numbers alongside the bucketed tag label.
  function volumeFloatPills(trade) {
    const ind = trade.indicators || {};
    const parts = [];
    if (ind.float_shares) {
      parts.push(`<span class="pill floattag" title="Shares outstanding (float proxy)">Float ${fmtShares(ind.float_shares)}</span>`);
    }
    if (ind.avg_volume_30d) {
      parts.push(`<span class="pill avgvol" title="30-day average daily volume">Avg vol ${fmtShares(ind.avg_volume_30d)}</span>`);
    }
    if (typeof ind.relative_volume === "number") {
      parts.push(`<span class="pill rvol" title="Entry-day volume vs. 30-day average">RVol ${ind.relative_volume.toFixed(2)}x</span>`);
    }
    return parts.join("\n");
  }

  function lessonItem(l) {
    if (typeof l === "string") {
      // Lessons occasionally round-trip through a text column as a raw
      // JSON string instead of an object (e.g. a stringified array
      // element) -- parse it back into one so it renders the same as
      // any other lesson instead of dumping raw JSON text on the page.
      try {
        const parsed = JSON.parse(l);
        if (parsed && typeof parsed === "object") l = parsed;
      } catch (e) { /* genuinely plain text -- fall through below */ }
    }
    if (typeof l === "string") return `<li style="margin-bottom:6px; font-size:12.5px;">${escapeHtml(l)}</li>`;
    // "How you'd know" is deliberately NOT shown here -- it's a real-time
    // signal to watch for, which belongs with the better-entry/exit calls
    // in betterRow() ("What you should've done"). A lesson is a
    // retrospective note about the trade, so even if an older lesson
    // still carries a how_to_know from before the prompt stopped asking
    // for one (see daily_sync.py's _build_verdict_prompt), it's ignored
    // here rather than duplicated into this section.
    const tagBadge = l.tag
      ? `<span class="lesson-tag" style="display:inline-block; font-size:10px; font-weight:600; letter-spacing:.02em; text-transform:uppercase; padding:1px 6px; border-radius:3px; background:rgba(91,147,240,.15); color:#5b93f0; margin-left:6px; vertical-align:middle;">${escapeHtml(String(l.tag).replace(/_/g, " "))}</span>`
      : "";
    return `<li style="margin-bottom:8px; font-size:12.5px;"><span class="lesson-body" style="flex:1; min-width:0;">${escapeHtml(l.lesson || l.text || "")}${tagBadge}</span></li>`;
  }

  function buildCharts(trade, overrideBars) {
    // overrideBars lets the "Show full day" button re-run this whole
    // function against a wider bars array instead of duplicating all the
    // series/marker/price-line setup below just to widen the data.
    const bars = (overrideBars && overrideBars.length) ? overrideBars : trade.bars;

    // Dispose whatever chart instance is already sitting in these
    // containers before creating a new one -- otherwise a second
    // buildCharts() call (the full-day rebuild) would stack a second
    // canvas inside each div rather than replacing the first.
    if (currentChartHandle) { window.ChartIndicators.teardownStandardChart(currentChartHandle); currentChartHandle = null; }
    currentCandleChart = null;
    if (currentMacdChart) { try { currentMacdChart.remove(); } catch (e) {} currentMacdChart = null; }
    pointersResizeHandler = null;

    // Builds every series' data array from whichever bar set is currently
    // displayed -- the raw 1-minute bars, or a 5m/15m/1h set resampled
    // from them client-side (see the timeframe switcher further down).
    // Kept as a function so switching timeframe just re-derives these and
    // calls setData() again on the existing series, instead of tearing
    // down and rebuilding the whole chart (which would also have to
    // re-plumb the pointers/price-lines below).
    function seriesDataFor(displayBars) {
      return {
        candleData: displayBars.map((b) => ({ time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c })),
        volData: displayBars.map((b) => ({ time: toUnix(b.t), value: b.v, color: b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" })),
        vwapData: displayBars.map((b) => ({ time: toUnix(b.t), value: b.vwap })),
        ema9Data: displayBars.map((b) => ({ time: toUnix(b.t), value: b.ema9 })),
        ema20Data: displayBars.map((b) => ({ time: toUnix(b.t), value: b.ema20 })),
        ema200Data: displayBars.map((b) => ({ time: toUnix(b.t), value: b.ema200 })),
        macdData: displayBars.map((b) => ({ time: toUnix(b.t), value: b.macd })),
        signalData: displayBars.map((b) => ({ time: toUnix(b.t), value: b.macd_signal })),
        histData: displayBars.map((b) => ({ time: toUnix(b.t), value: b.macd_hist, color: (b.macd_hist || 0) >= 0 ? "#2fd08a" : "#f2555a" })),
      };
    }

    const initialDisplayBars = currentInterval === 1 ? bars : window.ChartIndicators.resampleBars(bars, currentInterval);
    let currentSeriesData = seriesDataFor(initialDisplayBars);
    const { candleData, volData, vwapData, ema9Data, ema20Data, ema200Data, macdData, signalData, histData } = currentSeriesData;

    const candleEl = document.getElementById("candle-chart");
    const floatShares = (trade.indicators || {}).float_shares;
    function lastOf(arr) { return arr.length ? arr[arr.length - 1].value : null; }
    // onResize reads currentMacdChart/pointersResizeHandler live off
    // module state (rather than closing over this call's own macdChart/
    // repositionPointers bindings) -- both are only assigned further down
    // in this same buildCharts() call, so by the time a real resize event
    // fires they're populated; same "read live" approach the old
    // window-level listener used, just now driven by buildStandardChart's
    // per-instance ResizeObserver instead of a hand-rolled attach-once one.
    const handle = window.ChartIndicators.buildStandardChart(candleEl, initialDisplayBars, {
      height: 420,
      minimumWidth: 92, // room for "better entry" / "better exit" price-line titles
      priceScaleMargins: { top: 0.14, bottom: 0.18 }, // headroom for pointer markers at any zoom level
      volScaleMargins: { top: 0.82, bottom: 0 },
      showLastValueLine: false, // entry/exit/S-R lines are all drawn explicitly below; the built-in one is redundant noise
      hideTimeAxis: true, // the MACD pane below owns the one shared time axis
      fullscreenHost: document.getElementById("chart-stack"), // candle + MACD go fullscreen together
      drawKey: trade && trade.symbol ? trade.symbol + ":" + (trade.trade_date || "") : null, // saved drawings (support lines etc.) per symbol + day
      onFullscreenFit: () => {
        const m = document.getElementById("macd-chart");
        if (currentMacdChart && m) currentMacdChart.applyOptions({ width: m.clientWidth, height: m.clientHeight || 90 });
        if (pointersResizeHandler) pointersResizeHandler();
      },
      onFocus: () => zoomToTrade(),
      floatLabel: floatShares ? fmtShares(floatShares) : null,
      onResize: () => {
        const macdElNow = document.getElementById("macd-chart");
        if (currentMacdChart && macdElNow) currentMacdChart.applyOptions({ width: macdElNow.clientWidth });
        if (pointersResizeHandler) pointersResizeHandler();
      },
    });
    currentChartHandle = handle;
    const { chart: candleChart, series: candleSeries, volSeries, vwapSeries, ema9Series, ema20Series, ema200Series, renderOverlay, handleState } = handle;
    currentCandleChart = candleChart;
    srCandleSeries = candleSeries;

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

    // better_entry.time / better_exit.time come from the LLM verdict step
    // and, unlike entry_time/exit_time, are never guaranteed to include a
    // date -- most of the time they're just "HH:MM:SS". Handing a bare time
    // straight to toUnix()/new Date() either parses as Invalid Date (NaN),
    // which makes barAt() silently fall through its whole loop and return
    // bars[0] -- the FIRST candle on the chart, regardless of when the
    // trade actually happened -- or, in engines that accept a bare time,
    // resolves it against *today's* date instead of the trade's date,
    // landing it off the visible range entirely. Either way the dotted
    // price line (which only depends on price) looks right while the
    // pointer (which depends on this) ends up nowhere near it. Detect a
    // bare time (no "YYYY-MM-DD" in it) and explicitly prepend the trade's
    // own date before parsing, so it always resolves against the right day.
    function betterUnix(timeStr) {
      if (!timeStr) return NaN;
      const hasDate = /\d{4}-\d{2}-\d{2}/.test(timeStr);
      return toUnix(hasDate ? timeStr : `${trade.trade_date} ${timeStr}`);
    }

    // The LLM's suggested time and suggested price are two independent
    // guesses, and they don't always agree with each other: it can name a
    // real minute that resolves to a real candle (so betterUnix/barAt above
    // both succeed) while the *price* it gave was never actually touched
    // in that candle -- the wick doesn't reach it. The pointer still lands
    // on a legitimate candle, just the wrong one: the dotted price line
    // keeps pointing at where that price really traded, while the pointer
    // sits one or more minutes off from it. Cross-check the two: if the
    // price isn't within [low, high] of the time-based candle, search
    // outward in both directions (by bar index, i.e. by time) for the
    // nearest candle whose range actually contains that price, and use
    // that instead -- so the pointer always lands on "the one the line
    // means" rather than wherever the LLM said. If literally no candle in
    // the session touched that price, there's nothing better to snap to,
    // so the time-based candle is kept as the closest available guess.
    function barForPrice(price, candidateBar) {
      const within = (b) => price <= b.h + 1e-6 && price >= b.l - 1e-6;
      if (within(candidateBar)) return candidateBar;
      const idx = bars.indexOf(candidateBar);
      for (let d = 1; d < bars.length; d++) {
        const before = bars[idx - d];
        const after = bars[idx + d];
        if (before && within(before)) return before;
        if (after && within(after)) return after;
        if (!before && !after) break;
      }
      return candidateBar;
    }

    // Small, clear pointer markers instead of a label box + connector stem
    // + full-width dashed price line: just a tiny triangle sitting right on
    // the exact fill point, pointing straight at it. Nothing else on the
    // chart competes with it for attention, and it never gets orphaned from
    // its own price line the way the old label system could.
    //
    // The pointer itself owns its tooltip -- a styled box (not the native
    // title attribute, which can't be styled and is easy to misread as
    // "cut off" since it wraps awkwardly at narrow widths) showing the
    // FULL price/time plus, for "better" markers, the full reason +
    // how_to_know text -- nothing truncated, so nothing has to be crammed
    // into the short on-chart tag. It opens on hover for mouse users and on
    // tap for touch users (hover doesn't fire on touchscreens), so there's
    // no separate "i" badge competing for space on the chart.
    //
    // Appended to `wrap` directly (not the pointer overlay, which clips its
    // contents to the chart's bounds via overflow:hidden) so the tooltip is
    // never cut off at the pane edge.
    function buildPointer(tooltipHtml, color) {
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
      el.style.cssText = `
        position:absolute; width:0; height:0; pointer-events:auto;
        border-left:6px solid transparent; border-right:6px solid transparent;
        filter: drop-shadow(0 0 1.5px #0b0d10) drop-shadow(0 0 1.5px #0b0d10);
      `;
      overlay.appendChild(el);

      let tooltip = null;
      if (tooltipHtml) {
        tooltip = document.createElement("div");
        tooltip.className = "pointer-tooltip";
        tooltip.dataset.open = "0";
        tooltip.style.cssText = `
          position:absolute; display:none; width:220px; max-width:60vw;
          background:#181b22; border:1px solid ${color}; border-radius:8px;
          padding:10px 12px; font-size:12px; line-height:1.5; color:#eceef2;
          box-shadow:0 6px 20px rgba(0,0,0,.45); z-index:5; pointer-events:none;
        `;
        tooltip.innerHTML = tooltipHtml;
        wrap.appendChild(tooltip);

        const openTooltip = () => {
          wrap.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
          tooltip.dataset.open = "1";
          tooltip.style.display = "block";
          repositionPointers();
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
      return { el, tooltip };
    }

    // Any click outside a pointer tooltip closes whichever one is pinned
    // open -- otherwise a tapped-open tooltip would just sit there covering
    // the chart. (Hover-opened tooltips already close on mouseleave.)
    // Attached once ever -- otherwise "Show full day" re-running
    // buildCharts() stacks another copy of this on every rebuild. Reads
    // candleEl fresh off the DOM rather than closing over this call's
    // binding, so it always finds whichever tooltips are actually on the
    // page right now.
    if (!tooltipCloseListenerAttached) {
      tooltipCloseListenerAttached = true;
      document.addEventListener("click", () => {
        const el = document.getElementById("candle-chart");
        if (el) el.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
      });
    }

    const POINTER_H = 9; // triangle height in px -- also used to correct the tip offset in repositionPointers()

    const entryBar = barAt(toUnix(`${trade.trade_date} ${trade.entry_time}`));
    const exitBar = barAt(toUnix(`${trade.trade_date} ${trade.exit_time}`));

    // Chart-only tooltip content: marker + price + the how_to_know signal,
    // in full -- nothing truncated. This mirrors the older version of this
    // file -- the chart shows *why* to act (the observable signal), while
    // the "What you should've done" card (betterRow) carries the full
    // reason + how_to_know prose too. Using how_to_know here (not reason)
    // is what keeps the chart's wording genuinely different from the
    // card's, rather than a shorter copy of it. Returns HTML (escaped)
    // since it's dropped straight into the tooltip's innerHTML.
    function tooltipHtml(head, signal) {
      const headLine = `<div style="font-weight:700;${signal ? " margin-bottom:4px;" : ""}">${escapeHtml(head)}</div>`;
      return headLine + (signal ? `<div>${escapeHtml(signal)}</div>` : "");
    }

    function betterTooltip(kind, b) {
      return tooltipHtml(`better ${kind} $${Number(b.price).toFixed(2)}`, b.how_to_know || "");
    }

    // Same idea as betterTooltip, but for the ACTUAL fill: marker + price +
    // the entry_indicator/exit_indicator signal -- what was actually
    // visible in real time that justified acting at this price, not the
    // hypothetical better one.
    function actualTooltip(kind, price, indicator) {
      return tooltipHtml(`${kind.toUpperCase()} $${price.toFixed(2)}`, indicator || "");
    }

    const ACTUAL_ENTRY_COLOR = "#2fd08a"; // green, matches the entry pointer/legend
    const ACTUAL_EXIT_COLOR = "#f2555a"; // red, matches the exit pointer/legend

    // buildPointer returns { el, tooltip } -- el is the triangle marker,
    // tooltip is its hover/tap popup (null if there's no text to show).
    // mkPointer flattens that into one entry for the `pointers` array,
    // which repositionPointers() below reads by both el and tooltip.
    function mkPointer(time, price, color, above, tooltipHtmlText) {
      const { el, tooltip } = buildPointer(tooltipHtmlText, color);
      return { time, price, color, above, el, tooltip };
    }

    // One pointer per real execution (every add and every reduce), each with
    // its own hover/tap tooltip showing the shares added or sold. Trades
    // saved without fills fall back to a single entry + single exit pointer.
    const executions = executionsOf(trade);
    const lastExitIdx = (() => { for (let i = executions.length - 1; i >= 0; i--) if (executions[i].kind === "exit") return i; return -1; })();
    function executionTooltip(e, idx) {
      const entry = e.kind === "entry";
      const head = `${entry ? "+" : "\u2212"}${fmtQty(e.qty)} sh \u00b7 ${e.action} @ $${e.price.toFixed(e.price < 1 ? 4 : 2)}`;
      let signal = `${e.role} at ${e.time} \u2192 position ${fmtQty(e.posAfter)} sh`;
      if (e.fillCount > 1) signal += ` \u00b7 ${e.fillCount} partial fills, $${e.minPrice.toFixed(2)}\u2013$${e.maxPrice.toFixed(2)}`;
      const indicator = idx === 0 ? trade.entry_indicator : (idx === lastExitIdx ? trade.exit_indicator : "");
      if (indicator) signal += ` \u2014 ${indicator}`;
      return tooltipHtml(head, signal);
    }
    const pointers = [];
    if (executions.length) {
      const stack = new Map(); // same bar + same side -> nudge sideways so they don't hide each other
      executions.forEach((e, idx) => {
        const bar = barAt(toUnix(`${trade.trade_date} ${e.time}`));
        const entry = e.kind === "entry";
        const p = mkPointer(toUnix(bar.t), e.price, entry ? ACTUAL_ENTRY_COLOR : ACTUAL_EXIT_COLOR, entry, executionTooltip(e, idx));
        const k = `${p.time}|${e.kind}`;
        const n = stack.get(k) || 0;
        stack.set(k, n + 1);
        p.dx = n * 8;
        pointers.push(p);
      });
    } else {
      pointers.push(
        // Entry: triangle sits just above the fill, tip pointing down onto it.
        mkPointer(toUnix(entryBar.t), trade.entry_price, ACTUAL_ENTRY_COLOR, true,
          actualTooltip("entry", trade.entry_price, trade.entry_indicator)),
        // Exit: triangle sits just below the fill, tip pointing up onto it.
        mkPointer(toUnix(exitBar.t), trade.exit_price, ACTUAL_EXIT_COLOR, false,
          actualTooltip("exit", trade.exit_price, trade.exit_indicator)),
      );
    }
    // Better entry/exit get their own pointers, in colors that match their
    // legend swatches and dotted price lines below -- so color alone ties a
    // triangle to the right line without reading labels. These are their
    // own distinct hues (purple / pink) rather than a faded green/red, so a
    // "better" pointer never reads as just a dimmer copy of the actual
    // entry/exit pointer -- the two are unmistakably different markers even
    // at a glance. Each snaps to the bar its own suggested time falls on
    // (falling back to the actual entry/exit bar if no time was given)
    // rather than reusing the actual fill's x-position.
    const BETTER_ENTRY_COLOR = "#8b7cf6"; // purple
    const BETTER_EXIT_COLOR = "#ec6cad"; // pink

    // barForPrice (above) only ever decides which BAR to anchor to in
    // TIME -- it never touches the price itself, which stays whatever the
    // LLM said even when no bar it searched actually reached that price.
    // Most of the time that's a harmless near-miss (off by a cent or two),
    // but when the LLM's number was never touched by any candle all
    // session -- a genuine hallucination, not just an off-by-one-bar
    // guess -- drawing the pointer at that raw price puts it at a
    // y-coordinate nothing on the chart supports, floating in empty space
    // away from every wick: "on its own island". Clamp the *drawn*
    // position to the nearest edge of whatever bar we landed on so the
    // marker always sits against a real candle instead of hanging in
    // whitespace. The tooltip still shows the LLM's actual suggested
    // price (via betterTooltip/b.price below) -- only the pixel position
    // is clamped, not the analysis text.
    function clampToBar(price, bar) {
      if (price > bar.h) return bar.h;
      if (price < bar.l) return bar.l;
      return price;
    }

    if (trade.better_entry && trade.better_entry.price) {
      const b = trade.better_entry;
      const u = betterUnix(b.time);
      const bar = barForPrice(Number(b.price), Number.isFinite(u) ? barAt(u) : entryBar);
      const renderPrice = clampToBar(Number(b.price), bar);
      const bp = mkPointer(toUnix(bar.t), renderPrice, BETTER_ENTRY_COLOR, true, betterTooltip("entry", b));
      bp.better = true;
      pointers.push(bp);
    }
    if (trade.better_exit && trade.better_exit.price) {
      const b = trade.better_exit;
      const u = betterUnix(b.time);
      const bar = barForPrice(Number(b.price), Number.isFinite(u) ? barAt(u) : exitBar);
      const renderPrice = clampToBar(Number(b.price), bar);
      const bp = mkPointer(toUnix(bar.t), renderPrice, BETTER_EXIT_COLOR, false, betterTooltip("exit", b));
      bp.better = true;
      pointers.push(bp);
    }

    // A zero-size div with only border-bottom set renders a triangle whose
    // TIP sits at the box's OWN top edge, with the flat BASE extending
    // downward (by POINTER_H) from there; border-top-only is the mirror
    // image -- its tip sits POINTER_H *below* its own top edge, with the
    // base at the top. So "below" markers (border-bottom, tip pointing up)
    // can have their top set to the price-y directly, but "above" markers
    // (border-top, tip pointing down) need their top shifted up by
    // POINTER_H first, or the price ends up at the flat base instead of the
    // tip. See repositionPointers() below, which applies that shift.
    pointers.forEach((p) => {
      p.el.style.borderTop = p.above ? `${POINTER_H}px solid ${p.color}` : "";
      p.el.style.borderBottom = p.above ? "" : `${POINTER_H}px solid ${p.color}`;
    });

    function repositionPointers() {
      pointers.forEach((p) => {
        const x0 = candleChart.timeScale().timeToCoordinate(p.time);
        const x = x0 === null ? null : x0 + (p.dx || 0);
        const y = candleSeries.priceToCoordinate(p.price);
        if ((p.better && !showBetter) || x === null || y === null) {
          p.el.style.display = "none";
          if (p.tooltip) { p.tooltip.style.display = "none"; p.tooltip.dataset.open = "0"; }
          return;
        }
        p.el.style.display = "block";
        p.el.style.left = `${x}px`;
        // "above" markers (border-top) have their tip POINTER_H below their
        // own top edge, so shift up by POINTER_H to land the tip -- not the
        // base -- on the price. "below" markers (border-bottom) already
        // have their tip at their own top edge, so no shift is needed.
        const pointerTop = p.above ? y - POINTER_H : y;
        p.el.style.top = `${pointerTop}px`;
        p.el.style.transform = "translateX(-50%)";
        // The tooltip only needs positioning while it's actually open --
        // offset to the side of the triangle (above-left for "above"
        // markers, below-left for "below" ones) so it never sits on top of
        // the marker it belongs to.
        if (p.tooltip && p.tooltip.dataset.open === "1") {
          p.tooltip.style.left = `${x + 8}px`;
          p.tooltip.style.top = `${p.above ? pointerTop - 8 : pointerTop + POINTER_H + 8}px`;
          p.tooltip.style.transform = p.above ? "translateY(-100%)" : "none";
        }
      });
    }

    candleChart.timeScale().subscribeVisibleLogicalRangeChange(repositionPointers);
    // Read via the "attached once ever" resize listener further down
    // (same one that resizes currentCandleChart/currentMacdChart) instead
    // of adding a fresh window listener here -- see the note on
    // pointersResizeHandler above.
    pointersResizeHandler = repositionPointers;
    betterToggleHandler = repositionPointers;
    // priceToCoordinate depends on the right price scale's own autoscale,
    // which isn't settled until after setData/fitContent run -- a couple
    // of follow-up passes catch that instead of racing it.
    repositionPointers();
    requestAnimationFrame(repositionPointers);
    setTimeout(repositionPointers, 0);

    // Best fix for "pointers drift away from their candle": ask the chart to
    // call us from INSIDE its own paint, when the price/time scales are already
    // up to date. (The visible-range event fires before the price autoscale has
    // re-fit, so repositioning from it used the previous frame's scale.)
    candleSeries.attachPrimitive({
      attached() {}, detached() {}, updateAllViews() {},
      paneViews() { return [{ zOrder() { return "top"; }, renderer() { return { draw() { repositionPointers(); } }; } }]; },
    });

    // The library has no event for a PRICE-axis change (wheel/drag on the
    // price scale, autoscale re-fit), only for the time range -- so pointers
    // used to stay put until the chart itself was moved. Watch the pixel
    // position of a few reference prices each frame and re-place the pointers
    // the moment any of them moves. Cheap (a handful of lookups per frame);
    // stops by itself once this chart has been replaced or removed.
    if (pointerWatchRaf) cancelAnimationFrame(pointerWatchRaf);
    let lastSig = "";
    (function watchPriceScale() {
      if (!candleEl.isConnected || currentCandleChart !== candleChart) { pointerWatchRaf = 0; return; }
      const refs = [candleSeries.coordinateToPrice(0), candleSeries.coordinateToPrice(candleEl.clientHeight || 400)];
      const sig = refs.join("|") + "|" + (pointers[0] ? candleSeries.priceToCoordinate(pointers[0].price) : "");
      if (sig !== lastSig) { lastSig = sig; repositionPointers(); }
      pointerWatchRaf = requestAnimationFrame(watchPriceScale);
    })();

    candleSeries.createPriceLine({
      price: trade.entry_price,
      color: "#2fd08a",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      lineVisible: true,
      axisLabelVisible: true,
      title: "",
    });
    candleSeries.createPriceLine({
      price: trade.exit_price,
      color: "#f2555a",
      lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      lineVisible: true,
      axisLabelVisible: true,
      title: "",
    });

    // "Rewind" (renamed from "Replay" to match where it actually goes) sends
    // this trade over to the Rewind page's own replay/practice experience
    // instead of duplicating a second, page-local scrub player here -- one
    // replay implementation instead of two slightly-different ones to keep
    // in sync. "Practice" is the same ?trade= deep-link convention, pointed
    // at the Practice page instead, so you can go straight from reviewing a
    // trade to trading that same chart live.
    const replayBtn = document.getElementById("replay-btn");
    if (replayBtn) replayBtn.href = `rewind.html?trade=${encodeURIComponent(trade.id)}`;
    const practiceBtn = document.getElementById("practice-btn");
    if (practiceBtn) practiceBtn.href = `practice.html?trade=${encodeURIComponent(trade.id)}`;

    const macdEl = document.getElementById("macd-chart");
    // Same layout/grid/axis theme buildStandardChart uses for the candle
    // chart above -- kept as a small local literal rather than exported
    // from chart-indicators.js, since the MACD pane's own series
    // (histogram + 2 plain lines, no candles/volume/VWAP/EMA) aren't part
    // of the standard-chart shape that helper builds.
    const macdCt = window.chartThemeColors ? window.chartThemeColors() : { text: "#8b98a5", grid: "#1c2127", border: "#232830" };
    // Must mirror the candle chart's phone sizing: the price-scale gutter
    // width decides where the plot area starts, and the two panes only line
    // up bar-for-bar (they're range-synced) if both gutters are the same. It
    // also needs the same touch handling, or the MACD pane swallows vertical
    // swipes and the page can't be scrolled past it.
    const macdPhone = window.ChartIndicators.isPhone();
    const macdCommonOpts = {
      layout: { background: { color: "transparent" }, textColor: macdCt.text, fontSize: macdPhone ? 10 : 12 },
      grid: { vertLines: { color: macdCt.grid }, horzLines: { color: macdCt.grid } },
      rightPriceScale: { borderColor: macdCt.border, minimumWidth: macdPhone ? 60 : 92 },
      timeScale: { borderColor: macdCt.border, timeVisible: true, secondsVisible: false, rightOffset: macdPhone ? 3 : 0 },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      ...window.ChartIndicators.touchChartOpts(),
    };
    // Use the container's real (CSS) height -- 80px on phones -- not a
    // hard-coded 110, which overflowed the box and clipped the bottom axis.
    const macdChart = LightweightCharts.createChart(macdEl, { ...macdCommonOpts, width: macdEl.clientWidth, height: macdEl.clientHeight || 110 });
    currentMacdChart = macdChart;
    const macdHistSeries = macdChart.addHistogramSeries({ priceFormat: { type: "price", precision: 3 } });
    macdHistSeries.setData(histData);
    const macdLineSeries = macdChart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    macdLineSeries.setData(macdData);
    const macdSignalLineSeries = macdChart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    macdSignalLineSeries.setData(signalData);

    // Two-way range sync. The old version had each chart set the other's
    // range from its own change handler with no guard, so every pan/pinch
    // bounced between the panes (visible jitter on touch). The flag plus the
    // "already equal" check stops the echo.
    let rangeSyncing = false;
    function linkRanges(src, dst) {
      src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (!range || rangeSyncing) return;
        const cur = dst.timeScale().getVisibleLogicalRange();
        if (cur && Math.abs(cur.from - range.from) < 0.01 && Math.abs(cur.to - range.to) < 0.01) return;
        rangeSyncing = true;
        try { dst.timeScale().setVisibleLogicalRange(range); } finally { rangeSyncing = false; }
      });
    }
    linkRanges(candleChart, macdChart);
    linkRanges(macdChart, candleChart);

    // Mirror the candle crosshair onto the MACD pane so scrubbing the price
    // chart shows the same moment's MACD reading.
    let xhairSyncing = false;
    candleChart.subscribeCrosshairMove((param) => {
      if (xhairSyncing) return;
      xhairSyncing = true;
      try {
        if (param && param.time !== undefined && param.point) macdChart.setCrosshairPosition(0, param.time, macdLineSeries);
        else macdChart.clearCrosshairPosition();
      } catch (e) {} finally { xhairSyncing = false; }
    });

    // Zoom the view to the entry->exit window (with some context either
    // side). Wired to the fullscreen/zoom toolbar's target button.
    function zoomToTrade() {
      try {
        if (!trade.entry_time || !trade.exit_time) { candleChart.timeScale().fitContent(); return; }
        const a = toUnix(`${trade.trade_date} ${trade.entry_time}`);
        const b = toUnix(`${trade.trade_date} ${trade.exit_time}`);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const pad = Math.max(8 * currentInterval * 60, (hi - lo) * 0.75);
        candleChart.timeScale().setVisibleRange({ from: lo - pad, to: hi + pad });
      } catch (e) { try { candleChart.timeScale().fitContent(); } catch (e2) {} }
    }

    // Drag handle between the panes: resizes the MACD pane vertically.
    // Normal view: MACD height in px (candle stays 420). Fullscreen: the MACD
    // pane's share of the screen (candle takes the rest). Remembered.
    (function wireMacdResizer() {
      const stack = document.getElementById("chart-stack");
      const handleEl = document.getElementById("macd-resizer");
      if (!stack || !handleEl) return;
      const KEY = "trade.macdH";
      const DEFAULT_H = window.ChartIndicators.isPhone() ? 64 : 90;
      let macdH = DEFAULT_H;
      try { const v = parseInt(localStorage.getItem(KEY), 10); if (v >= 50 && v <= 600) macdH = v; } catch (e) {}
      function apply() {
        const fsOn = stack.classList.contains("chart-fs");
        const maxH = fsOn ? Math.floor(stack.clientHeight * 0.7) : 400;
        const h = Math.max(50, Math.min(macdH, maxH || macdH));
        macdEl.style.height = fsOn ? "" : h + "px";
        macdEl.style.flex = fsOn ? "0 0 " + h + "px" : "";
        if (!fsOn) macdEl.style.minHeight = "0";
        try { macdChart.applyOptions({ width: macdEl.clientWidth, height: h }); } catch (e) {}
        if (currentChartHandle && currentChartHandle.fullscreen && fsOn) { try { currentChartHandle.fullscreen.fit(); } catch (e) {} }
        if (pointersResizeHandler) pointersResizeHandler();
      }
      apply();
      new MutationObserver(() => requestAnimationFrame(apply)).observe(stack, { attributes: true, attributeFilter: ["class"] });
      let startY = 0, startH = 0, dragging = false;
      handleEl.addEventListener("pointerdown", (e) => {
        dragging = true; startY = e.clientY; startH = macdEl.clientHeight || macdH;
        try { handleEl.setPointerCapture(e.pointerId); } catch (err) {}
        handleEl.classList.add("dragging");
        e.preventDefault();
      });
      handleEl.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        macdH = Math.round(startH + (startY - e.clientY)); // drag up = taller MACD
        apply();
      });
      const end = () => {
        if (!dragging) return;
        dragging = false; handleEl.classList.remove("dragging");
        try { localStorage.setItem(KEY, String(macdH)); } catch (e) {}
      };
      handleEl.addEventListener("pointerup", end);
      handleEl.addEventListener("pointercancel", end);
      handleEl.addEventListener("dblclick", () => { macdH = DEFAULT_H; try { localStorage.removeItem(KEY); } catch (e) {} apply(); });
    })();

    candleChart.timeScale().fitContent();
    macdChart.timeScale().fitContent();

    // Timeframe switcher (1m/5m/15m/1h), resampled client-side from the
    // 1-minute bars already loaded -- no extra network call. Switching
    // just re-derives each series' data and calls setData() again; the
    // pointers/price-lines below are positioned by absolute time/price
    // (timeToCoordinate/priceToCoordinate), so they keep working
    // unchanged at any timeframe.
    function applyInterval(minutes) {
      currentInterval = minutes;
      if (window.ChartIndicators.syncTimeframeSwitchers) window.ChartIndicators.syncTimeframeSwitchers(minutes);
      const displayBars = minutes === 1 ? bars : window.ChartIndicators.resampleBars(bars, minutes);
      currentSeriesData = seriesDataFor(displayBars);
      candleSeries.setData(currentSeriesData.candleData);
      volSeries.setData(currentSeriesData.volData);
      vwapSeries.setData(currentSeriesData.vwapData);
      ema9Series.setData(currentSeriesData.ema9Data);
      ema20Series.setData(currentSeriesData.ema20Data);
      ema200Series.setData(currentSeriesData.ema200Data);
      macdHistSeries.setData(currentSeriesData.histData);
      macdLineSeries.setData(currentSeriesData.macdData);
      macdSignalLineSeries.setData(currentSeriesData.signalData);
      // buildStandardChart's own crosshair handler falls back to
      // handleState whenever nothing's hovered -- keep it in sync with
      // whichever timeframe is now showing, or leaving the crosshair
      // after a switch would fall back to stale 1-minute values.
      handleState.lastVol = lastOf(currentSeriesData.volData);
      handleState.lastVwap = lastOf(currentSeriesData.vwapData);
      handleState.lastEma9 = lastOf(currentSeriesData.ema9Data);
      handleState.lastEma20 = lastOf(currentSeriesData.ema20Data);
      handleState.lastEma200 = lastOf(currentSeriesData.ema200Data);
      renderOverlay(
        handleState.lastVol, "",
        handleState.lastVwap, handleState.lastEma9, handleState.lastEma20, handleState.lastEma200
      );
      candleChart.timeScale().fitContent();
      macdChart.timeScale().fitContent();
      repositionPointers();
    }

    const chartControls = document.getElementById("chart-controls");
    if (chartControls) {
      const existingSwitcher = chartControls.querySelector(".tf-switcher");
      if (existingSwitcher) existingSwitcher.remove();
      const switcher = window.ChartIndicators.buildTimeframeSwitcher({
        active: currentInterval,
        onSelect: applyInterval,
      });
      chartControls.insertBefore(switcher, chartControls.firstChild);
    }
    // Phones: the inline switcher is scrolled out of reach while the chart is
    // fullscreen, so put a second one inside it (kept in sync by applyInterval).
    if (handle.fullscreen) {
      handle.fullscreen.addFsTool(window.ChartIndicators.buildTimeframeSwitcher({ active: currentInterval, onSelect: applyInterval }));
    }

    const exportBtn = document.getElementById("export-chart-btn");
    if (exportBtn && !exportBtn.dataset.wired) {
      exportBtn.dataset.wired = "1";
      exportBtn.addEventListener("click", () => {
        // takeScreenshot() renders the chart's current view (whatever
        // zoom/pan the user has it at) to a canvas -- export what they're
        // actually looking at, not a fixed default view. Read the live
        // chart off currentCandleChart (not the candleChart this listener
        // closed over) in case a full-day rebuild has replaced it since.
        const canvas = currentCandleChart.takeScreenshot();
        canvas.toBlob((blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${trade.symbol}-${trade.trade_date}-${(trade.id || "chart")}.png`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        });
      });
    }
  }
})();
