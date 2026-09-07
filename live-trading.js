// live-trading.js
// Talks to live-service's control API (see live-service/app.py in the
// live-trading-stack repo) -- NOT chart_service.py. That service runs on
// your own machine (Docker Compose, next to IB Gateway) and is reached
// through whatever tunnel URL you put in window.LIVE_SERVICE_URL
// (config.js), the same way CHART_SERVICE_URL points at chart-service's
// ngrok URL for local dev.
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
    return `
      <div class="lt-run-card">
        <div class="lt-run-head">
          <div>
            <div class="title">${escapeHtml(r.run_id)} · ${escapeHtml(r.entry_mode)} · ${escapeHtml(r.symbols.join(", "))}</div>
            <div class="lt-run-meta">
              <span class="pill ${r.mode === "live" ? "loss" : ""}">${escapeHtml(r.mode)}</span>
              <span class="pill">${escapeHtml(r.status)}</span>
              ${r.halted ? '<span class="pill loss">halted (max daily loss)</span>' : ""}
              &nbsp;P&amp;L today: <strong>${fmtMoney(r.realized_pnl_today)}</strong>
            </div>
          </div>
          <button class="btn-advanced" id="lt-stop-${escapeHtml(r.run_id)}" ${stopDisabled}>Stop</button>
        </div>
        <div class="lt-positions">${posPills}</div>
        <div class="lt-events">${events || "<div>no events yet</div>"}</div>
      </div>`;
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

  function startRun() {
    const errEl = document.getElementById("lt-start-error");
    errEl.textContent = "";

    const symbols = document.getElementById("lt-symbols").value
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const mode = document.getElementById("lt-mode").value;
    const entry_mode = document.getElementById("lt-entry-mode").value;
    const stop_mode = document.getElementById("lt-stop-mode").value;
    const target_r = parseFloat(document.getElementById("lt-target-r").value) || 2.0;
    const shares_per_trade = parseInt(document.getElementById("lt-shares").value, 10) || 100;
    const max_daily_loss_usd = parseFloat(document.getElementById("lt-max-loss").value) || 200;
    const max_trades_per_day = parseInt(document.getElementById("lt-max-trades").value, 10) || 3;

    if (!symbols.length) {
      errEl.textContent = "Enter at least one symbol.";
      return;
    }
    if (mode === "live" && !confirm(
      "This will place REAL orders with REAL money on your IBKR live account. Are you sure?"
    )) {
      return;
    }

    apiCall("/api/live/start", {
      method: "POST",
      body: JSON.stringify({
        symbols, mode, entry_mode, shares_per_trade, max_daily_loss_usd,
        params: { stop_mode, target_r, max_trades_per_day },
      }),
    }).then(refreshStatus).catch((err) => { errEl.textContent = err.message; });
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
    refreshStatus();
    setInterval(refreshStatus, 5000);
  });
})();
