// discipline.js — 0-100 discipline score built ONLY from things you control
// (not P&L): rules followed, max-daily-loss held, journaling consistency,
// having a plan before trading, stopping out near your planned stop, and not
// sizing up right after a loss. Inputs: trade rows + trade-notes.js entries +
// daily-notes.js days. Components with no data yet are left out and the
// remaining weights are renormalised, so a new user isn't scored 0 for
// features they haven't started using.
(function () {
  "use strict";
  const WEIGHTS = { rules: 30, maxloss: 25, journaling: 15, planning: 10, stops: 10, sizing: 10 };
  const STOP_TOLERANCE_R = -1.25;  // a loss worse than this many R = blew through the planned stop
  const SIZE_UP_RATIO = 1.25;      // > 25% more shares than the losing trade before it = sizing up
  const LABELS = {
    rules: "Rules followed",
    maxloss: "Max daily loss held",
    journaling: "Trades journaled",
    planning: "Days with a plan",
    stops: "Losses kept near planned stop",
    sizing: "No size-up after a loss",
  };

  const pct = (ok, n) => (n ? (ok / n) * 100 : null);

  function compute(trades, opts) {
    opts = opts || {};
    const entries = opts.entries || (window.TradeNotes ? window.TradeNotes.all() : {});
    const daily = opts.days || (window.DailyNotes ? window.DailyNotes.allDays() : {});
    const rows = (trades || []).filter((t) =>
      (!opts.from || t.trade_date >= opts.from) && (!opts.to || t.trade_date <= opts.to));
    const sorted = rows.slice().sort((a, b) =>
      String(a.trade_date).localeCompare(String(b.trade_date)) ||
      String(a.entry_time || "").localeCompare(String(b.entry_time || "")));
    const c = {};

    // Rules: only trades where you answered the question.
    const answered = sorted.filter((t) => entries[t.id] && (entries[t.id].followed_rules === true || entries[t.id].followed_rules === false));
    c.rules = { n: answered.length, value: pct(answered.filter((t) => entries[t.id].followed_rules === true).length, answered.length) };

    // Journaling: share of trades with any journal entry.
    c.journaling = { n: sorted.length, value: pct(sorted.filter((t) => entries[t.id]).length, sorted.length) };

    // Group by day for the day-level components.
    const byDay = {};
    sorted.forEach((t) => (byDay[t.trade_date] = byDay[t.trade_date] || []).push(t));
    const dates = Object.keys(byDay);

    // Max loss: days where you set a limit; held if worst intraday drawdown of cumulative net P&L stayed within it.
    let planned = 0, held = 0;
    dates.forEach((d) => {
      const dn = daily[d];
      if (!dn || dn.max_loss == null) return;
      planned++;
      let cum = 0, low = 0;
      byDay[d].forEach((t) => { cum += typeof t.pnl_after_comm === "number" ? t.pnl_after_comm : 0; if (cum < low) low = cum; });
      if (-low <= dn.max_loss) held++;
    });
    c.maxloss = { n: planned, value: pct(held, planned) };

    // Planning: share of trading days with a written plan or a max-loss set.
    const withPlan = dates.filter((d) => { const dn = daily[d]; return dn && (dn.max_loss != null || (dn.plan || "").trim()); }).length;
    c.planning = { n: dates.length, value: pct(withPlan, dates.length) };

    // Stops: among LOSING trades with a planned stop, how many stayed within tolerance.
    let lossN = 0, lossOk = 0;
    sorted.forEach((t) => {
      const e = entries[t.id];
      if (!e || !e.plan_stop || !t.shares || typeof t.pnl_after_comm !== "number" || t.pnl_after_comm >= 0) return;
      const isShort = String(t.side || "").toLowerCase() === "short";
      const risk = isShort ? e.plan_stop - t.entry_price : t.entry_price - e.plan_stop;
      if (!(risk > 0)) return;
      lossN++;
      if (t.pnl_after_comm / (risk * t.shares) >= STOP_TOLERANCE_R) lossOk++;
    });
    c.stops = { n: lossN, value: pct(lossOk, lossN) };

    // Sizing: trades that directly follow a same-day LOSS; ok unless size jumped up.
    let afterLoss = 0, sizeOk = 0;
    dates.forEach((d) => {
      const day = byDay[d];
      for (let i = 1; i < day.length; i++) {
        const prev = day[i - 1], cur = day[i];
        if (prev.win || !prev.shares || !cur.shares) continue;
        afterLoss++;
        if (cur.shares <= prev.shares * SIZE_UP_RATIO) sizeOk++;
      }
    });
    c.sizing = { n: afterLoss, value: pct(sizeOk, afterLoss) };

    const components = Object.keys(WEIGHTS).map((k) => ({
      key: k, label: LABELS[k], weight: WEIGHTS[k], n: c[k].n, value: c[k].value,
    }));
    const avail = components.filter((x) => x.value !== null);
    const totalW = avail.reduce((s, x) => s + x.weight, 0);
    const score = totalW ? avail.reduce((s, x) => s + x.value * x.weight, 0) / totalW : null;
    return { score, components, trades: sorted.length, coveredWeight: totalW };
  }

  function grade(score) {
    if (score === null) return "—";
    return score >= 90 ? "Elite" : score >= 75 ? "Solid" : score >= 60 ? "Slipping" : score >= 40 ? "Loose" : "Off the rails";
  }

  window.Discipline = { compute, grade, WEIGHTS, LABELS };
})();
