(function () {
  "use strict";

  let trades = [];
  let activeFilter = "all";
  let searchTerm = "";
  let calYear = null;
  let calMonth = null; // 0-indexed
  let selectedDay = null;

  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

  const statGrid = document.getElementById("stat-grid");
  const dayGroups = document.getElementById("day-groups");

  fetch("data/trades.json")
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((data) => {
      trades = data.slice().sort((a, b) => (a.trade_date + a.entry_time).localeCompare(b.trade_date + b.entry_time));
      if (!trades.length) {
        renderEmptyEverywhere();
        return;
      }
      const last = trades[trades.length - 1];
      document.getElementById("last-updated").textContent = "Through " + last.trade_date;
      document.getElementById("date-range").textContent =
        trades[0].trade_date === last.trade_date ? last.trade_date : `${trades[0].trade_date} → ${last.trade_date}`;

      const lastDate = new Date(last.trade_date + "T12:00:00");
      calYear = lastDate.getFullYear();
      calMonth = lastDate.getMonth();

      renderStats();
      renderScore();
      renderMiniCal();
      renderEquity();
      renderRecentTrades();
      renderGroups();
      renderCalendar();
      renderReports();
    })
    .catch((err) => {
      const msg = `Couldn't load data/trades.json (${escapeHtml(String(err.message))}). Make sure you're serving this folder, not opening index.html via file://.`;
      dayGroups.innerHTML = `<div class="empty-state">${msg}</div>`;
      statGrid.innerHTML = "";
      document.getElementById("last-updated").textContent = "No data";
    });

  function renderEmptyEverywhere() {
    document.getElementById("last-updated").textContent = "No trades yet";
    statGrid.innerHTML = "";
    document.getElementById("score-wrap").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("mini-cal").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("recent-trades").innerHTML = '<div class="empty-state small">No trades logged yet.</div>';
    document.getElementById("equity-total").textContent = "";
    dayGroups.innerHTML = '<div class="empty-state">No trades logged yet — the pipeline will publish here after the first close.</div>';
    document.getElementById("cal-grid").innerHTML = '<div class="empty-state">No trades logged yet.</div>';
    document.getElementById("cal-summary-strip").innerHTML = "";
    document.getElementById("cal-month-label").textContent = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });
    document.getElementById("streak-strip").innerHTML = "";
    document.getElementById("highlight-pair").innerHTML = "";
    document.getElementById("report-symbol").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-dow").innerHTML = '<div class="empty-state small">No data yet.</div>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMoney(v) {
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toFixed(2);
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function dateKey(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }

  // ================================================================
  // TAB NAVIGATION
  // ================================================================
  const TAB_TITLES = { dashboard: "Dashboard", dayview: "Day View", tradeview: "Trade View", reports: "Reports" };

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

  document.querySelectorAll(".nav-item[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  });
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => setTab(btn.dataset.goto));
  });

  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("collapsed");
  });
  document.getElementById("mobile-nav-btn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("mobile-open");
  });

  // ================================================================
  // DASHBOARD — stat cards
  // ================================================================
  function computeStats() {
    const wins = trades.filter((t) => t.win);
    const losses = trades.filter((t) => !t.win);
    const winRate = (wins.length / trades.length) * 100;
    const grossPnl = trades.reduce((s, t) => s + t.pnl_before_comm, 0);
    const totalComm = trades.reduce((s, t) => s + t.commission, 0);
    const netPnl = trades.reduce((s, t) => s + t.pnl_after_comm, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl_after_comm, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_after_comm, 0) / losses.length : 0;
    const grossWinSum = wins.reduce((s, t) => s + t.pnl_after_comm, 0);
    const grossLossSum = Math.abs(losses.reduce((s, t) => s + t.pnl_after_comm, 0));
    const profitFactor = grossLossSum > 0 ? grossWinSum / grossLossSum : (grossWinSum > 0 ? Infinity : 0);

    const byDay = new Map();
    trades.forEach((t) => {
      if (!byDay.has(t.trade_date)) byDay.set(t.trade_date, 0);
      byDay.set(t.trade_date, byDay.get(t.trade_date) + t.pnl_after_comm);
    });
    const dayVals = Array.from(byDay.values());
    const winDays = dayVals.filter((v) => v > 0).length;
    const dayWinRate = dayVals.length ? (winDays / dayVals.length) * 100 : 0;

    return { wins, losses, winRate, grossPnl, totalComm, netPnl, avgWin, avgLoss, profitFactor, dayWinRate, dayCount: dayVals.length };
  }

  function renderStats() {
    const s = computeStats();
    const pfDisplay = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);

    const cards = [
      { label: "Net P&L", value: fmtMoney(s.netPnl), cls: s.netPnl >= 0 ? "up" : "down", sub: `gross ${fmtMoney(s.grossPnl)} · comm $${s.totalComm.toFixed(2)}` },
      { label: "Trade win %", value: s.winRate.toFixed(0) + "%", cls: s.winRate >= 50 ? "up" : "down", sub: `${trades.length} trades` },
      { label: "Profit factor", value: pfDisplay, cls: s.profitFactor >= 1 ? "up" : "down", sub: s.profitFactor >= 1 ? "profitable" : "below 1.0" },
      { label: "Day win %", value: s.dayWinRate.toFixed(0) + "%", cls: s.dayWinRate >= 50 ? "up" : "down", sub: `${s.dayCount} trading days` },
      { label: "Avg win", value: fmtMoney(s.avgWin), cls: "up", sub: `${s.wins.length} wins` },
      { label: "Avg loss", value: fmtMoney(s.avgLoss), cls: "down", sub: `${s.losses.length} losses` },
    ];

    statGrid.innerHTML = cards
      .map(
        (c) => `<div class="stat"><div class="label-row"><span class="label">${c.label}</span></div><div class="value ${c.cls}">${c.value}</div>${c.sub ? `<div class="sub-value">${c.sub}</div>` : ""}</div>`
      )
      .join("");
  }

  // ================================================================
  // DASHBOARD — trader score gauge
  // ================================================================
  function renderScore() {
    const s = computeStats();
    const winRateScore = Math.max(0, Math.min(100, s.winRate));
    const pfScore = s.profitFactor === Infinity ? 100 : Math.max(0, Math.min(100, (s.profitFactor / 3) * 100));
    const ratio = s.avgLoss !== 0 ? s.avgWin / Math.abs(s.avgLoss) : 0;
    const avgWLScore = Math.max(0, Math.min(100, (ratio / 2) * 100));
    const overall = Math.round((winRateScore + pfScore + avgWLScore) / 3);

    const color = overall >= 70 ? "var(--green)" : overall >= 40 ? "var(--amber)" : "var(--red)";
    const r = 58, c = 2 * Math.PI * r;
    const dash = (overall / 100) * c;

    document.getElementById("score-wrap").innerHTML = `
      <div class="score-gauge">
        <svg viewBox="0 0 132 132">
          <circle class="track" cx="66" cy="66" r="${r}"></circle>
          <circle class="fill" cx="66" cy="66" r="${r}" stroke="${color}" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}"></circle>
        </svg>
        <div class="center">
          <span class="num" style="color:${color}">${overall}</span>
          <span class="lbl">Score</span>
        </div>
      </div>
      <div class="score-breakdown">
        ${scoreRow("Win rate", winRateScore, s.winRate.toFixed(0) + "%")}
        ${scoreRow("Profit factor", pfScore, s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2))}
        ${scoreRow("Avg win/loss", avgWLScore, ratio.toFixed(2))}
      </div>
    `;
  }

  function scoreRow(label, pct, display) {
    const color = pct >= 70 ? "var(--green)" : pct >= 40 ? "var(--amber)" : "var(--red)";
    return `<div class="score-row">
      <span class="k">${label}</span>
      <span class="track"><span class="fill" style="width:${Math.max(4, pct).toFixed(0)}%; background:${color}"></span></span>
      <span class="v">${display}</span>
    </div>`;
  }

  // ================================================================
  // DASHBOARD — mini calendar (current month)
  // ================================================================
  function pnlByDay() {
    const map = new Map();
    trades.forEach((t) => {
      if (!map.has(t.trade_date)) map.set(t.trade_date, { net: 0, count: 0, trades: [] });
      const e = map.get(t.trade_date);
      e.net += t.pnl_after_comm;
      e.count += 1;
      e.trades.push(t);
    });
    return map;
  }

  function renderMiniCal() {
    const map = pnlByDay();
    const y = calYear, m = calMonth;
    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const todayKey = new Date().toISOString().slice(0, 10);

    let html = `<div class="mini-cal-head"><span>${MONTHS[m]} ${y}</span></div><div class="mini-cal-grid">`;
    DOW.forEach((d) => (html += `<div class="mini-cal-dow">${d[0]}</div>`));
    for (let i = 0; i < firstDow; i++) html += `<div class="mini-cell empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const key = dateKey(y, m, d);
      const entry = map.get(key);
      let cls = "mini-cell";
      if (entry) cls += entry.net >= 0 ? " win" : " loss";
      if (key === todayKey) cls += " today";
      html += `<div class="${cls}" title="${entry ? fmtMoney(entry.net) + " · " + entry.count + " trades" : "No trades"}">${d}</div>`;
    }
    html += "</div>";
    document.getElementById("mini-cal").innerHTML = html;
  }

  // ================================================================
  // EQUITY CURVE (shared by dashboard)
  // ================================================================
  function renderEquity() {
    const ordered = trades;
    const points = [{ e: 0 }, ...ordered.map((t) => ({ e: t.equity_after }))];
    const values = points.map((p) => p.e);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const range = max - min || 1;
    const W = 1000, H = 140, PAD = 8;

    const coords = points.map((p, i) => {
      const x = points.length > 1 ? (i / (points.length - 1)) * W : 0;
      const y = H - PAD - ((p.e - min) / range) * (H - PAD * 2);
      return [x, y];
    });

    const pathD = coords.map((c, i) => (i === 0 ? "M" : "L") + c[0].toFixed(1) + "," + c[1].toFixed(1)).join(" ");
    const zeroY = H - PAD - ((0 - min) / range) * (H - PAD * 2);
    const fillD = pathD + ` L${coords[coords.length - 1][0].toFixed(1)},${zeroY} L0,${zeroY} Z`;

    const finalPositive = values[values.length - 1] >= 0;
    const svg = document.getElementById("equity-svg");
    svg.innerHTML = `
      <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" class="equity-zero" />
      <path d="${fillD}" fill="${finalPositive ? "url(#gGreen)" : "url(#gRed)"}" />
      <path d="${pathD}" class="equity-path ${finalPositive ? "" : "neg"}" />
      <defs>
        <linearGradient id="gGreen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2fd08a" stop-opacity="0.22" />
          <stop offset="100%" stop-color="#2fd08a" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="gRed" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#f2555a" stop-opacity="0.2" />
          <stop offset="100%" stop-color="#f2555a" stop-opacity="0" />
        </linearGradient>
      </defs>
    `;
    document.getElementById("equity-total").textContent = fmtMoney(values[values.length - 1]);
    document.getElementById("equity-total").className = "value mono " + (values[values.length - 1] >= 0 ? "up" : "down");
  }

  // ================================================================
  // DASHBOARD — recent trades
  // ================================================================
  function tradeRowHtml(t) {
    const dotColor = t.win ? "var(--green)" : "var(--red)";
    return `
    <tr data-id="${t.id}">
      <td class="sym"><span class="side-dot" style="background:${dotColor}"></span>${t.symbol}</td>
      <td class="mono dim">${t.trade_date}</td>
      <td class="mono dim">${t.entry_time}</td>
      <td class="mono">$${t.entry_price.toFixed(2)} → $${t.exit_price.toFixed(2)}</td>
      <td class="mono dim">${t.shares}</td>
      <td><span class="pnl-tag ${t.win ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</span></td>
    </tr>`;
  }
  function bindTradeRows(container) {
    container.querySelectorAll("tr[data-id]").forEach((row) => {
      row.addEventListener("click", () => {
        window.location.href = `trade.html?id=${encodeURIComponent(row.dataset.id)}`;
      });
    });
  }

  function renderRecentTrades() {
    const recent = trades.slice(-5).reverse();
    const rows = recent.map(tradeRowHtml).join("");
    const el = document.getElementById("recent-trades");
    el.innerHTML = `<table class="trade-table"><thead><tr><th>Symbol</th><th>Date</th><th>Entry</th><th>Price</th><th>Shares</th><th>Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table>`;
    bindTradeRows(el);
  }

  // ================================================================
  // TRADE VIEW — day-grouped table (with search + filter)
  // ================================================================
  function getFiltered() {
    let list = trades;
    if (activeFilter === "win") list = list.filter((t) => t.win);
    if (activeFilter === "loss") list = list.filter((t) => !t.win);
    if (searchTerm) list = list.filter((t) => t.symbol.toLowerCase().includes(searchTerm));
    return list;
  }

  function renderGroups() {
    const list = getFiltered();
    if (!list.length) {
      dayGroups.innerHTML = '<div class="empty-state">No trades match — try clearing the search or filter.</div>';
      return;
    }

    const byDay = new Map();
    list.forEach((t) => {
      if (!byDay.has(t.trade_date)) byDay.set(t.trade_date, []);
      byDay.get(t.trade_date).push(t);
    });

    const days = Array.from(byDay.keys()).sort((a, b) => b.localeCompare(a));

    dayGroups.innerHTML = days
      .map((day) => {
        const dayTrades = byDay.get(day).sort((a, b) => a.entry_time.localeCompare(b.entry_time));
        const dayNet = dayTrades.reduce((s, t) => s + t.pnl_after_comm, 0);
        const dateLabel = new Date(day + "T12:00:00").toLocaleDateString(undefined, {
          weekday: "short", month: "short", day: "numeric", year: "numeric",
        });

        const rows = dayTrades
          .map((t) => {
            const dotColor = t.win ? "var(--green)" : "var(--red)";
            return `
            <tr data-id="${t.id}">
              <td class="sym"><span class="side-dot" style="background:${dotColor}"></span>${t.symbol}</td>
              <td class="mono dim">${t.entry_time}</td>
              <td class="mono dim">${t.exit_time}</td>
              <td class="mono">$${t.entry_price.toFixed(2)} → $${t.exit_price.toFixed(2)}</td>
              <td class="mono dim">${t.shares}</td>
              <td class="mono dim">$${t.commission.toFixed(2)}</td>
              <td><span class="pnl-tag ${t.win ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</span></td>
            </tr>`;
          })
          .join("");

        return `
        <div class="day-group">
          <div class="day-header">
            <div class="day-left">
              <span class="day-date">${dateLabel}</span>
              <span class="day-count">${dayTrades.length} trade${dayTrades.length === 1 ? "" : "s"}</span>
            </div>
            <span class="day-pnl ${dayNet >= 0 ? "up" : "down"}">${fmtMoney(dayNet)}</span>
          </div>
          <table class="trade-table">
            <thead>
              <tr>
                <th>Symbol</th><th>Entry</th><th>Exit</th><th>Price</th><th>Shares</th><th>Comm.</th><th>Net P&amp;L</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      })
      .join("");

    bindTradeRows(dayGroups);
  }

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      renderGroups();
    });
  });

  const searchInput = document.getElementById("search");
  searchInput.addEventListener("input", (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderGroups();
  });

  // ================================================================
  // DAY VIEW — full calendar
  // ================================================================
  function renderCalendar() {
    const map = pnlByDay();
    const y = calYear, m = calMonth;
    document.getElementById("cal-month-label").textContent = `${MONTHS[m]} ${y}`;

    const firstDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    let monthNet = 0, winDays = 0, lossDays = 0, tradingDays = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const entry = map.get(dateKey(y, m, d));
      if (entry) {
        monthNet += entry.net;
        tradingDays++;
        if (entry.net >= 0) winDays++; else lossDays++;
      }
    }

    document.getElementById("cal-summary-strip").innerHTML = `
      <div class="cell"><div class="label">Month P&amp;L</div><div class="value ${monthNet >= 0 ? "up" : "down"}">${fmtMoney(monthNet)}</div></div>
      <div class="cell"><div class="label">Trading days</div><div class="value">${tradingDays}</div></div>
      <div class="cell"><div class="label">Win days</div><div class="value up">${winDays}</div></div>
      <div class="cell"><div class="label">Loss days</div><div class="value down">${lossDays}</div></div>
    `;

    let html = "";
    DOW.forEach((d) => (html += `<div class="cal-dow">${d}</div>`));
    for (let i = 0; i < firstDow; i++) html += `<div class="cal-cell empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const key = dateKey(y, m, d);
      const entry = map.get(key);
      let cls = "cal-cell";
      if (entry) cls += (entry.net >= 0 ? " win" : " loss") + " has-trades";
      if (key === selectedDay) cls += " selected";
      html += `<div class="${cls}" data-day="${key}">
        <span class="date-num">${d}</span>
        ${entry ? `<span class="cell-pnl">${fmtMoney(entry.net)}</span><span class="cell-count">${entry.count} trade${entry.count === 1 ? "" : "s"}</span>` : ""}
      </div>`;
    }
    document.getElementById("cal-grid").innerHTML = html;

    document.querySelectorAll(".cal-cell.has-trades").forEach((cell) => {
      cell.addEventListener("click", () => {
        const key = cell.dataset.day;
        selectedDay = selectedDay === key ? null : key;
        renderCalendar();
        if (selectedDay) showDayDetail(selectedDay, map.get(selectedDay));
        else document.getElementById("day-detail-panel").style.display = "none";
      });
    });
  }

  function showDayDetail(key, entry) {
    const panel = document.getElementById("day-detail-panel");
    panel.style.display = "block";
    const dateLabel = new Date(key + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric", year: "numeric" });
    document.getElementById("day-detail-title").textContent = `${dateLabel} — ${fmtMoney(entry.net)} · ${entry.count} trade${entry.count === 1 ? "" : "s"}`;
    const sorted = entry.trades.slice().sort((a, b) => a.entry_time.localeCompare(b.entry_time));
    const rows = sorted.map((t) => `
      <tr data-id="${t.id}">
        <td class="sym"><span class="side-dot" style="background:${t.win ? "var(--green)" : "var(--red)"}"></span>${t.symbol}</td>
        <td class="mono dim">${t.entry_time}</td>
        <td class="mono dim">${t.exit_time}</td>
        <td class="mono">$${t.entry_price.toFixed(2)} → $${t.exit_price.toFixed(2)}</td>
        <td class="mono dim">${t.shares}</td>
        <td><span class="pnl-tag ${t.win ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</span></td>
      </tr>`).join("");
    const body = document.getElementById("day-detail-body");
    body.innerHTML = `<table class="trade-table"><thead><tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>Price</th><th>Shares</th><th>Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table>`;
    bindTradeRows(body);
    panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  document.getElementById("day-detail-close").addEventListener("click", () => {
    selectedDay = null;
    document.getElementById("day-detail-panel").style.display = "none";
    renderCalendar();
  });
  document.getElementById("cal-prev").addEventListener("click", () => {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
    selectedDay = null;
    document.getElementById("day-detail-panel").style.display = "none";
    renderCalendar();
  });
  document.getElementById("cal-next").addEventListener("click", () => {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
    selectedDay = null;
    document.getElementById("day-detail-panel").style.display = "none";
    renderCalendar();
  });

  // ================================================================
  // REPORTS
  // ================================================================
  function renderReports() {
    renderStreaks();
    renderHighlights();
    renderSymbolBreakdown();
    renderDowBreakdown();
  }

  function renderStreaks() {
    // trades already sorted chronologically
    let best = 0, worst = 0, curWinRun = 0, curLossRun = 0;
    let trailingSign = 0, trailingRun = 0;
    trades.forEach((t) => {
      if (t.win) { curWinRun++; curLossRun = 0; best = Math.max(best, curWinRun); }
      else { curLossRun++; curWinRun = 0; worst = Math.max(worst, curLossRun); }
      if (t.win === (trailingSign === 1)) { trailingRun++; }
      else { trailingSign = t.win ? 1 : -1; trailingRun = 1; }
    });
    const currentLabel = trailingSign === 1 ? `${trailingRun}W` : trailingSign === -1 ? `${trailingRun}L` : "—";
    const currentColor = trailingSign === 1 ? "up" : trailingSign === -1 ? "down" : "";

    document.getElementById("streak-strip").innerHTML = `
      <div class="cell"><div class="label">Current streak</div><div class="value ${currentColor}">${currentLabel}</div></div>
      <div class="cell"><div class="label">Best win streak</div><div class="value up">${best}W</div></div>
      <div class="cell"><div class="label">Worst loss streak</div><div class="value down">${worst}L</div></div>
    `;
  }

  function renderHighlights() {
    const best = trades.reduce((a, b) => (b.pnl_after_comm > a.pnl_after_comm ? b : a), trades[0]);
    const worst = trades.reduce((a, b) => (b.pnl_after_comm < a.pnl_after_comm ? b : a), trades[0]);
    document.getElementById("highlight-pair").innerHTML = `
      <div class="highlight-card best">
        <div class="label">Best trade</div>
        <div class="sym">${best.symbol} <span class="dim" style="font-weight:400;font-size:12px;">${best.trade_date}</span></div>
        <div class="pnl up">${fmtMoney(best.pnl_after_comm)}</div>
      </div>
      <div class="highlight-card worst">
        <div class="label">Worst trade</div>
        <div class="sym">${worst.symbol} <span class="dim" style="font-weight:400;font-size:12px;">${worst.trade_date}</span></div>
        <div class="pnl down">${fmtMoney(worst.pnl_after_comm)}</div>
      </div>
    `;
  }

  function renderSymbolBreakdown() {
    const bySym = new Map();
    trades.forEach((t) => {
      if (!bySym.has(t.symbol)) bySym.set(t.symbol, { trades: [], net: 0 });
      const e = bySym.get(t.symbol);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    const rows = Array.from(bySym.entries()).sort((a, b) => b[1].net - a[1].net);
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r[1].net)));

    const html = rows.map(([sym, e]) => {
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr>
        <td style="font-weight:600;">${escapeHtml(sym)}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    }).join("");

    document.getElementById("report-symbol").innerHTML = `<table class="report-table"><thead><tr><th>Symbol</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody>${html}</tbody></table>`;
  }

  function renderDowBreakdown() {
    const byDow = new Map();
    trades.forEach((t) => {
      const dow = new Date(t.trade_date + "T12:00:00").getDay();
      if (!byDow.has(dow)) byDow.set(dow, { trades: [], net: 0 });
      const e = byDow.get(dow);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    const order = [1, 2, 3, 4, 5, 0, 6]; // Mon..Sun
    const present = order.filter((d) => byDow.has(d));
    const maxAbs = Math.max(1, ...present.map((d) => Math.abs(byDow.get(d).net)));

    const html = present.map((d) => {
      const e = byDow.get(d);
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr>
        <td style="font-weight:600;">${DOW[d]}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    }).join("");

    document.getElementById("report-dow").innerHTML = `<table class="report-table"><thead><tr><th>Day</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody>${html}</tbody></table>`;
  }
})();
