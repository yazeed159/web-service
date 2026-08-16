(function () {
  "use strict";

  let trades = [];
  let activeFilter = "all";
  let searchTerm = "";

  const statGrid = document.getElementById("stat-grid");
  const dayGroups = document.getElementById("day-groups");

  fetch("data/trades.json")
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((data) => {
      trades = data;
      if (!trades.length) {
        dayGroups.innerHTML = '<div class="empty-state">No trades logged yet — the pipeline will publish here after the first close.</div>';
        statGrid.innerHTML = "";
        return;
      }
      document.getElementById("last-updated").textContent =
        "Through " + trades[trades.length - 1].trade_date;
      renderStats();
      renderEquity();
      renderGroups();
    })
    .catch((err) => {
      dayGroups.innerHTML = `<div class="empty-state">Couldn't load data/trades.json (${escapeHtml(String(err.message))}). Make sure you're serving this folder, not opening index.html via file://.</div>`;
      statGrid.innerHTML = "";
    });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMoney(v) {
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toFixed(2);
  }

  // ---------- Stats ----------
  function renderStats() {
    const wins = trades.filter((t) => t.win);
    const losses = trades.filter((t) => !t.win);
    const winRate = (wins.length / trades.length) * 100;
    const grossPnl = trades.reduce((s, t) => s + t.pnl_before_comm, 0);
    const totalComm = trades.reduce((s, t) => s + t.commission, 0);
    const netPnl = trades.reduce((s, t) => s + t.pnl_after_comm, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl_after_comm, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_after_comm, 0) / losses.length : 0;
    const best = trades.reduce((a, b) => (b.pnl_after_comm > a.pnl_after_comm ? b : a), trades[0]);

    const cards = [
      { label: "Trades", value: trades.length, cls: "" },
      { label: "Win rate", value: winRate.toFixed(0) + "%", cls: winRate >= 50 ? "up" : "down" },
      { label: "Gross P&L", value: fmtMoney(grossPnl), cls: grossPnl >= 0 ? "up" : "down", sub: "before commission" },
      { label: "Commission paid", value: "$" + totalComm.toFixed(2), cls: "" },
      { label: "Net P&L", value: fmtMoney(netPnl), cls: netPnl >= 0 ? "up" : "down", sub: "after commission" },
      { label: "Avg win", value: fmtMoney(avgWin), cls: "up" },
      { label: "Avg loss", value: fmtMoney(avgLoss), cls: "down" },
      { label: "Best trade", value: `${best.symbol} ${fmtMoney(best.pnl_after_comm)}`, cls: "up" },
    ];

    statGrid.innerHTML = cards
      .map(
        (c) => `<div class="stat"><div class="label">${c.label}</div><div class="value ${c.cls}">${c.value}</div>${c.sub ? `<div class="sub-value">${c.sub}</div>` : ""}</div>`
      )
      .join("");
  }

  // ---------- Equity curve ----------
  function renderEquity() {
    const ordered = [...trades].sort((a, b) => (a.trade_date + a.entry_time).localeCompare(b.trade_date + b.entry_time));
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

  // ---------- Day-grouped trade list ----------
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

    dayGroups.querySelectorAll("tr[data-id]").forEach((row) => {
      row.addEventListener("click", () => {
        window.location.href = `trade.html?id=${encodeURIComponent(row.dataset.id)}`;
      });
    });
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
})();
