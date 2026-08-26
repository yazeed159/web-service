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
  }
  function saveLocalReport(id, report) {
    try { localStorage.setItem(`report:${id}`, JSON.stringify(report)); } catch (e) { /* ignore */ }
    const idx = loadLocalIndex().filter((e) => e.id !== id);
    idx.unshift({
      id, label: report.label, created_at: report.created_at,
      num_trades: report.stats.num_trades, net_pnl_dollars: report.stats.net_pnl_dollars,
    });
    saveLocalIndex(idx);
  }
  function loadLocalReport(id) {
    try { return JSON.parse(localStorage.getItem(`report:${id}`)); } catch (e) { return null; }
  }
  function deleteLocalReport(id) {
    try { localStorage.removeItem(`report:${id}`); localStorage.removeItem(`journal:${id}`); } catch (e) { /* ignore */ }
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
    tradesHead: document.getElementById("rpt-trades-head"),
    tradesBody: document.getElementById("rpt-trades-body"),
    tradesCount: document.getElementById("rpt-trades-count"),
    exportCsv: document.getElementById("rpt-export-csv"),
    exportJson: document.getElementById("rpt-export-json"),
    sendJournal: document.getElementById("rpt-send-journal"),
    replaceCsv: document.getElementById("rpt-replace-csv"),
    deleteBtn: document.getElementById("rpt-delete"),
    toolbarStatus: document.getElementById("rpt-toolbar-status"),
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

  function tradeColumns(trades) {
    const has = (k) => trades.some((t) => t[k] !== undefined && t[k] !== null && t[k] !== "");
    const cols = [["date", "Date"], ["symbol", "Symbol"]];
    if (has("side")) cols.push(["side", "Side"]);
    if (has("gap_pct")) cols.push(["gap_pct", "Gap %"]);
    cols.push(["entry_time", "Entry"], ["entry_price", "Entry $"], ["exit_time", "Exit"], ["exit_price", "Exit $"]);
    if (has("exit_reason")) cols.push(["exit_reason", "Reason"]);
    cols.push(["shares", "Shares"], ["commission_total", "Comm. $"], ["pnl_dollars", "P&L $"]);
    if (has("r_multiple")) cols.push(["r_multiple", "R"]);
    return cols;
  }

  function tradeCell(key, t) {
    switch (key) {
      case "gap_pct": return typeof t.gap_pct === "number" ? t.gap_pct.toFixed(1) + "%" : "—";
      case "entry_price": case "exit_price": return typeof t[key] === "number" ? "$" + t[key].toFixed(2) : "—";
      case "commission_total": return t.commission_total ? "$" + Number(t.commission_total).toFixed(2) : "—";
      case "pnl_dollars": return `<span class="pill ${t.win ? "win" : "loss"}">${fmtMoney(t.pnl_dollars)}</span>`;
      case "r_multiple": return fmtR(t.r_multiple);
      case "shares": return t.shares != null ? t.shares : "—";
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
    const cols = tradeColumns(trades);
    els.tradesHead.innerHTML = cols.map(([, label]) => `<th>${label}</th>`).join("");
    els.tradesBody.innerHTML = trades.map((t) => `<tr>${cols.map(([key]) => `<td>${tradeCell(key, t)}</td>`).join("")}</tr>`).join("")
      || `<tr><td colspan="${cols.length}"><div class="empty-state small">No trades.</div></td></tr>`;
    els.tradesCount.textContent = `${trades.length} trade${trades.length === 1 ? "" : "s"}`;

    showOnly("loaded");
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
      fetch(`${API()}/backtest/history/${currentId}`, { method: "DELETE", headers: FETCH_HEADERS })
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
        els.toolbarStatus.textContent = `Sent ${n} trade${n === 1 ? "" : "s"} to the journal workflow.`;
      })
      .catch((err) => { els.toolbarStatus.textContent = `Couldn't send to journal (${err.message}).`; })
      .finally(() => { els.sendJournal.disabled = false; els.sendJournal.textContent = original; });
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

  // ================= boot =================
  function init() {
    const id = qs("id");
    if (!id) { showOnly("import"); renderLocalList(); return; }

    if (id.startsWith("local-")) {
      const report = loadLocalReport(id);
      if (!report) {
        els.errorText.textContent = "This CSV report isn't in this browser's storage (maybe it was cleared, or you're on a different device/browser). Import the CSV again to rebuild it.";
        showOnly("error");
        return;
      }
      renderLoaded(report, id);
      return;
    }

    // backend job id
    if (!API() || API().includes("YOUR-NGROK-SUBDOMAIN")) {
      els.errorText.textContent = "Set window.CHART_SERVICE_URL in config.js to your ngrok URL to open saved backtest runs.";
      showOnly("error");
      return;
    }
    fetch(`${API()}/backtest/history/${id}/report`, { headers: FETCH_HEADERS })
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
