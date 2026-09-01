(function () {
  "use strict";

  // ==================================================================
  // Practice Analytics — reads the same localStorage account
  // (practice:account:v2) that practice.js writes to and turns its
  // flat fill history into trade-level analytics: win rate, profit
  // factor, streaks, and -- since account.fills only records
  // individual buy/sell prints, not "trades" -- how long each
  // position was actually held.
  //
  // A "closed trade" here is a round trip: it starts at the first
  // fill after the position was flat and ends at the fill that
  // brings the running share count back to zero. practice.js always
  // force-flattens any open position when a session ends (endSession),
  // so fills never straddle two different charts mid-position and
  // this grouping is safe to do purely by walking the array in order.
  // ==================================================================

  const ACCOUNT_KEY = "practice:account:v2";

  // ---------------- shared formatting helpers (same conventions as
  // practice.js / app.js) ----------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toUnix(t) {
    return Math.floor(new Date(String(t).replace(" ", "T") + "").getTime() / 1000);
  }
  function fmtUsd(v) {
    if (!Number.isFinite(v)) return "—";
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtMoney(v) {
    if (!Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPrice(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
    const n = Number(v);
    return n.toFixed(Math.abs(n) < 5 ? 4 : 2);
  }
  function fmtClock(t) {
    try { return new Date(String(t).replace(" ", "T")).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
    catch (e) { return String(t); }
  }
  function fmtDuration(mins) {
    if (mins === null || mins === undefined || !Number.isFinite(mins)) return "—";
    const totalSec = Math.round(mins * 60);
    if (totalSec < 60) return totalSec + "s";
    const total = Math.round(mins);
    const h = Math.floor(total / 60), m = total % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function avgOf(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null; }

  // ---------------- load account ----------------
  function loadAccount() {
    try {
      const raw = localStorage.getItem(ACCOUNT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.fills)) return null;
      return parsed;
    } catch (e) { return null; }
  }

  // ---------------- group fills into round-trip closed trades ----------------
  function computeClosedTrades(fills) {
    const trades = [];
    let cur = null;
    let running = 0;

    fills.forEach((f) => {
      if (!cur) cur = { chartId: f.chartId, symbol: f.symbol, entryTime: f.time, fills: [] };
      cur.fills.push(f);
      running += f.side === "buy" ? f.shares : -f.shares;
      if (running <= 0) {
        cur.exitTime = f.time;
        cur.pnl = cur.fills.reduce((s, x) => s + (x.realizedPnl || 0), 0);
        cur.commission = cur.fills.reduce((s, x) => s + (x.commission || 0), 0);
        let r = 0, maxR = 0;
        cur.fills.forEach((x) => { r += x.side === "buy" ? x.shares : -x.shares; maxR = Math.max(maxR, r); });
        cur.maxShares = maxR;
        cur.win = cur.pnl > 0;
        const entryUnix = toUnix(cur.entryTime), exitUnix = toUnix(cur.exitTime);
        cur.durationMin = Number.isFinite(entryUnix) && Number.isFinite(exitUnix) && exitUnix >= entryUnix
          ? (exitUnix - entryUnix) / 60 : null;
        trades.push(cur);
        cur = null;
        running = 0;
      }
    });
    return trades;
  }

  const DURATION_BUCKETS = [
    { label: "< 1 min", max: 1 },
    { label: "1–5 min", max: 5 },
    { label: "5–15 min", max: 15 },
    { label: "15–30 min", max: 30 },
    { label: "30–60 min", max: 60 },
    { label: "1–2 hr", max: 120 },
    { label: "> 2 hr", max: Infinity },
  ];

  // ---------------- render ----------------
  const els = {
    emptyState: document.getElementById("pa-empty-state"),
    body: document.getElementById("pa-body"),
    statGrid: document.getElementById("pa-stat-grid"),
    equitySvg: document.getElementById("pa-equity-svg"),
    equityEmpty: document.getElementById("pa-equity-empty"),
    streakStrip: document.getElementById("pa-streak-strip"),
    highlightPair: document.getElementById("pa-highlight-pair"),
    durationStats: document.getElementById("pa-duration-stats"),
    durationBreakdown: document.getElementById("pa-duration-breakdown"),
    symbolTable: document.getElementById("pa-symbol-table"),
    tradesTable: document.getElementById("pa-trades-table"),
    tradesCount: document.getElementById("pa-trades-count"),
  };

  function statCell(label, value, cls) {
    return `<div class="stat"><div class="label-row"><span class="label">${label}</span></div><div class="value${cls ? " " + cls : ""}">${value}</div></div>`;
  }

  function renderStatGrid(account, closed) {
    const wins = closed.filter((t) => t.pnl > 0);
    const losses = closed.filter((t) => t.pnl < 0);
    const realized = closed.reduce((s, t) => s + t.pnl, 0);
    const comm = account.fills.reduce((s, f) => s + (f.commission || 0), 0);
    const winRate = closed.length ? (wins.length / closed.length) * 100 : null;
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = losses.reduce((s, t) => s + t.pnl, 0);
    const profitFactor = grossLoss < 0 ? grossWin / Math.abs(grossLoss) : (grossWin > 0 ? Infinity : null);
    const expectancy = closed.length ? realized / closed.length : null;

    els.statGrid.innerHTML = [
      statCell("Balance", fmtUsd(account.balance), account.balance >= account.startingBalance ? "up" : "down"),
      statCell("Starting balance", fmtUsd(account.startingBalance)),
      statCell("Realized P&amp;L", fmtMoney(realized), realized >= 0 ? "up" : "down"),
      statCell("Commission paid", fmtUsd(comm)),
      statCell("Closed trades", String(closed.length)),
      statCell("Win rate", winRate === null ? "—" : winRate.toFixed(0) + "%"),
      statCell("Profit factor", profitFactor === null ? "—" : profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)),
      statCell("Avg P&amp;L / trade", expectancy === null ? "—" : fmtMoney(expectancy), expectancy >= 0 ? "up" : "down"),
    ].join("");
  }

  function renderEquityCurve(closed) {
    const points = [0, ...closed.map((t, i, arr) => arr.slice(0, i + 1).reduce((s, x) => s + x.pnl, 0))];
    if (points.length < 2) {
      els.equitySvg.innerHTML = "";
      els.equityEmpty.style.display = "";
      return;
    }
    els.equityEmpty.style.display = "none";
    const min = Math.min(0, ...points);
    const max = Math.max(0, ...points);
    const range = max - min || 1;
    const W = 1000, H = 200, PAD = 10;
    const coords = points.map((p, i) => {
      const x = points.length > 1 ? (i / (points.length - 1)) * W : 0;
      const y = H - PAD - ((p - min) / range) * (H - PAD * 2);
      return [x, y];
    });
    const pathD = coords.map((c, i) => (i === 0 ? "M" : "L") + c[0].toFixed(1) + "," + c[1].toFixed(1)).join(" ");
    const zeroY = H - PAD - ((0 - min) / range) * (H - PAD * 2);
    const fillD = pathD + ` L${coords[coords.length - 1][0].toFixed(1)},${zeroY} L0,${zeroY} Z`;
    const finalPositive = points[points.length - 1] >= 0;
    els.equitySvg.innerHTML = `
      <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" class="equity-zero" />
      <path d="${fillD}" fill="${finalPositive ? "url(#paGGreen)" : "url(#paGRed)"}" />
      <path d="${pathD}" class="equity-path ${finalPositive ? "" : "neg"}" />
      <defs>
        <linearGradient id="paGGreen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2fd08a" stop-opacity="0.22" />
          <stop offset="100%" stop-color="#2fd08a" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="paGRed" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f2555a" stop-opacity="0.2" />
          <stop offset="100%" stop-color="#f2555a" stop-opacity="0" />
        </linearGradient>
      </defs>
    `;
  }

  function renderStreaks(closed) {
    let best = 0, worst = 0, trailingSign = 0, trailingRun = 0;
    let curWinRun = 0, curLossRun = 0;
    closed.forEach((t) => {
      if (t.win) { curWinRun++; curLossRun = 0; best = Math.max(best, curWinRun); }
      else { curLossRun++; curWinRun = 0; worst = Math.max(worst, curLossRun); }
      if (t.win === (trailingSign === 1)) trailingRun++;
      else { trailingSign = t.win ? 1 : -1; trailingRun = 1; }
    });
    const currentLabel = trailingSign === 1 ? `${trailingRun}W` : trailingSign === -1 ? `${trailingRun}L` : "—";
    const currentColor = trailingSign === 1 ? "up" : trailingSign === -1 ? "down" : "";
    els.streakStrip.innerHTML = `
      <div class="cell"><div class="label">Current streak</div><div class="value ${currentColor}">${currentLabel}</div></div>
      <div class="cell"><div class="label">Best win streak</div><div class="value up">${best}W</div></div>
      <div class="cell"><div class="label">Worst loss streak</div><div class="value down">${worst}L</div></div>
    `;
  }

  function renderHighlights(closed, indexMap) {
    if (!closed.length) { els.highlightPair.innerHTML = `<div class="pr-empty">No closed trades yet.</div>`; return; }
    const best = closed.reduce((a, b) => (b.pnl > a.pnl ? b : a), closed[0]);
    const worst = closed.reduce((a, b) => (b.pnl < a.pnl ? b : a), closed[0]);
    const card = (t, cls) => {
      const row = indexMap.get(t.chartId);
      const sub = row ? `${escapeHtml(row.symbol)} · ${escapeHtml(row.trade_date)}` : escapeHtml(t.symbol || t.chartId || "—");
      return `<div class="highlight-card ${cls}">
        <div class="label">${cls === "best" ? "Best trade" : "Worst trade"}</div>
        <div class="sym">${sub}</div>
        <div class="pnl ${cls === "best" ? "up" : "down"}">${fmtMoney(t.pnl)}</div>
      </div>`;
    };
    els.highlightPair.innerHTML = card(best, "best") + card(worst, "worst");
  }

  function renderDurationSection(closed) {
    const durations = closed.map((t) => t.durationMin).filter((v) => v !== null && Number.isFinite(v));
    els.durationStats.innerHTML = [
      statCell("Avg time in trade", fmtDuration(avgOf(durations))),
      statCell("Median time in trade", fmtDuration(median(durations))),
      statCell("Shortest", durations.length ? fmtDuration(Math.min(...durations)) : "—"),
      statCell("Longest", durations.length ? fmtDuration(Math.max(...durations)) : "—"),
    ].join("");

    if (!durations.length) {
      els.durationBreakdown.innerHTML = `<div class="empty-state small">No timed trades yet.</div>`;
      return;
    }
    const buckets = DURATION_BUCKETS.map((b) => ({ ...b, trades: [] }));
    closed.forEach((t) => {
      if (t.durationMin === null || !Number.isFinite(t.durationMin)) return;
      const bucket = buckets.find((b) => t.durationMin <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    const maxCount = Math.max(1, ...buckets.map((b) => b.trades.length));
    els.durationBreakdown.innerHTML = buckets.filter((b) => b.trades.length).map((b) => {
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (b.trades.length / maxCount) * 100;
      return `<div class="bar-row">
        <div class="bar-label">${b.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(0)}%;"></div></div>
        <div class="bar-count">${b.trades.length}x</div>
        <div style="width:52px; text-align:right; flex-shrink:0; color:${winRate >= 50 ? "var(--green)" : "var(--red)"};">${winRate.toFixed(0)}%</div>
      </div>`;
    }).join("");
  }

  function renderSymbolTable(closed, indexMap) {
    if (!closed.length) { els.symbolTable.innerHTML = `<div class="empty-state small">No closed trades yet.</div>`; return; }
    const byChart = new Map();
    closed.forEach((t) => {
      if (!byChart.has(t.chartId)) byChart.set(t.chartId, { trades: [], net: 0 });
      const e = byChart.get(t.chartId);
      e.trades.push(t);
      e.net += t.pnl;
    });
    const rows = Array.from(byChart.entries()).sort((a, b) => b[1].net - a[1].net);
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r[1].net)));

    const html = rows.map(([chartId, e]) => {
      const row = indexMap.get(chartId);
      const label = row ? `${escapeHtml(row.symbol)} <span class="dim" style="font-weight:400; font-size:11.5px; color:var(--text-faint);">${escapeHtml(row.trade_date)}</span>` : escapeHtml(chartId);
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      const avgHold = fmtDuration(avgOf(e.trades.map((t) => t.durationMin).filter((v) => v !== null && Number.isFinite(v))));
      const link = row ? `<a href="trade.html?id=${encodeURIComponent(chartId)}" target="_blank" rel="noopener" title="View the real trade">${label}</a>` : label;
      return `<tr>
        <td style="font-weight:600;">${link}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono">${avgHold}</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    }).join("");

    els.symbolTable.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>Chart</th><th>Trades</th><th>Win %</th><th>Avg hold</th><th>Net P&amp;L</th></tr></thead><tbody>${html}</tbody></table></div>`;
  }

  function renderTradesTable(closed, indexMap) {
    els.tradesCount.textContent = closed.length ? `${closed.length} trade${closed.length === 1 ? "" : "s"}` : "";
    if (!closed.length) { els.tradesTable.innerHTML = `<div class="empty-state small">No closed trades yet — head to <a href="practice.html">Practice</a> to place some.</div>`; return; }
    const rows = closed.slice().reverse().slice(0, 50).map((t) => {
      const row = indexMap.get(t.chartId);
      const sym = row ? row.symbol : (t.symbol || t.chartId || "—");
      return `<tr>
        <td style="font-weight:600;">${escapeHtml(sym)}</td>
        <td class="mono">${fmtClock(t.entryTime)}</td>
        <td class="mono">${fmtClock(t.exitTime)}</td>
        <td class="mono">${fmtDuration(t.durationMin)}</td>
        <td class="mono dim">${t.maxShares}</td>
        <td class="mono ${t.pnl >= 0 ? "up" : "down"}">${fmtMoney(t.pnl)}</td>
        <td><span class="pill ${t.win ? "win" : "loss"}">${t.win ? "Win" : "Loss"}</span></td>
      </tr>`;
    }).join("");
    els.tradesTable.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>Duration</th><th>Shares</th><th>Net P&amp;L</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${closed.length > 50 ? `<div class="pr-empty">Showing the most recent 50 of ${closed.length} trades.</div>` : ""}`;
  }

  function render(account, indexMap) {
    const closed = computeClosedTrades(account.fills);
    if (!account.fills.length) {
      els.emptyState.style.display = "";
      els.body.style.display = "none";
      return;
    }
    els.emptyState.style.display = "none";
    els.body.style.display = "";

    renderStatGrid(account, closed);
    renderEquityCurve(closed);
    renderStreaks(closed);
    renderHighlights(closed, indexMap);
    renderDurationSection(closed);
    renderSymbolTable(closed, indexMap);
    renderTradesTable(closed, indexMap);
  }

  // ---------------- boot ----------------
  const account = loadAccount();
  const indexMap = new Map();

  if (!account || !account.fills.length) {
    els.emptyState.style.display = "";
    els.body.style.display = "none";
  } else {
    // Best-effort enrichment: map each practiced chartId back to its
    // real symbol/trade_date so tables can show something more useful
    // than a raw id and link into the real trade. Analytics still
    // render fine (just with bare chart ids) if this fetch fails.
    window.fetchTradesIndex()
      .catch(() => [])
      .then((rows) => {
        (Array.isArray(rows) ? rows : []).forEach((row) => indexMap.set(row.id, row));
      })
      .catch(() => {})
      .then(() => render(account, indexMap));
  }
})();
