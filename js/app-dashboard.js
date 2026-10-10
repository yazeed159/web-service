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
  // ======================================================================
  // Dashboard "deck": period switcher, hero, KPI tiles, and the Form /
  // Timing / Symbols panels. Everything is computed from App.state.trades.
  // The period is anchored to the most recent logged trade (same rule the
  // equity curve's 30D/90D toggle uses), not to wall-clock "today".
  // ======================================================================
  const DK_PERIODS = [["7", "7D", 7], ["30", "30D", 30], ["90", "90D", 90], ["all", "All", null]];
  const DK_PERIOD_WORDS = { "7": "last 7 days", "30": "last 30 days", "90": "last 90 days", all: "all time" };
  const DK_STORE = "trade.log:dash-period";
  let dkPeriod = "all";
  try { const v = localStorage.getItem(DK_STORE); if (DK_PERIODS.some((p) => p[0] === v)) dkPeriod = v; } catch (e) {}

  const DK_ICONS = {
    coins: '<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.6 9.6c0-.9 1-1.6 2.4-1.6s2.4.7 2.4 1.6-1 1.4-2.4 1.7c-1.4.3-2.4.8-2.4 1.7s1 1.6 2.4 1.6 2.4-.7 2.4-1.6"/>',
    bars: '<path d="M5 20V11M12 20V4M19 20v-6"/>',
    drawdown: '<path d="M3 6l6 6 4-4 8 9"/><path d="M21 12v5h-5"/>',
  };
  function dkIcon(name) {
    const inner = DK_ICONS[name] || KPI_ICONS[name] || "";
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }
  const dkDayKey = (d) => d.toLocaleDateString("en-CA");
  const dkEsc = (v) => (window.escapeHtml ? window.escapeHtml(String(v)) : String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])));

  // computeStats() plus the three numbers the deck adds.
  function dkMetrics(list) {
    const s = App.computeStats(list);
    let cum = 0, peak = 0, maxDD = 0;
    list.forEach((t) => {
      cum += Number(t.pnl_after_comm) || 0;
      if (cum > peak) peak = cum;
      if (peak - cum > maxDD) maxDD = peak - cum;
    });
    s.expectancy = list.length ? s.netPnl / list.length : 0;
    s.payoff = s.avgLoss < 0 ? s.avgWin / Math.abs(s.avgLoss) : (s.avgWin > 0 ? Infinity : 0);
    s.maxDD = maxDD;
    return s;
  }
  // The selected period's trades, and what to compare them with.
  function dkWindow() {
    const all = App.state.trades || [];
    const days = DK_PERIODS.find((p) => p[0] === dkPeriod)[2];
    if (!all.length) return { cur: [], cmp: null };
    if (!days) {
      const w = tradeWindows();
      return { cur: all, cmp: w ? { c: dkMetrics(all.slice(-w.n)), p: dkMetrics(all.slice(-2 * w.n, -w.n)), label: `last ${w.n} vs the ${w.n} before` } : null };
    }
    const a = new Date(all[all.length - 1].trade_date + "T12:00:00");
    const s1 = new Date(a); s1.setDate(a.getDate() - days + 1);
    const s0 = new Date(a); s0.setDate(a.getDate() - 2 * days + 1);
    const k1 = dkDayKey(s1), k0 = dkDayKey(s0);
    const cur = all.filter((t) => t.trade_date >= k1);
    const prev = all.filter((t) => t.trade_date >= k0 && t.trade_date < k1);
    return { cur, cmp: prev.length >= 2 && cur.length >= 2 ? { c: dkMetrics(cur), p: dkMetrics(prev), label: `vs the previous ${days} days` } : null };
  }
  function dkByDay(list) {
    const m = new Map();
    list.forEach((t) => m.set(t.trade_date, (m.get(t.trade_date) || 0) + (Number(t.pnl_after_comm) || 0)));
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, net]) => ({ date, net }));
  }
  const dkSigned = (v) => `<span class="${v >= 0 ? "up" : "down"}">${fmtMoney(v)}</span>`;
  function dkShortDate(key) {
    try { return new Date(key + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch (e) { return key; }
  }

  function dkGreeting() {
    const h = new Date().getHours();
    return h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  }
  // One line: how today (or the last session) went.
  function dkStatusLine() {
    const tr = App.state.trades || [];
    if (!tr.length) return "Nothing logged yet";
    const today = dkDayKey(new Date());
    const todays = tr.filter((t) => t.trade_date === today);
    if (todays.length) {
      const pnl = todays.reduce((a, t) => a + (Number(t.pnl_after_comm) || 0), 0);
      return `Today ${dkSigned(pnl)} · ${todays.length} trade${todays.length === 1 ? "" : "s"}`;
    }
    const last = tr[tr.length - 1].trade_date;
    const pnl = tr.filter((t) => t.trade_date === last).reduce((a, t) => a + (Number(t.pnl_after_comm) || 0), 0);
    return `No trades today · last session ${dkShortDate(last)} ${dkSigned(pnl)}`;
  }
  // Daily P&L bars for the hero. Zero line in the middle; wins up, losses down.
  function dkDayBars(days) {
    const list = days.slice(-45);
    if (!list.length) return "";
    const W = 600, H = 84, mid = H / 2;
    const max = Math.max(1, ...list.map((d) => Math.abs(d.net)));
    const slot = W / list.length, bw = Math.max(2, Math.min(18, slot * 0.64));
    const bars = list.map((d, i) => {
      const h = Math.max(2, (Math.abs(d.net) / max) * (mid - 3));
      const x = i * slot + (slot - bw) / 2;
      const y = d.net >= 0 ? mid - h : mid;
      return `<rect class="${d.net >= 0 ? "up" : "down"}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(3, bw / 2).toFixed(1)}"><title>${dkShortDate(d.date)}  ${fmtMoney(d.net)}</title></rect>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Daily net P&amp;L, ${list.length} trading days"><line class="zero" x1="0" x2="${W}" y1="${mid}" y2="${mid}"/>${bars}</svg>`;
  }

  function dkRenderHero(win, S) {
    const heroEl = document.getElementById("dash-hero");
    if (!heroEl) return;
    const days = dkByDay(win.cur);
    const word = DK_PERIOD_WORDS[dkPeriod];
    const delta = win.cmp ? deltaChip(win.cmp.c.netPnl, win.cmp.p.netPnl, fmtMoney) : "";
    const streak = currentStreak();
    const streakChip = streak && streak.count >= 2 ? `<span class="dk-chip ${streak.win ? "up" : "down"}">${streak.count}-${streak.win ? "win" : "loss"} streak</span>` : "";
    const tr = App.state.trades || [];
    const isToday = tr.length && tr[tr.length - 1].trade_date === dkDayKey(new Date());
    const seg = DK_PERIODS.map((p) => `<button type="button" role="tab" data-dk-period="${p[0]}" aria-selected="${p[0] === dkPeriod}" class="${p[0] === dkPeriod ? "active" : ""}">${p[1]}</button>`).join("");
    const empty = !win.cur.length;
    heroEl.innerHTML = `
      <div class="dk-hero-top">
        <div class="dk-greet"><span class="dk-hello">${dkGreeting()}</span><span class="dk-status">${dkStatusLine()}</span></div>
        <div class="dk-seg" role="tablist" aria-label="Period">${seg}</div>
      </div>
      <div class="dk-hero-body">
        <div class="dk-hero-main">
          <div class="dk-eyebrow">Net P&amp;L <span>· ${word}</span></div>
          <div class="dk-big ${S.netPnl >= 0 ? "up" : "down"}">${empty ? "—" : fmtMoney(S.netPnl)}</div>
          <div class="dk-hero-meta">${delta ? `${delta}<span class="dim">${win.cmp.label}</span>` : ""}${streakChip}</div>
          <div class="dk-hero-sub">${empty ? "No trades in this period" : `gross ${fmtMoney(S.grossPnl)} · comm $${S.totalComm.toFixed(2)} · ${S.count} trade${S.count === 1 ? "" : "s"} · ${S.dayCount} day${S.dayCount === 1 ? "" : "s"}`}</div>
        </div>
        <div class="dk-hero-bars">
          <div class="dk-mini-label">Daily P&amp;L</div>
          ${empty ? `<div class="dk-empty">Nothing to chart yet</div>` : dkDayBars(days)}
        </div>
      </div>
      <div class="dk-hero-cta">
        <a class="dk-btn primary" id="hero-add" href="daily.html">${isToday ? "Review today" : "Plan today"}<i aria-hidden="true">›</i></a>
        <a class="dk-btn" href="journal.html">Journal</a>
      </div>`;
    // Count the big number up once per page load (skipped for reduced motion).
    const hv = heroEl.querySelector(".dk-big");
    let reduced = false;
    try { reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
    if (hv && !window.__heroCounted && !reduced && isFinite(S.netPnl) && S.netPnl !== 0 && !empty) {
      window.__heroCounted = true;
      const t0 = performance.now(), dur = 900, target = S.netPnl;
      const step = (now) => {
        const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        hv.textContent = fmtMoney(target * e);
        if (k < 1) requestAnimationFrame(step); else hv.textContent = fmtMoney(target);
      };
      requestAnimationFrame(step);
    }
    heroEl.querySelectorAll("[data-dk-period]").forEach((b) => b.addEventListener("click", () => dkSetPeriod(b.getAttribute("data-dk-period"))));
  }

  function dkSetPeriod(k) {
    if (k === dkPeriod || !DK_PERIODS.some((p) => p[0] === k)) return;
    dkPeriod = k;
    try { localStorage.setItem(DK_STORE, k); } catch (e) {}
    renderStats();
    // Keep the equity curve's own range in step (it has no 7-day option).
    const eq = { "7": "30", "30": "30", "90": "90", all: "all" }[k];
    const btn = document.querySelector(`#eq-range-toggle button[data-range="${eq}"]`);
    if (btn && !btn.classList.contains("active")) btn.click();
  }

  function dkRenderTiles(win, S) {
    const c = win.cmp;
    const d = (f, fmt) => (c ? deltaChip(c.c[f], c.p[f], fmt) : "");
    const pt = (x) => (x >= 0 ? "+" : "") + x.toFixed(0) + "pt";
    const empty = !win.cur.length;
    const dash = "—";
    const pf = S.profitFactor === Infinity ? "∞" : S.profitFactor.toFixed(2);
    const payoff = S.payoff === Infinity ? "∞" : S.payoff.toFixed(2);
    const tiles = [
      { label: "Win rate", icon: "target", v: S.winRate.toFixed(0) + "%", cls: S.winRate >= 50 ? "up" : "down", sub: `${S.wins.length}W · ${S.losses.length}L`, delta: d("winRate", pt) },
      { label: "Profit factor", icon: "scale", v: pf, cls: S.profitFactor >= 1 ? "up" : "down", sub: S.profitFactor >= 1 ? "profitable" : "below 1.0", delta: d("profitFactor", (x) => (x >= 0 ? "+" : "") + x.toFixed(2)) },
      { label: "Expectancy", icon: "coins", v: fmtMoney(S.expectancy), cls: S.expectancy >= 0 ? "up" : "down", sub: "per trade", delta: d("expectancy", fmtMoney) },
      { label: "Payoff ratio", icon: "bars", v: payoff, cls: S.payoff >= 1 ? "up" : "down", sub: "avg win ÷ avg loss", delta: d("payoff", (x) => (x >= 0 ? "+" : "") + x.toFixed(2)) },
      { label: "Day win rate", icon: "calendarCheck", v: S.dayWinRate.toFixed(0) + "%", cls: S.dayWinRate >= 50 ? "up" : "down", sub: `${S.dayCount} trading day${S.dayCount === 1 ? "" : "s"}`, delta: d("dayWinRate", pt) },
      { label: "Max drawdown", icon: "drawdown", v: S.maxDD > 0 ? "-$" + S.maxDD.toFixed(2) : "$0.00", cls: S.maxDD > 0 ? "down" : "up", sub: "peak to trough", delta: "" },
    ];
    document.getElementById("stat-grid").innerHTML = tiles.map((t) => `
      <div class="dk-tile">
        <div class="dk-tile-top"><span class="dk-tile-label">${t.label}</span><span class="dk-tile-icon">${dkIcon(t.icon)}</span></div>
        <div class="dk-tile-value ${empty ? "" : t.cls}">${empty ? dash : t.v}</div>
        <div class="dk-tile-foot">${empty ? "" : t.delta}<span class="dk-tile-sub">${empty ? "no trades" : t.sub}</span></div>
      </div>`).join("");
  }

  function dkRenderForm(win) {
    const el = document.getElementById("dk-form");
    if (!el) return;
    const all = App.state.trades || [];
    const last = all.slice(-20);
    const streak = currentStreak();
    const dots = last.map((t) => `<span class="dk-dot ${t.win ? "up" : "down"}" title="${dkEsc(t.symbol || "")}  ${fmtMoney(Number(t.pnl_after_comm) || 0)}"></span>`).join("");
    const lastWins = last.filter((t) => t.win).length;
    const days = dkByDay(win.cur);
    let bestDay = null, worstDay = null, best = null, worst = null;
    days.forEach((x) => { if (!bestDay || x.net > bestDay.net) bestDay = x; if (!worstDay || x.net < worstDay.net) worstDay = x; });
    win.cur.forEach((t) => { const v = Number(t.pnl_after_comm) || 0; if (!best || v > best.v) best = { v, t }; if (!worst || v < worst.v) worst = { v, t }; });
    const cell = (k, body) => `<div class="dk-pair"><span class="k">${k}</span><span class="v">${body}</span></div>`;
    el.innerHTML = `
      <div class="dk-card-head"><h3>Form</h3><span class="dk-card-sub">${last.length ? `last ${last.length} trades · ${lastWins}W ${last.length - lastWins}L` : ""}</span></div>
      ${last.length ? `<div class="dk-dots">${dots}</div>` : `<div class="dk-empty">Log a few trades and your recent form shows up here.</div>`}
      <div class="dk-pairs">
        ${cell("Current streak", streak ? `<span class="${streak.win ? "up" : "down"}">${streak.count} ${streak.win ? "win" : "loss"}${streak.count === 1 ? "" : "s"}</span>` : "—")}
        ${cell("Best day", bestDay ? `${dkSigned(bestDay.net)}<small>${dkShortDate(bestDay.date)}</small>` : "—")}
        ${cell("Worst day", worstDay ? `${dkSigned(worstDay.net)}<small>${dkShortDate(worstDay.date)}</small>` : "—")}
        ${cell("Best trade", best ? `${dkSigned(best.v)}<small>${dkEsc(best.t.symbol || "")}</small>` : "—")}
        ${cell("Worst trade", worst ? `${dkSigned(worst.v)}<small>${dkEsc(worst.t.symbol || "")}</small>` : "—")}
      </div>`;
  }

  // Entry-time buckets (minutes after midnight).
  const DK_BUCKETS = [
    { key: "pre", label: "Pre-market", from: 0, to: 570 },
    { key: "open", label: "Open", sub: "9:30–10:00", from: 570, to: 600 },
    { key: "morn", label: "Morning", sub: "10:00–11:30", from: 600, to: 690 },
    { key: "mid", label: "Midday", sub: "11:30–2:00", from: 690, to: 840 },
    { key: "close", label: "Close", sub: "2:00–4:00", from: 840, to: 960 },
    { key: "after", label: "After hours", from: 960, to: 1441 },
  ];
  function dkRenderTiming(win) {
    const el = document.getElementById("dk-timing");
    if (!el) return;
    const rows = DK_BUCKETS.map((b) => ({ b, net: 0, n: 0, w: 0 }));
    win.cur.forEach((t) => {
      const m = /^(\d{1,2}):(\d{2})/.exec(t.entry_time || "");
      if (!m) return;
      const mins = Number(m[1]) * 60 + Number(m[2]);
      const r = rows.find((x) => mins >= x.b.from && mins < x.b.to);
      if (!r) return;
      r.net += Number(t.pnl_after_comm) || 0; r.n++; if (t.win) r.w++;
    });
    const used = rows.filter((r) => r.n);
    if (!used.length) {
      el.innerHTML = `<div class="dk-card-head"><h3>Timing</h3><span class="dk-card-sub">by entry time</span></div><div class="dk-empty">Entry times show up here once trades are logged.</div>`;
      return;
    }
    const max = Math.max(1, ...used.map((r) => Math.abs(r.net)));
    const bestKey = used.reduce((a, r) => (r.net > a.net ? r : a), used[0]).b.key;
    el.innerHTML = `
      <div class="dk-card-head"><h3>Timing</h3><span class="dk-card-sub">net P&amp;L by entry time</span></div>
      <div class="dk-bars">
        ${used.map((r) => `
          <div class="dk-bar-row${r.b.key === bestKey && r.net > 0 ? " best" : ""}">
            <div class="dk-bar-name"><span>${r.b.label}</span>${r.b.sub ? `<small>${r.b.sub}</small>` : ""}</div>
            <div class="dk-bar-track"><span class="${r.net >= 0 ? "up" : "down"}" style="width:${Math.max(4, (Math.abs(r.net) / max) * 100).toFixed(0)}%"></span></div>
            <div class="dk-bar-val">${dkSigned(r.net)}<small>${r.n} trade${r.n === 1 ? "" : "s"} · ${Math.round((r.w / r.n) * 100)}% win</small></div>
          </div>`).join("")}
      </div>`;
  }

  function dkRenderSymbols(win) {
    const el = document.getElementById("dk-symbols");
    if (!el) return;
    const m = new Map();
    win.cur.forEach((t) => {
      const k = (t.symbol || "?").toUpperCase();
      const e = m.get(k) || { sym: k, net: 0, n: 0 };
      e.net += Number(t.pnl_after_comm) || 0; e.n++; m.set(k, e);
    });
    const list = Array.from(m.values()).sort((a, b) => b.net - a.net);
    if (!list.length) {
      el.innerHTML = `<div class="dk-card-head"><h3>Symbols</h3><span class="dk-card-sub">best &amp; worst</span></div><div class="dk-empty">No trades in this period.</div>`;
      return;
    }
    const nb = Math.min(3, Math.ceil(list.length / 2)), nw = Math.min(3, Math.floor(list.length / 2));
    const best = list.slice(0, nb).filter((x) => x.net > 0 || list.length === 1);
    const worst = nw ? list.slice(list.length - nw).reverse().filter((x) => x.net < 0) : [];
    const row = (x) => `<div class="dk-sym">${symbolAvatarHtml(x.sym)}<span class="dk-sym-name">${dkEsc(x.sym)}<small>${x.n} trade${x.n === 1 ? "" : "s"}</small></span><span class="dk-sym-pnl">${dkSigned(x.net)}</span></div>`;
    el.innerHTML = `
      <div class="dk-card-head"><h3>Symbols</h3><span class="dk-card-sub">${list.length} traded · ${DK_PERIOD_WORDS[dkPeriod]}</span></div>
      ${best.length ? `<div class="dk-group-label">Best</div>${best.map(row).join("")}` : ""}
      ${worst.length ? `<div class="dk-group-label">Worst</div>${worst.map(row).join("")}` : ""}
      ${!best.length && !worst.length ? `<div class="dk-empty">No clear winners or losers yet.</div>` : ""}`;
  }

  function renderStats() {
    const win = dkWindow();
    const S = dkMetrics(win.cur);
    dkRenderHero(win, S);
    dkRenderTiles(win, S);
    dkRenderForm(win);
    dkRenderTiming(win);
    dkRenderSymbols(win);
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
  let equityCompare = false; // overlay the previous equal-length period, dashed
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
  // The equal-length window immediately BEFORE the current 30D/90D
  // window -- e.g. with 30D selected, this is days 31-60 back from the
  // anchor. Only meaningful for a fixed-length range; "All" has no
  // "previous period" to compare against, so this returns [] then and
  // the compare toggle stays disabled.
  function equityPreviousRangeSubset() {
    if (equityRange === "all" || !App.state.trades.length) return [];
    const days = parseInt(equityRange, 10);
    const anchor = new Date(App.state.trades[App.state.trades.length - 1].trade_date + "T12:00:00");
    const currentCutoff = new Date(anchor);
    currentCutoff.setDate(currentCutoff.getDate() - days);
    const prevCutoff = new Date(currentCutoff);
    prevCutoff.setDate(prevCutoff.getDate() - days);
    return App.state.trades.filter((t) => {
      const d = new Date(t.trade_date + "T12:00:00");
      return d >= prevCutoff && d < currentCutoff;
    });
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
      const rangeBtn = e.target.closest("button[data-range]");
      if (rangeBtn) {
        equityRange = rangeBtn.dataset.range;
        wrap.querySelectorAll("button[data-range]").forEach((b) => b.classList.toggle("active", b === rangeBtn));
        if (equityRange === "all") equityCompare = false; // no "previous period" against All
        renderEquity();
        return;
      }
      const compareBtn = e.target.closest("#eq-compare-btn");
      if (compareBtn && !compareBtn.disabled) {
        equityCompare = !equityCompare;
        renderEquity();
      }
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

    // Compare overlay: the previous equal-length window's own curve,
    // normalized so it STARTS at the current window's startBalance --
    // i.e. "if the previous period's run had started from today's
    // balance, where would it have led". That's what makes it possible
    // to overlay two periods with completely different account sizes on
    // one shared y-axis and compare their shapes directly. Only offered
    // for a fixed-length range (30D/90D) with enough prior history; the
    // compare button itself is disabled otherwise (see below).
    const prevOrdered = equityRange === "all" ? [] : equityPreviousRangeSubset();
    let compareValues = [];
    let comparePoints = [];
    if (equityCompare && prevOrdered.length) {
      const prevStart = prevOrdered[0]._balance - (prevOrdered[0].pnl_after_comm || 0);
      comparePoints = [
        { e: startBalance, t: null },
        ...prevOrdered.map((t) => ({ e: startBalance + (t._balance - prevStart), t })),
      ];
      compareValues = comparePoints.map((p) => p.e);
    }

    const scaleValues = compareValues.length ? values.concat(compareValues) : values;
    const min = Math.min(startBalance, ...scaleValues);
    const max = Math.max(startBalance, ...scaleValues);
    const range = max - min || 1;
    const W = 1000, H = 140, PAD = 8;

    const coords = points.map((p, i) => {
      const x = points.length > 1 ? (i / (points.length - 1)) * W : 0;
      const y = H - PAD - ((p.e - min) / range) * (H - PAD * 2);
      return [x, y];
    });
    // Plotted by index fraction (same convention the main curve uses,
    // not by real elapsed time), since the previous window usually has a
    // different trade count than the current one -- this keeps both
    // curves spanning the full chart width so their shapes line up
    // side by side rather than one trailing off partway across.
    const compareCoords = comparePoints.map((p, i) => {
      const x = comparePoints.length > 1 ? (i / (comparePoints.length - 1)) * W : 0;
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
    const compareMarkup = compareCoords.length > 1
      ? `<path d="${compareCoords.map((c, i) => (i === 0 ? "M" : "L") + fmt1(c[0]) + "," + fmt1(c[1])).join(" ")}" class="equity-path-compare" />`
      : "";
    const svg = document.getElementById("equity-svg");
    svg.innerHTML = `
      <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" class="equity-zero" />
      <line x1="0" y1="${allTimeHighY.toFixed(1)}" x2="${W}" y2="${allTimeHighY.toFixed(1)}" class="equity-ath" />
      ${fillMarkup}
      <path d="${ddPathD}" class="equity-drawdown" />
      ${compareMarkup}
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

    // Compare button: disabled outright on "All" (no fixed-length
    // "previous period" to mirror), or when there's no trade history
    // before the current window to draw one from. The legend below the
    // chart only appears once the overlay is actually on and has data.
    const compareBtn = document.getElementById("eq-compare-btn");
    if (compareBtn) {
      const canCompare = equityRange !== "all" && prevOrdered.length > 0;
      compareBtn.disabled = !canCompare;
      compareBtn.classList.toggle("active", equityCompare && canCompare);
    }
    const legendEl = document.getElementById("equity-compare-legend");
    if (legendEl) {
      if (equityCompare && comparePoints.length > 1) {
        const currentNet = values[values.length - 1] - startBalance;
        const prevNet = compareValues[compareValues.length - 1] - startBalance;
        legendEl.style.display = "flex";
        legendEl.innerHTML = `
          <span><span class="sw" style="background:${finalPositive ? "var(--green)" : "var(--red)"};"></span>This period <b>${fmtMoney(currentNet)}</b></span>
          <span><span class="sw prev"></span>Previous period <b>${fmtMoney(prevNet)}</b></span>
        `;
      } else {
        legendEl.style.display = "none";
        legendEl.innerHTML = "";
      }
    }

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
    const yline = document.getElementById("equity-crosshair-yline");
    const yvalLabel = document.getElementById("equity-yval-label");
    if (!wrap || !svg) return;
    const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    let shownIdx = -1;

    function nearestIndex(clientX) {
      const rect = wrap.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const { points } = equityState;
      return Math.round(frac * (points.length - 1));
    }

    function showAt(clientX) {
      if (!equityState) return;
      const { points, coords, values, startBalance, W, H } = equityState;
      const i = nearestIndex(clientX);
      shownIdx = i;
      const [cx, cy] = coords[i];
      const rect = wrap.getBoundingClientRect();
      const pxX = (cx / W) * rect.width;

      crosshair.style.display = "block";
      crosshair.style.left = `${pxX}px`;

      // Value-axis readout: a horizontal line at the hovered point's
      // height plus a $ pill pinned to the left edge, same idea as a
      // trading platform's price-axis crosshair label -- alongside, not
      // instead of, the date/trade tooltip below.
      if (yline && yvalLabel) {
        const pxY = (cy / H) * rect.height;
        yline.style.top = `${pxY}px`;
        yline.style.display = "block";
        yvalLabel.style.top = `${pxY}px`;
        yvalLabel.textContent = fmtBalance(values[i]);
        yvalLabel.style.display = "block";
      }

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
        html += `<div class="eq-hint">${coarse ? "Tap again to open trade" : "Click to open trade"} →</div>`;
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
      shownIdx = -1;
      crosshair.style.display = "none";
      tooltip.style.display = "none";
      if (yline) yline.style.display = "none";
      if (yvalLabel) yvalLabel.style.display = "none";
      const dot = document.getElementById("equity-hover-dot");
      if (dot) dot.style.display = "none";
    }

    // Mouse: hover as before. Touch: press and hold (~200ms) then drag to scrub
    // along the curve; a quick swipe still scrolls the page. A plain tap shows
    // that point, and tapping the same point again opens the trade.
    wrap.addEventListener("pointermove", (e) => { if (e.pointerType !== "touch") showAt(e.clientX); }, { signal: App.signal });
    wrap.addEventListener("pointerleave", (e) => { if (e.pointerType !== "touch") hide(); }, { signal: App.signal });

    let holdTimer = null, scrubbing = false, suppressClick = false;
    let sx = 0, sy = 0, lastX = 0;
    const endHold = () => { clearTimeout(holdTimer); holdTimer = null; };
    wrap.addEventListener("touchstart", (e) => {
      if (e.touches.length !== 1) { endHold(); return; }
      sx = lastX = e.touches[0].clientX; sy = e.touches[0].clientY;
      endHold();
      holdTimer = setTimeout(() => {
        holdTimer = null; scrubbing = true;
        wrap.classList.add("scrubbing");
        try { if (navigator.vibrate) navigator.vibrate(8); } catch (err) {}
        showAt(lastX);
      }, 200);
    }, { passive: true, signal: App.signal });
    wrap.addEventListener("touchmove", (e) => {
      const t = e.touches[0];
      if (!t) return;
      lastX = t.clientX;
      if (scrubbing) {
        if (e.cancelable) e.preventDefault(); // keep the page from scrolling while scrubbing
        showAt(t.clientX);
      } else if (Math.abs(t.clientX - sx) > 8 || Math.abs(t.clientY - sy) > 8) {
        endHold(); // finger moved before the hold registered: it is a scroll
      }
    }, { passive: false, signal: App.signal });
    const touchDone = () => {
      endHold();
      if (scrubbing) {
        scrubbing = false;
        wrap.classList.remove("scrubbing");
        suppressClick = true; // the click synthesised on release must not open the trade
        setTimeout(() => { suppressClick = false; }, 400);
      }
    };
    wrap.addEventListener("touchend", touchDone, { signal: App.signal });
    wrap.addEventListener("touchcancel", touchDone, { signal: App.signal });
    wrap.addEventListener("contextmenu", (e) => { if (coarse) e.preventDefault(); }, { signal: App.signal });
    // Tapping anywhere else (or scrolling away) clears the readout left on screen.
    document.addEventListener("touchstart", (e) => { if (!wrap.contains(e.target)) hide(); }, { passive: true, signal: App.signal });

    wrap.addEventListener("click", (e) => {
      if (!equityState || suppressClick) return;
      const i = nearestIndex(e.clientX);
      const p = equityState.points[i];
      if (coarse && shownIdx !== i) { showAt(e.clientX); return; } // first tap: just show it
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
    // Light theme: the pale 68% text washes out on the light tint, so go dark there (the toggle reloads the page).
    const light = document.documentElement.getAttribute("data-theme") === "light";
    return `<span class="sym-avatar" style="background:hsla(${hue},70%,55%,0.16); color:hsl(${hue},70%,${light ? 28 : 68}%);">${initials}</span>`;
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
    el.innerHTML = `<div class="table-scroll"><table class="trade-table tt-recent"><thead><tr><th>Symbol</th><th>Date</th><th>Entry</th><th>Price</th><th>Shares</th><th>Net P&amp;L</th><th>Grade</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    App.bindTradeRows(el);
  }

  App.tabs.dashboard.renderStats = renderStats;
  App.tabs.dashboard.renderScore = renderScore;
  App.tabs.dashboard.renderMiniCal = renderMiniCal;
  App.tabs.dashboard.renderEquity = renderEquity;
  App.tabs.dashboard.renderRecentTrades = renderRecentTrades;
})();
