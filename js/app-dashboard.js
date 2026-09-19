(function () {
  "use strict";

  // Dashboard tab of index.html. Split out of the old app.js -- see the
  // big comment at the top of app-shared.js (loaded right before this
  // file on every navigation here) for how these files fit together.
  // Reads/writes shared trade data via `App.state`; registers its render
  // entry points on `App.tabs.dashboard` so app-shared.js's fetch-then-
  // render pass can call them once data loads.

  const statGrid = document.getElementById("stat-grid");

  // Same formatting, minus the leading "+" -- for an actual balance
  // (equity curve's running total/tooltip), not a gain/loss delta. A
  // "+" there misleadingly reads as extra cash on top of the balance.
  function fmtBalance(v) {
    return (v < 0 ? "-" : "") + "$" + Math.abs(v).toFixed(2);
  }
  // Splits the chronological trade list into two equal, back-to-back
  // windows -- "recent" (the last N trades) and "prior" (the N before
  // that) -- so dashboard cards can show real vs-last-period movement
  // instead of a single flat number. Returns null when there isn't
  // enough history (fewer than 4 trades) for the comparison to mean
  // anything; callers render without a delta in that case.
  function tradeWindows() {
    const n = Math.min(10, Math.floor(App.state.trades.length / 2));
    if (n < 2) return null;
    const recent = App.state.trades.slice(-n);
    const prior = App.state.trades.slice(-2 * n, -n);
    if (prior.length < 2) return null;
    return { recent: App.computeStats(recent), prior: App.computeStats(prior), n };
  }
  // Current streak of same-outcome trades counting back from the most
  // recent one -- e.g. 3 straight wins. Returns {count, win} or null
  // if there's no trade history yet.
  function currentStreak() {
    if (!App.state.trades.length) return null;
    const last = App.state.trades[App.state.trades.length - 1];
    let count = 0;
    for (let i = App.state.trades.length - 1; i >= 0; i--) {
      if (App.state.trades[i].win !== last.win) break;
      count++;
    }
    return { count, win: last.win };
  }
  // Formats a before/after difference as a small colored chip. Every
  // metric this is used on (net P&L, win %, profit factor, avg win,
  // avg loss) is "higher is better" -- including avg loss, since a
  // less-negative average (e.g. -$30 vs -$50) is a diff of +$20 and a
  // real improvement -- so a single up-is-green rule covers all of
  // them with no special-casing. Returns "" when there's nothing
  // meaningful to compare (no prior window, or either side is
  // infinite, as profit factor can be).
  function deltaChip(curr, prev, fmt) {
    if (prev === null || prev === undefined || !isFinite(curr) || !isFinite(prev)) return "";
    const diff = curr - prev;
    fmt = fmt || ((d) => (d >= 0 ? "+" : "") + d.toFixed(1));
    if (Math.abs(diff) < 0.05) return `<span class="kpi-delta flat">flat</span>`;
    const up = diff > 0;
    return `<span class="kpi-delta ${up ? "up" : "down"}">${up ? "\u25B2" : "\u25BC"} ${fmt(diff)}</span>`;
  }
  // Small bar sparkline of the last few trades' net P&L, baseline at
  // zero -- the "recent form" visual in the dashboard hero. Purely a
  // reading of real trade values, not a fabricated trend line.
  function svgTradeSparkline(list, opts) {
    opts = opts || {};
    const w = opts.width || 220, h = opts.height || 48;
    if (!list.length) return `<svg viewBox="0 0 ${w} ${h}"></svg>`;
    const maxAbs = Math.max(1, ...list.map((t) => Math.abs(t.pnl_after_comm)));
    const gap = 3;
    const barW = (w - gap * (list.length - 1)) / list.length;
    const midY = h / 2;
    const bars = list.map((t, i) => {
      const barH = Math.max(2, (Math.abs(t.pnl_after_comm) / maxAbs) * (h / 2 - 3));
      const x = i * (barW + gap);
      const y = t.win ? midY - barH : midY;
      const color = t.win ? "var(--green)" : "var(--red)";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5" fill="${color}" opacity="${0.55 + 0.45 * (i / Math.max(1, list.length - 1))}"/>`;
    }).join("");
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" style="display:block; overflow:visible;">
      <line x1="0" y1="${midY}" x2="${w}" y2="${midY}" stroke="var(--border)" stroke-width="1"/>
      ${bars}
    </svg>`;
  }
  const KPI_ICONS = {
    target: '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"></circle>',
    scale: '<path d="M12 3v18"></path><path d="M5 8l-3 6a3.5 3.5 0 0 0 7 0z"></path><path d="M19 8l-3 6a3.5 3.5 0 0 0 7 0z"></path><path d="M5 8h14"></path><path d="M9 21h6"></path>',
    calendarCheck: '<rect x="3" y="4.5" width="18" height="16" rx="2"></rect><line x1="3" y1="9.5" x2="21" y2="9.5"></line><path d="M8 14l2.5 2.5L16 11"></path>',
    trendUp: '<polyline points="3 17 9 11 13 15 21 6"></polyline><polyline points="15 6 21 6 21 12"></polyline>',
    trendDown: '<polyline points="3 7 9 13 13 9 21 18"></polyline><polyline points="21 12 21 18 15 18"></polyline>',
  };
  function kpiIcon(name) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${KPI_ICONS[name]}</svg>`;
  }
  function renderStats() {
    const s = App.computeStats();
    const w = tradeWindows();
    const pfDisplay = s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2);
    const streak = currentStreak();

    // ---------- Hero: the one number that matters most, up top ----------
    const heroEl = document.getElementById("dash-hero");
    if (heroEl) {
      const heroDelta = w ? deltaChip(w.recent.netPnl, w.prior.netPnl, fmtMoney) : "";
      const sparkTrades = App.state.trades.slice(-14);
      const streakChip = streak && streak.count >= 2
        ? `<span class="hero-streak ${streak.win ? "up" : "down"}">${streak.count} ${streak.win ? "win" : "loss"} streak</span>`
        : "";
      heroEl.innerHTML = `
        <div class="hero-main">
          <div class="hero-label">Net P&amp;L <span class="dim" style="font-weight:500; text-transform:none; letter-spacing:0;">· all time</span></div>
          <div class="hero-value ${s.netPnl >= 0 ? "up" : "down"}">${fmtMoney(s.netPnl)}</div>
          <div class="hero-meta">
            ${heroDelta ? `${heroDelta}<span class="dim" style="font-size:11.5px;">vs prior ${w.n} trades</span>` : ""}
            ${streakChip}
          </div>
          <div class="hero-sub">gross ${fmtMoney(s.grossPnl)} · comm $${s.totalComm.toFixed(2)} · ${s.count} trades</div>
        </div>
        <div class="hero-spark">
          <div class="hero-spark-label">Last ${sparkTrades.length} trades</div>
          ${svgTradeSparkline(sparkTrades)}
        </div>
      `;
    }

    // ---------- Supporting KPI cards ----------
    const cards = [
      { label: "Trade win %", value: s.winRate.toFixed(0) + "%", cls: s.winRate >= 50 ? "up" : "down", sub: `${App.state.trades.length} trades`, icon: "target",
        delta: w ? deltaChip(w.recent.winRate, w.prior.winRate, (d) => (d >= 0 ? "+" : "") + d.toFixed(0) + "pt") : "" },
      { label: "Profit factor", value: pfDisplay, cls: s.profitFactor >= 1 ? "up" : "down", sub: s.profitFactor >= 1 ? "profitable" : "below 1.0", icon: "scale",
        delta: w ? deltaChip(w.recent.profitFactor, w.prior.profitFactor, (d) => (d >= 0 ? "+" : "") + d.toFixed(2)) : "" },
      { label: "Day win %", value: s.dayWinRate.toFixed(0) + "%", cls: s.dayWinRate >= 50 ? "up" : "down", sub: `${s.dayCount} trading days`, icon: "calendarCheck",
        delta: w ? deltaChip(w.recent.dayWinRate, w.prior.dayWinRate, (d) => (d >= 0 ? "+" : "") + d.toFixed(0) + "pt") : "" },
      { label: "Avg win", value: fmtMoney(s.avgWin), cls: "up", sub: `${s.wins.length} wins`, icon: "trendUp",
        delta: w ? deltaChip(w.recent.avgWin, w.prior.avgWin, fmtMoney) : "" },
      { label: "Avg loss", value: fmtMoney(s.avgLoss), cls: "down", sub: `${s.losses.length} losses`, icon: "trendDown",
        delta: w ? deltaChip(w.recent.avgLoss, w.prior.avgLoss, fmtMoney) : "" },
    ];

    statGrid.innerHTML = cards
      .map(
        (c) => `<div class="stat kpi-card">
          <div class="label-row"><span class="kpi-icon">${kpiIcon(c.icon)}</span><span class="label">${c.label}</span></div>
          <div class="value ${c.cls}">${c.value}</div>
          <div class="kpi-foot">
            ${c.delta}
            ${c.sub ? `<span class="sub-value">${c.sub}</span>` : ""}
          </div>
        </div>`
      )
      .join("");
  }
  function renderScore() {
    const s = App.computeStats();
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

    const extraEl = document.getElementById("score-month-extra");
    if (extraEl && App.state.calYear !== null && App.state.calMonth !== null) {
      const extra = monthDayExtremes(App.state.calYear, App.state.calMonth);
      if (!extra) {
        extraEl.innerHTML = `<div class="score-day-extremes empty">No trades logged yet in ${App.MONTHS[App.state.calMonth]}.</div>`;
      } else if (extra.best.key === extra.worst.key) {
        extraEl.innerHTML = `
          <div class="sde-head">Only trading day this month</div>
          <div class="score-day-extremes single">
            <div class="sde-cell ${extra.best.net >= 0 ? "up" : "down"}">
              <span class="sde-label">${fmtDayShort(extra.best.key)}</span>
              <span class="sde-pnl">${fmtMoney(extra.best.net)}</span>
              <span class="sde-sub">${extra.best.count} trade${extra.best.count === 1 ? "" : "s"}</span>
            </div>
          </div>`;
      } else {
        extraEl.innerHTML = `
          <div class="sde-head">Best &amp; worst day — ${App.MONTHS[App.state.calMonth]}</div>
          <div class="score-day-extremes">
            <div class="sde-cell up">
              <span class="sde-label">Best</span>
              <span class="sde-date">${fmtDayShort(extra.best.key)}</span>
              <span class="sde-pnl">${fmtMoney(extra.best.net)}</span>
            </div>
            <div class="sde-cell down">
              <span class="sde-label">Worst</span>
              <span class="sde-date">${fmtDayShort(extra.worst.key)}</span>
              <span class="sde-pnl">${fmtMoney(extra.worst.net)}</span>
            </div>
          </div>`;
      }
    }
  }
  function scoreRow(label, pct, display) {
    const color = pct >= 70 ? "var(--green)" : pct >= 40 ? "var(--amber)" : "var(--red)";
    return `<div class="score-row">
      <span class="k">${label}</span>
      <span class="track"><span class="fill" style="width:${Math.max(4, pct).toFixed(0)}%; background:${color}"></span></span>
      <span class="v">${display}</span>
    </div>`;
  }
  function renderMiniCal() {
    const y = App.state.calYear, m = App.state.calMonth;
    document.getElementById("mini-cal-label").textContent = `${App.MONTHS[m]} ${y}`;
    document.getElementById("mini-cal").innerHTML = App.buildMonthGridHtml(y, m, { clickable: false, compact: true });
  }
  // Best/worst single trading day for the given month, by net P&L. Lives
  // under Trader score so that panel has something worth showing beside
  // the mini calendar instead of empty space, and it's a natural
  // companion to that calendar rather than a repeat of the win-rate /
  // profit-factor rows above it. Returns null if no trades that month.
  function monthDayExtremes(y, m) {
    const map = App.pnlByDay();
    let best = null, worst = null;
    map.forEach((entry, key) => {
      const d = new Date(key + "T12:00:00");
      if (d.getFullYear() !== y || d.getMonth() !== m) return;
      if (!best || entry.net > best.net) best = { key, net: entry.net, count: entry.count };
      if (!worst || entry.net < worst.net) worst = { key, net: entry.net, count: entry.count };
    });
    return best ? { best, worst } : null;
  }
  function fmtDayShort(key) {
    return new Date(key + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  //
  // `_balance` is starting-capital-from-Settings + cumulative P&L (see
  // computeAccountBalances in auth.js). If the person has never logged
  // anything in Settings' capital ledger, starting capital is 0, so this
  // curve is really just cumulative P&L -- often a small, unremarkable
  // number that looks nothing like an actual account balance. Labeling
  // that "account balance" regardless made the whole panel read as
  // broken ("no numbers, just a decline"), so the label and a hint
  // below the chart now say plainly which figure is being shown.
  //
  // Interactive: hovering traces a crosshair + tooltip showing the
  // balance and (for real trade points) that trade's symbol/P&L, and
  // clicking a trade point opens it on trade.html. `equityState` holds
  // the latest geometry so the pointer handlers (bound once, below)
  // always read current data without re-binding on every render.
  let equityState = null;
  let equityBound = false;
  let equityRange = "all"; // "30" | "90" | "all" -- see bindEquityRangeToggle
  // Trailing-N-calendar-day slice of `trades`, anchored to the most
  // recent logged trade (not wall-clock "today", since the data itself
  // may be historical) -- so the 30D/90D toggle means "last N days of
  // this journal" consistently no matter when it's viewed.
  function equityRangeSubset() {
    if (equityRange === "all" || !App.state.trades.length) return App.state.trades;
    const days = parseInt(equityRange, 10);
    const anchor = new Date(App.state.trades[App.state.trades.length - 1].trade_date + "T12:00:00");
    const cutoff = new Date(anchor);
    cutoff.setDate(cutoff.getDate() - days);
    const subset = App.state.trades.filter((t) => new Date(t.trade_date + "T12:00:00") >= cutoff);
    return subset.length ? subset : App.state.trades;
  }
  // Splits a polyline into pieces that never cross the threshold line --
  // used so the equity curve can color each stretch by whether IT sits
  // above/below the starting balance, instead of painting the whole
  // curve by only its final value. Every (x1,y1)-(x2,y2) pair from
  // `coords` is classified by the sign of its two `values` relative to
  // thresholdValue; a pair that actually crosses gets split at the
  // interpolated crossing point (thresholdY) so the color switches
  // exactly where the balance does, not at the nearest sampled point.
  function splitSignedSegments(coords, values, thresholdY, thresholdValue) {
    const segs = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const [x1, y1] = coords[i], [x2, y2] = coords[i + 1];
      const v1 = values[i], v2 = values[i + 1];
      const pos1 = v1 >= thresholdValue, pos2 = v2 >= thresholdValue;
      if (pos1 === pos2) {
        segs.push({ x1, y1, x2, y2, positive: pos1 });
      } else {
        const t = (thresholdValue - v1) / (v2 - v1);
        const xm = x1 + (x2 - x1) * t;
        segs.push({ x1, y1, x2: xm, y2: thresholdY, positive: pos1 });
        segs.push({ x1: xm, y1: thresholdY, x2, y2, positive: pos2 });
      }
    }
    return segs;
  }
  function bindEquityRangeToggle() {
    const wrap = document.getElementById("eq-range-toggle");
    if (!wrap || wrap.dataset.bound) return;
    wrap.dataset.bound = "1";
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn) return;
      equityRange = btn.dataset.range;
      wrap.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      renderEquity();
    }, { signal: App.signal });
  }
  function renderEquity() {
    bindEquityRangeToggle();
    const ordered = equityRangeSubset();
    // Origin point is the real balance *before* the first trade (starting
    // capital from the Settings ledger, or 0 if nothing's been added there
    // -- same as before this existed). Everything else plots `_balance`.
    const startBalance = ordered.length ? ordered[0]._balance - (ordered[0].pnl_after_comm || 0) : 0;
    const points = [
      { e: startBalance, t: null },
      ...ordered.map((t) => ({ e: t._balance, t })),
    ];
    const values = points.map((p) => p.e);
    const min = Math.min(startBalance, ...values);
    const max = Math.max(startBalance, ...values);
    const range = max - min || 1;
    const W = 1000, H = 140, PAD = 8;

    const coords = points.map((p, i) => {
      const x = points.length > 1 ? (i / (points.length - 1)) * W : 0;
      const y = H - PAD - ((p.e - min) / range) * (H - PAD * 2);
      return [x, y];
    });

    const zeroY = H - PAD - ((startBalance - min) / range) * (H - PAD * 2);

    // Drawdown shading (Edgewonk-style): a running "peak so far" line
    // tracks the account's high-water mark, and the band between that
    // line and the actual curve is shaded whenever the curve sits below
    // it -- i.e. "currently underwater by this much". The band's height
    // is literally the live drawdown, so it collapses to nothing at
    // every new high and widens through a slump, without needing a
    // separate drawdown stat to explain it. allTimeHighY draws a thin
    // dashed reference line at the single highest balance ever reached
    // in this range, so a partial recovery still shows how far there is
    // left to go back to even.
    let runningPeak = -Infinity;
    const peakCoords = coords.map((c, i) => {
      runningPeak = Math.max(runningPeak, values[i]);
      const y = H - PAD - ((runningPeak - min) / range) * (H - PAD * 2);
      return [c[0], y];
    });
    const ddPathD =
      coords.map((c, i) => (i === 0 ? "M" : "L") + c[0].toFixed(1) + "," + c[1].toFixed(1)).join(" ") +
      " " +
      peakCoords.slice().reverse().map((p) => "L" + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ") +
      " Z";
    const allTimeHighY = Math.min(...peakCoords.map((c) => c[1]));

    const finalPositive = values[values.length - 1] >= startBalance;
    const segs = coords.length > 1 ? splitSignedSegments(coords, values, zeroY, startBalance) : [];
    const fmt1 = (n) => n.toFixed(1);
    const strokeMarkup = segs.length
      ? segs.map((s) => `<path d="M${fmt1(s.x1)},${fmt1(s.y1)} L${fmt1(s.x2)},${fmt1(s.y2)}" class="equity-path ${s.positive ? "" : "neg"}" />`).join("")
      : `<path d="M${fmt1(coords[0][0])},${fmt1(coords[0][1])} L${fmt1(coords[0][0])},${fmt1(coords[0][1])}" class="equity-path ${finalPositive ? "" : "neg"}" />`;
    const fillMarkup = segs.map((s) => `<path d="M${fmt1(s.x1)},${fmt1(s.y1)} L${fmt1(s.x2)},${fmt1(s.y2)} L${fmt1(s.x2)},${fmt1(zeroY)} L${fmt1(s.x1)},${fmt1(zeroY)} Z" fill="${s.positive ? "url(#gGreen)" : "url(#gRed)"}" />`).join("");
    const svg = document.getElementById("equity-svg");
    svg.innerHTML = `
      <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" class="equity-zero" />
      <line x1="0" y1="${allTimeHighY.toFixed(1)}" x2="${W}" y2="${allTimeHighY.toFixed(1)}" class="equity-ath" />
      ${fillMarkup}
      <path d="${ddPathD}" class="equity-drawdown" />
      ${strokeMarkup}
      <circle id="equity-hover-dot" r="4" fill="var(--panel)" stroke="${finalPositive ? "var(--green)" : "var(--red)"}" stroke-width="2" style="display:none;" />
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
    document.getElementById("equity-total").textContent = fmtBalance(values[values.length - 1]);
    document.getElementById("equity-total").className = "value mono " + (values[values.length - 1] >= 0 ? "up" : "down");

    const labelEl = document.getElementById("equity-label");
    const hintEl = document.getElementById("equity-hint");
    if (labelEl) labelEl.textContent = App.state.hasCapitalLedger ? "Equity curve — account balance" : "Equity curve — cumulative P&L";
    if (hintEl) {
      hintEl.innerHTML = App.state.hasCapitalLedger
        ? ""
        : 'Add your starting capital in <a href="settings.html">Settings</a> to see your real account balance here instead of just cumulative P&amp;L.';
    }

    equityState = { points, coords, values, startBalance, W, H };
    renderEquityStats(points, values);
    bindEquityInteractivity();
  }
  // Peak-to-trough max drawdown over the plotted balance series, plus
  // best/worst single trade by P&L -- three figures the old static
  // chart never surfaced anywhere on the dashboard.
  function renderEquityStats(points, values) {
    const statsEl = document.getElementById("equity-stats");
    if (!statsEl) return;
    if (points.length < 2) { statsEl.innerHTML = ""; return; }

    let peak = values[0], peakIdx = 0, maxDD = 0, maxDDPct = 0, ddPeakIdx = 0, ddTroughIdx = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i] > peak) { peak = values[i]; peakIdx = i; }
      const dd = peak - values[i];
      if (dd > maxDD) {
        maxDD = dd;
        maxDDPct = peak !== 0 ? (dd / Math.abs(peak)) * 100 : 0;
        ddPeakIdx = peakIdx;
        ddTroughIdx = i;
      }
    }

    const tradesOnly = points.slice(1).map((p) => p.t).filter(Boolean);
    let best = null, worst = null;
    tradesOnly.forEach((t) => {
      if (!best || t.pnl_after_comm > best.pnl_after_comm) best = t;
      if (!worst || t.pnl_after_comm < worst.pnl_after_comm) worst = t;
    });

    const ddLabel = points[ddPeakIdx].t
      ? `${points[ddPeakIdx].t.trade_date} → ${points[ddTroughIdx].t ? points[ddTroughIdx].t.trade_date : ""}`
      : "";

    const chips = [];
    chips.push(`
      <span><span class="eq-stat-label">Max drawdown</span><span class="eq-stat-value ${maxDD > 0 ? "down" : ""}">${fmtMoney(-maxDD)} (${maxDDPct.toFixed(1)}%)</span>${ddLabel ? ` <span class="dim" style="font-size:11px;">${ddLabel}</span>` : ""}</span>
    `);
    if (best) {
      chips.push(`<a href="trade.html?id=${encodeURIComponent(best.id)}" style="text-decoration:none;"><span class="eq-stat-label">Best trade</span><span class="eq-stat-value up">${fmtMoney(best.pnl_after_comm)}</span> <span class="dim" style="font-size:11px;">${escapeHtml(best.symbol)} · ${best.trade_date}</span></a>`);
    }
    if (worst) {
      chips.push(`<a href="trade.html?id=${encodeURIComponent(worst.id)}" style="text-decoration:none;"><span class="eq-stat-label">Worst trade</span><span class="eq-stat-value down">${fmtMoney(worst.pnl_after_comm)}</span> <span class="dim" style="font-size:11px;">${escapeHtml(worst.symbol)} · ${worst.trade_date}</span></a>`);
    }
    statsEl.innerHTML = chips.join("");
  }
  // Bound once -- reads whatever's current in `equityState` rather than
  // re-binding on every renderEquity() call.
  function bindEquityInteractivity() {
    if (equityBound) return;
    equityBound = true;

    const wrap = document.getElementById("equity-chart-wrap");
    const svg = document.getElementById("equity-svg");
    const crosshair = document.getElementById("equity-crosshair");
    const tooltip = document.getElementById("equity-tooltip");
    if (!wrap || !svg) return;

    function nearestIndex(clientX) {
      const rect = wrap.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const { points } = equityState;
      return Math.round(frac * (points.length - 1));
    }

    function showAt(clientX) {
      if (!equityState) return;
      const { points, coords, values, startBalance, W } = equityState;
      const i = nearestIndex(clientX);
      const [cx] = coords[i];
      const rect = wrap.getBoundingClientRect();
      const pxX = (cx / W) * rect.width;

      crosshair.style.display = "block";
      crosshair.style.left = `${pxX}px`;

      const dot = document.getElementById("equity-hover-dot");
      if (dot) {
        dot.style.display = "block";
        dot.setAttribute("cx", coords[i][0].toFixed(1));
        dot.setAttribute("cy", coords[i][1].toFixed(1));
        dot.setAttribute("stroke", values[i] >= startBalance ? "var(--green)" : "var(--red)");
      }

      const p = points[i];
      const dateLabel = p.t ? p.t.trade_date : (points[1] ? `Before ${points[1].t.trade_date}` : "—");
      let html = `<div class="eq-date">${escapeHtml(dateLabel)}</div><div class="eq-bal">${fmtBalance(p.e)}</div>`;
      if (p.t) {
        html += `<div class="eq-trade">${escapeHtml(p.t.symbol)} <span class="${p.t.win ? "up" : "down"}">${fmtMoney(p.t.pnl_after_comm)}</span></div>`;
        html += `<div class="eq-hint">Click to open trade →</div>`;
      }
      tooltip.innerHTML = html;
      tooltip.style.display = "block";

      // Clamp the tooltip so it never runs off either edge of the panel.
      const ttWidth = tooltip.offsetWidth || 140;
      let left = pxX + 10;
      if (left + ttWidth > rect.width) left = pxX - ttWidth - 10;
      if (left < 0) left = 4;
      tooltip.style.left = `${left}px`;
    }

    function hide() {
      crosshair.style.display = "none";
      tooltip.style.display = "none";
      const dot = document.getElementById("equity-hover-dot");
      if (dot) dot.style.display = "none";
    }

    wrap.addEventListener("pointermove", (e) => showAt(e.clientX), { signal: App.signal });
    wrap.addEventListener("pointerleave", hide, { signal: App.signal });
    wrap.addEventListener("click", (e) => {
      if (!equityState) return;
      const i = nearestIndex(e.clientX);
      const p = equityState.points[i];
      if (p && p.t) window.location.href = `trade.html?id=${encodeURIComponent(p.t.id)}`;
    }, { signal: App.signal });
  }
  // Deterministic accent color for a symbol's avatar -- same symbol
  // always lands on the same hue, purely cosmetic (no meaning encoded).
  const AVATAR_HUES = [262, 199, 152, 28, 340, 45];
  function avatarColor(symbol) {
    let h = 0;
    for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % AVATAR_HUES.length;
    return AVATAR_HUES[h];
  }
  function symbolAvatarHtml(symbol) {
    const hue = avatarColor(symbol);
    const initials = symbol.slice(0, 2).toUpperCase();
    return `<span class="sym-avatar" style="background:hsla(${hue},70%,55%,0.16); color:hsl(${hue},70%,68%);">${initials}</span>`;
  }
  // "$5.20", or an em dash when a trade has no recorded price -- null.toFixed()
  // used to throw here and took the whole Recent trades table down with it.
  function fmtPriceOrDash(v) {
    if (v == null || v === "" || !Number.isFinite(Number(v))) return "\u2014";
    return "$" + Number(v).toFixed(2);
  }
  function tradeRowHtml(t) {
    const setupLabel = t.setup_type ? String(t.setup_type).replace(/_/g, " ") : "";
    return `
    <tr data-id="${escapeHtml(t.id)}">
      <td class="sym">${symbolAvatarHtml(t.symbol)}<span>${escapeHtml(t.symbol)}</span>${setupLabel ? `<span class="setup-pill">${escapeHtml(setupLabel)}</span>` : ""}</td>
      <td class="mono dim">${t.trade_date}</td>
      <td class="mono dim">${escapeHtml(t.entry_time || "\u2014")}</td>
      <td class="mono">${fmtPriceOrDash(t.entry_price)} → ${fmtPriceOrDash(t.exit_price)}</td>
      <td class="mono dim">${escapeHtml(t.shares == null ? "\u2014" : t.shares)}</td>
      <td><span class="pnl-tag ${t.win ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</span></td>
      <td>${window.TradeGrade ? window.TradeGrade.starsHtml(window.TradeGrade.get(t), { size: 12 }) : "—"}</td>
    </tr>`;
  }
  function renderRecentTrades() {
    const recent = App.state.trades.slice(-5).reverse();
    const rows = recent.map(tradeRowHtml).join("");
    const el = document.getElementById("recent-trades");
    el.innerHTML = `<div class="table-scroll"><table class="trade-table"><thead><tr><th>Symbol</th><th>Date</th><th>Entry</th><th>Price</th><th>Shares</th><th>Net P&amp;L</th><th>Grade</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    App.bindTradeRows(el);
  }

  App.tabs.dashboard.renderStats = renderStats;
  App.tabs.dashboard.renderScore = renderScore;
  App.tabs.dashboard.renderMiniCal = renderMiniCal;
  App.tabs.dashboard.renderEquity = renderEquity;
  App.tabs.dashboard.renderRecentTrades = renderRecentTrades;
})();
