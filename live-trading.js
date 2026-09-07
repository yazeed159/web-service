// live-trading.js
// Talks to live-service's control API (see live-service/live_app.py in the
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
//
// The dropdown is actually TWO lists merged together (see loadStrategies
// below): the built-in presets from window.STRATEGY_PRESETS
// (strategy-presets.js -- edit that file and redeploy to add/change one,
// nothing to click here) plus whatever's actually saved in Supabase via
// the Backtester's "Save as Strategy" button. A preset's synthetic id
// (starts with "preset:") never gets sent as strategy_id -- startRun()
// below sends its entry_mode/params directly instead, the same
// "one-off run" path the Advanced form already used, so presets never
// need a Supabase row at all.
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

  // --- Built-in presets (window.STRATEGY_PRESETS, from strategy-presets.js) ---
  // Reshaped into the same {id, name, entry_mode, params, symbol_rule,
  // source_summary_stats} shape a real Supabase strategy row has, so
  // renderStrategyDetails/onStrategyChange/startRun don't need to know
  // the difference. Same key split chart_service.py's
  // /backtest/history/<id>/save-strategy does server-side
  // (_SYMBOL_RULE_KEYS / _BACKTEST_ONLY_KEYS) -- done here client-side
  // instead since these never go through an actual backtest run. A
  // preset's id is prefixed "preset:" so startRun() knows to send its
  // entry_mode/params directly rather than a strategy_id that doesn't
  // exist in Supabase (see start()'s entry_mode-only path, live_app.py).
  const SYMBOL_RULE_KEYS = ["top_n", "min_price", "max_price", "min_dollar_volume", "min_gap_pct"];
  const BACKTEST_ONLY_KEYS = [
    "start", "end", "label", "position_size", "position_sizing_mode",
    "position_size_pct", "risk_pct_of_capital", "starting_capital", "include_commissions",
  ];

  function splitPresetConfig(config) {
    const symbol_rule = { mode: "top_gappers" };
    SYMBOL_RULE_KEYS.forEach((k) => { if (config[k] !== undefined) symbol_rule[k] = config[k]; });
    const params = {};
    Object.keys(config).forEach((k) => {
      if (k === "entry_mode" || SYMBOL_RULE_KEYS.indexOf(k) !== -1 || BACKTEST_ONLY_KEYS.indexOf(k) !== -1) return;
      params[k] = config[k];
    });
    return { params: params, symbol_rule: symbol_rule };
  }

  function slugify(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  function builtInStrategies() {
    return (window.STRATEGY_PRESETS || []).map((p) => {
      const split = splitPresetConfig(p.config);
      return {
        id: "preset:" + slugify(p.name),
        name: p.name,
        entry_mode: p.config.entry_mode,
        params: split.params,
        symbol_rule: split.symbol_rule,
        source_summary_stats: {},
        source_backtest_run_id: null,
        is_preset: true,
      };
    });
  }

  function loadStrategies() {
    const emptyEl = document.getElementById("lt-no-strategies");
    const presets = builtInStrategies();
    return apiCall("/api/live/strategies")
      .then((rows) => { renderStrategyOptions(presets, rows || []); })
      .catch((err) => {
        // live-service being unreachable shouldn't hide the built-in
        // presets -- they don't depend on it at all.
        renderStrategyOptions(presets, []);
        emptyEl.style.display = "block";
        emptyEl.textContent = "Couldn't load your saved strategies (" + err.message + ") -- starter presets still work below.";
      });
  }

  function renderStrategyOptions(presets, saved) {
    const sel = document.getElementById("lt-strategy");
    const emptyEl = document.getElementById("lt-no-strategies");
    strategiesById = {};
    presets.forEach((s) => { strategiesById[s.id] = s; });
    saved.forEach((s) => { strategiesById[s.id] = s; });

    const presetOptions = presets.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.entry_mode)})</option>`).join("");
    const savedOptions = saved.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.entry_mode)})</option>`).join("");

    sel.innerHTML = '<option value="">— choose a strategy —</option>' +
      (presetOptions ? `<optgroup label="Starter presets">${presetOptions}</optgroup>` : "") +
      (savedOptions ? `<optgroup label="Saved from Backtester">${savedOptions}</optgroup>` : "");

    emptyEl.style.display = saved.length ? "none" : "block";
    onStrategyChange();
  }

  // --- Position sizing field (Fixed shares / Fixed $ / % of equity) ---

  const SIZE_MODE_LABELS = {
    shares: { label: "Shares per trade", step: "1", value: "100", note: "" },
    dollars: { label: "Dollar amount per trade", step: "50", value: "1000",
      note: "Converted to a share count at entry: floor($ amount ÷ entry price)." },
    pct_equity: { label: "% of account equity per trade", step: "0.5", value: "2",
      note: "Uses a snapshot of Net Liquidation taken when you hit Run — see the Account panel above." },
  };

  function onSizeModeChange() {
    const mode = document.getElementById("lt-size-mode").value;
    const cfg = SIZE_MODE_LABELS[mode];
    document.getElementById("lt-size-value-label").textContent = cfg.label;
    const input = document.getElementById("lt-size-value");
    input.step = cfg.step;
    if (!input.dataset.userEdited) input.value = cfg.value;
    document.getElementById("lt-size-value-note").textContent = cfg.note;
  }

  function startRun() {
    const errEl = document.getElementById("lt-start-error");
    errEl.textContent = "";

    const strategyId = document.getElementById("lt-strategy").value || null;
    const advancedEntryMode = document.getElementById("lt-entry-mode").value || null;
    const symbols = document.getElementById("lt-symbols").value
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const mode = document.getElementById("lt-mode").value;
    const size_mode = document.getElementById("lt-size-mode").value;
    const size_value = parseFloat(document.getElementById("lt-size-value").value);
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
    if (!size_value || size_value <= 0) {
      errEl.textContent = "Enter a position size greater than 0.";
      return;
    }
    if (mode === "live" && !confirm(
      "This will place REAL orders with REAL money on your IBKR live account. Are you sure?"
    )) {
      return;
    }

    const body = { symbols, mode, size_mode, size_value, max_daily_loss_usd, params: {} };
    if (strategyId && strategyId.indexOf("preset:") === 0) {
      // Built-in preset -- no Supabase row exists for this id, so send
      // its entry_mode/params directly instead of strategy_id (same
      // one-off-run path the Advanced form below already uses). Also
      // send its friendly name as strategy_name so run history shows
      // "Ross Cameron style gap-and-go breakout" instead of a raw
      // entry_mode string -- see app.py's start()/start_run's
      // strategy_label.
      const strat = strategiesById[strategyId];
      body.entry_mode = strat.entry_mode;
      body.params = Object.assign({}, strat.params);
      body.strategy_name = strat.name;
    } else if (strategyId) {
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

  function fmtRelativeTime(iso) {
    if (!iso) return "";
    const diffMs = Date.now() - new Date(iso).getTime();
    const s = Math.max(0, Math.round(diffMs / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return `${h}h ago`;
  }

  // status -> { label, cls } for the colored-dot badge. Anything not
  // recognized falls back to "starting" styling rather than throwing.
  const STATUS_BADGE = {
    running: { label: "Running", cls: "running" },
    starting: { label: "Starting", cls: "starting" },
    stopping: { label: "Stopping…", cls: "stopping" },
    stopped: { label: "Stopped", cls: "stopped" },
  };

  function statusBadge(status) {
    const cfg = STATUS_BADGE[status] || { label: status, cls: "starting" };
    return `<span class="lt-status ${cfg.cls}"><span class="dot"></span>${escapeHtml(cfg.label)}</span>`;
  }

  // --- Active & recent runs ---

  function renderRuns(data) {
    const el = document.getElementById("lt-runs");
    const runs = Object.values((data && data.runs) || {});
    if (!runs.length) {
      el.innerHTML = '<div class="lt-empty">No runs yet — start one above.</div>';
      return;
    }
    // Split so a stopped run visibly leaves "Active" instead of sitting
    // there indistinguishable from a live one -- this was the main
    // complaint: nothing made "stopped" read as actually different from
    // "running" at a glance.
    const active = runs.filter((r) => r.status !== "stopped");
    const recent = runs.filter((r) => r.status === "stopped");
    // Most-recently-stopped first.
    recent.sort((a, b) => {
      const ta = (a.recent_events || []).findLast?.((e) => e.type === "run_stopped")?.ts || "";
      const tb = (b.recent_events || []).findLast?.((e) => e.type === "run_stopped")?.ts || "";
      return tb.localeCompare(ta);
    });

    let html = "";
    html += `<div class="lt-runs-section-head">Active <span class="count">(${active.length})</span></div>`;
    html += active.length
      ? active.map(renderRunCard).join("")
      : '<div class="lt-empty" style="padding:12px 0;">Nothing running right now.</div>';

    if (recent.length) {
      html += `<div class="lt-runs-section-head">Recent (stopped) <span class="count">(${recent.length})</span></div>`;
      html += recent.map(renderRunCard).join("");
    }

    el.innerHTML = html;
    runs.forEach((r) => {
      const btn = document.getElementById("lt-stop-" + r.run_id);
      if (btn) btn.addEventListener("click", () => stopRun(r.run_id, btn));
      const stratBtn = document.getElementById("lt-view-strat-" + r.run_id);
      if (stratBtn) stratBtn.addEventListener("click", () => toggleRunStrategyDetails(r.run_id, r.strategy_id, stratBtn));
    });
  }

  function renderRunCard(r) {
    const posPills = Object.entries(r.positions || {}).map(([sym, p]) => {
      const cls = p.in_position ? "pill win" : p.entry_pending ? "pill" : "pill";
      const label = p.in_position ? `${sym}: ${p.shares}sh @ ${Number(p.entry_price).toFixed(2)}`
        : p.entry_pending ? `${sym}: order pending`
        : `${sym}: flat`;
      return `<span class="${cls}">${escapeHtml(label)}</span>`;
    }).join(" ");
    const events = (r.recent_events || []).slice().reverse().map((e) =>
      `<div>[${escapeHtml(e.ts.split("T")[1].split(".")[0])}] ${escapeHtml(e.symbol)} ${escapeHtml(e.type)} — ${escapeHtml(e.detail)}</div>`
    ).join("");
    const isStopped = r.status === "stopped";
    const stopDisabled = isStopped ? "disabled" : "";
    const label = r.strategy_name || r.entry_mode || "(custom run)";
    const sizing = r.sizing || {};
    const sizingLabel = sizing.mode === "dollars" ? `$${sizing.value}/trade`
      : sizing.mode === "pct_equity" ? `${sizing.value}% equity/trade`
      : `${sizing.value} sh/trade`;
    const stoppedEvent = isStopped ? (r.recent_events || []).slice().reverse().find((e) => e.type === "run_stopped") : null;
    const stoppedNote = stoppedEvent ? `<span class="pill">stopped ${escapeHtml(fmtRelativeTime(stoppedEvent.ts))}</span>` : "";
    const viewStratBtn = r.strategy_id
      ? `<button class="lt-run-strategy-link" id="lt-view-strat-${escapeHtml(r.run_id)}">View strategy details</button>`
      : "";
    return `
      <div class="lt-run-card ${isStopped ? "is-stopped" : ""}">
        <div class="lt-run-head">
          <div>
            <div class="title">${escapeHtml(r.run_id)} · ${escapeHtml(label)} · ${escapeHtml(r.symbols.join(", "))}</div>
            <div class="lt-run-meta">
              ${statusBadge(r.status)}
              <span class="pill ${r.mode === "live" ? "loss" : ""}">${escapeHtml(r.mode)}</span>
              ${r.halted ? '<span class="pill loss">halted (max daily loss)</span>' : ""}
              <span class="pill">${escapeHtml(sizingLabel)}</span>
              ${stoppedNote}
              &nbsp;P&amp;L today: <strong>${fmtMoney(r.realized_pnl_today)}</strong>
              ${viewStratBtn}
            </div>
          </div>
          <button class="btn-danger" id="lt-stop-${escapeHtml(r.run_id)}" ${stopDisabled}>${isStopped ? "Stopped" : "Stop"}</button>
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

  function stopRun(runId, btn) {
    // Optimistic feedback -- don't wait for the next poll (or even this
    // request) to show something happened. This is the other half of the
    // "I see it succeed but nothing changes" complaint: the request was
    // always completing, the UI just gave zero acknowledgement until the
    // next 5s refresh redrew the card.
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Stopping…";
    }
    apiCall(`/api/live/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      body: JSON.stringify({ flatten: true }),
    }).then(refreshStatus).catch((err) => {
      if (btn) { btn.disabled = false; btn.textContent = "Stop"; }
      alert("Stop failed: " + err.message);
    });
  }

  function updateModeBanner() {
    const mode = document.getElementById("lt-mode").value;
    const banner = document.getElementById("lt-mode-banner");
    banner.className = "lt-mode-banner " + mode;
    banner.textContent = mode === "live"
      ? "LIVE — real orders, real money"
      : "PAPER — no real orders will be placed";
  }

  // --- Account panel (net liq / buying power / today's PnL) ---

  function loadAccount() {
    const mode = document.getElementById("lt-account-mode").value;
    const errEl = document.getElementById("lt-account-error");
    errEl.style.display = "none";
    apiCall(`/api/live/account?mode=${encodeURIComponent(mode)}`)
      .then((acct) => {
        document.getElementById("lt-acct-netliq").textContent = acct.NetLiquidation != null ? fmtMoney(acct.NetLiquidation) : "—";
        document.getElementById("lt-acct-bp").textContent = acct.BuyingPower != null ? fmtMoney(acct.BuyingPower) : "—";
        document.getElementById("lt-acct-upnl").textContent = acct.UnrealizedPnL != null ? fmtMoney(acct.UnrealizedPnL) : "—";
        document.getElementById("lt-acct-rpnl").textContent = acct.RealizedPnL != null ? fmtMoney(acct.RealizedPnL) : "—";
      })
      .catch((err) => {
        errEl.style.display = "block";
        errEl.textContent = "Couldn't load account info: " + err.message;
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("lt-start-btn").addEventListener("click", startRun);
    document.getElementById("lt-refresh-btn").addEventListener("click", refreshStatus);
    document.getElementById("lt-mode").addEventListener("change", updateModeBanner);
    document.getElementById("lt-strategy").addEventListener("change", onStrategyChange);

    document.getElementById("lt-size-mode").addEventListener("change", onSizeModeChange);
    document.getElementById("lt-size-value").addEventListener("input", function () {
      this.dataset.userEdited = "1";
    });
    document.getElementById("lt-account-mode").addEventListener("change", loadAccount);
    onSizeModeChange();
    loadStrategies();
    refreshStatus();
    loadAccount();
    setInterval(refreshStatus, 5000);
    setInterval(loadAccount, 15000);
  });
})();
