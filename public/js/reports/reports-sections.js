(function () {
  "use strict";
  const R = (App.reports = App.reports || {});
  const { DOW, dailyAgg, drillAttr, drillRegistry, groupByField, renderAdvanced, renderBreakdownTable, renderCumulativeCharts, renderDetailSubtabs, renderDetailedStats, renderInsights, renderOverviewCumulativePnl, renderPaginatedBreakdownTable, renderPeriodDistPerf, renderTagBreakdown, runCalc, streakInfo, symbolAgg } = R;

  // Phone: the headline numbers for the filtered set, shown above the tabs.
  function renderReportKpis() {
    const el = document.getElementById("rpt-kpis");
    if (!el) return;
    const list = App.state.trades;
    if (!list.length) { el.innerHTML = '<div class="kpi" style="grid-column:1/-1"><div class="l">No trades match these filters</div></div>'; return; }
    const st = App.computeStats(list);
    const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
    const pf = st.profitFactor === Infinity ? "\u221e" : st.profitFactor.toFixed(2);
    const k = (l, n, c) => `<div class="kpi"><div class="l">${l}</div><div class="n ${c || ""}">${n}</div></div>`;
    el.innerHTML = k("Net P&amp;L", fmtMoney(st.netPnl), cls(st.netPnl)) + k("Win rate", st.winRate.toFixed(0) + "%") + k("Profit factor", pf) + k("Trades", String(st.count));
  }
  function renderReports() {
    drillRegistry.clear(); // parked trade lists belong to the pass that made them
    App.safeRender(renderReportKpis, "renderReportKpis");
    R.updateFiltersToggle();
    // Each of these owns its own, unrelated slice of the page (a
    // different tab/panel's worth of divs) -- one throwing on some
    // edge-case field shouldn't stop the other fifteen from running.
    // See safeRender()'s comment near the top of this file for why.
    App.safeRender(renderDetailedStats, "renderDetailedStats");
    App.safeRender(renderDetailSubtabs, "renderDetailSubtabs");
    App.safeRender(renderPeriodDistPerf, "renderPeriodDistPerf");
    App.safeRender(renderOverviewCumulativePnl, "renderOverviewCumulativePnl");
    App.safeRender(renderStreaks, "renderStreaks");
    App.safeRender(renderHighlights, "renderHighlights");
    App.safeRender(renderSymbolBreakdown, "renderSymbolBreakdown");
    App.safeRender(renderDowBreakdown, "renderDowBreakdown");
    App.safeRender(renderTimeOfDayBreakdown, "renderTimeOfDayBreakdown");
    App.safeRender(renderDurationBreakdown, "renderDurationBreakdown");
    App.safeRender(renderSectorCountryBreakdown, "renderSectorCountryBreakdown");
    App.safeRender(renderWinLossDays, "renderWinLossDays");
    App.safeRender(renderDrawdown, "renderDrawdown");
    App.safeRender(renderCompare, "renderCompare");
    App.safeRender(renderTagBreakdown, "renderTagBreakdown");
    App.safeRender(renderAdvanced, "renderAdvanced");
    App.safeRender(renderInsights, "renderInsights");
  }
  function renderStreaks() {
    // trades already sorted chronologically
    let best = 0, worst = 0, curWinRun = 0, curLossRun = 0;
    let trailingSign = 0, trailingRun = 0;
    App.state.trades.forEach((t) => {
      if (t.win) { curWinRun++; curLossRun = 0; best = Math.max(best, curWinRun); }
      else { curLossRun++; curWinRun = 0; worst = Math.max(worst, curLossRun); }
      if (t.win === (trailingSign === 1)) { trailingRun++; }
      else { trailingSign = t.win ? 1 : -1; trailingRun = 1; }
    });
    const currentLabel = trailingSign === 1 ? `${trailingRun}W` : trailingSign === -1 ? `${trailingRun}L` : "—";
    const currentColor = trailingSign === 1 ? "up" : trailingSign === -1 ? "down" : "";

    const si = streakInfo(App.state.trades);
    document.getElementById("streak-strip").innerHTML = `
      <div class="cell"${drillAttr("Current streak: " + currentLabel, si.current, { sub: "The run you're in right now", order: "chrono", calc: runCalc(si.current, currentLabel) })}><div class="label">Current streak</div><div class="value ${currentColor}">${currentLabel}</div></div>
      <div class="cell"${drillAttr("Best win streak: " + best + "W", si.bestWin, { sub: "Longest run of winners, oldest first", order: "chrono", calc: runCalc(si.bestWin, "Winning streak") })}><div class="label">Best win streak</div><div class="value up">${best}W</div></div>
      <div class="cell"${drillAttr("Worst loss streak: " + worst + "L", si.bestLoss, { sub: "Longest run of losers, oldest first", order: "chrono", calc: runCalc(si.bestLoss, "Losing streak") })}><div class="label">Worst loss streak</div><div class="value down">${worst}L</div></div>
    `;
  }
  function renderHighlights() {
    // Filters (symbol / Advanced) can leave zero trades -- reduce() with a
    // missing initial value used to throw on that.
    if (!App.state.trades.length) {
      document.getElementById("highlight-pair").innerHTML = `<div class="empty-state small">No trades match these filters.</div>`;
      return;
    }
    const best = App.state.trades.reduce((a, b) => (b.pnl_after_comm > a.pnl_after_comm ? b : a), App.state.trades[0]);
    const worst = App.state.trades.reduce((a, b) => (b.pnl_after_comm < a.pnl_after_comm ? b : a), App.state.trades[0]);
    document.getElementById("highlight-pair").innerHTML = `
      <a class="highlight-card best" href="trade.html?id=${encodeURIComponent(best.id)}" style="text-decoration:none;">
        <div class="label">Best trade</div>
        <div class="sym">${escapeHtml(best.symbol)} <span class="dim" style="font-weight:400;font-size:12px;">${escapeHtml(best.trade_date)}</span></div>
        <div class="pnl up">${fmtMoney(best.pnl_after_comm)}</div>
      </a>
      <a class="highlight-card worst" href="trade.html?id=${encodeURIComponent(worst.id)}" style="text-decoration:none;">
        <div class="label">Worst trade</div>
        <div class="sym">${escapeHtml(worst.symbol)} <span class="dim" style="font-weight:400;font-size:12px;">${escapeHtml(worst.trade_date)}</span></div>
        <div class="pnl down">${fmtMoney(worst.pnl_after_comm)}</div>
      </a>
    `;
  }
  function renderSymbolBreakdown() {
    const bySym = new Map();
    App.state.trades.forEach((t) => {
      if (!bySym.has(t.symbol)) bySym.set(t.symbol, { trades: [], net: 0 });
      const e = bySym.get(t.symbol);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    const rows = Array.from(bySym.entries()).sort((a, b) => b[1].net - a[1].net);
    const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r[1].net)));

    renderPaginatedBreakdownTable("report-symbol", rows, "Symbol", ([sym, e]) => {
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      const smallSample = e.trades.length < 3;
      return `<tr class="report-row"${drillAttr(sym, e.trades, { row: true, sub: "By symbol" })}>
        <td style="font-weight:600;">${escapeHtml(sym)}${smallSample ? ` <span class="pill" style="font-size:9.5px; padding:1px 6px;" title="Fewer than 3 trades — win rate isn't meaningful yet.">n=${e.trades.length}</span>` : ""}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    });
  }
  function renderDowBreakdown() {
    const byDow = new Map();
    App.state.trades.forEach((t) => {
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
      return `<tr class="report-row"${drillAttr(DOW[d], e.trades, { row: true, sub: "By day of week" })}>
        <td style="font-weight:600;">${DOW[d]}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    }).join("");

    const dowEl = document.getElementById("report-dow");
    dowEl.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Day</th><th scope="col">Trades</th><th scope="col">Win %</th><th scope="col">Net P&amp;L</th></tr></thead><tbody>${html}</tbody></table></div>`;
    bindTradeToggles(dowEl);
  }
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
    App.state.trades.forEach((t) => {
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
      return `<tr class="report-row"${drillAttr(b.label, b.trades, { row: true, sub: "By entry time" })}>
        <td style="font-weight:600;">${b.label}</td>
        <td class="mono dim">${b.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</span></td>
      </tr>`;
    }).join("");

    const el = document.getElementById("report-timeofday");
    if (!rows) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    el.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Session</th><th scope="col">Trades</th><th scope="col">Win %</th><th scope="col">Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    bindTradeToggles(el);
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
    App.state.trades.forEach((t) => {
      const mins = App.durationMinutes(t);
      if (mins === null) return;
      const bucket = buckets.find((b) => mins <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    const maxCount = Math.max(1, ...buckets.map((b) => b.trades.length));

    const rows = buckets.filter((b) => b.trades.length).map((b) => {
      const winRate = (b.trades.filter((t) => t.win).length / b.trades.length) * 100;
      const pct = (b.trades.length / maxCount) * 100;
      return `<div class="bar-row"${drillAttr(b.label, b.trades, { sub: "Hold time" })}>
        <div class="bar-label">${b.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(0)}%;"></div></div>
        <div class="bar-count">${b.trades.length}x</div>
        <div style="width:52px; text-align:right; flex-shrink:0; color:${winRate >= 50 ? "var(--green)" : "var(--red)"};">${winRate.toFixed(0)}%</div>
      </div>`;
    }).join("");

    const el = document.getElementById("report-duration");
    const used = buckets.filter((b) => b.trades.length).length;
    // One bar holding every trade says nothing a trade count doesn't -- say so instead of drawing it.
    el.innerHTML = used > 1 ? rows : used === 1
      ? `<div class="empty-state small">Every trade with a hold time falls in ${escapeHtml(buckets.find((b) => b.trades.length).label)}.</div>`
      : `<div class="empty-state small">No data yet.</div>`;
    bindTradeToggles(el);
  }
  function leaderboardRows(entries, valueFn, valueCls) {
    return entries.map(([sym, e]) => {
      return `
      <div class="bar-row"${drillAttr(sym, e.trades, { sub: "Symbol" })}>
        <div class="bar-label" style="width:70px;">${escapeHtml(sym)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${e._pct}%;"></div></div>
        <div style="width:70px; text-align:right; flex-shrink:0;" class="${valueCls(e)}">${valueFn(e)}</div>
      </div>`;
    }).join("");
  }
  function renderLeaderboards() {
    const map = symbolAgg();
    const entries = Array.from(map.entries());

    const byCount = entries.slice().sort((a, b) => b[1].trades.length - a[1].trades.length).slice(0, 5);
    const maxCount = Math.max(1, ...byCount.map(([, e]) => e.trades.length));
    byCount.forEach(([, e]) => (e._pct = Math.round((e.trades.length / maxCount) * 100)));
    const mostTradedEl = document.getElementById("report-most-traded");
    mostTradedEl.innerHTML =
      leaderboardRows(byCount, (e) => `${e.trades.length}x`, () => "dim") || `<div class="empty-state small">No data yet.</div>`;
    bindTradeToggles(mostTradedEl);

    const byNet = entries.slice().sort((a, b) => b[1].net - a[1].net).slice(0, 5);
    const maxAbsNet = Math.max(1, ...byNet.map(([, e]) => Math.abs(e.net)));
    byNet.forEach(([, e]) => (e._pct = Math.round((Math.abs(e.net) / maxAbsNet) * 100)));
    const mostProfitableEl = document.getElementById("report-most-profitable");
    mostProfitableEl.innerHTML =
      leaderboardRows(byNet, (e) => fmtMoney(e.net), (e) => (e.net >= 0 ? "up" : "down")) || `<div class="empty-state small">No data yet.</div>`;
    bindTradeToggles(mostProfitableEl);
  }
  function renderSectorCountryBreakdown() {
    renderBreakdownTable("report-sector", groupByField("sector"), "Sector");
    renderBreakdownTable("report-country", groupByField("country"), "Country");
    renderBreakdownTable("report-subtype", groupByField("subtype"), "Stock type");
    renderVenueBreakdown();
  }
  // What each exchange cost you: shares executed there and the commission charged on them.
  function renderVenueBreakdown() {
    const el = document.getElementById("report-venue");
    if (!el) return;
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!t.venues || typeof t.venues !== "object") return;
      Object.entries(t.venues).forEach(([ven, v]) => {
        const e = map.get(ven) || { trades: 0, sh: 0, comm: 0 };
        e.trades += 1; e.sh += Number(v.sh) || 0; e.comm += Number(v.comm) || 0;
        map.set(ven, e);
      });
    });
    if (!map.size) { el.innerHTML = '<div class="empty-state small">No exchange data on these trades yet.</div>'; return; }
    const rows = [...map.entries()].sort((a, b) => b[1].sh - a[1].sh).map(([ven, e]) => `<tr class="report-row">
      <td style="font-weight:600;">${escapeHtml(ven)}</td><td class="mono dim">${e.trades}</td>
      <td class="mono">${Math.round(e.sh).toLocaleString()}</td><td class="mono">$${e.comm.toFixed(2)}</td>
      <td class="mono">${e.sh ? "$" + (e.comm / e.sh).toFixed(4) : "\u2014"}</td></tr>`).join("");
    el.innerHTML = `<div class="table-scroll"><table class="report-table no-stack"><thead><tr><th>Exchange</th><th class="num">Trades</th><th class="num">Shares</th><th class="num">Comm.</th><th class="num">Per sh.</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    window.paginateReportList(el, "tbody > tr");
  }
  function dayTableHtml(days) {
    if (!days.length) return `<div class="empty-state small">No data yet.</div>`;
    const rows = days.map((d) => {
      return `<tr class="report-row"${drillAttr(d.date, d.trades, { row: true, sub: "Trading day" })}>
        <td style="font-weight:600;">${d.date}</td>
        <td class="mono dim">${d.count}</td>
        <td class="mono ${d.net >= 0 ? "up" : "down"}">${fmtMoney(d.net)}</td>
      </tr>`;
    }).join("");
    return `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Date</th><th scope="col">Trades</th><th scope="col">Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function renderWinLossDays() {
    const map = dailyAgg();
    const days = Array.from(map.entries()).map(([date, e]) => ({ date, net: e.net, count: e.trades.length, trades: e.trades }));
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

    const winDayTrades = winDays.flatMap((d) => d.trades), lossDayTrades = lossDays.flatMap((d) => d.trades);
    summaryEl.innerHTML = `
      <div class="streak-strip" style="grid-template-columns:repeat(4,1fr);">
        <div class="cell"><div class="label">Winning days</div><div class="value up">${winDays.length} (${((winDays.length / days.length) * 100).toFixed(0)}%)</div></div>
        <div class="cell"><div class="label">Losing days</div><div class="value down">${lossDays.length} (${((lossDays.length / days.length) * 100).toFixed(0)}%)</div></div>
        <div class="cell"><div class="label">Avg win day</div><div class="value up">${fmtMoney(avg(winDays))}</div></div>
        <div class="cell"><div class="label">Avg loss day</div><div class="value down">${fmtMoney(avg(lossDays))}</div></div>
      </div>`;

    const winEl = document.getElementById("wld-top-win");
    winEl.innerHTML = dayTableHtml(winDays.slice().sort((a, b) => b.net - a.net).slice(0, 8));
    bindTradeToggles(winEl);
    window.paginateReportList(winEl, "tbody > tr");
    const lossEl = document.getElementById("wld-top-loss");
    lossEl.innerHTML = dayTableHtml(lossDays.slice().sort((a, b) => a.net - b.net).slice(0, 8));
    bindTradeToggles(lossEl);
    window.paginateReportList(lossEl, "tbody > tr");
  }
  // Walks the equity curve (real account balance -- `_balance`, see
  // computeAccountBalances in auth.js; already chronological) tracking the
  // running peak. A drawdown "period" runs from the last new high to the
  // next new high (or to the end of the data if it hasn't recovered).
  function computeDrawdownStats() {
    const list = App.state.trades;
    if (!list.length) return null;
    let runPeak = list[0]._balance;
    let peakIdx = 0, troughIdx = 0; // indexes into `list`, so each period knows which trades it spans
    let inDD = false;
    const periods = [];
    let maxDD = 0, maxDDPeakIdx = 0, maxDDTroughIdx = 0;

    list.forEach((t, i) => {
      if (t._balance >= runPeak) {
        if (inDD) {
          periods.push({ peak: list[peakIdx], trough: list[troughIdx], recover: t, peakIdx, troughIdx, recoverIdx: i });
          inDD = false;
        }
        runPeak = t._balance;
        peakIdx = i;
        troughIdx = i;
      } else {
        inDD = true;
        if (t._balance < list[troughIdx]._balance) troughIdx = i;
      }
      const dd = t._balance - runPeak;
      if (dd < maxDD) { maxDD = dd; maxDDPeakIdx = peakIdx; maxDDTroughIdx = i; }
    });
    if (inDD) periods.push({ peak: list[peakIdx], trough: list[troughIdx], recover: null, peakIdx, troughIdx, recoverIdx: null });

    const last = list[list.length - 1];
    const currentDD = last._balance - runPeak;
    const maxDDPeak = list[maxDDPeakIdx], maxDDTrough = list[maxDDTroughIdx];
    const maxDDPct = maxDDPeak._balance !== 0 ? (maxDD / Math.abs(maxDDPeak._balance)) * 100 : null;

    periods.forEach((p) => {
      p.size = p.trough._balance - p.peak._balance;
      // The trades that dug the hole: everything after the peak, up to the trough.
      p.trades = list.slice(p.peakIdx + 1, p.troughIdx + 1);
    });
    periods.sort((a, b) => a.size - b.size);

    return {
      maxDD, maxDDPct, maxDDPeak, maxDDTrough, currentDD, periods,
      maxDDTrades: list.slice(maxDDPeakIdx + 1, maxDDTroughIdx + 1),
      currentTrades: currentDD < 0 ? list.slice(peakIdx + 1) : [],
      // Every trade taken while underwater (peak to recovery, or to today if still down).
      underwaterTrades: periods.reduce((acc, p) => acc.concat(list.slice(p.peakIdx + 1, p.recoverIdx == null ? list.length : p.recoverIdx)), []),
    };
  }
  function renderDrawdown() {
    renderCumulativeCharts();
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
        <div class="cell"${drillAttr("Max drawdown", d.maxDDTrades, { sub: `${d.maxDDPeak.trade_date} \u2192 ${d.maxDDTrough.trade_date} \u00b7 the trades between the peak and the bottom` })}><div class="label">Max drawdown</div><div class="value down">${fmtMoney(d.maxDD)}${d.maxDDPct != null ? ` (${d.maxDDPct.toFixed(1)}%)` : ""}</div></div>
        <div class="cell"${drillAttr("Current drawdown", d.currentTrades, { sub: "Every trade since your last equity high" })}><div class="label">Current drawdown</div><div class="value ${d.currentDD < 0 ? "down" : ""}">${d.currentDD < 0 ? fmtMoney(d.currentDD) : "At peak"}</div></div>
        <div class="cell"><div class="label">Number of drawdowns</div><div class="value">${d.periods.length}</div></div>
      </div>`;

    if (!d.periods.length) {
      periodsEl.innerHTML = `<div class="empty-state small">No drawdown periods — equity has only made new highs.</div>`;
      return;
    }
    const rows = d.periods.slice(0, 10).map((p) => `<tr${drillAttr(`Drawdown ${p.peak.trade_date} \u2192 ${p.trough.trade_date}`, p.trades, { row: true, sub: `${fmtMoney(p.size)} \u00b7 trades from the peak down to the trough` })}>
        <td><a href="trade.html?id=${encodeURIComponent(p.peak.id)}">${p.peak.trade_date} <span class="dim" style="font-size:11px;">(${fmtMoney(p.peak._balance)})</span></a></td>
        <td><a href="trade.html?id=${encodeURIComponent(p.trough.id)}">${p.trough.trade_date} <span class="dim" style="font-size:11px;">(${fmtMoney(p.trough._balance)})</span></a></td>
        <td class="mono down">${fmtMoney(p.size)}</td>
        <td>${p.recover ? `<a href="trade.html?id=${encodeURIComponent(p.recover.id)}">${p.recover.trade_date}</a>` : `<span class="dim">Ongoing</span>`}</td>
      </tr>`).join("");
    periodsEl.innerHTML = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Peak</th><th scope="col">Trough</th><th scope="col">Drawdown</th><th scope="col">Recovered</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    window.paginateReportList(periodsEl, "tbody > tr");
  }
  function periodStats(startDate, endDate) {
    if (!startDate || !endDate) return null;
    const subset = App.state.trades.filter((t) => t.trade_date >= startDate && t.trade_date <= endDate);
    if (!subset.length) return null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    const wins = subset.filter((t) => t.win);
    const losses = subset.filter((t) => !t.win);
    const sum = (arr, f) => arr.reduce((s, t) => s + f(t), 0);
    const net = sum(subset, (t) => num(t.pnl_after_comm));
    const gross = sum(subset, (t) => num(t.pnl_before_comm));
    const commissions = sum(subset, (t) => num(t.commission));
    const winRate = (wins.length / subset.length) * 100;
    const grossWinSum = sum(wins, (t) => num(t.pnl_after_comm));
    const lossSum = sum(losses, (t) => num(t.pnl_after_comm));
    // null (shown as "—") when the period has no winners / no losers, rather than a fake $0.00.
    const avgWin = wins.length ? grossWinSum / wins.length : null;
    const avgLoss = losses.length ? lossSum / losses.length : null;
    const grossLossSum = Math.abs(lossSum);
    // Break-even win rate for this period's payoff (avg win vs avg loss) and how far the actual win rate is from it.
    const breakeven = avgWin != null && avgLoss != null && avgWin > 0 && avgLoss < 0 ? (-avgLoss / (avgWin - avgLoss)) * 100 : null;
    const profitFactor = grossLossSum > 0 ? grossWinSum / grossLossSum : (grossWinSum > 0 ? Infinity : 0);
    const payoffRatio = avgWin != null && avgLoss != null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null;
    const pnls = subset.map((t) => num(t.pnl_after_comm));
    // reduce, not Math.max(...arr): spreading a very large array can overflow the call stack.
    const maxOf = (arr) => arr.reduce((m, v) => (v > m ? v : m), -Infinity);
    const minOf = (arr) => arr.reduce((m, v) => (v < m ? v : m), Infinity);
    // Per-day nets, for the day-level rows (best/worst day, winning-day %).
    const byDay = new Map();
    subset.forEach((t) => byDay.set(t.trade_date, (byDay.get(t.trade_date) || 0) + num(t.pnl_after_comm)));
    const dayNets = Array.from(byDay.values());
    const holds = subset.map((t) => App.durationMinutes(t)).filter((m) => m != null);
    // Trade sets behind the special rows (best/worst day, biggest win...), for click-through.
    const dayEntries = Array.from(byDay.entries());
    const pickDay = (better) => {
      const e = dayEntries.reduce((m, x) => (better(x[1], m[1]) ? x : m), dayEntries[0]);
      return subset.filter((t) => t.trade_date === e[0]);
    };
    const sets = {
      wins, losses,
      bestWin: subset.filter((t) => num(t.pnl_after_comm) === maxOf(pnls)),
      worstLoss: subset.filter((t) => num(t.pnl_after_comm) === minOf(pnls)),
      bestDay: pickDay((a, b) => a > b),
      worstDay: pickDay((a, b) => a < b),
      winDays: subset.filter((t) => byDay.get(t.trade_date) > 0),
    };
    return {
      trades: subset, sets,
      n: subset.length,
      days: dayNets.length,
      net, gross, commissions, winRate, avgWin, avgLoss, profitFactor, payoffRatio,
      breakeven, cushion: breakeven == null ? null : winRate - breakeven,
      expectancy: net / subset.length,
      largestWin: maxOf(pnls),
      largestLoss: minOf(pnls),
      tradesPerDay: subset.length / dayNets.length,
      avgPerDay: net / dayNets.length,
      winningDayPct: (dayNets.filter((d) => d > 0).length / dayNets.length) * 100,
      bestDay: maxOf(dayNets),
      worstDay: minOf(dayNets),
      avgHold: holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : null,
      avgShares: sum(subset, (t) => num(t.shares)) / subset.length,
    };
  }
  // One row per metric. `better` says which direction of change is good
  // ("up" = higher is better, "down" = lower is better, null = neutral, so
  // the Change column only colors a difference when it clearly helps or
  // hurts). Every metric here is signed such that "higher = better" holds
  // except commissions.
  const COMPARE_ROWS = [
    { label: "Trading days", key: "days", kind: "int" },
    { label: "Trades", key: "n", kind: "int" },
    { label: "Trades per day", key: "tradesPerDay", kind: "dec1" },
    { label: "Net P&amp;L", key: "net", kind: "money", better: "up", bold: true },
    { label: "Gross P&amp;L", key: "gross", kind: "money", better: "up" },
    { label: "Commissions", key: "commissions", kind: "moneyAbs", better: "down" },
    { label: "Avg P&amp;L per day", key: "avgPerDay", kind: "money", better: "up" },
    { label: "Win rate", key: "winRate", kind: "pct", better: "up" },
    { label: "Break-even win rate", key: "breakeven", kind: "pct", better: "down" },
    { label: "Win rate vs break-even", key: "cushion", kind: "pp", better: "up" },
    { label: "Winning days", key: "winningDayPct", kind: "pct", better: "up" },
    { label: "Avg win", key: "avgWin", kind: "money", better: "up" },
    { label: "Avg loss", key: "avgLoss", kind: "money", better: "up" },
    { label: "Win/loss ratio", key: "payoffRatio", kind: "dec2", better: "up" },
    { label: "Profit factor", key: "profitFactor", kind: "dec2", better: "up" },
    { label: "Expectancy per trade", key: "expectancy", kind: "money", better: "up" },
    { label: "Largest win", key: "largestWin", kind: "money", better: "up" },
    { label: "Largest loss", key: "largestLoss", kind: "money", better: "up" },
    { label: "Best day", key: "bestDay", kind: "money", better: "up" },
    { label: "Worst day", key: "worstDay", kind: "money", better: "up" },
    { label: "Avg hold time", key: "avgHold", kind: "duration" },
    { label: "Avg shares per trade", key: "avgShares", kind: "int" },
  ];
  function compareFormat(kind, v) {
    if (v == null || Number.isNaN(v)) return "\u2014";
    if (v === Infinity) return "\u221e";
    switch (kind) {
      case "int": return Math.round(v).toLocaleString();
      case "dec1": return v.toFixed(1);
      case "dec2": return v.toFixed(2);
      case "pct": return v.toFixed(1) + "%";
      case "pp": return (v >= 0 ? "+" : "\u2212") + Math.abs(v).toFixed(1) + " pts";
      case "money": return fmtMoney(v);
      case "moneyAbs": return "$" + v.toFixed(2);
      case "duration": return App.fmtDurationPrecise(v);
      default: return String(v);
    }
  }
  function compareDeltaHtml(row, a, b) {
    const av = a ? a[row.key] : null, bv = b ? b[row.key] : null;
    if (av == null || bv == null || !Number.isFinite(av) || !Number.isFinite(bv)) return `<span class="dim">\u2014</span>`;
    const diff = bv - av;
    if (Math.abs(diff) < 1e-9) return `<span class="dim">0</span>`;
    const sign = diff > 0 ? "+" : "-";
    const mag = Math.abs(diff);
    let text;
    switch (row.kind) {
      case "money": text = sign + "$" + mag.toFixed(2); break;
      case "moneyAbs": text = sign + "$" + mag.toFixed(2); break;
      case "pct": case "pp": text = sign + mag.toFixed(1) + " pp"; break;
      case "dec1": text = sign + mag.toFixed(1); break;
      case "dec2": text = sign + mag.toFixed(2); break;
      case "duration": text = sign + App.fmtDurationPrecise(mag); break;
      default: text = sign + Math.round(mag).toLocaleString();
    }
    let cls = "dim";
    if (row.better === "up") cls = diff > 0 ? "up" : "down";
    else if (row.better === "down") cls = diff > 0 ? "down" : "up";
    return `<span class="${cls}">${text}</span>`;
  }
  // Which trades a Compare cell should open: the specific winners / losers /
  // day behind the metric where there is one, otherwise the whole period.
  function compareSet(st, key) {
    switch (key) {
      case "avgWin": return st.sets.wins;
      case "avgLoss": return st.sets.losses;
      case "largestWin": return st.sets.bestWin;
      case "largestLoss": return st.sets.worstLoss;
      case "bestDay": return st.sets.bestDay;
      case "worstDay": return st.sets.worstDay;
      case "winningDayPct": return st.sets.winDays;
      default: return st.trades;
    }
  }
  function periodStatsHtml(a, b, ranges) {
    if (!a && !b) return `<div class="empty-state small">No trades in either date range.</div>`;
    const cell = (s, row, which) => {
      const txt = s ? compareFormat(row.kind, s[row.key]) : "\u2014";
      const da = ""; // compare cells: the period is already your own date range
      // Color the signed-money rows green/red by sign; everything else stays neutral.
      const cls = s && (row.kind === "money" || row.kind === "pp") && Number.isFinite(s[row.key]) ? (s[row.key] >= 0 ? " up" : " down") : "";
      return `<td class="mono num${cls}${row.bold ? " strong" : ""}"${da}>${txt}</td>`;
    };
    // The Change column opens both periods' trades for that metric together
    // (a trade that falls in both ranges is only listed once).
    const bothSets = (row) => {
      if (!a || !b) return [];
      const seen = new Set(), out = [];
      compareSet(a, row.key).concat(compareSet(b, row.key)).forEach((t) => {
        const k = t.id != null ? t.id : t;
        if (!seen.has(k)) { seen.add(k); out.push(t); }
      });
      return out;
    };
    const rows = COMPARE_ROWS.map((row) => `<tr>
        <td>${row.label}</td>${cell(a, row, "Period A")}${cell(b, row, "Period B")}
        <td class="mono num">${compareDeltaHtml(row, a, b)}</td>
      </tr>`).join("");
    const note = (!a || !b) ? `<div class="dim" style="font-size:12px;margin-bottom:8px;">No trades in ${!a ? "Period A" : "Period B"}'s date range.</div>` : "";
    return `${note}<div class="table-scroll"><table class="report-table compare-table"><thead><tr>
      <th scope="col">Metric</th>
      <th scope="col" class="num">Period A<span class="range">${escapeHtml(ranges.a)}</span></th>
      <th scope="col" class="num">Period B<span class="range">${escapeHtml(ranges.b)}</span></th>
      <th scope="col" class="num">Change (B vs A)</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function updateCompare() {
    const el = document.getElementById("compare-table");
    if (!el) return;
    const aS = document.getElementById("cmp-a-start").value, aE = document.getElementById("cmp-a-end").value;
    const bS = document.getElementById("cmp-b-start").value, bE = document.getElementById("cmp-b-end").value;
    el.innerHTML = periodStatsHtml(periodStats(aS, aE), periodStats(bS, bE), {
      a: aS && aE ? `${aS} \u2192 ${aE}` : "no range",
      b: bS && bE ? `${bS} \u2192 ${bE}` : "no range",
    });
  }
  function renderCompare() {
    if (!App.state.trades.length) { updateCompare(); return; }
    const aStartEl = document.getElementById("cmp-a-start");
    // Only seed defaults once — don't clobber a range the person already picked.
    if (aStartEl && !aStartEl.value) {
      const first = App.state.trades[0].trade_date, last = App.state.trades[App.state.trades.length - 1].trade_date;
      const midDate = App.state.trades[Math.floor(App.state.trades.length / 2)].trade_date;
      aStartEl.value = first;
      document.getElementById("cmp-a-end").value = midDate;
      document.getElementById("cmp-b-start").value = midDate;
      document.getElementById("cmp-b-end").value = last;
    }
    updateCompare();
  }
  Object.assign(R, { renderReports, updateCompare });
})();
