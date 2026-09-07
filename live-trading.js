// live-trading.js
// Talks to live-service's control API (see live-service/app.py in the
// live-trading-stack repo) -- NOT chart_service.py. That service runs on
// your own machine (Docker Compose, next to IB Gateway) and is reached
// through whatever tunnel URL you put in window.LIVE_SERVICE_URL
// (config.js), the same way CHART_SERVICE_URL points at chart-service's
// ngrok URL for local dev.
//
// Strategy picker: GET /api/live/strategies (live-service reads
// strategy_store.py directly off its read-only chart-service mount, no
// HTTP hop) is the thing that replaced the old "type a symbol and an
// entry mode by hand" form. Selecting a strategy fills in its entry_mode
// + params server-side when the run starts (POST /api/live/start with
// strategy_id) -- this page only still needs to know the strategy's
// symbol_rule, so it can prefill/require the Symbols field correctly.
(function () {
  "use strict";

  const API = () => (window.LIVE_SERVICE_URL || "").replace(/\/+$/, "");
  const FETCH_HEADERS = {
    "Content-Type": "application/json",
    // Only matters if you're tunneling with ngrok's free tier, same as
    // backtester.js -- harmless no-op for a Cloudflare Tunnel.
    "ngrok-skip-browser-warning": "true",
  };

  function authedHeaders(extra) {
    // NOTE: deliberately re-fetches the session on every call instead of
    // reusing window.AUTH_READY. AUTH_READY resolves ONCE at page load;
    // supabase-js refreshes the access token silently in the background
    // as it nears expiry, but that refreshed token never flows back into
    // an already-resolved Promise. Long-lived tabs (this page polls
    // /api/live/status every few seconds and can be left open for
    // hours) would otherwise keep sending an expired token forever once
    // the original one lapsed, hitting live-service's 401 even though
    // the browser is still genuinely logged in. getSession() always
    // returns supabase-js's current (auto-refreshed) session instead.
    return window.AUTH_READY.then(() => window.sb.auth.getSession()).then((res) => {
      const session = res && res.data && res.data.session;
      if (!session) throw new Error("Please log in first.");
      return Object.assign({}, FETCH_HEADERS, extra || {}, { "Authorization": "Bearer " + session.access_token });
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function apiCall(path, opts) {
    if (!API()) return Promise.reject(new Error("window.LIVE_SERVICE_URL isn't set in config.js yet."));
    return authedHeaders((opts && opts.headers) || {}).then((headers) =>
      fetch(API() + path, Object.assign({}, opts, { headers })).then((r) =>
        r.json().then((body) => {
          if (!r.ok) throw new Error(body.error || ("HTTP " + r.status));
          return body;
        })
      )
    );
  }

  function fmtMoney(n) {
    const v = Number(n || 0);
    return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(2);
  }
  function fmtPct(v) {
    return typeof v === "number" ? v.toFixed(1) + "%" : "—";
  }

  // Loaded once from /api/live/strategies and keyed by id -- both the
  // "Start a run" picker's own details panel and any run card's "View
  // strategy details" toggle read from this instead of re-fetching,
  // since it's the same account's same list either way.
  let strategiesById = {};

  // --- Strategy details rendering (shared by the picker and run cards) ---

  function describeSymbolRule(rule) {
    rule = rule || {};
    if (rule.mode === "manual") {
      return "Manual list: " + ((rule.symbols || []).join(", ") || "(none set)");
    }
    if (rule.mode === "top_gappers") {
      return `Live top-gappers scan (top ${rule.top_n != null ? rule.top_n : 5}, ` +
        `$${rule.min_price != null ? rule.min_price : 1}–$${rule.max_price != null ? rule.max_price : 50}, ` +
        `min gap ${rule.min_gap_pct != null ? rule.min_gap_pct : 5}%) — no live scanner yet, so this needs symbols entered by hand today`;
    }
    return "unknown";
  }

  function renderStrategyDetails(strategy) {
    const stats = strategy.source_summary_stats || {};
    const hasStats = Object.keys(stats).length > 0;
    const params = strategy.params || {};
    const paramRows = Object.entries(params)
      .map(([k, v]) => `<div class="lt-kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(JSON.stringify(v))}</span></div>`)
      .join("");

    return `
      <div class="lt-kv"><span>Entry style</span><span>${escapeHtml(strategy.entry_mode)}</span></div>
      <div class="lt-kv"><span>Symbol rule</span><span>${escapeHtml(describeSymbolRule(strategy.symbol_rule))}</span></div>
      ${hasStats ? `
        <div class="lt-detail-stats">
          <div><div class="pb-label">Net P&amp;L</div><div class="pb-value">${fmtMoney(stats.net_pnl_dollars)}</div></div>
          <div><div class="pb-label">Win Rate</div><div class="pb-value">${fmtPct(stats.win_rate)}</div></div>
          <div><div class="pb-label">Trades</div><div class="pb-value">${stats.num_trades != null ? stats.num_trades : "—"}</div></div>
          <div><div class="pb-label">Profit Factor</div><div class="pb-value">${stats.profit_factor != null ? Number(stats.profit_factor).toFixed(2) : "—"}</div></div>
        </div>` : ""}
      ${strategy.source_backtest_run_id ? `<a class="link" href="report.html?id=${encodeURIComponent(strategy.source_backtest_run_id)}" target="_blank" rel="noopener">View the original backtest report →</a>` : ""}
      <details class="lt-params-details">
        <summary>All params (${Object.keys(params).length})</summary>
        <div class="lt-kv-list">${paramRows || "<div class=\"lt-kv\"><span>(none)</span></div>"}</div>
      </details>
    `;
  }

  // --- Start-a-run form ---

  function onStrategyChange() {
    const sel = document.getElementById("lt-strategy");
    const detailsEl = document.getElementById("lt-strategy-details");
    const symbolsInput = document.getElementById("lt-symbols");
    const noteEl = document.getElementById("lt-symbols-note");
    const strat = sel.value ? strategiesById[sel.value] : null;

    if (!strat) {
      detailsEl.style.display = "none";
      detailsEl.innerHTML = "";
      noteEl.textContent = "";
      noteEl.classList.remove("warn");
      return;
    }

    detailsEl.style.display = "block";
    detailsEl.innerHTML = renderStrategyDetails(strat);

    const rule = strat.symbol_rule || {};
    if (rule.mode === "manual") {
      symbolsInput.value = (rule.symbols || []).join(", ");
      noteEl.textContent = "Prefilled from this strategy's saved symbol list — edit freely for this run.";
      noteEl.classList.remove("warn");
    } else if (rule.mode === "top_gappers") {
      noteEl.textContent = "This strategy scans for top gappers live, but that scanner doesn't exist yet — enter symbols by hand to trade its rules against specific tickers.";
      noteEl.classList.add("warn");
    } else {
      noteEl.textContent = "";
      noteEl.classList.remove("warn");
    }
  }

  function loadStrategies() {
    const sel = document.getElementById("lt-strategy");
    const emptyEl = document.getElementById("lt-no-strategies");
    return apiCall("/api/live/strategies")
      .then((rows) => {
        strategiesById = {};
        (rows || []).forEach((s) => { strategiesById[s.id] = s; });
        if (!rows || !rows.length) {
          sel.innerHTML = '<option value="">— no saved strategies —</option>';
          emptyEl.style.display = "block";
        } else {
          emptyEl.style.display = "none";
          sel.innerHTML = '<option value="">— choose a strategy —</option>' +
            rows.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.entry_mode)})</option>`).join("");
        }
        onStrategyChange();
      })
      .catch((err) => {
        sel.innerHTML = '<option value="">(couldn\u2019t load strategies)</option>';
        emptyEl.style.display = "block";
        emptyEl.textContent = "Couldn't load saved strategies: " + err.message;
      });
  }

  function startRun() {
    const errEl = document.getElementById("lt-start-error");
    errEl.textContent = "";

    const strategyId = document.getElementById("lt-strategy").value || null;
    const advancedEntryMode = document.getElementById("lt-entry-mode").value || null;
    const symbols = document.getElementById("lt-symbols").value
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const mode = document.getElementById("lt-mode").value;
    const shares_per_trade = parseInt(document.getElementById("lt-shares").value, 10) || 100;
    const max_daily_loss_usd = parseFloat(document.getElementById("lt-max-loss").value) || 200;
    const maxTradesRaw = document.getElementById("lt-max-trades").value;

    if (!strategyId && !advancedEntryMode) {
      errEl.textContent = 'Pick a strategy above, or open "Advanced" to run a one-off entry style.';
      return;
    }
    if (!symbols.length) {
      errEl.textContent = "Enter at least one symbol to trade.";
      return;
    }
    if (mode === "live" && !confirm(
      "This will place REAL orders with REAL money on your IBKR live account. Are you sure?"
    )) {
      return;
    }

    const body = { symbols, mode, shares_per_trade, max_daily_loss_usd, params: {} };
    if (strategyId) {
      body.strategy_id = strategyId;
    } else {
      body.entry_mode = advancedEntryMode;
      body.params.stop_mode = document.getElementById("lt-stop-mode").value;
      body.params.target_r = parseFloat(document.getElementById("lt-target-r").value) || 2.0;
    }
    if (maxTradesRaw) body.params.max_trades_per_day = parseInt(maxTradesRaw, 10);

    apiCall("/api/live/start", { method: "POST", body: JSON.stringify(body) })
      .then(refreshStatus)
      .catch((err) => { errEl.textContent = err.message; });
  }

  // --- Active & recent runs ---

  function renderRuns(data) {
    const el = document.getElementById("lt-runs");
    const runs = Object.values((data && data.runs) || {});
    if (!runs.length) {
      el.innerHTML = '<div class="lt-empty">No runs yet.</div>';
      return;
    }
    el.innerHTML = runs.map(renderRunCard).join("");
    runs.forEach((r) => {
      const btn = document.getElementById("lt-stop-" + r.run_id);
      if (btn) btn.addEventListener("click", () => stopRun(r.run_id));
      const stratBtn = document.getElementById("lt-view-strat-" + r.run_id);
      if (stratBtn) stratBtn.addEventListener("click", () => toggleRunStrategyDetails(r.run_id, r.strategy_id, stratBtn));
    });
  }

  function renderRunCard(r) {
    const posPills = Object.entries(r.positions || {}).map(([sym, p]) => {
      const cls = p.in_position ? "pill win" : "pill";
      const label = p.in_position ? `${sym}: ${p.shares}sh @ ${Number(p.entry_price).toFixed(2)}` : `${sym}: flat`;
      return `<span class="${cls}">${escapeHtml(label)}</span>`;
    }).join(" ");
    const events = (r.recent_events || []).slice().reverse().map((e) =>
      `<div>[${escapeHtml(e.ts.split("T")[1].split(".")[0])}] ${escapeHtml(e.symbol)} ${escapeHtml(e.type)} — ${escapeHtml(e.detail)}</div>`
    ).join("");
    const stopDisabled = r.status === "stopped" ? "disabled" : "";
    const label = r.strategy_name || r.entry_mode || "(custom run)";
    const viewStratBtn = r.strategy_id
      ? `<button class="lt-run-strategy-link" id="lt-view-strat-${escapeHtml(r.run_id)}">View strategy details</button>`
      : "";
    return `
      <div class="lt-run-card">
        <div class="lt-run-head">
          <div>
            <div class="title">${escapeHtml(r.run_id)} · ${escapeHtml(label)} · ${escapeHtml(r.symbols.join(", "))}</div>
            <div class="lt-run-meta">
              <span class="pill ${r.mode === "live" ? "loss" : ""}">${escapeHtml(r.mode)}</span>
              <span class="pill">${escapeHtml(r.status)}</span>
              ${r.halted ? '<span class="pill loss">halted (max daily loss)</span>' : ""}
              &nbsp;P&amp;L today: <strong>${fmtMoney(r.realized_pnl_today)}</strong>
              ${viewStratBtn}
            </div>
          </div>
          <button class="btn-advanced" id="lt-stop-${escapeHtml(r.run_id)}" ${stopDisabled}>Stop</button>
        </div>
        <div class="lt-positions">${posPills}</div>
        <div class="lt-run-strategy-detail lt-strategy-detail" id="lt-run-detail-${escapeHtml(r.run_id)}" style="display:none;"></div>
        <div class="lt-events">${events || "<div>no events yet</div>"}</div>
      </div>`;
  }

  function toggleRunStrategyDetails(runId, strategyId, btn) {
    const el = document.getElementById("lt-run-detail-" + runId);
    if (!el) return;
    const showing = el.style.display !== "none";
    if (showing) {
      el.style.display = "none";
      btn.textContent = "View strategy details";
      return;
    }
    el.style.display = "block";
    btn.textContent = "Hide strategy details";
    const cached = strategiesById[strategyId];
    if (cached) {
      el.innerHTML = renderStrategyDetails(cached);
      return;
    }
    el.innerHTML = `<div class="lt-empty">Loading…</div>`;
    apiCall(`/api/live/strategies/${encodeURIComponent(strategyId)}`)
      .then((strat) => { el.innerHTML = renderStrategyDetails(strat); })
      .catch((err) => { el.innerHTML = `<div class="lt-empty">Couldn't load this strategy (${escapeHtml(err.message)}).</div>`; });
  }

  function refreshStatus() {
    apiCall("/api/live/status").then(renderRuns).catch((err) => {
      document.getElementById("lt-runs").innerHTML =
        `<div class="lt-empty">${escapeHtml(err.message)}</div>`;
    });
  }

  function stopRun(runId) {
    apiCall(`/api/live/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      body: JSON.stringify({ flatten: true }),
    }).then(refreshStatus).catch((err) => alert("Stop failed: " + err.message));
  }

  function updateModeBanner() {
    const mode = document.getElementById("lt-mode").value;
    const banner = document.getElementById("lt-mode-banner");
    banner.className = "lt-mode-banner " + mode;
    banner.textContent = mode === "live"
      ? "LIVE — real orders, real money"
      : "PAPER — no real orders will be placed";
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("lt-start-btn").addEventListener("click", startRun);
    document.getElementById("lt-refresh-btn").addEventListener("click", refreshStatus);
    document.getElementById("lt-mode").addEventListener("change", updateModeBanner);
    document.getElementById("lt-strategy").addEventListener("change", onStrategyChange);
    loadStrategies();
    refreshStatus();
    setInterval(refreshStatus, 5000);
  });
})();
