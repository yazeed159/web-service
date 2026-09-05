// report.js — drives report.html: a single self-contained page for ONE
// backtest report. Two data sources:
//   1. A backend run: ?id=<job_id> -> fetched from chart_service.py's
//      GET /backtest/history/<job_id>/report (same data backtester.js used
//      to render inline).
//   2. A CSV you drop in yourself: parsed entirely client-side, mapped to
//      a common trade shape, stats computed here, and cached in
//      localStorage under a generated id (?id=local-<uuid>) so refreshing
//      or bookmarking the URL still works. Nothing is uploaded anywhere.
(function () {
  "use strict";

  const API = () => (window.CHART_SERVICE_URL || "").replace(/\/+$/, "");
  const FETCH_HEADERS = {
    "Content-Type": "application/json",
    "ngrok-skip-browser-warning": "true",
  };
  // Same per-account scoping as backtester.js -- see that file's
  // authedHeaders for the full rationale. Only used for the backend-run
  // path (?id=<job_id>); local CSV reports never touch the network.
  function authedHeaders(extra) {
    return window.AUTH_READY.then((session) => {
      if (!session) throw new Error("Please log in first.");
      return Object.assign({}, FETCH_HEADERS, extra || {}, { "Authorization": "Bearer " + session.access_token });
    });
  }
  const LOCAL_INDEX_KEY = "bt_local_reports";

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMoney(v) {
    if (typeof v !== "number" || !isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toFixed(2);
  }
  function fmtPct(v) { return typeof v === "number" && isFinite(v) ? v.toFixed(1) + "%" : "—"; }
  function fmtR(v) { return typeof v === "number" && isFinite(v) ? v.toFixed(2) + "R" : "—"; }
  function fmtMinutes(v) {
    if (typeof v !== "number" || !isFinite(v)) return "—";
    const h = Math.floor(v / 60), m = Math.round(v % 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }

  function qs(name) {
    return new URLSearchParams(location.search).get(name);
  }

  // ---------- tiny CSV parser (quoted fields, commas, \r\n) ----------
  function parseCsvText(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((f) => f !== "")) rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return { headers: [], rows: [] };
    const headers = rows[0].map((h) => h.trim());
    return { headers, rows: rows.slice(1) };
  }

  function csvEscape(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function downloadBlob(content, mime, filename) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- localStorage helpers ----------
  function loadLocalIndex() {
    try { return JSON.parse(localStorage.getItem(LOCAL_INDEX_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveLocalIndex(list) {
    try { localStorage.setItem(LOCAL_INDEX_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
    if (window.KV) window.KV.set(LOCAL_INDEX_KEY, list);
  }
  function saveLocalReport(id, report) {
    try { localStorage.setItem(`report:${id}`, JSON.stringify(report)); } catch (e) { /* ignore */ }
    // Mirror the report body + index to Supabase (user_kv) so a
    // CSV-imported report survives a cleared cache or opens on a
    // different device -- see KV in auth.js.
    if (window.KV) window.KV.set(`report:${id}`, report);
    const idx = loadLocalIndex().filter((e) => e.id !== id);
    idx.unshift({
      id, label: report.label, created_at: report.created_at,
      num_trades: report.stats.num_trades, net_pnl_dollars: report.stats.net_pnl_dollars,
    });
    saveLocalIndex(idx);
  }
  function loadLocalReport(id) {
    try {
      const local = JSON.parse(localStorage.getItem(`report:${id}`));
      if (local) return local;
    } catch (e) { /* fall through to remote */ }
    return window.KV ? window.KV.get(`report:${id}`) || null : null;
  }
  function deleteLocalReport(id) {
    try { localStorage.removeItem(`report:${id}`); localStorage.removeItem(`journal:${id}`); } catch (e) { /* ignore */ }
    if (window.KV) window.KV.delete(`report:${id}`);
    saveLocalIndex(loadLocalIndex().filter((e) => e.id !== id));
  }

  // ---------- stats engine for CSV-derived reports (backend already sends its own) ----------
  function computeStats(trades) {
    const n = trades.length;
    const wins = trades.filter((t) => t.pnl_dollars >= 0);
    const losses = trades.filter((t) => t.pnl_dollars < 0);
    const net = trades.reduce((s, t) => s + t.pnl_dollars, 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl_dollars, 0);
    const grossLoss = losses.reduce((s, t) => s + t.pnl_dollars, 0);
    const rTrades = trades.filter((t) => typeof t.r_multiple === "number" && isFinite(t.r_multiple));

    // streaks, in date/entry-time order (trades are pre-sorted by caller)
    let curWin = 0, curLoss = 0, longestWin = 0, longestLoss = 0;
    for (const t of trades) {
      if (t.pnl_dollars >= 0) { curWin++; curLoss = 0; } else { curLoss++; curWin = 0; }
      longestWin = Math.max(longestWin, curWin);
      longestLoss = Math.max(longestLoss, curLoss);
    }

    // equity curve + drawdown, one point per trade in order
    let running = 0, peak = 0, maxDD = 0;
    const curve = [];
    for (const t of trades) {
      running += t.pnl_dollars;
      peak = Math.max(peak, running);
      maxDD = Math.max(maxDD, peak - running);
      curve.push({ date: t.date, equity: running });
    }

    return {
      num_trades: n,
      net_pnl_dollars: net,
      win_rate: n ? (wins.length / n) * 100 : 0,
      profit_factor: grossLoss !== 0 ? Math.abs(grossProfit / grossLoss) : null,
      avg_r: rTrades.length ? rTrades.reduce((s, t) => s + t.r_multiple, 0) / rTrades.length : null,
      avg_win_dollars: wins.length ? grossProfit / wins.length : 0,
      avg_loss_dollars: losses.length ? grossLoss / losses.length : 0,
      max_drawdown_dollars: maxDD,
      longest_win_streak: longestWin,
      longest_loss_streak: longestLoss,
      total_commissions_dollars: trades.reduce((s, t) => s + (t.commission_total || 0), 0),
      equity_curve: curve,
    };
  }

  function computeDetailedStats(trades) {
    if (!trades.length) return null;
    let grossProfit = 0, grossLoss = 0, totalShares = 0, holdSum = 0, holdCount = 0;
    let best = trades[0], worst = trades[0];
    const bySymbol = new Map();
    for (const t of trades) {
      const pnl = Number(t.pnl_dollars || 0);
      if (pnl >= 0) grossProfit += pnl; else grossLoss += pnl;
      totalShares += Number(t.shares || 0);
      if (pnl > Number(best.pnl_dollars || 0)) best = t;
      if (pnl < Number(worst.pnl_dollars || 0)) worst = t;
      if (t.entry_time && t.exit_time) {
        const toSec = (s) => { const p = String(s).split(":").map(Number); return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0); };
        const mins = (toSec(t.exit_time) - toSec(t.entry_time)) / 60;
        if (mins >= 0) { holdSum += mins; holdCount++; }
      }
      const sym = t.symbol || "?";
      bySymbol.set(sym, (bySymbol.get(sym) || 0) + 1);
    }
    let topSymbol = null, topCount = 0;
    for (const [sym, c] of bySymbol) if (c > topCount) { topSymbol = sym; topCount = c; }
    return {
      grossProfit, grossLoss,
      avgTradePnl: trades.reduce((s, t) => s + Number(t.pnl_dollars || 0), 0) / trades.length,
      totalShares, avgHoldMinutes: holdCount ? holdSum / holdCount : null,
      best, worst, uniqueSymbols: bySymbol.size, topSymbol, topSymbolCount: topCount,
    };
  }

  // ================= extra analytics (Overview tab) =================
  // All three of these are pure functions of `trades`/`stats` the page
  // already has in hand -- no new backend fields needed. Each is wrapped
  // so a bad field on one trade can't take out the other panels or leave
  // them on a stale/half-rendered state.
  let rptEquityChart = null;

  function renderEquityCurve(stats) {
    const curve = (stats && stats.equity_curve) || [];
    const box = document.getElementById("rpt-equity-box");
    if (curve.length < 2) {
      box.style.display = "none";
      return;
    }
    box.style.display = "";
    if (!rptEquityChart) {
      rptEquityChart = LightweightCharts.createChart(els.equityChart, {
        width: els.equityChart.clientWidth,
        height: els.equityChart.clientHeight || 220,
        layout: { background: { color: "transparent" }, textColor: "#8b8fa3" },
        grid: { vertLines: { color: "#1b1e26" }, horzLines: { color: "#1b1e26" } },
        rightPriceScale: { borderColor: "#262a34" },
        timeScale: { borderColor: "#262a34" },
      });
      window.addEventListener("resize", () => rptEquityChart && rptEquityChart.applyOptions({ width: els.equityChart.clientWidth }));
    }
    rptEquityChart.timeScale().fitContent();
    // Trades can share a date (several fills on the same day) — Lightweight
    // Charts' line series needs strictly increasing/unique time values, so
    // this keeps the LAST equity value per date, same convention the
    // dashboard's own cumulative-P&L chart uses.
    const byDate = new Map();
    for (const p of curve) { if (p && p.date) byDate.set(p.date, p.equity); }
    const points = Array.from(byDate.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, equity]) => ({ time: date, value: equity }));
    const net = points.length ? points[points.length - 1].value : 0;
    if (rptEquitySeries) rptEquityChart.removeSeries(rptEquitySeries);
    rptEquitySeries = rptEquityChart.addAreaSeries({
      lineColor: net >= 0 ? "#2fd08a" : "#f2555a",
      topColor: net >= 0 ? "rgba(47,208,138,0.28)" : "rgba(242,85,90,0.28)",
      bottomColor: "rgba(0,0,0,0)",
      lineWidth: 2,
    });
    rptEquitySeries.setData(points);
    rptEquityChart.timeScale().fitContent();
  }
  let rptEquitySeries = null;

  function renderRMultDistribution(trades) {
    const rTrades = trades.filter((t) => typeof t.r_multiple === "number" && isFinite(t.r_multiple));
    if (!rTrades.length) { els.rmultBox.innerHTML = ""; els.rmultBox.style.display = "none"; return; }
    els.rmultBox.style.display = "";
    const buckets = [
      { label: "< -2R", test: (r) => r < -2, positive: false },
      { label: "-2R to -1R", test: (r) => r >= -2 && r < -1, positive: false },
      { label: "-1R to 0R", test: (r) => r >= -1 && r < 0, positive: false },
      { label: "0R to 1R", test: (r) => r >= 0 && r < 1, positive: true },
      { label: "1R to 2R", test: (r) => r >= 1 && r < 2, positive: true },
      { label: "2R to 3R", test: (r) => r >= 2 && r < 3, positive: true },
      { label: "> 3R", test: (r) => r >= 3, positive: true },
    ].map((b) => ({ ...b, count: rTrades.filter((t) => b.test(t.r_multiple)).length }));
    const maxCount = Math.max(1, ...buckets.map((b) => b.count));
    els.rmultBox.innerHTML = `
      <div class="panel-box-head"><span class="title">R-Multiple Distribution</span></div>
      <p style="color:var(--text-faint); font-size:12.5px; margin:-6px 0 14px;">${rTrades.length} of ${trades.length} trade${trades.length === 1 ? "" : "s"} carry an R value. A healthy edge should skew toward the right of zero.</p>
      ${buckets.map((b) => `
        <div class="bar-row">
          <div class="bar-label">${b.label}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(b.count / maxCount) * 100}%; background:${b.positive ? "var(--green)" : "var(--red)"};"></div></div>
          <div class="bar-count">${b.count}x</div>
        </div>
      `).join("")}
    `;
  }

  function renderSymbolBreakdown(trades) {
    const bySymbol = new Map();
    for (const t of trades) {
      const sym = t.symbol || "?";
      if (!bySymbol.has(sym)) bySymbol.set(sym, []);
      bySymbol.get(sym).push(t);
    }
    const entries = Array.from(bySymbol.entries()).sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    if (!entries.length) { els.symbolBox.innerHTML = ""; els.symbolBox.style.display = "none"; return; }
    els.symbolBox.style.display = "";
    const maxCount = Math.max(1, ...entries.map(([, ts]) => ts.length));
    els.symbolBox.innerHTML = `
      <div class="panel-box-head"><span class="title">Top Symbols</span></div>
      ${entries.map(([sym, ts]) => {
        const wins = ts.filter((t) => t.win).length;
        const winRate = Math.round((wins / ts.length) * 100);
        const net = ts.reduce((s, t) => s + (t.pnl_dollars || 0), 0);
        return `
        <div class="bar-row">
          <div class="bar-label">${escapeHtml(sym)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(ts.length / maxCount) * 100}%; background:${net >= 0 ? "var(--green)" : "var(--red)"};" title="${winRate}% win, ${fmtMoney(net)}"></div></div>
          <div class="bar-count">${ts.length}x</div>
        </div>`;
      }).join("")}
    `;
  }

  function renderDowBreakdown(trades) {
    const withDate = trades.filter((t) => t.date);
    if (!withDate.length) { els.dowBox.innerHTML = ""; els.dowBox.style.display = "none"; return; }
    els.dowBox.style.display = "";
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const byDow = new Map();
    for (const t of withDate) {
      const dow = new Date(t.date + "T12:00:00").getDay();
      if (!byDow.has(dow)) byDow.set(dow, []);
      byDow.get(dow).push(t);
    }
    const entries = Array.from(byDow.entries()).sort((a, b) => a[0] - b[0]);
    const maxCount = Math.max(1, ...entries.map(([, ts]) => ts.length));
    els.dowBox.innerHTML = `
      <div class="panel-box-head"><span class="title">Performance by Day of Week</span></div>
      ${entries.map(([dow, ts]) => {
        const net = ts.reduce((s, t) => s + (t.pnl_dollars || 0), 0);
        return `
        <div class="bar-row">
          <div class="bar-label">${DOW[dow]}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(ts.length / maxCount) * 100}%; background:${net >= 0 ? "var(--green)" : "var(--red)"};" title="${fmtMoney(net)}"></div></div>
          <div class="bar-count">${ts.length}x</div>
        </div>`;
      }).join("")}
    `;
  }

  // ================= DOM refs =================
  const els = {
    rangePill: document.getElementById("rpt-range-pill"),
    importState: document.getElementById("rpt-import-state"),
    mapState: document.getElementById("rpt-map-state"),
    loadedState: document.getElementById("rpt-loaded-state"),
    errorState: document.getElementById("rpt-error-state"),
    errorText: document.getElementById("rpt-error-text"),
    dropZone: document.getElementById("rpt-drop-zone"),
    csvFile: document.getElementById("rpt-csv-file"),
    localLabel: document.getElementById("rpt-local-label"),
    localList: document.getElementById("rpt-local-list"),
    mapFields: document.getElementById("rpt-map-fields"),
    mapBuild: document.getElementById("rpt-map-build"),
    mapCancel: document.getElementById("rpt-map-cancel"),
    mapStatus: document.getElementById("rpt-map-status"),
    subtitle: document.getElementById("rpt-subtitle"),
    statGrid: document.getElementById("rpt-stat-grid"),
    detailBox: document.getElementById("rpt-detail-box"),
    equityChart: document.getElementById("rpt-equity-chart"),
    rmultBox: document.getElementById("rpt-rmult-box"),
    symbolBox: document.getElementById("rpt-symbol-box"),
    dowBox: document.getElementById("rpt-dow-box"),
    tradesHead: document.getElementById("rpt-trades-head"),
    tradesBody: document.getElementById("rpt-trades-body"),
    tradesCount: document.getElementById("rpt-trades-count"),
    exportCsv: document.getElementById("rpt-export-csv"),
    exportJson: document.getElementById("rpt-export-json"),
    sendJournal: document.getElementById("rpt-send-journal"),
    replaceCsv: document.getElementById("rpt-replace-csv"),
    deleteBtn: document.getElementById("rpt-delete"),
    toolbarStatus: document.getElementById("rpt-toolbar-status"),
    chartModal: document.getElementById("rpt-chart-modal"),
    chartModalBackdrop: document.getElementById("rpt-chart-modal-backdrop"),
    chartModalClose: document.getElementById("rpt-chart-modal-close"),
    chartModalTitle: document.getElementById("rpt-chart-modal-title"),
    chartModalSub: document.getElementById("rpt-chart-modal-sub"),
    chartVerdict: document.getElementById("rpt-chart-verdict"),
    chartLegendBetterEntry: document.getElementById("rpt-chart-legend-better-entry"),
    chartLegendBetterExit: document.getElementById("rpt-chart-legend-better-exit"),
    chartPracticeBtn: document.getElementById("rpt-chart-practice-btn"),
  };

  function showOnly(which) {
    els.importState.style.display = which === "import" ? "" : "none";
    els.mapState.style.display = which === "map" ? "" : "none";
    els.loadedState.style.display = which === "loaded" ? "" : "none";
    els.errorState.style.display = which === "error" ? "" : "none";
  }

  // ================= tabs =================
  document.getElementById("rpt-toptabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".toptab-btn");
    if (!btn) return;
    document.querySelectorAll("#rpt-toptabs .toptab-btn").forEach((b) => b.classList.toggle("active", b === btn));
    const name = btn.dataset.toptab;
    document.querySelectorAll(".toptab-panel").forEach((p) => p.classList.toggle("active", p.dataset.toptabPanel === name));
  });

  // ================= CSV import + mapping =================
  const FIELD_ALIASES = {
    date: ["date", "trade date", "entry date", "day"],
    symbol: ["symbol", "ticker"],
    side: ["side", "direction", "buy/sell", "action"],
    entry_time: ["entry time", "time in", "buy time", "open time"],
    entry_price: ["entry price", "buy price", "entry", "open price"],
    exit_time: ["exit time", "time out", "sell time", "close time"],
    exit_price: ["exit price", "sell price", "exit", "close price"],
    shares: ["shares", "qty", "quantity", "size", "no. of shares"],
    commission: ["commission", "fees", "ibcommission", "comm"],
    pnl: ["pnl", "p&l", "p&l after comm", "profit", "net p&l", "realized pnl", "gain/loss"],
    r_multiple: ["r", "r multiple", "r-multiple"],
    notes: ["notes", "comment", "comments", "exit comments"],
  };
  const FIELD_LABELS = {
    date: "Trade date *", symbol: "Symbol *", side: "Side (long/short)",
    entry_time: "Entry time", entry_price: "Entry price",
    exit_time: "Exit time", exit_price: "Exit price",
    shares: "Shares", commission: "Commission",
    pnl: "P&L (if your CSV already has it)", r_multiple: "R multiple", notes: "Notes",
  };
  const REQUIRED_FIELDS = ["date", "symbol"];

  function guessMapping(headers) {
    const norm = (s) => s.toLowerCase().trim();
    const map = {};
    for (const field in FIELD_ALIASES) {
      const aliases = FIELD_ALIASES[field];
      const hit = headers.find((h) => aliases.includes(norm(h)));
      map[field] = hit || "";
    }
    return map;
  }

  let pendingCsv = null; // { headers, rows }

  function openMappingStep(headers, rows) {
    pendingCsv = { headers, rows };
    const guess = guessMapping(headers);
    els.mapFields.innerHTML = Object.keys(FIELD_LABELS).map((field) => {
      const options = [`<option value="">-- none --</option>`]
        .concat(headers.map((h) => `<option value="${escapeHtml(h)}" ${guess[field] === h ? "selected" : ""}>${escapeHtml(h)}</option>`));
      return `<div class="bt-field rpt-map-field">
        <label>${FIELD_LABELS[field]}</label>
        <select data-field="${field}">${options.join("")}</select>
      </div>`;
    }).join("");
    els.mapStatus.textContent = "";
    showOnly("map");
  }

  function currentMapping() {
    const map = {};
    els.mapFields.querySelectorAll("select[data-field]").forEach((sel) => { map[sel.dataset.field] = sel.value; });
    return map;
  }

  els.mapCancel.addEventListener("click", () => { pendingCsv = null; showOnly("import"); });

  els.mapBuild.addEventListener("click", () => {
    const map = currentMapping();
    const missing = REQUIRED_FIELDS.filter((f) => !map[f]);
    if (missing.length) {
      els.mapStatus.textContent = `Please map: ${missing.map((f) => FIELD_LABELS[f]).join(", ")}`;
      return;
    }
    if (!map.pnl && !(map.entry_price && map.exit_price)) {
      els.mapStatus.textContent = "Map either a P&L column, or both Entry price and Exit price, so we can compute P&L.";
      return;
    }
    const { headers, rows } = pendingCsv;
    const idx = {};
    for (const f in map) idx[f] = map[f] ? headers.indexOf(map[f]) : -1;
    const num = (v) => { const n = parseFloat(String(v).replace(/[$,]/g, "")); return isNaN(n) ? null : n; };

    let skipped = 0;
    const trades = [];
    for (const row of rows) {
      const get = (f) => (idx[f] >= 0 ? row[idx[f]] : "");
      const date = String(get("date") || "").trim();
      const symbol = String(get("symbol") || "").trim();
      if (!date || !symbol) { skipped++; continue; }

      const sideRaw = String(get("side") || "").toLowerCase();
      const sign = /short|sell|-1/.test(sideRaw) ? -1 : 1;
      const entryPrice = num(get("entry_price"));
      const exitPrice = num(get("exit_price"));
      const shares = num(get("shares")) || 1;
      const commission = num(get("commission")) || 0;
      const pnlDirect = num(get("pnl"));

      let pnl;
      if (pnlDirect !== null) pnl = pnlDirect;
      else if (entryPrice !== null && exitPrice !== null) pnl = sign * (exitPrice - entryPrice) * shares - commission;
      else { skipped++; continue; }

      trades.push({
        date, symbol,
        entry_time: String(get("entry_time") || ""), exit_time: String(get("exit_time") || ""),
        entry_price: entryPrice, exit_price: exitPrice,
        shares, commission_total: commission,
        pnl_dollars: Math.round(pnl * 100) / 100,
        pnl_dollars_gross: entryPrice !== null && exitPrice !== null ? Math.round(sign * (exitPrice - entryPrice) * shares * 100) / 100 : pnl,
        r_multiple: num(get("r_multiple")),
        win: pnl >= 0,
        exit_reason: String(get("notes") || ""),
        side: sign > 0 ? "Long" : "Short",
      });
    }

    if (!trades.length) {
      els.mapStatus.textContent = "Couldn't build any trades from that mapping — double check the columns above.";
      return;
    }
    trades.sort((a, b) => (a.date + (a.entry_time || "")).localeCompare(b.date + (b.entry_time || "")));

    const id = "local-" + uid();
    const label = (qs("label") || "CSV import").slice(0, 80);
    const report = {
      label, source: "csv", created_at: new Date().toISOString(),
      stats: computeStats(trades), trades,
      skipped_rows: skipped,
    };
    saveLocalReport(id, report);
    location.href = `report.html?id=${encodeURIComponent(id)}`;
  });

  function handleCsvFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const { headers, rows } = parseCsvText(String(reader.result));
      if (!headers.length || !rows.length) {
        alert("Couldn't read any rows from that file — is it a CSV?");
        return;
      }
      openMappingStep(headers, rows);
    };
    reader.readAsText(file);
  }
  els.csvFile.addEventListener("change", () => handleCsvFile(els.csvFile.files[0]));
  ["dragenter", "dragover"].forEach((ev) => els.dropZone.addEventListener(ev, (e) => { e.preventDefault(); els.dropZone.classList.add("drag-over"); }));
  ["dragleave", "drop"].forEach((ev) => els.dropZone.addEventListener(ev, (e) => { e.preventDefault(); els.dropZone.classList.remove("drag-over"); }));
  els.dropZone.addEventListener("drop", (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleCsvFile(f); });

  els.replaceCsv.addEventListener("click", () => { showOnly("import"); });

  // ================= render loaded report =================
  let currentReport = null;
  let currentId = null;

  // Rendered REPORT_TRADES_PAGE_SIZE at a time with a "Load more" row
  // rather than dumping the entire (possibly thousands-long, for a long
  // backtest run) trades table into the DOM at once -- same reasoning as
  // journal.html's TABLE_PAGE_SIZE and app.js's TRADE_LIST_PAGE_SIZE.
  const REPORT_TRADES_PAGE_SIZE = 100;
  let reportTradesRows = [];
  let reportTradesCols = [];
  let reportTradesShown = 0;

  function renderReportTradesBody() {
    const shown = reportTradesShown;
    const rowsHtml = reportTradesRows.slice(0, shown)
      .map((t, idx) => `<tr>${reportTradesCols.map(([key]) => `<td>${tradeCell(key, t, idx)}</td>`).join("")}</tr>`)
      .join("");
    const remaining = reportTradesRows.length - shown;
    const moreHtml = remaining > 0
      ? `<tr id="report-trades-load-more-row"><td colspan="${reportTradesCols.length}" style="padding:14px 10px; text-align:center;">
          <button type="button" class="btn-load-more" id="report-trades-load-more-btn">Load more (${remaining} left)</button>
        </td></tr>`
      : "";
    els.tradesBody.innerHTML = rowsHtml + moreHtml
      || `<tr><td colspan="${reportTradesCols.length}"><div class="empty-state small">No trades.</div></td></tr>`;
  }

  function tradeColumns(trades) {
    const has = (k) => trades.some((t) => t[k] !== undefined && t[k] !== null && t[k] !== "");
    const cols = [["date", "Date"], ["symbol", "Symbol"]];
    if (has("side")) cols.push(["side", "Side"]);
    if (has("gap_pct")) cols.push(["gap_pct", "Gap %"]);
    cols.push(["entry_time", "Entry"], ["entry_price", "Entry $"], ["exit_time", "Exit"], ["exit_price", "Exit $"]);
    if (has("exit_reason")) cols.push(["exit_reason", "Reason"]);
    cols.push(["shares", "Shares"], ["commission_total", "Comm. $"], ["pnl_dollars", "P&L $"]);
    if (has("r_multiple")) cols.push(["r_multiple", "R"]);
    // Only appears once at least one trade has been enriched with bars
    // (see sendJournal -> /enrich -> ENRICH_FIELDS in chart_service.py) --
    // that's the raw per-minute series the interactive chart is built from.
    if (has("bars")) cols.push(["chart", "Chart"]);
    return cols;
  }

  function tradeCell(key, t, idx) {
    switch (key) {
      case "gap_pct": return typeof t.gap_pct === "number" ? t.gap_pct.toFixed(1) + "%" : "—";
      case "entry_price": case "exit_price": return typeof t[key] === "number" ? "$" + t[key].toFixed(2) : "—";
      case "commission_total": return t.commission_total ? "$" + Number(t.commission_total).toFixed(2) : "—";
      case "pnl_dollars": return `<span class="pill ${t.win ? "win" : "loss"}">${fmtMoney(t.pnl_dollars)}</span>`;
      case "r_multiple": return fmtR(t.r_multiple);
      case "shares": return t.shares != null ? t.shares : "—";
      case "chart":
        return Array.isArray(t.bars) && t.bars.length
          ? `<button type="button" class="rpt-view-chart-btn" data-trade-idx="${idx}">View Chart</button>`
          : `<button type="button" class="rpt-view-chart-btn" disabled title="Send this run to the journal workflow first to get a chart for this trade">View Chart</button>`;
      default: return escapeHtml(t[key] != null ? t[key] : "—");
    }
  }

  function renderLoaded(report, id) {
    currentReport = report; currentId = id;
    document.getElementById("page-title").textContent = report.label || "Report";
    document.title = `${report.label || "Report"} — trade.log`;

    const trades = report.trades || [];
    const stats = report.stats || {};

    if (report.source === "backend" && report.params && report.params.start) {
      els.rangePill.style.display = "";
      els.rangePill.textContent = `${report.params.start} → ${report.params.end}`;
    } else {
      els.rangePill.style.display = "none";
    }

    els.subtitle.textContent = report.source === "csv"
      ? `Imported from CSV${report.created_at ? " on " + new Date(report.created_at).toLocaleString() : ""} — ${trades.length} trade${trades.length === 1 ? "" : "s"}${report.skipped_rows ? ` (${report.skipped_rows} row${report.skipped_rows === 1 ? "" : "s"} skipped — missing data)` : ""}.`
      : `Saved backtest run${report.created_at ? " from " + new Date(report.created_at).toLocaleString() : ""}.`;

    els.sendJournal.style.display = report.source === "backend" ? "" : "none";
    els.replaceCsv.style.display = report.source === "csv" ? "" : "none";
    els.toolbarStatus.textContent = "";

    // stat grid
    els.statGrid.innerHTML = `
      <div class="stat"><div class="label-row"><span class="label">Net P&amp;L</span></div><div class="value ${stats.net_pnl_dollars >= 0 ? "up" : "down"}">${fmtMoney(stats.net_pnl_dollars)}</div>${stats.return_pct != null ? `<div class="sub-value">${stats.return_pct >= 0 ? "+" : ""}${stats.return_pct.toFixed(2)}% of capital</div>` : ""}</div>
      <div class="stat"><div class="label-row"><span class="label">Win Rate</span></div><div class="value">${fmtPct(stats.win_rate)}</div><div class="sub-value">${stats.num_trades} trade${stats.num_trades === 1 ? "" : "s"}</div></div>
      <div class="stat"><div class="label-row"><span class="label">Profit Factor</span></div><div class="value">${stats.profit_factor != null ? stats.profit_factor.toFixed(2) : "—"}</div></div>
      <div class="stat"><div class="label-row"><span class="label">Avg R</span></div><div class="value ${(stats.avg_r || 0) >= 0 ? "up" : "down"}">${fmtR(stats.avg_r)}</div></div>
      <div class="stat"><div class="label-row"><span class="label">Max Drawdown</span></div><div class="value down">-$${Number(stats.max_drawdown_dollars || 0).toFixed(2)}</div>${stats.max_drawdown_pct != null ? `<div class="sub-value">${stats.max_drawdown_pct.toFixed(2)}% of capital</div>` : ""}</div>
      <div class="stat"><div class="label-row"><span class="label">Streaks (W/L)</span></div><div class="value">${stats.longest_win_streak} / ${stats.longest_loss_streak}</div></div>
      <div class="stat" title="Already netted out of Net P&amp;L above"><div class="label-row"><span class="label">Commissions</span></div><div class="value down">-$${Number(stats.total_commissions_dollars || 0).toFixed(2)}</div></div>
      ${stats.ending_capital != null ? `<div class="stat"><div class="label-row"><span class="label">Ending Capital</span></div><div class="value">$${Number(stats.ending_capital).toFixed(2)}</div><div class="sub-value">from $${Number(stats.starting_capital).toFixed(2)}</div></div>` : ""}
    `;

    const d = computeDetailedStats(trades);
    els.detailBox.innerHTML = !d ? "" : `
      <div class="panel-box-head"><span class="title">Detailed Metrics</span></div>
      <div class="stat-grid">
        <div class="stat"><div class="label-row"><span class="label">Avg Win</span></div><div class="value up">${fmtMoney(stats.avg_win_dollars)}</div></div>
        <div class="stat"><div class="label-row"><span class="label">Avg Loss</span></div><div class="value down">${fmtMoney(stats.avg_loss_dollars)}</div></div>
        <div class="stat"><div class="label-row"><span class="label">Avg Trade</span></div><div class="value ${d.avgTradePnl >= 0 ? "up" : "down"}">${fmtMoney(d.avgTradePnl)}</div></div>
        <div class="stat"><div class="label-row"><span class="label">Gross Profit</span></div><div class="value up">${fmtMoney(d.grossProfit)}</div></div>
        <div class="stat"><div class="label-row"><span class="label">Gross Loss</span></div><div class="value down">${fmtMoney(d.grossLoss)}</div></div>
        <div class="stat" title="${d.best ? escapeHtml(d.best.symbol + " on " + d.best.date) : ""}"><div class="label-row"><span class="label">Best Trade</span></div><div class="value up">${d.best ? fmtMoney(d.best.pnl_dollars) : "—"}</div><div class="sub-value">${d.best ? escapeHtml(d.best.symbol) : ""}</div></div>
        <div class="stat" title="${d.worst ? escapeHtml(d.worst.symbol + " on " + d.worst.date) : ""}"><div class="label-row"><span class="label">Worst Trade</span></div><div class="value down">${d.worst ? fmtMoney(d.worst.pnl_dollars) : "—"}</div><div class="sub-value">${d.worst ? escapeHtml(d.worst.symbol) : ""}</div></div>
        <div class="stat"><div class="label-row"><span class="label">Avg Hold Time</span></div><div class="value">${fmtMinutes(d.avgHoldMinutes)}</div></div>
        <div class="stat"><div class="label-row"><span class="label">Total Shares</span></div><div class="value">${d.totalShares.toLocaleString()}</div></div>
        <div class="stat"><div class="label-row"><span class="label">Symbols Traded</span></div><div class="value">${d.uniqueSymbols}</div>${d.topSymbol ? `<div class="sub-value">most: ${escapeHtml(d.topSymbol)} (${d.topSymbolCount})</div>` : ""}</div>
      </div>`;

    // trades table
    reportTradesCols = tradeColumns(trades);
    reportTradesRows = trades;
    reportTradesShown = Math.min(REPORT_TRADES_PAGE_SIZE, trades.length);
    els.tradesHead.innerHTML = reportTradesCols.map(([, label]) => `<th>${label}</th>`).join("");
    renderReportTradesBody();
    els.tradesCount.textContent = `${trades.length} trade${trades.length === 1 ? "" : "s"}`;

    // Each analytics panel is independent -- a bad field on one trade
    // (a missing R value, an odd date) shouldn't be able to take out
    // the others or leave a panel half-drawn.
    safeCall(() => renderEquityCurve(stats), "renderEquityCurve");
    safeCall(() => renderRMultDistribution(trades), "renderRMultDistribution");
    safeCall(() => renderSymbolBreakdown(trades), "renderSymbolBreakdown");
    safeCall(() => renderDowBreakdown(trades), "renderDowBreakdown");

    showOnly("loaded");
  }

  function safeCall(fn, label) {
    try { fn(); } catch (err) { console.error(`[report.js] ${label} failed:`, err); }
  }

  function exportFileBase(label) {
    const slug = (label || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${slug}_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  }

  const TRADE_EXPORT_COLUMNS = ["date", "symbol", "side", "gap_pct", "entry_time", "entry_price", "exit_time", "exit_price", "exit_reason", "shares", "commission_total", "pnl_dollars", "pnl_dollars_gross", "r_multiple", "win"];
  els.exportCsv.addEventListener("click", () => {
    if (!currentReport) return;
    const header = TRADE_EXPORT_COLUMNS.join(",");
    const rows = currentReport.trades.map((t) => TRADE_EXPORT_COLUMNS.map((c) => csvEscape(t[c])).join(","));
    downloadBlob([header, ...rows].join("\r\n"), "text/csv;charset=utf-8;", `${exportFileBase(currentReport.label)}.csv`);
  });
  els.exportJson.addEventListener("click", () => {
    if (!currentReport) return;
    downloadBlob(JSON.stringify(currentReport.trades, null, 2), "application/json;charset=utf-8;", `${exportFileBase(currentReport.label)}.json`);
  });

  els.deleteBtn.addEventListener("click", () => {
    if (!currentReport || !currentId) return;
    if (!confirm("Delete this report? This can't be undone.")) return;
    if (currentReport.source === "backend") {
      authedHeaders()
        .then((headers) => fetch(`${API()}/backtest/history/${currentId}`, { method: "DELETE", headers }))
        .catch(() => { /* best effort */ })
        .finally(() => { location.href = "backtester.html"; });
    } else {
      deleteLocalReport(currentId);
      location.href = "report.html";
    }
  });

  // Same "Send to Journal" loop as backtester.js: POSTs to
  // N8N_BACKTEST_IMPORT_URL, which should call back to
  // /backtest/history/<id>/enrich on chart_service.py (never the real
  // journal), and never touch data/trades.json.
  els.sendJournal.addEventListener("click", () => {
    if (!currentReport || currentReport.source !== "backend") return;
    const url = window.N8N_BACKTEST_IMPORT_URL || "";
    if (!url || url.includes("YOUR-")) {
      els.toolbarStatus.textContent = "Set window.N8N_BACKTEST_IMPORT_URL in config.js to your n8n webhook first.";
      return;
    }
    const trades = currentReport.trades;
    els.sendJournal.disabled = true;
    const original = els.sendJournal.textContent;
    els.sendJournal.textContent = "Sending…";
    els.toolbarStatus.textContent = `Sending ${trades.length} trade${trades.length === 1 ? "" : "s"} through the journal workflow…`;
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        run: {
          label: currentReport.label, source: "backtest", job_id: currentId,
          callback_url: `${API()}/backtest/history/${currentId}/enrich`,
          started: trades[0] ? trades[0].date : null, ended: trades[trades.length - 1] ? trades[trades.length - 1].date : null,
        },
        trades: trades.map((t) => ({
          date: t.date, symbol: t.symbol, entry_time: t.entry_time, entry_price: t.entry_price,
          exit_time: t.exit_time, exit_price: t.exit_price, exit_reason: t.exit_reason, shares: t.shares,
          pnl_dollars: t.pnl_dollars, pnl_dollars_gross: t.pnl_dollars_gross, commission_total: t.commission_total,
          r_multiple: t.r_multiple, win: t.win,
        })),
      }),
    })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json().catch(() => ({})); })
      .then((data) => {
        const n = (data && data.imported) || trades.length;
        // The workflow runs async (one chart render per trade, paced ~13s
        // apart by the chart server's own Polygon rate limit -- see
        // chart_service.py) and calls back to /enrich once it's done, so
        // nothing new is available on THIS response yet.
        //
        // This used to reload the report exactly ONCE, 20 seconds later,
        // regardless of trade count -- fine for a couple of trades, but a
        // batch of a dozen-plus can legitimately take several minutes
        // (~13s per trade), so that single reload landed mid-run and
        // showed whatever had enriched so far as done, with everything
        // still in flight stuck permanently greyed out until a manual
        // page refresh. Poll instead: keep reloading every 15s until
        // every trade has its bars (or the run truly errored out on the
        // n8n side), for a budget that scales with how many trades are
        // actually in this batch.
        const POLL_MS = 15000;
        const maxAttempts = Math.max(4, Math.ceil((trades.length * 15000 + 30000) / POLL_MS));
        let attempt = 0;

        function allEnriched() {
          return currentReport && Array.isArray(currentReport.trades)
            && currentReport.trades.every((t) => Array.isArray(t.bars) && t.bars.length);
        }

        function poll() {
          attempt++;
          loadBackendReport(currentId).then(() => {
            if (!currentReport || currentReport.source !== "backend") return; // navigated away
            if (allEnriched()) {
              els.toolbarStatus.textContent = `All ${trades.length} trade${trades.length === 1 ? "" : "s"} enriched.`;
              return;
            }
            if (attempt >= maxAttempts) {
              els.toolbarStatus.textContent = "Some trades are still missing charts — the journal workflow may still be running or hit an error partway through; reload this page in a bit to check again.";
              return;
            }
            els.toolbarStatus.textContent = `Sent ${n} trade${n === 1 ? "" : "s"} to the journal workflow — charts will appear here as they finish (checking again in ${POLL_MS / 1000}s)…`;
            setTimeout(poll, POLL_MS);
          });
        }

        els.toolbarStatus.textContent = `Sent ${n} trade${n === 1 ? "" : "s"} to the journal workflow — charts will appear here once it finishes (this page will refresh automatically).`;
        setTimeout(poll, POLL_MS);
      })
      .catch((err) => { els.toolbarStatus.textContent = `Couldn't send to journal (${err.message}).`; })
      .finally(() => { els.sendJournal.disabled = false; els.sendJournal.textContent = original; });
  });

  // ================= interactive per-trade chart modal =================
  // Renders the same kind of candlestick + volume + VWAP/EMA/MACD chart
  // with entry/exit markers that trade.js draws for real journal trades,
  // but here it's built from a backtest trade's `bars`/`indicators` --
  // populated by sendJournal() above once the n8n workflow's /enrich
  // callback has run. No image is generated or shown; everything is
  // drawn client-side from the raw bar data.
  let rptCandleChart = null, rptMacdChart = null, rptRepositionPointers = null;

  function toUnix(t) { return Math.floor(new Date(String(t).replace(" ", "T")).getTime() / 1000); }

  function closeTradeChart() {
    els.chartModal.style.display = "none";
    els.chartModal.setAttribute("aria-hidden", "true");
    if (rptCandleChart) { rptCandleChart.remove(); rptCandleChart = null; }
    if (rptMacdChart) { rptMacdChart.remove(); rptMacdChart = null; }
    rptRepositionPointers = null;
    document.getElementById("rpt-candle-chart").innerHTML = "";
    document.getElementById("rpt-macd-chart").innerHTML = "";
  }

  function openTradeChart(t) {
    if (!t || !Array.isArray(t.bars) || !t.bars.length) return;
    els.chartModal.style.display = "";
    els.chartModal.removeAttribute("aria-hidden");
    els.chartModalTitle.textContent = `${t.symbol || "—"} — ${t.date || ""}`;
    els.chartModalSub.textContent = `${t.win ? "WIN" : "LOSS"} · ${fmtMoney(t.pnl_dollars)} · entry ${t.entry_time || "—"} @ $${Number(t.entry_price).toFixed(2)} → exit ${t.exit_time || "—"} @ $${Number(t.exit_price).toFixed(2)}`;

    if (t.verdict) {
      els.chartVerdict.style.display = "";
      els.chartVerdict.textContent = t.verdict;
    } else {
      els.chartVerdict.style.display = "none";
      els.chartVerdict.textContent = "";
    }
    els.chartLegendBetterEntry.style.display = t.better_entry_price ? "" : "none";
    els.chartLegendBetterExit.style.display = t.better_exit_price ? "" : "none";

    wirePracticeHandoff(t);
    buildTradeChart(t);
  }

  // Hands this backtest trade's own bars + entry/exit/pnl/verdict off to
  // the Practice tab via localStorage (same-origin, so the new tab can
  // read it right away), so "Practice this trade" lets you paper-trade
  // the exact symbol/session the backtester flagged, then see the
  // backtester's own result on it once the practice session ends --
  // the same "what actually happened" comparison practice.html already
  // shows for real logged journal trades.
  const PRACTICE_HANDOFF_KEY = "practice:pending_backtest_trade";
  function wirePracticeHandoff(t) {
    if (!els.chartPracticeBtn) return;
    const hasBars = Array.isArray(t.bars) && t.bars.length;
    els.chartPracticeBtn.style.display = hasBars ? "" : "none";
    if (!hasBars) return;
    els.chartPracticeBtn.onclick = () => {
      try {
        localStorage.setItem(PRACTICE_HANDOFF_KEY, JSON.stringify(Object.assign({}, t, {
          job_id: currentId,
          label: (currentReport && currentReport.label) || null,
        })));
      } catch (e) { /* storage full/unavailable -- link still opens practice.html normally */ }
    };
  }

  function buildTradeChart(trade) {
    const bars = trade.bars;
    const candleData = bars.map((b) => ({ time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c }));
    const volData = bars.map((b) => ({ time: toUnix(b.t), value: b.v, color: b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" }));
    const vwapData = bars.map((b) => ({ time: toUnix(b.t), value: b.vwap }));
    const ema9Data = bars.map((b) => ({ time: toUnix(b.t), value: b.ema9 }));
    const ema20Data = bars.map((b) => ({ time: toUnix(b.t), value: b.ema20 }));
    const macdData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd }));
    const signalData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd_signal }));
    const histData = bars.map((b) => ({ time: toUnix(b.t), value: b.macd_hist, color: b.macd_hist >= 0 ? "#2fd08a" : "#f2555a" }));

    const candleEl = document.getElementById("rpt-candle-chart");
    const macdEl = document.getElementById("rpt-macd-chart");
    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: "#8b98a5" },
      grid: { vertLines: { color: "#1c2127" }, horzLines: { color: "#1c2127" } },
      rightPriceScale: { borderColor: "#232830", minimumWidth: 92 },
      timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };

    rptCandleChart = LightweightCharts.createChart(candleEl, { ...commonOpts, width: candleEl.clientWidth, height: candleEl.clientHeight || 380 });
    const candleSeries = rptCandleChart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
      // See trade.js buildCharts() -- disable the library's built-in
      // dashed "last value" price line so it doesn't show up as a stray
      // green/red line at the last close price alongside our own
      // entry/exit/S-R lines.
      priceLineVisible: false,
    });
    candleSeries.setData(candleData);
    rptCandleChart.priceScale("right").applyOptions({ scaleMargins: { top: 0.14, bottom: 0.18 } });

    const volSeries = rptCandleChart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    rptCandleChart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(volData);

    rptCandleChart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(vwapData);
    rptCandleChart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema9Data);
    rptCandleChart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema20Data);

    // Entry/exit price lines -- solid, actual fills. No axis title: the
    // pointer triangles below (same visual language as trade.js's
    // real-journal chart) carry that now, on hover/tap, instead of a
    // permanent label competing with the axis. lineVisible: false so only
    // the axis tag shows, matching trade.js -- without it these drew as
    // full-width dashed lines straight across the chart.
    candleSeries.createPriceLine({ price: trade.entry_price, color: "#2fd08a", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, lineVisible: false, axisLabelVisible: true, title: "" });
    candleSeries.createPriceLine({ price: trade.exit_price, color: "#f2555a", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, lineVisible: false, axisLabelVisible: true, title: "" });

    // The LLM verdict step (see chart_service.py's /enrich contract) only
    // ever gives a better_entry/exit PRICE for backtest trades, no time --
    // so unlike trade.js's real-journal chart, these can only be drawn as
    // dotted price lines, not time-anchored pointer markers.
    if (trade.better_entry_price) {
      candleSeries.createPriceLine({
        price: Number(trade.better_entry_price), color: "#8b7cf6", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted, lineVisible: false, axisLabelVisible: true, title: "better entry",
      });
    }
    if (trade.better_exit_price) {
      candleSeries.createPriceLine({
        price: Number(trade.better_exit_price), color: "#ec6cad", lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dotted, lineVisible: false, axisLabelVisible: true, title: "better exit",
      });
    }

    // Small pointer triangles right on the actual entry/exit fills, exact
    // same visual language and mechanics as trade.js's real-journal chart:
    // a tiny CSS triangle positioned in screen pixels off the fill's real
    // time/price coordinate, with a hover/tap tooltip carrying the full
    // price -- instead of lightweight-charts' native arrow+text markers,
    // which draw their text permanently on the pane and, at anything but
    // a wide zoom, sit right on top of (or right next to) the candles
    // themselves.
    //
    // Backtest trades never carry better_entry_time/better_exit_time (only
    // a price -- see Build Backtest Callback Body), so unlike trade.js
    // there's no bar to anchor a "better" pointer to; those stay as the
    // dotted price lines above, axis label only.
    function barAt(unixTime) {
      let best = bars[0];
      for (const b of bars) { if (toUnix(b.t) <= unixTime) best = b; else break; }
      return best;
    }
    const entryBar = barAt(toUnix(`${trade.date} ${trade.entry_time}`));
    const exitBar = barAt(toUnix(`${trade.date} ${trade.exit_time}`));

    const POINTER_H = 9; // triangle height in px -- also used to correct the tip offset in repositionPointers()

    function tooltipHtml(head) {
      return `<div style="font-weight:700;">${escapeHtml(head)}</div>`;
    }

    // Appended to `wrap` directly (not the pointer overlay, which clips its
    // contents to the chart's bounds via overflow:hidden) so the tooltip is
    // never cut off at the pane edge.
    function buildPointer(tooltipHtmlText, color) {
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
      if (tooltipHtmlText) {
        tooltip = document.createElement("div");
        tooltip.className = "pointer-tooltip";
        tooltip.dataset.open = "0";
        tooltip.style.cssText = `
          position:absolute; display:none; width:180px; max-width:60vw;
          background:#181b22; border:1px solid ${color}; border-radius:8px;
          padding:10px 12px; font-size:12px; line-height:1.5; color:#eceef2;
          box-shadow:0 6px 20px rgba(0,0,0,.45); z-index:5; pointer-events:none;
        `;
        tooltip.innerHTML = tooltipHtmlText;
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

    function mkPointer(time, price, color, above, tooltipHtmlText) {
      const { el, tooltip } = buildPointer(tooltipHtmlText, color);
      return { time, price, color, above, el, tooltip };
    }

    const pointers = [
      // Entry: triangle sits just above the fill, tip pointing down onto it.
      mkPointer(toUnix(entryBar.t), trade.entry_price, "#2fd08a", true, tooltipHtml(`ENTRY $${Number(trade.entry_price).toFixed(2)}`)),
      // Exit: triangle sits just below the fill, tip pointing up onto it.
      mkPointer(toUnix(exitBar.t), trade.exit_price, "#f2555a", false, tooltipHtml(`EXIT $${Number(trade.exit_price).toFixed(2)}`)),
    ];

    // A zero-size div with only border-bottom set renders a triangle whose
    // TIP sits at the box's OWN top edge, with the flat BASE extending
    // downward (by POINTER_H) from there; border-top-only is the mirror
    // image. See repositionPointers() below, which corrects for that.
    pointers.forEach((p) => {
      p.el.style.borderTop = p.above ? `${POINTER_H}px solid ${p.color}` : "";
      p.el.style.borderBottom = p.above ? "" : `${POINTER_H}px solid ${p.color}`;
    });

    function repositionPointers() {
      pointers.forEach((p) => {
        const x = rptCandleChart.timeScale().timeToCoordinate(p.time);
        const y = candleSeries.priceToCoordinate(p.price);
        if (x === null || y === null) {
          p.el.style.display = "none";
          if (p.tooltip) { p.tooltip.style.display = "none"; p.tooltip.dataset.open = "0"; }
          return;
        }
        p.el.style.display = "block";
        p.el.style.left = `${x}px`;
        const pointerTop = p.above ? y - POINTER_H : y;
        p.el.style.top = `${pointerTop}px`;
        p.el.style.transform = "translateX(-50%)";
        if (p.tooltip && p.tooltip.dataset.open === "1") {
          p.tooltip.style.left = `${x + 8}px`;
          p.tooltip.style.top = `${p.above ? pointerTop - 8 : pointerTop + POINTER_H + 8}px`;
          p.tooltip.style.transform = p.above ? "translateY(-100%)" : "none";
        }
      });
    }

    rptRepositionPointers = repositionPointers;
    rptCandleChart.timeScale().subscribeVisibleLogicalRangeChange(repositionPointers);
    // priceToCoordinate depends on the right price scale's own autoscale,
    // which isn't settled until after setData/fitContent run -- a couple
    // of follow-up passes catch that instead of racing it.
    repositionPointers();
    requestAnimationFrame(repositionPointers);
    setTimeout(repositionPointers, 0);

    rptMacdChart = LightweightCharts.createChart(macdEl, { ...commonOpts, width: macdEl.clientWidth, height: macdEl.clientHeight || 100 });
    rptMacdChart.addHistogramSeries({ priceFormat: { type: "price", precision: 3 } }).setData(histData);
    rptMacdChart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(macdData);
    rptMacdChart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(signalData);

    rptCandleChart.timeScale().subscribeVisibleLogicalRangeChange((range) => { if (range && rptMacdChart) rptMacdChart.timeScale().setVisibleLogicalRange(range); });
    rptMacdChart.timeScale().subscribeVisibleLogicalRangeChange((range) => { if (range && rptCandleChart) rptCandleChart.timeScale().setVisibleLogicalRange(range); });
    rptCandleChart.timeScale().fitContent();
    rptMacdChart.timeScale().fitContent();
  }

  els.tradesBody.addEventListener("click", (e) => {
    const moreBtn = e.target.closest("#report-trades-load-more-btn");
    if (moreBtn) {
      reportTradesShown = Math.min(reportTradesShown + REPORT_TRADES_PAGE_SIZE, reportTradesRows.length);
      renderReportTradesBody();
      return;
    }
    const btn = e.target.closest(".rpt-view-chart-btn");
    if (!btn || btn.disabled) return;
    const idx = Number(btn.dataset.tradeIdx);
    const trade = currentReport && currentReport.trades && currentReport.trades[idx];
    if (trade) openTradeChart(trade);
  });
  els.chartModalBackdrop.addEventListener("click", closeTradeChart);
  els.chartModalClose.addEventListener("click", closeTradeChart);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && els.chartModal.style.display !== "none") closeTradeChart(); });
  // Closes whichever pointer tooltip is tap-pinned open when the user
  // clicks anywhere else -- otherwise a tapped-open tooltip (the only way
  // touch users reach it, since there's no mouseenter) would just sit
  // there covering the chart. Registered once here rather than inside
  // buildTradeChart, which reruns on every chart open.
  document.addEventListener("click", () => {
    document.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
  });
  window.addEventListener("resize", () => {
    if (!rptCandleChart) return;
    const candleEl = document.getElementById("rpt-candle-chart");
    const macdEl = document.getElementById("rpt-macd-chart");
    rptCandleChart.applyOptions({ width: candleEl.clientWidth });
    if (rptMacdChart) rptMacdChart.applyOptions({ width: macdEl.clientWidth });
    if (rptRepositionPointers) rptRepositionPointers();
  });

  // ================= local reports list (import/empty state) =================
  function renderLocalList() {
    const list = loadLocalIndex();
    if (!list.length) { els.localLabel.style.display = "none"; els.localList.innerHTML = ""; return; }
    els.localLabel.style.display = "";
    els.localList.innerHTML = list.map((e) => `
      <div class="rpt-local-card" data-id="${escapeHtml(e.id)}">
        <div>
          <div class="rpt-local-card-title">${escapeHtml(e.label || "CSV import")}</div>
          <div class="rpt-local-card-sub">${e.num_trades} trades · ${fmtMoney(e.net_pnl_dollars)}${e.created_at ? " · " + new Date(e.created_at).toLocaleDateString() : ""}</div>
        </div>
        <button class="rpt-local-card-delete" data-del="${escapeHtml(e.id)}" title="Delete">&times;</button>
      </div>`).join("");
    els.localList.querySelectorAll(".rpt-local-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest("[data-del]")) return;
        location.href = `report.html?id=${encodeURIComponent(card.dataset.id)}`;
      });
    });
    els.localList.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm("Delete this saved CSV report?")) { deleteLocalReport(btn.dataset.del); renderLocalList(); }
      });
    });
  }

  // Once auth.js has this user's synced index down, a remote copy wins
  // (cross-device source of truth) and the import/empty-state list gets
  // repainted; otherwise whatever's local right now gets pushed up as
  // the seed (which also seeds every report:<id> body it references,
  // since saveLocalReport already ran when each one was first imported).
  if (window.KV) {
    window.KV.sync(LOCAL_INDEX_KEY, (remote) => {
      if (!Array.isArray(remote)) return;
      try { localStorage.setItem(LOCAL_INDEX_KEY, JSON.stringify(remote)); } catch (e) { /* ignore */ }
      if (typeof renderLocalList === "function") renderLocalList();
    });
  }

  // ================= boot =================
  function init() {
    const id = qs("id");
    if (!id) { showOnly("import"); renderLocalList(); return; }

    if (id.startsWith("local-")) {
      const report = loadLocalReport(id);
      if (report) { renderLoaded(report, id); return; }
      // Not found locally yet -- if KV (Supabase) hasn't finished its
      // initial load, wait for it and retry once before giving up; a
      // report saved on a different browser/device only lives there
      // until KV.ready resolves.
      if (window.KV && !window.KV.isLoaded()) {
        window.KV.ready.then(() => {
          const remote = loadLocalReport(id);
          if (remote) { renderLoaded(remote, id); return; }
          els.errorText.textContent = "This CSV report isn't in this browser's storage (maybe it was cleared, or you're on a different device/browser). Import the CSV again to rebuild it.";
          showOnly("error");
        });
        return;
      }
      els.errorText.textContent = "This CSV report isn't in this browser's storage (maybe it was cleared, or you're on a different device/browser). Import the CSV again to rebuild it.";
      showOnly("error");
      return;
    }

    // backend job id
    loadBackendReport(id);
  }

  function loadBackendReport(id) {
    if (!API() || API().includes("YOUR-NGROK-SUBDOMAIN")) {
      els.errorText.textContent = "Set window.CHART_SERVICE_URL in config.js to your ngrok URL to open saved backtest runs.";
      showOnly("error");
      return Promise.resolve();
    }
    return authedHeaders()
      .then((headers) => fetch(`${API()}/backtest/history/${id}/report`, { headers }))
      .then((r) => {
        if (r.status === 404) throw new Error("No saved report for this run — it may have been deleted, or predates this feature.");
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        renderLoaded({
          label: data.label || "Backtest run", source: "backend",
          created_at: data.created_at, params: data.params || null,
          stats: data.stats, trades: data.trades || [],
        }, id);
      })
      .catch((err) => {
        els.errorText.textContent = "Couldn't load this report: " + err.message;
        showOnly("error");
      });
  }

  init();
})();
