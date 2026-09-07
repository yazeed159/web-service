// scanner.js
// Drives scanner.html: polls chart_service.py's GET /gappers (backed by
// gappers_store.py, written by chart-service's scanner.py Cron Job) and
// renders it as a live-updating table. Same auth pattern as backtester.js
// -- every request needs the logged-in person's Supabase access token,
// even though the underlying data isn't user-scoped (it's the same scan
// for everyone -- see gappers_store.py's docstring).
(function () {
  "use strict";

  const API = () => (window.CHART_SERVICE_URL || "").replace(/\/+$/, "");
  const REFRESH_MS = 5000; // matches scanner.py's own poll cadence -- see its docstring

  function authedHeaders() {
    return window.AUTH_READY.then((session) => {
      if (!session) throw new Error("Please log in first.");
      return {
        "Content-Type": "application/json",
        "ngrok-skip-browser-warning": "true",
        "Authorization": "Bearer " + session.access_token,
      };
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtAgo(iso) {
    const ageS = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (ageS < 60) return ageS + "s ago";
    return Math.round(ageS / 60) + "m ago";
  }

  function fmtVol(v) {
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
    if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
    return String(v);
  }

  function renderBanner(sessionActive, rowCount) {
    const el = document.getElementById("sc-banner");
    if (!el) return;
    if (sessionActive) {
      el.className = "lt-mode-banner paper";
      el.textContent = rowCount > 0
        ? `Scanning live — premarket session (4:00–9:30 ET)`
        : `Scanning live — no gappers qualifying yet`;
    } else {
      el.className = "lt-mode-banner";
      el.style.background = "var(--panel-2)";
      el.style.color = "var(--text-dim)";
      el.style.borderColor = "var(--border)";
      el.textContent = "Outside the scan window (4:00–9:30 ET weekdays) — showing today's last scan, if any.";
    }
  }

  function renderRows(rows) {
    const tbody = document.getElementById("sc-tbody");
    const empty = document.getElementById("sc-empty");
    if (!rows.length) {
      tbody.innerHTML = "";
      empty.style.display = "block";
      return;
    }
    empty.style.display = "none";
    tbody.innerHTML = rows.map((r) => {
      const stale = (Date.now() - new Date(r.updated_at).getTime()) > 5 * 60 * 1000;
      return `<tr${stale ? ' style="opacity:.45"' : ""}>
        <td class="mono-num">${escapeHtml(r.symbol)}</td>
        <td class="mono-num">$${Number(r.price).toFixed(2)}</td>
        <td><span class="pill ${r.gap_pct >= 0 ? "win" : "loss"} mono-num">${r.gap_pct >= 0 ? "+" : ""}${Number(r.gap_pct).toFixed(1)}%</span></td>
        <td class="mono-num">${fmtVol(r.premkt_volume)}</td>
        <td class="mono-num" style="color:var(--text-faint)">${fmtAgo(r.updated_at)}${stale ? " (stale)" : ""}</td>
      </tr>`;
    }).join("");
  }

  async function refresh() {
    try {
      const headers = await authedHeaders();
      const resp = await fetch(API() + "/gappers", { headers });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      renderBanner(data.session_active, (data.rows || []).length);
      renderRows(data.rows || []);
    } catch (e) {
      const empty = document.getElementById("sc-empty");
      empty.style.display = "block";
      empty.textContent = "Couldn't load the scanner: " + e.message;
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.CHART_SERVICE_URL) {
      document.getElementById("sc-empty").textContent = "CHART_SERVICE_URL isn't set in config.js.";
      document.getElementById("sc-empty").style.display = "block";
      return;
    }
    refresh();
    setInterval(refresh, REFRESH_MS);
  });
})();
