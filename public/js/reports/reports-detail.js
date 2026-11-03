(function () {
  "use strict";
  const R = (App.reports = App.reports || {});
  const { DOW, dailyAgg, drillAttr, drillNum, drillStamp, fmtAxisMoney, groupByField, renderBreakdownTable, renderMiniLineChart, renderPairedHistogram, streakInfo, svgAxisBarChart, svgDonutChart, symbolAgg, unescHtml } = R;

  function groupByTagArray(field) {
    const map = new Map();
    let any = false;
    App.state.trades.forEach((t) => {
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
  function computeAdvancedStats() {
    if (!App.state.trades.length) return null;
    const s = App.computeStats();
    const n = App.state.trades.length;
    const commPctOfGross = s.grossPnl !== 0 ? (s.totalComm / Math.abs(s.grossPnl)) * 100 : null;
    const tradesPerDay = s.dayCount ? n / s.dayCount : null;

    const dayVals = Array.from(dailyAgg().values()).map((e) => e.net);
    const dayMean = dayVals.reduce((a, b) => a + b, 0) / dayVals.length;
    const daySd = stdev(dayVals);
    const dailySharpe = daySd ? dayMean / daySd : null;

    let curSign = 0, curStreakSum = 0, curStart = 0, bestWinStreakSum = 0, worstLossStreakSum = 0;
    let bwStart = -1, bwEnd = -1, wlStart = -1, wlEnd = -1; // where the best/worst $ streak sits in the list
    App.state.trades.forEach((t, i) => {
      const sign = t.pnl_after_comm >= 0 ? 1 : -1;
      if (sign === curSign) curStreakSum += t.pnl_after_comm;
      else { curSign = sign; curStreakSum = t.pnl_after_comm; curStart = i; }
      if (curSign === 1) {
        if (curStreakSum > bestWinStreakSum) { bestWinStreakSum = curStreakSum; bwStart = curStart; bwEnd = i; }
      } else if (curStreakSum < worstLossStreakSum) { worstLossStreakSum = curStreakSum; wlStart = curStart; wlEnd = i; }
    });

    const allHold = App.state.trades.map(App.durationMinutes).filter((v) => v != null);
    const avgHoldAll = allHold.length ? allHold.reduce((a, b) => a + b, 0) / allHold.length : null;

    return {
      commPctOfGross, tradesPerDay, dailySharpe, dayMean, daySd, bestWinStreakSum, worstLossStreakSum, avgHoldAll,
      bestWinStreakTrades: bwStart >= 0 ? App.state.trades.slice(bwStart, bwEnd + 1) : [],
      worstLossStreakTrades: wlStart >= 0 ? App.state.trades.slice(wlStart, wlEnd + 1) : [],
    };
  }
  function renderAdvanced() {
    const d = computeAdvancedStats();
    const el = document.getElementById("advanced-grid");
    if (!d) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const all = App.state.trades;
    const paid = all.filter((t) => Number(t.commission) > 0);
    const s = App.computeStats();
    const withHold = all.filter((t) => App.durationMinutes(t) != null);
    const rows = [
      ["Commissions as % of Gross P&amp;L", d.commPctOfGross != null ? `<span class="v mono">${d.commPctOfGross.toFixed(1)}%</span>` : naCell("No gross P&L to compare against."), paid, "Trades that paid commission", { focus: "comm", calc: [["Commissions", "$" + s.totalComm.toFixed(2)], ["Gross P&L (before commissions)", dm(s.grossPnl)], ["Commissions as % of gross", d.commPctOfGross != null ? d.commPctOfGross.toFixed(1) + "%" : ""]] }],
      ["Avg Trades per Trading Day", d.tradesPerDay != null ? `<span class="v mono">${d.tradesPerDay.toFixed(1)}</span>` : naCell("No trading days recorded."), null, "Every trade in this view", { calc: [["Trades", String(all.length)], ["Trading days", String(s.dayCount)], ["Per day", d.tradesPerDay != null ? d.tradesPerDay.toFixed(1) : ""]] }],
      ["Daily Sharpe (un-annualized)", d.dailySharpe != null ? `<span class="v mono" title="Mean divided by standard deviation of daily net P&amp;L — not annualized, not risk-free-rate adjusted.">${d.dailySharpe.toFixed(2)}</span>` : naCell("Not enough trading days yet."), all, "Average day vs how much days swing", { collapse: true, calc: [["Trading days", String(s.dayCount)], ["Average day", dm(d.dayMean)], ["Std deviation of days", "$" + d.daySd.toFixed(2)], ["Sharpe", d.dailySharpe != null ? d.dailySharpe.toFixed(2) : ""]], note: "Average daily net P&L divided by its standard deviation. Not annualized." }],
      ["Best Win Streak ($)", `<span class="v up mono">${fmtMoney(d.bestWinStreakSum)}</span>`, d.bestWinStreakTrades, "The run of trades that made the most money", { order: "chrono", calc: runCalc(d.bestWinStreakTrades, "Run", true), note: "Listed oldest first — the run of winning trades that added up to the most money." }],
      ["Worst Loss Streak ($)", `<span class="v down mono">${fmtMoney(d.worstLossStreakSum)}</span>`, d.worstLossStreakTrades, "The run of trades that lost the most money", { order: "chrono", calc: runCalc(d.worstLossStreakTrades, "Run", true), note: "Listed oldest first — the run of losing trades that added up to the most lost." }],
      ["Average Hold Time (all trades)", `<span class="v mono">${fmtDuration(d.avgHoldAll)}</span>`, withHold, "Trades that have a hold time", { focus: "hold", calc: holdCalc(withHold, all.length) }],
    ];
    el.innerHTML = rows.map(([k, v, set, sub, extra]) => `<div class="stat-line"${set ? drillAttr(unescHtml(k), set, { sub, row: true, ...(extra || {}) }) : ""}><span class="k">${k}</span>${v}</div>`).join("");
  }
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
  // Regression slope / standard-error-of-slope of the equity curve against
  // trade index — a rough, un-annualized "consistency of the equity curve"
  // figure in the same spirit as a K-Ratio, computed straight off
  // equity_after (nothing else in the schema tracks daily equity).
  function computeKRatio() {
    const y = App.state.trades.map((t) => t.equity_after);
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
    const s = App.computeStats();
    const n = App.state.trades.length;
    const pnls = App.state.trades.map((t) => t.pnl_after_comm);
    const largestGain = Math.max(...pnls);
    const largestLoss = Math.min(...pnls);
    const avgDailyGainLoss = s.dayCount ? s.netPnl / s.dayCount : 0;
    const avgTradeGainLoss = n ? s.netPnl / n : 0;

    const perShare = App.state.trades.filter((t) => t.shares).map((t) => t.pnl_after_comm / t.shares);
    const avgPerShare = perShare.length ? perShare.reduce((a, b) => a + b, 0) / perShare.length : null;

    const scratch = App.state.trades.filter((t) => t.pnl_after_comm === 0);
    const avgOf = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const holdWinAvg = avgOf(s.wins.map(App.durationMinutes).filter((v) => v != null));
    const holdLossAvg = avgOf(s.losses.map(App.durationMinutes).filter((v) => v != null));
    const holdScratchAvg = avgOf(scratch.map(App.durationMinutes).filter((v) => v != null));

    let bestWin = 0, bestLoss = 0, curWin = 0, curLoss = 0;
    App.state.trades.forEach((t) => {
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
  // ---- drill-down "how this number is made" helpers (Detailed / Advanced stat rows) ----
  const dm = (v) => fmtMoney(v);
  const dsum = (arr) => arr.reduce((a, t) => a + drillNum(t.pnl_after_comm), 0);
  // The run of trades behind a streak: how long, when, and what it made or lost.
  function runCalc(trades, noun, withCount) {
    if (!trades.length) return null;
    const first = trades.reduce((a, t) => (drillStamp(t) < drillStamp(a) ? t : a), trades[0]);
    const last = trades.reduce((a, t) => (drillStamp(t) > drillStamp(a) ? t : a), trades[0]);
    return [...(withCount ? [[noun, `${trades.length} in a row`]] : []), ["From", first.trade_date || "—"], ["To", last.trade_date || "—"], ["Net P&L", dm(dsum(trades))]];
  }
  function holdCalc(set, total) {
    const v = set.map(App.durationMinutes).filter((x) => x != null);
    if (!v.length) return null;
    const rows = [["Trades with a hold time", String(v.length)], ["Average hold", fmtDuration(v.reduce((a, b) => a + b, 0) / v.length)], ["Longest", fmtDuration(Math.max(...v))], ["Shortest", fmtDuration(Math.min(...v))]];
    if (total != null && total > v.length) rows.push(["Left out (no exit time)", String(total - v.length)]);
    return rows;
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

    // [label, value html, trades behind it, one-line note for the panel]
    const all = App.state.trades;
    const scratch = all.filter((t) => t.pnl_after_comm === 0);
    const withHold = (arr) => arr.filter((t) => App.durationMinutes(t) != null);
    const si = streakInfo(all);
    const mean = d.avgTradeGainLoss;
    const winSum = dsum(d.wins), lossSum = dsum(d.losses);
    const tstat = d.n && d.sd ? mean / (d.sd / Math.sqrt(d.n)) : null;
    const R = d.avgLoss !== 0 ? d.avgWin / Math.abs(d.avgLoss) : null;
    const wr = d.n ? (d.wins.length / d.n) * 100 : 0;
    const withShares = all.filter((t) => t.shares);
    const paid = all.filter((t) => Number(t.commission) > 0);
    const feeTrades = all.filter((t) => Number(t.fees) > 0);
    const hasFeeCol = all.some((t) => t.fees != null);
    const totalFees = all.reduce((n, t) => n + (Number(t.fees) || 0), 0);
    const paidShares = paid.reduce((n, t) => n + 2 * (Number(t.shares) || 0), 0); // each share is executed twice: in and out
    const grossAll = all.reduce((n, t) => n + (Number(t.pnl_before_comm) || 0), 0);
    const streakNote = (what) => `Listed oldest first \u2014 ${what}`;
    const rows = [
      ["Total Gain/Loss", moneyCell(d.netPnl), all, "Every trade in this view", { calc: [["Winners", dm(winSum)], ["Losers", dm(lossSum)], ["Net (after commissions)", dm(d.netPnl)]] }],
      ["Largest Gain", moneyCell(d.largestGain), all.filter((t) => t.pnl_after_comm === d.largestGain), "Your best trade"],
      ["Largest Loss", moneyCell(d.largestLoss), all.filter((t) => t.pnl_after_comm === d.largestLoss), "Your worst trade"],
      ["Average Daily Gain/Loss", moneyCell(d.avgDailyGainLoss), all, `Averaged over ${d.dayCount} trading day${d.dayCount === 1 ? "" : "s"}`, { calc: [["Net P&L", dm(d.netPnl)], ["Trading days", String(d.dayCount)], ["Per day", dm(d.avgDailyGainLoss)]] }],
      ["Average Daily Volume", naCell("Needs each symbol's daily market volume flattened onto each trade — not in the schema yet.")],
      ["Average Per-share Gain/Loss", d.avgPerShare != null ? moneyCell(d.avgPerShare) : naCell("No trades with a share count."), withShares, "Trades with a share count", { focus: "share", calc: [["Trades with shares", String(withShares.length)], ["Average per share", d.avgPerShare != null ? dm(d.avgPerShare) : ""]], note: "Each trade's net P&L divided by its share count, then averaged." }],
      ["Average Trade Gain/Loss", moneyCell(d.avgTradeGainLoss), null, "Every trade in this view", { calc: [["Net P&L", dm(d.netPnl)], ["Trades", String(d.n)], ["Per trade", dm(mean)]] }],
      ["Average Winning Trade", moneyCell(d.avgWin), d.wins, "Winners", { calc: [["Winners", String(d.wins.length)], ["Total won", dm(winSum)], ["Average", dm(d.avgWin)]] }],
      ["Average Losing Trade", moneyCell(d.avgLoss), d.losses, "Losers", { calc: [["Losers", String(d.losses.length)], ["Total lost", dm(lossSum)], ["Average", dm(d.avgLoss)]] }],
      ["Total Number of Trades", `<span class="v">${d.n}</span>`, null, "Every trade in this view"],
      ["Number of Winning Trades", `<span class="v up">${d.wins.length} (${winPct.toFixed(1)}%)</span>`, null, "Winners", { calc: [["Winners", `${d.wins.length} of ${d.n}`], ["Win rate", winPct.toFixed(1) + "%"]] }],
      ["Number of Losing Trades", `<span class="v down">${d.losses.length} (${lossPct.toFixed(1)}%)</span>`, null, "Losers", { calc: [["Losers", `${d.losses.length} of ${d.n}`], ["Loss rate", lossPct.toFixed(1) + "%"]] }],
      ["Average Hold Time (scratch trades)", `<span class="v mono">${fmtDuration(d.holdScratchAvg)}</span>`, withHold(scratch), "Scratch trades that have a hold time", { focus: "hold", calc: holdCalc(scratch, scratch.length) }],
      ["Average Hold Time (winning trades)", `<span class="v mono">${fmtDuration(d.holdWinAvg)}</span>`, withHold(d.wins), "Winners that have a hold time", { focus: "hold", calc: holdCalc(d.wins, d.wins.length) }],
      ["Average Hold Time (losing trades)", `<span class="v mono">${fmtDuration(d.holdLossAvg)}</span>`, withHold(d.losses), "Losers that have a hold time", { focus: "hold", calc: holdCalc(d.losses, d.losses.length) }],
      ["Number of Scratch Trades", `<span class="v">${d.scratchCount}</span>`, scratch, "Trades that closed at exactly $0"],
      ["Max Consecutive Wins", `<span class="v up">${d.bestWin}</span>`, si.bestWin, "Your longest winning streak", { order: "chrono", calc: runCalc(si.bestWin, "Winning streak"), note: streakNote("the longest unbroken run of winners.") }],
      ["Max Consecutive Losses", `<span class="v down">${d.bestLoss}</span>`, si.bestLoss, "Your longest losing streak", { order: "chrono", calc: runCalc(si.bestLoss, "Losing streak"), note: streakNote("the longest unbroken run of losers.") }],
      ["Trade P&amp;L Standard Deviation", `<span class="v mono">$${d.sd.toFixed(2)}</span>`, all, "How spread out your trade results are", { collapse: true, calc: [["Average trade", dm(mean)], ["Standard deviation", "$" + d.sd.toFixed(2)], ["Typical trade lands between", `${dm(mean - d.sd)} and ${dm(mean + d.sd)}`], ["Trades", String(d.n)]], note: "A bigger number means your results swing more from trade to trade." }],
      ["System Quality Number (SQN)", d.sqn != null ? `<span class="v mono" title="PnL-based SQN, not R-multiple-based.">${d.sqn.toFixed(2)}</span>` : naCell("Not enough trades yet."), all, "Average trade vs how much results swing", { collapse: true, calc: [["Trades", String(d.n)], ["Average trade", dm(mean)], ["Standard deviation", "$" + d.sd.toFixed(2)], ["SQN", d.sqn != null ? d.sqn.toFixed(2) : ""]], note: "SQN = √trades × average trade ÷ standard deviation. Higher means a steadier edge." }],
      ["Probability of Random Chance", d.pRandom != null ? `<span class="v mono" title="Approximate — normal-approximation two-tailed p-value.">${(d.pRandom * 100).toFixed(1)}%</span>` : naCell("Not enough trades yet."), all, "How likely these results are luck", { collapse: true, calc: [["Trades", String(d.n)], ["Average trade", dm(mean)], ["t-statistic", tstat != null ? tstat.toFixed(2) : ""], ["Chance it's luck", d.pRandom != null ? (d.pRandom * 100).toFixed(1) + "%" : ""]], note: "The odds of an average this far from $0 if your trades had no real edge." }],
      ["Kelly Percentage", d.kelly != null ? `<span class="v mono">${d.kelly.toFixed(1)}%</span>` : naCell("Needs both wins and losses to compute."), all, "Bet size the win rate and payoff imply", { collapse: true, calc: [["Win rate", wr.toFixed(1) + "%"], ["Average win", dm(d.avgWin)], ["Average loss", dm(d.avgLoss)], ["Win / loss ratio", R != null ? R.toFixed(2) : ""], ["Kelly", d.kelly != null ? d.kelly.toFixed(1) + "%" : ""]], note: "Kelly = win rate − (1 − win rate) ÷ win/loss ratio." }],
      ["K-Ratio", d.kr != null ? `<span class="v mono" title="Trade-level, un-annualized.">${d.kr.toFixed(2)}</span>` : naCell("Not enough trades yet."), all, "How steadily your equity curve climbs", { collapse: true, calc: [["Trades", String(d.n)], ["K-Ratio", Number.isFinite(d.kr) ? d.kr.toFixed(2) : ""]], note: "The slope of your equity curve divided by how noisy it is. Higher means a smoother climb." }],
      ["Profit Factor", `<span class="v mono">${d.profitFactor === Infinity ? "∞" : d.profitFactor.toFixed(2)}</span>`, all, "Gross wins ÷ gross losses", { collapse: true, calc: [["Gross wins", dm(winSum)], ["Gross losses", dm(lossSum)], ["Profit factor", d.profitFactor === Infinity ? "∞" : d.profitFactor.toFixed(2)]], note: "Above 1.00 means winners outweigh losers in dollars." }],
      ["Total Commissions", `<span class="v mono">$${d.totalComm.toFixed(2)}</span>`, paid, "Trades that paid commission", { focus: "comm", calc: [["Total paid", "$" + d.totalComm.toFixed(2)], ["Trades that paid", String(paid.length)], ["Average per trade", paid.length ? "$" + (d.totalComm / paid.length).toFixed(2) : ""]] }],
      ["Commission per Share", paidShares > 0 ? `<span class="v mono">$${(d.totalComm / paidShares).toFixed(4)}</span>` : naCell("No shares on trades that paid commission."), paid, "What each executed share cost in commission", { focus: "comm", calc: [["Total paid", "$" + d.totalComm.toFixed(2)], ["Shares executed (in + out)", paidShares.toLocaleString()], ["Per share", paidShares > 0 ? "$" + (d.totalComm / paidShares).toFixed(4) : ""]], note: "Total commission divided by shares executed (every share is bought and sold, so counted twice) \u2014 the same per-share rate your broker charges." }],
      ["Commission % of Gross P&amp;L", grossAll > 0 ? `<span class="v mono">${(d.totalComm / grossAll * 100).toFixed(1)}%</span>` : naCell("Gross P&L isn't positive, so a percentage isn't meaningful."), paid, "How much of what you made went to commission", { focus: "flip", calc: [["Gross P&L", dm(grossAll)], ["Commission", "$" + d.totalComm.toFixed(2)], ["Net P&L", dm(grossAll - d.totalComm)], ["Share of gross", grossAll > 0 ? (d.totalComm / grossAll * 100).toFixed(1) + "%" : ""]], note: "Commission divided by gross P&L (before commission)." }],
      ["Total Fees", feeTrades.length || hasFeeCol ? `<span class="v mono">$${totalFees.toFixed(2)}</span>` : naCell("No fee data saved yet \u2014 it comes from the statement's taxes / fees section on the next sync or re-import."), feeTrades, "SEC / FINRA and similar fees on your orders", { focus: "fees", calc: [["Total fees", "$" + totalFees.toFixed(2)], ["Trades that paid fees", String(feeTrades.length)], ["Commission + fees", "$" + (d.totalComm + totalFees).toFixed(2)]], note: "Kept separate: fees are not part of the commission or net P&L figures." }],
      ["Average Position MAE", naCell("Needs intrabar adverse-excursion tracking not in the current schema.")],
      ["Average Position MFE", naCell("Needs intrabar favorable-excursion tracking not in the current schema.")],
    ];

    document.getElementById("detailed-stat-grid").innerHTML = rows
      .map(([k, v, set, sub, extra]) => `<div class="stat-line"${set ? drillAttr(unescHtml(k), set, { sub, row: true, ...(extra || {}) }) : ""}><span class="k">${k}</span>${v}</div>`)
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
      return `<tr class="report-row"${drillAttr(b.label, b.trades, { row: true, sub: labelHeader })}>
        <td style="font-weight:600;">${escapeHtml(b.label)}</td>
        <td class="mono dim">${b.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${net >= 0 ? "up" : "down"}">${fmtMoney(net)}</span></td>
      </tr>`;
    }).join("");
    return `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">${escapeHtml(labelHeader)}</th><th scope="col">Trades</th><th scope="col">Win %</th><th scope="col">Net P&amp;L</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  // bucketBreakdownTableHtml returns markup with the toggle rows baked in,
  // but the click handlers still need binding after each caller drops the
  // string into the DOM via innerHTML — this wraps that so every call site
  // gets the same treatment in one line.
  function setBucketBreakdownHtml(elId, buckets, labelHeader) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = bucketBreakdownTableHtml(buckets, labelHeader);
    bindTradeToggles(el);
    window.paginateReportList(el, "tbody > tr");
  }
  function renderDetailSubtabs() {
    App.safeRender(renderDetailHour, "renderDetailHour");
    App.safeRender(renderDetailPrice, "renderDetailPrice");
    App.safeRender(renderDetailSize, "renderDetailSize");
    App.safeRender(renderDetailSymbolTop20Bottom20, "renderDetailSymbolTop20Bottom20");
    App.safeRender(renderDetailSide, "renderDetailSide");
    App.safeRender(renderDetailSetup, "renderDetailSetup");
    App.safeRender(renderDetailLessons, "renderDetailLessons");
    App.safeRender(renderDetailWinLossRatio, "renderDetailWinLossRatio");
    App.safeRender(renderDetailDistribution, "renderDetailDistribution");
    App.safeRender(renderDetailExpectancy, "renderDetailExpectancy");
    App.safeRender(renderDetailRvol, "renderDetailRvol");
    App.safeRender(renderDetailAvgVol, "renderDetailAvgVol");
    App.safeRender(() => renderBreakdownTable("detail-float", groupByField("float_tag"), "Float"), "renderBreakdownTable(detail-float)");
  }
  // ---- Days/Times ----
  function renderDetailDow() {
    const byDow = new Map();
    App.state.trades.forEach((t) => {
      const dow = new Date(t.trade_date + "T12:00:00").getDay();
      if (!byDow.has(dow)) byDow.set(dow, { label: DOW[dow], trades: [] });
      byDow.get(dow).trades.push(t);
    });
    const order = [1, 2, 3, 4, 5, 0, 6];
    const buckets = order.filter((d) => byDow.has(d)).map((d) => byDow.get(d));
    setBucketBreakdownHtml("detail-dow", buckets, "Day");
  }
  function renderDetailHour() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      // No entry time -> no hour to put it in. Skip it rather than throw
      // (which used to blank this whole breakdown).
      if (typeof t.entry_time !== "string" || t.entry_time.length < 2) return;
      const label = t.entry_time.slice(0, 2) + ":00";
      if (!map.has(label)) map.set(label, { label, trades: [] });
      map.get(label).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
    setBucketBreakdownHtml("detail-hour", buckets, "Hour");
  }
  // ---- Price/Volume ----
  const PRICE_BUCKETS = [
    { label: "< $2", max: 2 }, { label: "$2 – $4.99", max: 4.99 }, { label: "$5 – $9.99", max: 9.99 },
    { label: "$10 – $19.99", max: 19.99 }, { label: "$20 – $49.99", max: 49.99 }, { label: "$50 – $99.99", max: 99.99 },
    { label: "$100 – $199.99", max: 199.99 }, { label: "$200 – $499.99", max: 499.99 }, { label: "$500+", max: Infinity },
  ];
  function renderDetailPrice() {
    const buckets = PRICE_BUCKETS.map((b) => ({ ...b, trades: [] }));
    App.state.trades.forEach((t) => {
      // A missing price would otherwise coerce to 0 and land in the "< $2"
      // bucket (null <= 2 is true), quietly skewing that row. Skip it.
      if (t.entry_price == null || !Number.isFinite(Number(t.entry_price))) return;
      const bucket = buckets.find((b) => t.entry_price <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    renderPairedHistogram("detail-price-dist", "detail-price-perf", buckets, { labelW: 96, context: "Entry price" });
  }
  const SIZE_BUCKETS = [
    { label: "< 20", max: 20 }, { label: "20 – 49", max: 49 }, { label: "50 – 99", max: 99 },
    { label: "100 – 500", max: 500 }, { label: "500 – 1,000", max: 1000 }, { label: "1,000 – 2,500", max: 2500 },
    { label: "2,500 – 5,000", max: 5000 }, { label: "5,000 – 10,000", max: 10000 }, { label: "10,000+", max: Infinity },
  ];
  function renderDetailSize() {
    const buckets = SIZE_BUCKETS.map((b) => ({ ...b, trades: [] }));
    App.state.trades.forEach((t) => {
      const bucket = buckets.find((b) => t.shares <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    renderPairedHistogram("detail-size-dist", "detail-size-perf", buckets, { labelW: 96, context: "Position size (shares)" });
  }
  // ---- Instrument ----
  function renderDetailSymbolTable() {
    const map = symbolAgg();
    const buckets = Array.from(map.entries())
      .map(([sym, e]) => ({ label: sym, trades: e.trades }))
      .sort((a, b) => b.trades.length - a.trades.length)
      .slice(0, 10);
    setBucketBreakdownHtml("detail-symbol", buckets, "Symbol");
  }
  // Performance by symbol, Top 20 / Bottom 20 by net P&L -- Tradervue's
  // signature Instrument-tab chart. Every symbol with at least one
  // trade is eligible; a symbol only ever appears on one side (its own
  // net P&L is either >= 0 or < 0, never both).
  function renderDetailSymbolTop20Bottom20() {
    const map = symbolAgg();
    const entries = Array.from(map.entries()).map(([sym, e]) => ({
      label: sym, net: e.net, trades: e.trades,
    }));
    const winners = entries.filter((e) => e.net >= 0).sort((a, b) => b.net - a.net).slice(0, 20);
    const losers = entries.filter((e) => e.net < 0).sort((a, b) => a.net - b.net).slice(0, 20).reverse();

    const chartFor = (elId, rows, color) => {
      const el = document.getElementById(elId);
      if (!el) return;
      if (!rows.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
      el.innerHTML = svgAxisBarChart(
        rows.map((r) => ({ label: r.label, value: r.net, color, trades: r.trades })),
        { fmt: fmtAxisMoney, labelW: 60, barHeight: 15, context: "Symbol" }
      );
    };
    chartFor("detail-symbol-top20", winners, "var(--green)");
    chartFor("detail-symbol-bottom20", losers, "var(--red)");
  }
  function renderDetailSide() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      const side = t.side || "unknown";
      if (!map.has(side)) map.set(side, { label: side, trades: [] });
      map.get(side).trades.push(t);
    });
    setBucketBreakdownHtml("detail-side", Array.from(map.values()), "Side");
  }
  // ---- Market Behavior ----
  function renderDetailSetup() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!t.setup_type) return;
      if (!map.has(t.setup_type)) map.set(t.setup_type, { label: t.setup_type, trades: [] });
      map.get(t.setup_type).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => b.trades.length - a.trades.length);
    setBucketBreakdownHtml("detail-setup", buckets, "Setup");
  }
  function renderDetailLessons() {
    const counts = new Map();
    App.state.trades.forEach((t) => (t.lesson_tags || []).forEach((tag) => {
      if (!counts.has(tag)) counts.set(tag, { count: 0, trades: [] });
      const e = counts.get(tag);
      e.count++;
      e.trades.push(t);
    }));
    const entries = Array.from(counts.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
    const el = document.getElementById("detail-lessons");
    if (!entries.length) { el.innerHTML = `<div class="empty-state small">No lesson tags logged yet.</div>`; return; }
    const maxCount = Math.max(...entries.map(([, e]) => e.count));
    el.innerHTML = entries.map(([tag, e]) => {
      return `
      <div class="bar-row"${drillAttr(tag.replace(/_/g, " "), e.trades, { sub: "Lesson tag" })}>
        <div class="bar-label">${escapeHtml(tag.replace(/_/g, " "))}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${((e.count / maxCount) * 100).toFixed(0)}%;"></div></div>
        <div class="bar-count">${e.count}x</div>
      </div>`;
    }).join("");
    window.paginateReportList(el, ".bar-row");
    bindTradeToggles(el);
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
    const buckets = PNL_BUCKETS.map((b) => ({ ...b, count: 0, trades: [] }));
    App.state.trades.forEach((t) => {
      const b = buckets.find((b) => b.test(t.pnl_after_comm));
      if (b) { b.count++; b.trades.push(t); }
    });
    const present = buckets.filter((b) => b.count);
    const el = document.getElementById("detail-distribution");
    if (!present.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const maxCount = Math.max(...present.map((b) => b.count));
    el.innerHTML = present.map((b) => {
      return `
      <div class="bar-row"${drillAttr(b.label, b.trades, { sub: "Trade P&L range" })}>
        <div class="bar-label" style="width:130px;">${b.label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${((b.count / maxCount) * 100).toFixed(0)}%;background:${b.neg ? "var(--red)" : "var(--green)"};"></div></div>
        <div class="bar-count">${b.count}x</div>
      </div>`;
    }).join("");
    bindTradeToggles(el);
  }
  // ---- Liquidity ----
  // relative_volume is a raw multiplier on each trade row (1.0 = 100% of
  // 30-day average volume) -- real numeric buckets, matching Tradervue's
  // own "% of Nd avg" scale.
  const RVOL_BUCKETS = [
    { label: "25% – 49%", max: 0.49 }, { label: "50% – 74%", max: 0.74 }, { label: "75% – 99%", max: 0.99 },
    { label: "100% – 124%", max: 1.24 }, { label: "125% – 149%", max: 1.49 }, { label: "150% – 199%", max: 1.99 },
    { label: "200% – 299%", max: 2.99 }, { label: "300% – 499%", max: 4.99 }, { label: "500%+", max: Infinity },
  ];
  function renderDetailRvol() {
    const withRvol = App.state.trades.filter((t) => typeof t.relative_volume === "number" && isFinite(t.relative_volume));
    const buckets = RVOL_BUCKETS.map((b) => ({ ...b, trades: [] }));
    const under = { label: "< 25%", trades: [] };
    withRvol.forEach((t) => {
      if (t.relative_volume < 0.25) { under.trades.push(t); return; }
      const bucket = buckets.find((b) => t.relative_volume <= b.max);
      (bucket || buckets[buckets.length - 1]).trades.push(t);
    });
    const all = under.trades.length ? [under, ...buckets] : buckets;
    renderPairedHistogram("detail-rvol-dist", "detail-rvol-perf", all, { labelW: 92, context: "Relative volume" });
  }
  // No raw 30-day-average-volume number is carried on the trades index
  // (only trade.js's per-trade detail fetch sees that) -- so this uses
  // the index's own avg_volume_tag categories rather than fabricating
  // Tradervue's exact dollar-volume tiers off data that isn't there.
  function renderDetailAvgVol() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!t.avg_volume_tag) return;
      if (!map.has(t.avg_volume_tag)) map.set(t.avg_volume_tag, []);
      map.get(t.avg_volume_tag).push(t);
    });
    const buckets = Array.from(map.entries()).map(([label, ts]) => ({ label: prettifyTag(label), trades: ts }));
    renderPairedHistogram("detail-avgvol-dist", "detail-avgvol-perf", buckets, { labelW: 92, context: "Average volume" });
  }
  // ---- Win/Loss/Expectation ----
  function renderDetailWinLossRatio() {
    const d = computeDetailedStats();
    const donutEl = document.getElementById("detail-winloss-donut");
    const cmpEl = document.getElementById("detail-winloss-compare");
    if (!donutEl || !cmpEl) return;
    if (!d.n) {
      donutEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      cmpEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    const winPct = (d.wins.length / d.n) * 100;
    donutEl.innerHTML = svgDonutChart(winPct, { winTrades: d.wins, lossTrades: d.losses, allTrades: App.state.trades }) + `<div style="text-align:center; color:var(--text-faint); font-size:11.5px; margin-top:4px;"><span>${d.wins.length} wins</span> · <span>${d.losses.length} losses</span></div>`;
    const grossWin = d.wins.reduce((s, t) => s + t.pnl_after_comm, 0);
    const grossLoss = d.losses.reduce((s, t) => s + t.pnl_after_comm, 0);
    cmpEl.innerHTML = svgAxisBarChart(
      [{ label: "Gain", value: grossWin, color: "var(--green)", trades: d.wins, drillTitle: "Winning trades" }, { label: "Loss", value: grossLoss, color: "var(--red)", trades: d.losses, drillTitle: "Losing trades" }],
      { fmt: fmtAxisMoney, labelW: 56, barHeight: 34, context: "Gross gain vs gross loss" }
    );
  }
  function renderDetailExpectationBar() {
    const d = computeDetailedStats();
    const el = document.getElementById("detail-expectation-bar");
    if (!el) return;
    if (!d.n) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const winRateFrac = d.wins.length / d.n, lossRateFrac = d.losses.length / d.n;
    const expectancy = winRateFrac * d.avgWin + lossRateFrac * d.avgLoss;
    el.innerHTML = svgAxisBarChart(
      [{ label: "Expectation", value: expectancy, color: expectancy >= 0 ? "var(--green)" : "var(--red)", trades: null }],
      { fmt: fmtAxisMoney, labelW: 84, barHeight: 34, context: "Expected P&L per trade" }
    ) + `<div style="text-align:center; color:var(--text-faint); font-size:11.5px; margin-top:2px;">Expected P&amp;L per trade</div>`;
  }
  function renderDetailExpectancy() {
    const d = computeDetailedStats();
    const el = document.getElementById("detail-expectancy");
    if (!d.n) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    const winRateFrac = d.wins.length / d.n;
    const lossRateFrac = d.losses.length / d.n;
    const expectancy = winRateFrac * d.avgWin + lossRateFrac * d.avgLoss;
    const ratio = d.avgLoss !== 0 ? d.avgWin / Math.abs(d.avgLoss) : null;
    const allT = App.state.trades;
    const R2 = d.avgLoss !== 0 ? d.avgWin / Math.abs(d.avgLoss) : null;
    const rows = [
      ["Avg win / avg loss ratio", ratio != null ? ratio.toFixed(2) : "—", allT, "How big your average win is next to your average loss", { collapse: true, calc: [["Average win", dm(d.avgWin)], ["Average loss", dm(d.avgLoss)], ["Ratio", ratio != null ? ratio.toFixed(2) : ""]] }],
      ["Expectancy per trade", fmtMoney(expectancy), allT, "What an average trade is worth", { collapse: true, calc: [["Win rate × average win", dm(winRateFrac * d.avgWin)], ["Loss rate × average loss", dm(lossRateFrac * d.avgLoss)], ["Expectancy", dm(expectancy)]] }],
    ];
    el.innerHTML = `<div class="kv-list">${rows.map(([k, v, set, sub, extra]) => `<div class="kv-row"${drillAttr(k, set, { sub, row: true, ...(extra || {}) })}><span class="k">${k}</span><span class="v">${v}</span></div>`).join("")}</div>`;
  }
  // Tradervue-style Daily/Weekly/Monthly/Yearly rollup switcher (see
  // #report-period-select). All four timeframes are the exact same
  // group-by-date-key-then-net-P&L aggregation Monthly already did --
  // only periodKey() below changes per timeframe. Monthly stays the
  // default so existing behavior/screenshots don't shift.
  const PERIOD_NOUN = { daily: "day", weekly: "week", monthly: "month", yearly: "year" };
  // Returns the bucket key + display label for one trade's trade_date
  // under the given timeframe. Weekly buckets by the Monday that starts
  // ISO week the trade falls in (labeled as that Monday's date, so bars
  // read left-to-right in real chronological order same as the other
  // timeframes) -- "T12:00:00" avoids the DST/UTC-rollover edge cases
  // the rest of this file already works around when parsing trade_date.
  function periodKey(dateStr, timeframe) {
    if (!dateStr) return null;
    if (timeframe === "yearly") return dateStr.slice(0, 4);
    if (timeframe === "monthly") return dateStr.slice(0, 7);
    if (timeframe === "daily") return dateStr;
    // weekly
    const d = new Date(dateStr + "T12:00:00");
    const dow = d.getDay(); // 0=Sun..6=Sat
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    d.setDate(d.getDate() + mondayOffset);
    return `${d.getFullYear()}-${App.pad2(d.getMonth() + 1)}-${App.pad2(d.getDate())}`;
  }
  function renderPeriodDistPerf() {
    const timeframe = R.reportPeriodTimeframe || "monthly";
    const noun = PERIOD_NOUN[timeframe] || "month";

    const labelEl = document.getElementById("report-period-label");
    if (labelEl) labelEl.innerHTML = `Trade distribution &amp; performance by ${noun}`;
    const distTitleEl = document.getElementById("report-period-dist-title");
    if (distTitleEl) distTitleEl.textContent = `Trade distribution by ${noun}`;
    const perfTitleEl = document.getElementById("report-period-perf-title");
    if (perfTitleEl) perfTitleEl.textContent = `Performance by ${noun}`;

    const map = new Map();
    App.state.trades.forEach((t) => {
      const key = periodKey(t.trade_date, timeframe);
      if (!key) return;
      if (!map.has(key)) map.set(key, { label: key, trades: [] });
      map.get(key).trades.push(t);
    });
    const buckets = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
    renderPairedHistogram("report-month-dist", "report-month-perf", buckets, { labelW: 64, barHeight: 15, context: `By ${noun}` });
  }
  function renderCumulativeCharts() {
    const pnlEl = document.getElementById("dd-cum-pnl");
    const ddEl = document.getElementById("dd-cum-drawdown");
    if (!pnlEl || !ddEl) return;
    if (!App.state.trades.length) {
      pnlEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      ddEl.innerHTML = `<div class="empty-state small">No data yet.</div>`;
      return;
    }
    // Use the real account balance (`_balance` -- Settings ledger +
    // cumulative P&L, see computeAccountBalances in auth.js) so a deposit
    // or withdrawal moves these charts the same way it already moves the
    // Max/Current drawdown figures and Drawdown periods table above.
    const startBalance = App.state.trades[0]._balance - (App.state.trades[0].pnl_after_comm || 0);
    const cumPnl = App.state.trades.map((t) => t._balance - startBalance);
    let runPeak = -Infinity;
    const drawdown = cumPnl.map((v) => { runPeak = Math.max(runPeak, v); return v - runPeak; });
    renderMiniLineChart(pnlEl, App.state.trades.map((t, i) => ({ x: t.trade_date, y: cumPnl[i] })), { trades: App.state.trades, context: "Cumulative P&L" });
    renderMiniLineChart(ddEl, App.state.trades.map((t, i) => ({ x: t.trade_date, y: drawdown[i] })), { trades: App.state.trades, context: "Drawdown from peak" });
  }
  // ================================================================
  // REPORTS — Overview: Cumulative P&L with its own 30/60/90/All toggle
  // (Detailed's Win/Loss/Expectation cumulative chart below reuses the
  // page's already-selected date range instead, since it sits alongside
  // panels that don't have their own toggle either.)
  // ================================================================
  let overviewCumRange = "90"; // "30" | "60" | "90" | "all"
  function overviewCumSubset() {
    if (overviewCumRange === "all" || !App.state.trades.length) return App.state.trades;
    const days = parseInt(overviewCumRange, 10);
    const anchor = new Date(App.state.trades[App.state.trades.length - 1].trade_date + "T12:00:00");
    const cutoff = new Date(anchor);
    cutoff.setDate(cutoff.getDate() - days);
    const subset = App.state.trades.filter((t) => new Date(t.trade_date + "T12:00:00") >= cutoff);
    return subset.length ? subset : App.state.trades;
  }
  function bindOverviewCumRangeToggle() {
    const wrap = document.getElementById("ov-cumpnl-range-toggle");
    if (!wrap || wrap.dataset.bound) return;
    wrap.dataset.bound = "1";
    wrap.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (!btn) return;
      overviewCumRange = btn.dataset.range;
      wrap.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      renderOverviewCumulativePnl();
    }, { signal: App.signal });
  }
  function renderOverviewCumulativePnl() {
    bindOverviewCumRangeToggle();
    const el = document.getElementById("report-cum-pnl");
    if (!el) return;
    const subset = overviewCumSubset();
    if (!subset.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    let running = 0;
    const series = subset.map((t) => { running += t.pnl_after_comm; return { x: t.trade_date, y: running }; });
    renderMiniLineChart(el, series, { trades: subset, context: "Cumulative P&L" });
  }
  // Win/Loss/Expectation's own Cumulative P&L -- tracks whatever `trades`
  // currently holds (the page's overall date range / filters), same as
  // its sibling panels in that grid.
  function renderDetailCumulativePnl() {
    const el = document.getElementById("detail-cum-pnl");
    if (!el) return;
    if (!App.state.trades.length) { el.innerHTML = `<div class="empty-state small">No data yet.</div>`; return; }
    let running = 0;
    const series = App.state.trades.map((t) => { running += t.pnl_after_comm; return { x: t.trade_date, y: running }; });
    renderMiniLineChart(el, series, { trades: App.state.trades, context: "Cumulative P&L" });
  }
  Object.assign(R, { renderAdvanced, renderCumulativeCharts, renderDetailSubtabs, renderDetailedStats, renderOverviewCumulativePnl, renderPeriodDistPerf, renderTagBreakdown, runCalc });
})();
