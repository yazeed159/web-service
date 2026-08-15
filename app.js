(function () {
  "use strict";

  let trades = [];
  let sortKey = "trade_date";
  let sortDir = -1; // newest first
  let activeFilter = "all";
  let searchTerm = "";

  const tbody = document.getElementById("trade-tbody");
  const statGrid = document.getElementById("stat-grid");
  const tickerTrack = document.getElementById("ticker-track");

  fetch("data/trades.json")
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((data) => {
      trades = data;
      if (!trades.length) {
        tbody.innerHTML = '<tr class="empty-row"><td colspan="7">no trades logged yet — the pipeline will publish here after the first close.</td></tr>';
        statGrid.innerHTML = "";
        return;
      }
      renderStats();
      renderEquity();
      renderTicker();
      renderTable();
    })
    .catch((err) => {
      tbody.innerHTML = `<tr class="empty-row"><td colspan="7">couldn't load data/trades.json (${escapeHtml(String(err.message))}). Make sure you're serving this folder, not opening index.html via file://.</td></tr>`;
      statGrid.innerHTML = "";
    });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtPct(v) {
    const s = (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
    return s;
  }

  // ---------- Stats ----------
  function renderStats() {
    const wins = trades.filter((t) => t.win);
    const losses = trades.filter((t) => !t.win);
    const winRate = (wins.length / trades.length) * 100;
    const totalPnl = trades.reduce((s, t) => s + t.pnl_pct, 0);
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl_pct, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl_pct, 0) / losses.length : 0;
    const best = trades.reduce((a, b) => (b.pnl_pct > a.pnl_pct ? b : a), trades[0]);
    const worst = trades.reduce((a, b) => (b.pnl_pct < a.pnl_pct ? b : a), trades[0]);

    const cards = [
      { label: "trades", value: trades.length, cls: "" },
      { label: "win rate", value: winRate.toFixed(0) + "%", cls: winRate >= 50 ? "up" : "down" },
      { label: "net p&l", value: fmtPct(totalPnl), cls: totalPnl >= 0 ? "up" : "down" },
      { label: "avg win", value: fmtPct(avgWin), cls: "up" },
      { label: "avg loss", value: fmtPct(avgLoss), cls: "down" },
      { label: "best trade", value: `${best.symbol} ${fmtPct(best.pnl_pct)}`, cls: "up" },
      { label: "worst trade", value: `${worst.symbol} ${fmtPct(worst.pnl_pct)}`, cls: "down" },
    ];

    statGrid.innerHTML = cards
      .map(
        (c) => `<div class="stat"><div class="label">${c.label}</div><div class="value ${c.cls}">${c.value}</div></div>`
      )
      .join("");

    animateNumbers();
  }

  function animateNumbers() {
    document.querySelectorAll(".stat .value").forEach((el) => {
      el.style.opacity = 0;
      el.style.transform = "translateY(4px)";
      el.style.transition = "opacity .4s ease, transform .4s ease";
      requestAnimationFrame(() => {
        setTimeout(() => {
          el.style.opacity = 1;
          el.style.transform = "translateY(0)";
        }, 30);
      });
    });
  }

  // ---------- Equity curve ----------
  function renderEquity() {
    const ordered = [...trades].sort((a, b) => (a.trade_date + a.entry_time).localeCompare(b.trade_date + b.entry_time));
    const points = [{ e: 0 }, ...ordered.map((t) => ({ e: t.equity_after, sym: t.symbol, d: t.trade_date }))];
    const values = points.map((p) => p.e);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const range = max - min || 1;
    const W = 1000, H = 130, PAD = 6;

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
      <path d="${fillD}" class="equity-fill" fill="${finalPositive ? "url(#gGreen)" : "url(#gRed)"}" />
      <path d="${pathD}" class="equity-path ${finalPositive ? "" : "neg"}" />
      <defs>
        <linearGradient id="gGreen" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#33e08a" stop-opacity="0.28" />
          <stop offset="100%" stop-color="#33e08a" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="gRed" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff5f5f" stop-opacity="0.24" />
          <stop offset="100%" stop-color="#ff5f5f" stop-opacity="0" />
        </linearGradient>
      </defs>
    `;

    const rangeLabel = document.getElementById("equity-range");
    if (ordered.length) {
      rangeLabel.textContent = `${ordered[0].trade_date} → ${ordered[ordered.length - 1].trade_date}`;
    }
  }

  // ---------- Ticker ----------
  function renderTicker() {
    const items = trades
      .slice()
      .reverse()
      .map(
        (t) =>
          `<span class="ticker-item"><span class="sym">${t.symbol}</span> ${fmtPct(t.pnl_pct)}</span>`
      )
      .join("");
    // duplicate content so the scroll loop (-50%) is seamless
    tickerTrack.innerHTML = items + items;
  }

  // ---------- Table ----------
  function getFiltered() {
    let list = trades;
    if (activeFilter === "win") list = list.filter((t) => t.win);
    if (activeFilter === "loss") list = list.filter((t) => !t.win);
    if (searchTerm) list = list.filter((t) => t.symbol.toLowerCase().includes(searchTerm));
    return list;
  }

  function renderTable() {
    let list = getFiltered();
    list = [...list].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (typeof av === "string") return av.localeCompare(bv) * sortDir;
      return (av - bv) * sortDir;
    });

    if (!list.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">no trades match — try clearing the search or filter.</td></tr>';
      return;
    }

    tbody.innerHTML = list
      .map((t) => {
        const dotColor = t.win ? "var(--green)" : "var(--red)";
        return `
        <tr data-id="${t.id}">
          <td class="mono">${t.trade_date}</td>
          <td class="sym"><span class="side-dot" style="background:${dotColor}"></span>${t.symbol}</td>
          <td class="mono dim">${t.entry_time}</td>
          <td class="mono dim">${t.exit_time}</td>
          <td class="mono">$${t.entry_price.toFixed(2)}</td>
          <td class="mono">$${t.exit_price.toFixed(2)}</td>
          <td><span class="pnl-tag ${t.win ? "up" : "down"}">${fmtPct(t.pnl_pct)}</span></td>
        </tr>`;
      })
      .join("");

    tbody.querySelectorAll("tr[data-id]").forEach((row) => {
      row.addEventListener("click", () => {
        window.location.href = `trade.html?id=${encodeURIComponent(row.dataset.id)}`;
      });
    });

    updateSortIndicators();
  }

  function updateSortIndicators() {
    document.querySelectorAll("#trade-table thead th").forEach((th) => {
      th.classList.remove("sorted");
      const arrow = th.querySelector(".arrow");
      if (arrow) arrow.textContent = "";
      if (th.dataset.key === sortKey) {
        th.classList.add("sorted");
        if (arrow) arrow.textContent = sortDir === 1 ? "↑" : "↓";
      }
    });
  }

  document.querySelectorAll("#trade-table thead th").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sortKey === key) {
        sortDir *= -1;
      } else {
        sortKey = key;
        sortDir = key === "trade_date" || key === "entry_time" || key === "exit_time" ? -1 : -1;
      }
      renderTable();
    });
  });

  document.querySelectorAll(".filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.filter;
      renderTable();
    });
  });

  const searchInput = document.getElementById("search");
  searchInput.addEventListener("input", (e) => {
    searchTerm = e.target.value.trim().toLowerCase();
    renderTable();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== searchInput) {
      e.preventDefault();
      searchInput.focus();
    }
  });

  // ---------- Clock / session status ----------
  function tickClock() {
    const now = new Date();
    const et = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(now);
    document.getElementById("clock").textContent = et + " ET";

    const etParts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    }).formatToParts(now);
    const map = {};
    etParts.forEach((p) => (map[p.type] = p.value));
    const mins = parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10);
    const isWeekday = !["Sat", "Sun"].includes(map.weekday);
    const open = isWeekday && mins >= 570 && mins < 960; // 9:30–16:00 ET
    const statusEl = document.getElementById("session-status");
    statusEl.textContent = open ? "MARKET OPEN" : "MARKET CLOSED";
    statusEl.style.color = open ? "var(--green)" : "var(--text-dim)";
  }
  tickClock();
  setInterval(tickClock, 1000);
})();
