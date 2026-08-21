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
    document.getElementById("report-timeofday").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-duration").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-most-traded").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-most-profitable").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-sector").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("report-country").innerHTML = '<div class="empty-state small">No data yet.</div>';
    document.getElementById("detailed-stat-grid").innerHTML = "";
    [
      "detail-dow", "detail-hour", "detail-price", "detail-size", "detail-symbol", "detail-side",
      "detail-setup", "detail-lessons", "detail-distribution", "detail-expectancy",
      "detail-rvol", "detail-avgvol", "detail-float",
    ].forEach((id) => (document.getElementById(id).innerHTML = '<div class="empty-state small">No data yet.</div>'));
    [
      "wld-summary", "wld-top-win", "wld-top-loss", "dd-summary", "dd-periods",
      "compare-a", "compare-b", "tagb-setup", "tagb-lessons",
    ].forEach((id) => (document.getElementById(id).innerHTML = '<div class="empty-state small">No data yet.</div>'));
    document.getElementById("advanced-grid").innerHTML = "";
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

  const sidebarBackdrop = document.createElement("div");
  sidebarBackdrop.className = "sidebar-backdrop";
  document.body.appendChild(sidebarBackdrop);
  function closeMobileNav() { document.getElementById("sidebar").classList.remove("mobile-open"); }
  sidebarBackdrop.addEventListener("click", closeMobileNav);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMobileNav(); });

  document.getElementById("sidebar-toggle").addEventListener("click", () => {
    const sidebar = document.getElementById("sidebar");
    if (window.innerWidth <= 760 && sidebar.classList.contains("mobile-open")) {
      closeMobileNav();
    } else {
      sidebar.classList.toggle("collapsed");
    }
  });
  document.getElementById("mobile-nav-btn").addEventListener("click", () => {
    document.getElementById("sidebar").classList.toggle("mobile-open");
  });

  // Reports → Detailed stats sub-tabs (separate from the main sidebar tabs)
  document.querySelectorAll(".subtab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".subtab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".subtab-panel").forEach((p) => p.classList.toggle("active", p.id === "subtab-" + btn.dataset.subtab));
    });
  });

  // Reports → top-level tabs (Overview / Detailed / Win vs Loss Days / Drawdown / Compare / Tag Breakdown / Advanced)
  document.querySelectorAll(".toptab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".toptab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".toptab-panel").forEach((p) => p.classList.toggle("active", p.id === "toptab-" + btn.dataset.toptab));
    });
  });

  // Reports → Compare tab controls (not gated behind trades having loaded —
  // periodStats() just returns an empty result until data arrives)
  const cmpApplyBtn = document.getElementById("cmp-apply");
  if (cmpApplyBtn) cmpApplyBtn.addEventListener("click", updateCompare);
  ["cmp-a-start", "cmp-a-end", "cmp-b-start", "cmp-b-end"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", updateCompare);
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
    el.innerHTML = `<div class="table-scroll"><table class="trade-table"><thead><tr><th>Symbol</th><th>Date</th><th>Entry</th><th>Price</th><th>Shares</th><th>Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
          <div class="table-scroll"><table class="trade-table">
            <thead>
              <tr>
                <th>Symbol</th><th>Entry</th><th>Exit</th><th>Price</th><th>Shares</th><th>Comm.</th><th>Net P&amp;L</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table></div>
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
    body.innerHTML = `<div class="table-scroll"><table class="trade-table"><thead><tr><th>Symbol</th><th>Entry</th><th>Exit</th><th>Price</th><th>Shares</th><th>Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
    renderDetailedStats();
    renderDetailSubtabs();
    renderStreaks();
    renderHighlights();
    renderSymbolBreakdown();
    renderDowBreakdown();
    renderTimeOfDayBreakdown();
    renderDurationBreakdown();
    renderLeaderboards();
    renderSectorCountryBreakdown();
    renderWinLossDays();
    renderDrawdown();
    renderCompare();
    renderTagBreakdown();
    renderAdvanced();
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
      const smallSample = e.trades.length < 3;
      return `<tr>
        <td style="font-weight:600;">${escapeHtml(sym)}${smallSample ? ` <span class="pill" style="font-size:9.5px; padding:1px 6px;" title="Fewer than 3 trades — win rate isn't meaningful yet.">n=${e.trades.length}</span>` : ""}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    }).join("");

    document.getElementById("report-symbol").innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>Symbol</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody>${html}</tbody></table></div>`;
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

    document.getElementById("report-dow").innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>Day</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody>${html}</tbody></table></div>`;
  }

  // ================================================================
  // REPORTS — time of day
  // ================================================================
  // Buckets by ENTRY time, on the theory that when you got in is the
  // habit worth watching (chasing the open, forcing trades at lunch, etc).
  // Times are "HH:MM:SS" strings, which sort/compare correctly as text.
  const TOD_BUCKETS = [
    { label: "Open (9:30–9:45)", from: "09:30:00", to: "09:44:59" },
    { label: "Early (9:45–10:30)", from: "09:45:00", to: "10:29:59" },
    { label: "Mid-morning (10:30–11:30)", from: "10:30:00", to: "11:29:59" },
    { label: "Midday (11:30–14:00)", from: "11:30:00", to: "13:59:59" },
    { label: "Power hour (14:00–15:30)", from: "14:00:00", to: "15:29:59" },
    { label: "Close (15:30–16:00)", from: "15:30:00", to: "16:00:00" },
  ];

  function renderTimeOfDayBreakdown() {
    const buckets = TOD_BUCKETS.map((b) => ({ ...b, trades: [] }));
    const other = [];
    trades.forEach((t) => {
      const bucket = buckets.find((b) => t.entry_time >= b.from && t.entry_time <= b.to);
      if (bucket) bucket.trades.push(t);
      else other.push(t);
    });
    const present = buckets.filter((b) => b.trades.length);
    const maxAbs = Math.max(1, ...present.map((b) => Math.abs(b.trades.reduce((s, t) => s + t.pnl_after_comm, 0))));

    const rows = present.map((b) => {
      const net = b.trades.reduce((s, t) => s + t.pnl_after_comm, 0);
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (Math.abs(net) / maxAbs) * 100;
      const color = net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr>
        <td style="font-weight:600;">${b.label}</td>
        <td class="mono dim">${b.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</span></td>
      </tr>`;
    }).join("");

    const el = document.getElementById("report-timeofday");
    if (!rows) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    el.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>Session</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ================================================================
  // REPORTS — trade duration
  // ================================================================
  // Duration comes from entry_time/exit_time (both "HH:MM:SS" on the
  // same trade_date), not a separate field -- the index doesn't carry
  // time_in_trade, so it's computed here the same way the detail page
  // would show it.
  function durationMinutes(t) {
    const toSec = (s) => { const [h, m, sec] = s.split(":").map(Number); return h * 3600 + m * 60 + (sec || 0); };
    const diff = toSec(t.exit_time) - toSec(t.entry_time);
    return diff > 0 ? diff / 60 : null;
  }

  const DURATION_BUCKETS = [
    { label: "< 5 min", max: 5 },
    { label: "5–15 min", max: 15 },
    { label: "15–30 min", max: 30 },
    { label: "30–60 min", max: 60 },
    { label: "> 60 min", max: Infinity },
  ];

  function renderDurationBreakdown() {
    const buckets = DURATION_BUCKETS.map((b) => ({ ...b, trades: [] }));
    trades.forEach((t) => {
      const mins = durationMinutes(t);
      if (mins === null) return;
      const bucket = buckets.find((b) => mins <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    const maxCount = Math.max(1, ...buckets.map((b) => b.trades.length));

    const rows = buckets.filter((b) => b.trades.length).map((b) => {
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (b.trades.length / maxCount) * 100;
      return `<div class="bar-row">
        <div class="bar-label">${b.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(0)}%;"></div></div>
        <div class="bar-count">${b.trades.length}x</div>
        <div style="width:52px; text-align:right; flex-shrink:0; color:${winRate >= 50 ? "var(--green)" : "var(--red)"};">${winRate.toFixed(0)}%</div>
      </div>`;
    }).join("");

    const el = document.getElementById("report-duration");
    el.innerHTML = rows || `<div class="empty-state small">No data yet.</div>`;
  }

  // ================================================================
  // REPORTS — leaderboards
  // ================================================================
  function symbolAgg() {
    const map = new Map();
    trades.forEach((t) => {
      if (!map.has(t.symbol)) map.set(t.symbol, { trades: [], net: 0 });
      const e = map.get(t.symbol);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return map;
  }

  function leaderboardRows(entries, valueFn, valueCls) {
    return entries.map(([sym, e]) => `
      <div class="bar-row">
        <div class="bar-label" style="width:70px;">${escapeHtml(sym)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${e._pct}%;"></div></div>
        <div style="width:70px; text-align:right; flex-shrink:0;" class="${valueCls(e)}">${valueFn(e)}</div>
      </div>`).join("");
  }

  function renderLeaderboards() {
    const map = symbolAgg();
    const entries = Array.from(map.entries());

    const byCount = entries.slice().sort((a, b) => b[1].trades.length - a[1].trades.length).slice(0, 5);
    const maxCount = Math.max(1, ...byCount.map(([, e]) => e.trades.length));
    byCount.forEach(([, e]) => (e._pct = Math.round((e.trades.length / maxCount) * 100)));
    document.getElementById("report-most-traded").innerHTML =
      leaderboardRows(byCount, (e) => `${e.trades.length}x`, () => "dim") || `<div class="empty-state small">No data yet.</div>`;

    const byNet = entries.slice().sort((a, b) => b[1].net - a[1].net).slice(0, 5);
    const maxAbsNet = Math.max(1, ...byNet.map(([, e]) => Math.abs(e.net)));
    byNet.forEach(([, e]) => (e._pct = Math.round((Math.abs(e.net) / maxAbsNet) * 100)));
    document.getElementById("report-most-profitable").innerHTML =
      leaderboardRows(byNet, (e) => fmtMoney(e.net), (e) => (e.net >= 0 ? "up" : "down")) || `<div class="empty-state small">No data yet.</div>`;
  }

  // ================================================================
  // REPORTS — sector / country
  // ================================================================
  // sector/country aren't in the documented index schema today (only
  // trade detail files carry symbol_info) -- this reads them from the
  // index row IF the publish step has been extended to copy them over
  // (same pattern as setup_type/lesson_tags), and just shows an empty
  // state otherwise rather than fetching every detail file to fill the
  // gap, which would defeat the whole point of the index existing.
  function groupByField(field) {
    const map = new Map();
    let anyPresent = false;
    trades.forEach((t) => {
      if (!t[field]) return;
      anyPresent = true;
      if (!map.has(t[field])) map.set(t[field], { trades: [], net: 0 });
      const e = map.get(t[field]);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return anyPresent ? map : null;
  }

  function renderBreakdownTable(elId, map, colLabel) {
    const el = document.getElementById(elId);
    if (!map) {
      el.innerHTML = `<div class="empty-state small">No ${escapeHtml(colLabel.toLowerCase())} data on these trades yet.</div>`;
      return;
    }
    const rows = Array.from(map.entries()).sort((a, b) => b[1].net - a[1].net);
    const maxAbs = Math.max(1, ...rows.map(([, e]) => Math.abs(e.net)));
    const html = rows.map(([key, e]) => {
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr>
        <td style="font-weight:600;">${escapeHtml(key)}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    }).join("");
    el.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>${colLabel}</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody>${html}</tbody></table></div>`;
  }

  function renderSectorCountryBreakdown() {
    renderBreakdownTable("report-sector", groupByField("sector"), "Sector");
    renderBreakdownTable("report-country", groupByField("country"), "Country");
  }

  // ================================================================
  // REPORTS — Win vs Loss Days
  // ================================================================
  function dailyAgg() {
    const map = new Map();
    trades.forEach((t) => {
      if (!map.has(t.trade_date)) map.set(t.trade_date, { trades: [], net: 0 });
      const e = map.get(t.trade_date);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return map;
  }

  function dayTableHtml(days) {
    if (!days.length) return `<div class="empty-state small">No data yet.</div>`;
    const rows = days.map((d) => `<tr>
        <td style="font-weight:600;">${d.date}</td>
        <td class="mono dim">${d.count}</td>
        <td class="mono ${d.net >= 0 ? "up" : "down"}">${fmtMoney(d.net)}</td>
      </tr>`).join("");
    return `<div class="table-scroll"><table class="report-table"><thead><tr><th>Date</th><th>Trades</th><th>Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderWinLossDays() {
    const map = dailyAgg();
    const days = Array.from(map.entries()).map(([date, e]) => ({ date, net: e.net, count: e.trades.length }));
    const summaryEl = document.getElementById("wld-summary");
    if (!days.length) {
      summaryEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      document.getElementById("wld-top-win").innerHTML = `<div class="empty-state small">No data yet.</div>`;
      document.getElementById("wld-top-loss").innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    const winDays = days.filter((d) => d.net > 0);
    const lossDays = days.filter((d) => d.net < 0);
    const avg = (arr) => (arr.length ? arr.reduce((s, d) => s + d.net, 0) / arr.length : 0);

    summaryEl.innerHTML = `
      <div class="streak-strip" style="grid-template-columns:repeat(4,1fr);">
        <div class="cell"><div class="label">Winning days</div><div class="value up">${winDays.length} (${((winDays.length / days.length) * 100).toFixed(0)}%)</div></div>
        <div class="cell"><div class="label">Losing days</div><div class="value down">${lossDays.length} (${((lossDays.length / days.length) * 100).toFixed(0)}%)</div></div>
        <div class="cell"><div class="label">Avg win day</div><div class="value up">${fmtMoney(avg(winDays))}</div></div>
        <div class="cell"><div class="label">Avg loss day</div><div class="value down">${fmtMoney(avg(lossDays))}</div></div>
      </div>`;

    document.getElementById("wld-top-win").innerHTML = dayTableHtml(winDays.slice().sort((a, b) => b.net - a.net).slice(0, 8));
    document.getElementById("wld-top-loss").innerHTML = dayTableHtml(lossDays.slice().sort((a, b) => a.net - b.net).slice(0, 8));
  }

  // ================================================================
  // REPORTS — Drawdown
  // ================================================================
  // Walks the equity curve (equity_after, already chronological) tracking
  // the running peak. A drawdown "period" runs from the last new high to
  // the next new high (or to the end of the data if it hasn't recovered).
  function computeDrawdownStats() {
    if (!trades.length) return null;
    let runPeak = trades[0].equity_after;
    let runPeakTrade = trades[0];
    let runTroughTrade = trades[0];
    let inDD = false;
    const periods = [];
    let maxDD = 0, maxDDPeak = trades[0], maxDDTrough = trades[0];

    trades.forEach((t) => {
      if (t.equity_after >= runPeak) {
        if (inDD) {
          periods.push({ peak: runPeakTrade, trough: runTroughTrade, recover: t });
          inDD = false;
        }
        runPeak = t.equity_after;
        runPeakTrade = t;
        runTroughTrade = t;
      } else {
        inDD = true;
        if (t.equity_after < runTroughTrade.equity_after) runTroughTrade = t;
      }
      const dd = t.equity_after - runPeak;
      if (dd < maxDD) { maxDD = dd; maxDDPeak = runPeakTrade; maxDDTrough = t; }
    });
    if (inDD) periods.push({ peak: runPeakTrade, trough: runTroughTrade, recover: null });

    const last = trades[trades.length - 1];
    const currentDD = last.equity_after - runPeak;
    const maxDDPct = maxDDPeak.equity_after !== 0 ? (maxDD / Math.abs(maxDDPeak.equity_after)) * 100 : null;

    periods.forEach((p) => (p.size = p.trough.equity_after - p.peak.equity_after));
    periods.sort((a, b) => a.size - b.size);

    return { maxDD, maxDDPct, maxDDPeak, maxDDTrough, currentDD, periods };
  }

  function renderDrawdown() {
    const d = computeDrawdownStats();
    const summaryEl = document.getElementById("dd-summary");
    const periodsEl = document.getElementById("dd-periods");
    if (!d) {
      summaryEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      periodsEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    summaryEl.innerHTML = `
      <div class="streak-strip" style="grid-template-columns:repeat(3,1fr);">
        <div class="cell"><div class="label">Max drawdown</div><div class="value down">${fmtMoney(d.maxDD)}${d.maxDDPct != null ? ` (${d.maxDDPct.toFixed(1)}%)` : ""}</div></div>
        <div class="cell"><div class="label">Current drawdown</div><div class="value ${d.currentDD < 0 ? "down" : ""}">${d.currentDD < 0 ? fmtMoney(d.currentDD) : "At peak"}</div></div>
        <div class="cell"><div class="label">Drawdown periods</div><div class="value">${d.periods.length}</div></div>
      </div>`;

    if (!d.periods.length) {
      periodsEl.innerHTML = `<div class="empty-state small">No drawdown periods — equity has only made new highs.</div>`;
      return;
    }
    const rows = d.periods.slice(0, 10).map((p) => `<tr>
        <td>${p.peak.trade_date} <span class="dim" style="font-size:11px;">(${fmtMoney(p.peak.equity_after)})</span></td>
        <td>${p.trough.trade_date} <span class="dim" style="font-size:11px;">(${fmtMoney(p.trough.equity_after)})</span></td>
        <td class="mono down">${fmtMoney(p.size)}</td>
        <td>${p.recover ? p.recover.trade_date : `<span class="dim">Ongoing</span>`}</td>
      </tr>`).join("");
    periodsEl.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th>Peak</th><th>Trough</th><th>Drawdown</th><th>Recovered</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ================================================================
  // REPORTS — Compare periods
  // ================================================================
  function periodStats(startDate, endDate) {
    if (!startDate || !endDate) return null;
    const subset = trades.filter((t) => t.trade_date >= startDate && t.trade_date <= endDate);
    if (!subset.length) return null;
    const wins = subset.filter((t) => t.win);
    const losses = subset.filter((t) => !t.win);
    const net = subset.reduce((s, t) => s + t.pnl_after_comm, 0);
    const winRate = (wins.length / subset.length) * 100;
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl_after_comm, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_after_comm, 0) / losses.length : 0;
    const grossWinSum = wins.reduce((s, t) => s + t.pnl_after_comm, 0);
    const grossLossSum = Math.abs(losses.reduce((s, t) => s + t.pnl_after_comm, 0));
    const profitFactor = grossLossSum > 0 ? grossWinSum / grossLossSum : (grossWinSum > 0 ? Infinity : 0);
    return { n: subset.length, net, winRate, avgWin, avgLoss, profitFactor };
  }

  function periodStatsHtml(s) {
    if (!s) return `<div class="empty-state small">No trades in this range.</div>`;
    const pf = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);
    const rows = [
      ["Trades", s.n],
      ["Net P&amp;L", `<span class="${s.net >= 0 ? "up" : "down"}">${fmtMoney(s.net)}</span>`],
      ["Win rate", s.winRate.toFixed(0) + "%"],
      ["Avg win", fmtMoney(s.avgWin)],
      ["Avg loss", fmtMoney(s.avgLoss)],
      ["Profit factor", pf],
    ];
    return `<div class="kv-list">${rows.map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>`;
  }

  function updateCompare() {
    const aEl = document.getElementById("compare-a");
    const bEl = document.getElementById("compare-b");
    if (!aEl || !bEl) return;
    const aS = document.getElementById("cmp-a-start").value, aE = document.getElementById("cmp-a-end").value;
    const bS = document.getElementById("cmp-b-start").value, bE = document.getElementById("cmp-b-end").value;
    aEl.innerHTML = periodStatsHtml(periodStats(aS, aE));
    bEl.innerHTML = periodStatsHtml(periodStats(bS, bE));
  }

  function renderCompare() {
    if (!trades.length) { updateCompare(); return; }
    const aStartEl = document.getElementById("cmp-a-start");
    // Only seed defaults once — don't clobber a range the person already picked.
    if (aStartEl && !aStartEl.value) {
      const first = trades[0].trade_date, last = trades[trades.length - 1].trade_date;
      const midDate = trades[Math.floor(trades.length / 2)].trade_date;
      aStartEl.value = first;
      document.getElementById("cmp-a-end").value = midDate;
      document.getElementById("cmp-b-start").value = midDate;
      document.getElementById("cmp-b-end").value = last;
    }
    updateCompare();
  }

  // ================================================================
  // REPORTS — Tag breakdown
  // ================================================================
  function groupByTagArray(field) {
    const map = new Map();
    let any = false;
    trades.forEach((t) => {
      const tags = t[field];
      if (!tags || !tags.length) return;
      any = true;
      tags.forEach((tag) => {
        if (!map.has(tag)) map.set(tag, { trades: [], net: 0 });
        const e = map.get(tag);
        e.trades.push(t);
        e.net += t.pnl_after_comm;
      });
    });
    return any ? map : null;
  }

  function renderTagBreakdown() {
    renderBreakdownTable("tagb-setup", groupByField("setup_type"), "Setup");
    renderBreakdownTable("tagb-lessons", groupByTagArray("lesson_tags"), "Lesson tag");
  }

  // ================================================================
  // REPORTS — Advanced
  // ================================================================
  function computeAdvancedStats() {
    if (!trades.length) return null;
    const s = computeStats();
    const n = trades.length;
    const commPctOfGross = s.grossPnl !== 0 ? (s.totalComm / Math.abs(s.grossPnl)) * 100 : null;
    const tradesPerDay = s.dayCount ? n / s.dayCount : null;

    const dayVals = Array.from(dailyAgg().values()).map((e) => e.net);
    const dayMean = dayVals.reduce((a, b) => a + b, 0) / dayVals.length;
    const daySd = stdev(dayVals);
    const dailySharpe = daySd ? dayMean / daySd : null;

    let curSign = 0, curStreakSum = 0, bestWinStreakSum = 0, worstLossStreakSum = 0;
    trades.forEach((t) => {
      const sign = t.pnl_after_comm >= 0 ? 1 : -1;
      if (sign === curSign) curStreakSum += t.pnl_after_comm;
      else { curSign = sign; curStreakSum = t.pnl_after_comm; }
      if (curSign === 1) bestWinStreakSum = Math.max(bestWinStreakSum, curStreakSum);
      else worstLossStreakSum = Math.min(worstLossStreakSum, curStreakSum);
    });

    const allHold = trades.map(durationMinutes).filter((v) => v != null);
    const avgHoldAll = allHold.length ? allHold.reduce((a, b) => a + b, 0) / allHold.length : null;

    return { commPctOfGross, tradesPerDay, dailySharpe, bestWinStreakSum, worstLossStreakSum, avgHoldAll };
  }

  function renderAdvanced() {
    const d = computeAdvancedStats();
    const el = document.getElementById("advanced-grid");
    if (!d) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const rows = [
      ["Commissions as % of Gross P&amp;L", d.commPctOfGross != null ? `<span class="v mono">${d.commPctOfGross.toFixed(1)}%</span>` : naCell("No gross P&L to compare against.")],
      ["Avg Trades per Trading Day", d.tradesPerDay != null ? `<span class="v mono">${d.tradesPerDay.toFixed(1)}</span>` : naCell("No trading days recorded.")],
      ["Daily Sharpe (un-annualized)", d.dailySharpe != null ? `<span class="v mono" title="Mean divided by standard deviation of daily net P&amp;L — not annualized, not risk-free-rate adjusted.">${d.dailySharpe.toFixed(2)}</span>` : naCell("Not enough trading days yet.")],
      ["Best Win Streak ($)", `<span class="v up mono">${fmtMoney(d.bestWinStreakSum)}</span>`],
      ["Worst Loss Streak ($)", `<span class="v down mono">${fmtMoney(d.worstLossStreakSum)}</span>`],
      ["Average Hold Time (all trades)", `<span class="v mono">${fmtDuration(d.avgHoldAll)}</span>`],
    ];
    el.innerHTML = rows.map(([k, v]) => `<div class="stat-line"><span class="k">${k}</span>${v}</div>`).join("");
  }

  // ================================================================
  // REPORTS — Detailed stats grid (Tradervue-style "Reports > Detailed")
  // ================================================================
  // Small stats helpers shared by the grid below.
  function stdev(arr) {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }
  // Abramowitz-Stegun erf approximation, used only to turn a t-stat into
  // an approximate two-tailed p-value (normal approximation — fine for the
  // ballpark "how likely is this by chance" figure, not a rigorous test).
  function erf(x) {
    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }
  function normalCdf(z) { return 0.5 * (1 + erf(z / Math.SQRT2)); }

  function fmtDuration(mins) {
    if (mins == null || isNaN(mins)) return "—";
    const total = Math.round(mins);
    const h = Math.floor(total / 60), m = total % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // Regression slope / standard-error-of-slope of the equity curve against
  // trade index — a rough, un-annualized "consistency of the equity curve"
  // figure in the same spirit as a K-Ratio, computed straight off
  // equity_after (nothing else in the schema tracks daily equity).
  function computeKRatio() {
    const y = trades.map((t) => t.equity_after);
    const n = y.length;
    if (n < 3) return null;
    const xMean = (n - 1) / 2;
    const yMean = y.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (i - xMean) * (y[i] - yMean); sxx += (i - xMean) ** 2; }
    if (sxx === 0) return null;
    const slope = sxy / sxx;
    let ssRes = 0;
    for (let i = 0; i < n; i++) { const pred = yMean + slope * (i - xMean); ssRes += (y[i] - pred) ** 2; }
    const df = n - 2;
    if (df <= 0) return null;
    const se = Math.sqrt(ssRes / df);
    const seSlope = se / Math.sqrt(sxx);
    return seSlope === 0 ? null : slope / seSlope;
  }

  function computeDetailedStats() {
    const s = computeStats();
    const n = trades.length;
    const pnls = trades.map((t) => t.pnl_after_comm);
    const largestGain = Math.max(...pnls);
    const largestLoss = Math.min(...pnls);
    const avgDailyGainLoss = s.dayCount ? s.netPnl / s.dayCount : 0;
    const avgTradeGainLoss = n ? s.netPnl / n : 0;

    const perShare = trades.filter((t) => t.shares).map((t) => t.pnl_after_comm / t.shares);
    const avgPerShare = perShare.length ? perShare.reduce((a, b) => a + b, 0) / perShare.length : null;

    const scratch = trades.filter((t) => t.pnl_after_comm === 0);
    const avgOf = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const holdWinAvg = avgOf(s.wins.map(durationMinutes).filter((v) => v != null));
    const holdLossAvg = avgOf(s.losses.map(durationMinutes).filter((v) => v != null));
    const holdScratchAvg = avgOf(scratch.map(durationMinutes).filter((v) => v != null));

    let bestWin = 0, bestLoss = 0, curWin = 0, curLoss = 0;
    trades.forEach((t) => {
      if (t.win) { curWin++; curLoss = 0; bestWin = Math.max(bestWin, curWin); }
      else { curLoss++; curWin = 0; bestLoss = Math.max(bestLoss, curLoss); }
    });

    const sd = stdev(pnls);
    const mean = n ? pnls.reduce((a, b) => a + b, 0) / n : 0;
    const sqn = n && sd ? Math.sqrt(n) * (mean / sd) : null;
    const tstat = n && sd ? mean / (sd / Math.sqrt(n)) : null;
    const pRandom = tstat != null ? 2 * (1 - normalCdf(Math.abs(tstat))) : null;

    const R = s.avgLoss !== 0 ? s.avgWin / Math.abs(s.avgLoss) : null;
    const winFrac = n ? s.wins.length / n : 0;
    const kelly = R ? (winFrac - (1 - winFrac) / R) * 100 : null;

    const kr = computeKRatio();

    return {
      ...s, n, largestGain, largestLoss, avgDailyGainLoss, avgTradeGainLoss, avgPerShare,
      scratchCount: scratch.length, holdWinAvg, holdLossAvg, holdScratchAvg,
      bestWin, bestLoss, sd, sqn, pRandom, kelly, kr,
    };
  }

  function moneyCell(v) {
    return `<span class="v mono ${v >= 0 ? "up" : "down"}">${fmtMoney(v)}</span>`;
  }
  function naCell(title) {
    return `<span class="v na" title="${escapeHtml(title)}">—</span>`;
  }

  function renderDetailedStats() {
    const d = computeDetailedStats();
    const winPct = d.n ? (d.wins.length / d.n) * 100 : 0;
    const lossPct = d.n ? (d.losses.length / d.n) * 100 : 0;

    const rows = [
      ["Total Gain/Loss", moneyCell(d.netPnl)],
      ["Largest Gain", moneyCell(d.largestGain)],
      ["Largest Loss", moneyCell(d.largestLoss)],
      ["Average Daily Gain/Loss", moneyCell(d.avgDailyGainLoss)],
      ["Average Daily Volume", naCell("Needs each symbol's daily market volume flattened onto data/trades.json — not in the schema yet.")],
      ["Average Per-share Gain/Loss", d.avgPerShare != null ? moneyCell(d.avgPerShare) : naCell("No trades with a share count.")],
      ["Average Trade Gain/Loss", moneyCell(d.avgTradeGainLoss)],
      ["Average Winning Trade", moneyCell(d.avgWin)],
      ["Average Losing Trade", moneyCell(d.avgLoss)],
      ["Total Number of Trades", `<span class="v">${d.n}</span>`],
      ["Number of Winning Trades", `<span class="v up">${d.wins.length} (${winPct.toFixed(1)}%)</span>`],
      ["Number of Losing Trades", `<span class="v down">${d.losses.length} (${lossPct.toFixed(1)}%)</span>`],
      ["Average Hold Time (scratch trades)", `<span class="v mono">${fmtDuration(d.holdScratchAvg)}</span>`],
      ["Average Hold Time (winning trades)", `<span class="v mono">${fmtDuration(d.holdWinAvg)}</span>`],
      ["Average Hold Time (losing trades)", `<span class="v mono">${fmtDuration(d.holdLossAvg)}</span>`],
      ["Number of Scratch Trades", `<span class="v">${d.scratchCount}</span>`],
      ["Max Consecutive Wins", `<span class="v up">${d.bestWin}</span>`],
      ["Max Consecutive Losses", `<span class="v down">${d.bestLoss}</span>`],
      ["Trade P&amp;L Standard Deviation", `<span class="v mono">$${d.sd.toFixed(2)}</span>`],
      ["System Quality Number (SQN)", d.sqn != null ? `<span class="v mono" title="PnL-based SQN, not R-multiple-based.">${d.sqn.toFixed(2)}</span>` : naCell("Not enough trades yet.")],
      ["Probability of Random Chance", d.pRandom != null ? `<span class="v mono" title="Approximate — normal-approximation two-tailed p-value.">${(d.pRandom * 100).toFixed(1)}%</span>` : naCell("Not enough trades yet.")],
      ["Kelly Percentage", d.kelly != null ? `<span class="v mono">${d.kelly.toFixed(1)}%</span>` : naCell("Needs both wins and losses to compute.")],
      ["K-Ratio", d.kr != null ? `<span class="v mono" title="Trade-level, un-annualized.">${d.kr.toFixed(2)}</span>` : naCell("Not enough trades yet.")],
      ["Profit Factor", `<span class="v mono">${d.profitFactor === Infinity ? "∞" : d.profitFactor.toFixed(2)}</span>`],
      ["Total Commissions", `<span class="v mono">$${d.totalComm.toFixed(2)}</span>`],
      ["Total Fees", naCell("Only commission is tracked in the current schema — no separate fees field.")],
      ["Average Position MAE", naCell("Needs intrabar adverse-excursion tracking not in the current schema.")],
      ["Average Position MFE", naCell("Needs intrabar favorable-excursion tracking not in the current schema.")],
    ];

    document.getElementById("detailed-stat-grid").innerHTML = rows
      .map(([k, v]) => `<div class="stat-line"><span class="k">${k}</span>${v}</div>`)
      .join("");
  }

  // ---------------------------------------------------------------
  // Shared bucket → report-table renderer for the sub-tabs below.
  // Takes [{label, trades:[...]}] and renders the same money/win%
  // table style as the existing symbol/day-of-week reports.
  // ---------------------------------------------------------------
  function bucketBreakdownTableHtml(buckets, labelHeader) {
    const present = buckets.filter((b) => b.trades.length);
    if (!present.length) return `<div class="empty-state small">No data yet.</div>`;
    const maxAbs = Math.max(1, ...present.map((b) => Math.abs(b.trades.reduce((s, t) => s + t.pnl_after_comm, 0))));
    const rows = present.map((b) => {
      const net = b.trades.reduce((s, t) => s + t.pnl_after_comm, 0);
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (Math.abs(net) / maxAbs) * 100;
      const color = net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr>
        <td style="font-weight:600;">${escapeHtml(b.label)}</td>
        <td class="mono dim">${b.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</span></td>
      </tr>`;
    }).join("");
    return `<div class="table-scroll"><table class="report-table"><thead><tr><th>${escapeHtml(labelHeader)}</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderDetailSubtabs() {
    renderDetailDow();
    renderDetailHour();
    renderDetailPrice();
    renderDetailSize();
    renderDetailSymbolTable();
    renderDetailSide();
    renderDetailSetup();
    renderDetailLessons();
    renderDetailDistribution();
    renderDetailExpectancy();
    renderBreakdownTable("detail-rvol", groupByField("rvol_tag"), "Relative volume");
    renderBreakdownTable("detail-avgvol", groupByField("avg_volume_tag"), "Avg volume");
    renderBreakdownTable("detail-float", groupByField("float_tag"), "Float");
  }

  // ---- Days/Times ----
  function renderDetailDow() {
    const byDow = new Map();
    trades.forEach((t) => {
      const dow = new Date(t.trade_date + "T12:00:00").getDay();
      if (!byDow.has(dow)) byDow.set(dow, { label: DOW[dow], trades: [] });
      byDow.get(dow).trades.push(t);
    });
    const order = [1, 2, 3, 4, 5, 0, 6];
    const buckets = order.filter((d) => byDow.has(d)).map((d) => byDow.get(d));
    document.getElementById("detail-dow").innerHTML = bucketBreakdownTableHtml(buckets, "Day");
  }

  function renderDetailHour() {
    const map = new Map();
    trades.forEach((t) => {
      const label = t.entry_time.slice(0, 2) + ":00";
      if (!map.has(label)) map.set(label, { label, trades: [] });
      map.get(label).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
    document.getElementById("detail-hour").innerHTML = bucketBreakdownTableHtml(buckets, "Hour");
  }

  // ---- Price/Volume ----
  const PRICE_BUCKETS = [
    { label: "< $5", max: 5 }, { label: "$5–20", max: 20 }, { label: "$20–50", max: 50 },
    { label: "$50–100", max: 100 }, { label: "$100–200", max: 200 }, { label: "> $200", max: Infinity },
  ];
  function renderDetailPrice() {
    const buckets = PRICE_BUCKETS.map((b) => ({ ...b, trades: [] }));
    trades.forEach((t) => {
      const bucket = buckets.find((b) => t.entry_price <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    document.getElementById("detail-price").innerHTML = bucketBreakdownTableHtml(buckets, "Entry price");
  }

  const SIZE_BUCKETS = [
    { label: "< 100 sh", max: 100 }, { label: "100–300 sh", max: 300 }, { label: "300–1,000 sh", max: 1000 },
    { label: "1,000–5,000 sh", max: 5000 }, { label: "> 5,000 sh", max: Infinity },
  ];
  function renderDetailSize() {
    const buckets = SIZE_BUCKETS.map((b) => ({ ...b, trades: [] }));
    trades.forEach((t) => {
      const bucket = buckets.find((b) => t.shares <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    document.getElementById("detail-size").innerHTML = bucketBreakdownTableHtml(buckets, "Position size");
  }

  // ---- Instrument ----
  function renderDetailSymbolTable() {
    const map = symbolAgg();
    const buckets = Array.from(map.entries())
      .map(([sym, e]) => ({ label: sym, trades: e.trades }))
      .sort((a, b) => b.trades.length - a.trades.length)
      .slice(0, 10);
    document.getElementById("detail-symbol").innerHTML = bucketBreakdownTableHtml(buckets, "Symbol");
  }

  function renderDetailSide() {
    const map = new Map();
    trades.forEach((t) => {
      const side = t.side || "unknown";
      if (!map.has(side)) map.set(side, { label: side, trades: [] });
      map.get(side).trades.push(t);
    });
    document.getElementById("detail-side").innerHTML = bucketBreakdownTableHtml(Array.from(map.values()), "Side");
  }

  // ---- Market Behavior ----
  function renderDetailSetup() {
    const map = new Map();
    trades.forEach((t) => {
      if (!t.setup_type) return;
      if (!map.has(t.setup_type)) map.set(t.setup_type, { label: t.setup_type, trades: [] });
      map.get(t.setup_type).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => b.trades.length - a.trades.length);
    document.getElementById("detail-setup").innerHTML = bucketBreakdownTableHtml(buckets, "Setup");
  }

  function renderDetailLessons() {
    const counts = new Map();
    trades.forEach((t) => (t.lesson_tags || []).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
    const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const el = document.getElementById("detail-lessons");
    if (!entries.length) { el.innerHTML = `<div class="empty-state small">No lesson tags logged yet.</div>`; return; }
    const maxCount = Math.max(...entries.map(([, c]) => c));
    el.innerHTML = entries.map(([tag, c]) => `
      <div class="bar-row">
        <div class="bar-label">${escapeHtml(tag.replace(/_/g, " "))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${((c / maxCount) * 100).toFixed(0)}%;"></div></div>
        <div class="bar-count">${c}x</div>
      </div>`).join("");
  }

  // ---- Win/Loss/Expectation ----
  const PNL_BUCKETS = [
    { label: "< -$500", neg: true, test: (v) => v < -500 },
    { label: "-$500 to -$200", neg: true, test: (v) => v >= -500 && v < -200 },
    { label: "-$200 to -$50", neg: true, test: (v) => v >= -200 && v < -50 },
    { label: "-$50 to $0", neg: true, test: (v) => v >= -50 && v < 0 },
    { label: "$0 to $50", neg: false, test: (v) => v >= 0 && v < 50 },
    { label: "$50 to $200", neg: false, test: (v) => v >= 50 && v < 200 },
    { label: "$200 to $500", neg: false, test: (v) => v >= 200 && v < 500 },
    { label: "> $500", neg: false, test: (v) => v >= 500 },
  ];
  function renderDetailDistribution() {
    const buckets = PNL_BUCKETS.map((b) => ({ ...b, count: 0 }));
    trades.forEach((t) => {
      const b = buckets.find((b) => b.test(t.pnl_after_comm));
      if (b) b.count++;
    });
    const present = buckets.filter((b) => b.count);
    const el = document.getElementById("detail-distribution");
    if (!present.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const maxCount = Math.max(...present.map((b) => b.count));
    el.innerHTML = present.map((b) => `
      <div class="bar-row">
        <div class="bar-label" style="width:130px;">${b.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${((b.count / maxCount) * 100).toFixed(0)}%;background:${b.neg ? "var(--red)" : "var(--green)"};"></div></div>
        <div class="bar-count">${b.count}x</div>
      </div>`).join("");
  }

  function renderDetailExpectancy() {
    const d = computeDetailedStats();
    const el = document.getElementById("detail-expectancy");
    if (!d.n) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const winRateFrac = d.wins.length / d.n;
    const lossRateFrac = d.losses.length / d.n;
    const expectancy = winRateFrac * d.avgWin + lossRateFrac * d.avgLoss;
    const ratio = d.avgLoss !== 0 ? d.avgWin / Math.abs(d.avgLoss) : null;
    const rows = [
      ["Win rate", (winRateFrac * 100).toFixed(1) + "%"],
      ["Avg win / avg loss ratio", ratio != null ? ratio.toFixed(2) : "—"],
      ["Expectancy per trade", fmtMoney(expectancy)],
      ["Kelly percentage", d.kelly != null ? d.kelly.toFixed(1) + "%" : "—"],
    ];
    el.innerHTML = `<div class="kv-list">${rows.map(([k, v]) => `<div class="kv-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>`;
  }
})();
