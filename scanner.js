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

  // --- Sort state -- click a numeric column header to sort by it; click
  // again to flip direction. Symbol/gap_pct/price/premkt_volume only --
  // "Updated" isn't sortable (see data-sort/no-sort on the <th>s), it's
  // basically the same moment for every row while the scan is live.
  let sortKey = "gap_pct";
  let sortAsc = false;
  let filterText = "";
  let lastRows = [];

  function applySort(rows) {
    return rows.slice().sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (typeof av === "string") return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? av - bv : bv - av;
    });
  }

  function renderBanner(sessionActive, rowCount) {
    const el = document.getElementById("sc-banner");
    if (!el) return;
    if (sessionActive) {
      el.className = "sc-banner scanning";
      el.innerHTML = `<span class="sc-live-dot"></span>` +
        (rowCount > 0
          ? `Scanning live — premarket session (4:00–9:30 ET)`
          : `Scanning live — no gappers qualifying yet`) +
        `<span class="sc-banner-sub">refreshes every 5s</span>`;
    } else {
      el.className = "sc-banner idle";
      el.textContent = "Outside the scan window (4:00–9:30 ET weekdays) — showing today's last scan, if any.";
    }
  }

  function renderStats(rows) {
    const wrap = document.getElementById("sc-stats");
    if (!rows.length) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "";
    const top = rows.slice().sort((a, b) => b.gap_pct - a.gap_pct)[0];
    const avgGap = rows.reduce((sum, r) => sum + Number(r.gap_pct), 0) / rows.length;
    const mostRecent = rows.reduce((latest, r) => {
      const t = new Date(r.updated_at).getTime();
      return t > latest ? t : latest;
    }, 0);

    document.getElementById("sc-stat-count").textContent = String(rows.length);
    document.getElementById("sc-stat-top").textContent = top.symbol;
    document.getElementById("sc-stat-top-sub").textContent =
      `${top.gap_pct >= 0 ? "+" : ""}${Number(top.gap_pct).toFixed(1)}% · $${Number(top.price).toFixed(2)}`;
    document.getElementById("sc-stat-avg").textContent =
      `${avgGap >= 0 ? "+" : ""}${avgGap.toFixed(1)}%`;
    document.getElementById("sc-stat-updated").textContent = mostRecent ? fmtAgo(new Date(mostRecent).toISOString()) : "—";
  }

  function renderRows() {
    const tbody = document.getElementById("sc-tbody");
    const empty = document.getElementById("sc-empty");
    const needle = filterText.trim().toUpperCase();
    const filtered = needle ? lastRows.filter((r) => r.symbol.toUpperCase().indexOf(needle) !== -1) : lastRows;

    if (!filtered.length) {
      tbody.innerHTML = "";
      empty.style.display = "block";
      empty.textContent = lastRows.length
        ? `No symbols match "${filterText}".`
        : "No gappers found yet today.";
      return;
    }
    empty.style.display = "none";

    const rows = applySort(filtered);
    tbody.innerHTML = rows.map((r) => {
      const stale = (Date.now() - new Date(r.updated_at).getTime()) > 5 * 60 * 1000;
      return `<tr${stale ? ' class="stale"' : ""}>
        <td class="sym">${escapeHtml(r.symbol)}</td>
        <td class="mono-num">$${Number(r.price).toFixed(2)}</td>
        <td><span class="pill ${r.gap_pct >= 0 ? "win" : "loss"} mono-num">${r.gap_pct >= 0 ? "+" : ""}${Number(r.gap_pct).toFixed(1)}%</span></td>
        <td class="mono-num">${fmtVol(r.premkt_volume)}</td>
        <td class="mono-num" style="color:var(--text-faint)">${fmtAgo(r.updated_at)}${stale ? " (stale)" : ""}</td>
      </tr>`;
    }).join("");
  }

  function updateSortHeaders() {
    document.querySelectorAll("#sc-table .headcell[data-sort]").forEach((el) => {
      const active = el.dataset.sort === sortKey;
      el.classList.toggle("sorted", active);
      el.classList.toggle("asc", active && sortAsc);
    });
  }

  async function refresh() {
    try {
      const headers = await authedHeaders();
      const resp = await fetch(API() + "/gappers", { headers });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      lastRows = data.rows || [];
      renderBanner(data.session_active, lastRows.length);
      renderStats(lastRows);
      renderRows();
      document.getElementById("sc-refresh-note").textContent = "Updated just now";
    } catch (e) {
      const empty = document.getElementById("sc-empty");
      document.getElementById("sc-tbody").innerHTML = "";
      empty.style.display = "block";
      empty.textContent = "Couldn't load the scanner: " + e.message;
      document.getElementById("sc-stats").style.display = "none";
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!window.CHART_SERVICE_URL) {
      document.getElementById("sc-empty").textContent = "CHART_SERVICE_URL isn't set in config.js.";
      document.getElementById("sc-empty").style.display = "block";
      return;
    }

    document.querySelectorAll("#sc-table .headcell[data-sort]").forEach((el) => {
      el.addEventListener("click", () => {
        const key = el.dataset.sort;
        if (sortKey === key) sortAsc = !sortAsc;
        else { sortKey = key; sortAsc = false; }
        updateSortHeaders();
        renderRows();
      });
    });
    updateSortHeaders();

    document.getElementById("sc-filter").addEventListener("input", (e) => {
      filterText = e.target.value;
      renderRows();
    });

    refresh();
    setInterval(refresh, REFRESH_MS);
    // Cosmetic "Ns ago" ticker between polls so the toolbar note doesn't
    // freeze at "just now" for the full 5s -- cheap, no extra fetch.
    let secsSincePoll = 0;
    setInterval(() => {
      secsSincePoll += 1;
      if (secsSincePoll >= REFRESH_MS / 1000) { secsSincePoll = 0; return; }
      document.getElementById("sc-refresh-note").textContent = `Updated ${secsSincePoll}s ago`;
    }, 1000);
  });
})();
