(function () {
  "use strict";
  const R = (App.reports = App.reports || {});
  const { drillAttr, unescHtml } = R;
  const applyReportFiltersAndRender = (...args) => R.applyReportFiltersAndRender(...args);
  const initReportFilters = (...args) => R.initReportFilters(...args);

  // =====================================================================
  // Insights tab: time vs size / behavior / concentration.
  // All three read App.state.trades, so the filter bar (and its Advanced
  // filters) narrows them exactly like every other Reports tab.
  // =====================================================================
  const INS_SESSION_MIN = 390; // regular US session (6.5h) -- denominator for "time in market"
  const insSum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const insAvg = (arr, f) => (arr.length ? insSum(arr, f) / arr.length : null);
  const insUsd = (v) => (v == null || !Number.isFinite(v) ? "\u2014" : "$" + Math.round(v).toLocaleString());
  const insPct = (v, d = 1) => (v == null || !Number.isFinite(v) ? "\u2014" : v.toFixed(d) + "%");
  const insEmpty = (msg) => `<div class="empty-state small">${msg}</div>`;
  const insCls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "dim");
  const insDur = (m) => App.fmtDurationPrecise(m);
  const insPlural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  // A bold number inside a sentence. Clickable (opens the trades behind it)
  // whenever there are any; plain bold when there are none.
  function insLink(html, title, trades, sub) {
    const a = drillAttr(title, trades, { sub });
    return a ? `<b class="ins-link"${a}>${html}</b>` : `<b>${html}</b>`;
  }
  // Green/red wash for a heat-map cell, scaled against the biggest |value| on the grid.
  function insTint(v, maxAbs) {
    if (!maxAbs || !Number.isFinite(v) || v === 0) return "";
    const pct = Math.round(8 + 32 * Math.min(1, Math.abs(v) / maxAbs));
    return ` style="background:color-mix(in srgb, var(${v > 0 ? "--green" : "--red"}) ${pct}%, transparent)"`;
  }

  // One row per trade with the numbers all three blocks share. `notional`
  // is the money put into the position (entry price x shares) and `mins`
  // the time held; each is null -- never a made-up 0 -- when the trade
  // doesn't carry the data (no price / no share count / no usable times).
  function insRows(trades) {
    return trades.map((t) => {
      const px = Number(t.entry_price), sh = Number(t.shares), net = Number(t.pnl_after_comm);
      return {
        t,
        notional: t.entry_price != null && t.shares != null && px > 0 && sh > 0 ? px * sh : null,
        mins: App.durationMinutes(t),
        net: Number.isFinite(net) ? net : 0,
        // Before-commission P&L is null (not 0) when the trade doesn't carry it.
        gross: t.pnl_before_comm != null && Number.isFinite(Number(t.pnl_before_comm)) ? Number(t.pnl_before_comm) : null,
        comm: Number.isFinite(Number(t.commission)) ? Number(t.commission) : 0,
        shares: Number.isFinite(sh) ? sh : 0,
        win: Boolean(t.win),
        date: t.trade_date,
      };
    });
  }
  // Split rows into k roughly-equal-count buckets by `key` (ties stay together).
  function insQuantileBuckets(rows, key, k) {
    const vals = rows.map((r) => r[key]).sort((a, b) => a - b);
    const edges = [];
    for (let i = 1; i < k; i++) {
      const e = vals[Math.floor((vals.length * i) / k)];
      if (!edges.length || e > edges[edges.length - 1]) edges.push(e);
    }
    const buckets = Array.from({ length: edges.length + 1 }, () => ({ rows: [] }));
    rows.forEach((r) => {
      let i = 0;
      while (i < edges.length && r[key] >= edges[i]) i++;
      buckets[i].rows.push(r);
    });
    return buckets.filter((b) => b.rows.length).map((b) => {
      b.lo = b.rows.reduce((m, r) => Math.min(m, r[key]), Infinity);
      b.hi = b.rows.reduce((m, r) => Math.max(m, r[key]), -Infinity);
      return b;
    });
  }
  // Average minutes per trading day that you actually had *a* position open.
  // Overlapping trades are merged first so two positions held at the same
  // time count once, not twice.
  function insTimeInMarket(trades) {
    const toMin = (s) => {
      if (typeof s !== "string" || !s) return NaN;
      const [h, m, sec] = s.split(":").map(Number);
      return h * 60 + m + (sec || 0) / 60;
    };
    const byDay = new Map();
    trades.forEach((t) => {
      const a = toMin(t.entry_time), b = toMin(t.exit_time);
      if (!(b > a)) return;
      if (!byDay.has(t.trade_date)) byDay.set(t.trade_date, []);
      byDay.get(t.trade_date).push([a, b]);
    });
    if (!byDay.size) return null;
    let total = 0;
    byDay.forEach((iv) => {
      iv.sort((x, y) => x[0] - y[0]);
      let [cs, ce] = iv[0];
      iv.slice(1).forEach(([s, e]) => {
        if (s <= ce) ce = Math.max(ce, e);
        else { total += ce - cs; cs = s; ce = e; }
      });
      total += ce - cs;
    });
    return { days: byDay.size, avgPerDay: total / byDay.size };
  }

  // ---------------------------------------------------------------- Time vs size
  function renderInsightsTimeSize(rows, trades) {
    const el = document.getElementById("insights-timesize");
    if (!el) return;
    const both = rows.filter((r) => r.notional != null && r.mins != null);
    if (both.length < 5) {
      el.innerHTML = insEmpty("Needs at least 5 trades that have a price, a share count and a hold time.");
      return;
    }
    const wins = both.filter((r) => r.win), losses = both.filter((r) => !r.win);
    const capHours = (r) => (r.notional * r.mins) / 60; // dollars tied up x hours tied up
    // Total P&L / total capital-hours (not an average of per-trade ratios,
    // which explodes on 10-second trades).
    const perK = (arr) => { const c = insSum(arr, capHours); return c > 0 ? insSum(arr, (r) => r.net) / (c / 1000) : null; };
    const col = (arr) => ({
      n: arr.length,
      size: insAvg(arr, (r) => r.notional),
      hold: insAvg(arr, (r) => r.mins),
      ret: insAvg(arr, (r) => (r.net / r.notional) * 100),
      capK: insSum(arr, capHours) / 1000,
      perK: perK(arr),
    });
    const A = col(both), W = wins.length ? col(wins) : null, L = losses.length ? col(losses) : null;
    const insT = (arr) => arr.map((r) => r.t);
    const TS_SUB = "Trades with a price, share count and hold time";
    const cell = (c, f, arr, who, label) => `<td class="mono num">${c ? f(c) : "\u2014"}</td>`;
    const money = (v) => (v == null ? "\u2014" : `<span class="${insCls(v)}">${fmtMoney(v)}</span>`);
    const line = (label, f) => `<tr><td>${label}</td>${cell(A, f, both, "All trades", label)}${cell(W, f, wins, "Winners", label)}${cell(L, f, losses, "Losers", label)}</tr>`;

    // Plain-language reads -- only when both sides have enough trades to mean something.
    const notes = [];
    if (W && L && W.n >= 3 && L.n >= 3) {
      const hr = L.hold / W.hold;
      const hrL = (txt) => insLink(txt, "Losing trades \u00b7 hold time", insT(losses), `Losers are held about ${hr.toFixed(1)}\u00d7 as long as winners`);
      notes.push(hr >= 1.15 ? `You hold losers about ${hrL(`${hr.toFixed(1)}\u00d7 as long`)} as winners.`
        : hr <= 0.87 ? `You cut losers faster than winners (losers are held about ${hrL(`${hr.toFixed(1)}\u00d7`)} as long).`
        : `Winners and losers are held for about the same time.`);
      const sr = L.size / W.size;
      const srL = (txt) => insLink(txt, "Losing trades \u00b7 position size", insT(losses), "Compared with your winners' size");
      notes.push(sr >= 1.15 ? `Your losing trades are about ${srL(`${Math.round((sr - 1) * 100)}% bigger`)} than your winners.`
        : sr <= 0.87 ? `Your losing trades are about ${srL(`${Math.round((1 - sr) * 100)}% smaller`)} than your winners.`
        : `Winners and losers are about the same size.`);
    }
    const tim = insTimeInMarket(trades);
    const timedT = trades.filter((t) => insToMin(t.exit_time) > insToMin(t.entry_time));
    const timeLine = tim
      ? `On days you trade, you're in a position about ${insLink(insDur(tim.avgPerDay), "Time in market", timedT, "Trades with an entry and exit time")} (${insPct((tim.avgPerDay / INS_SESSION_MIN) * 100, 0)} of a 6.5-hour session), overlapping trades counted once.`
      : "";

    // Size buckets (equal trade counts) -> hold time / win rate / P&L / return per capital-hour.
    const k = both.length >= 20 ? 4 : both.length >= 9 ? 3 : 0;
    let sizeTable = "", grid = "";
    if (k) {
      const sizeB = insQuantileBuckets(both, "notional", k);
      const sizeName = (b, i) => `${i === 0 ? "Smallest" : i === sizeB.length - 1 ? "Largest" : "Mid"} \u00b7 ${insUsd(b.lo)}\u2013${insUsd(b.hi)}`;
      sizeTable = `<div class="table-scroll"><table class="report-table"><thead><tr>
        <th scope="col">Position size</th><th scope="col" class="num">Trades</th><th scope="col" class="num">Avg hold</th><th scope="col" class="num">Win rate</th>
        <th scope="col" class="num">Net P&amp;L</th><th scope="col" class="num">Avg return</th><th scope="col" class="num">$ per $1k-hour</th></tr></thead><tbody>
        ${sizeB.map((b, i) => {
          const wr = (b.rows.filter((r) => r.win).length / b.rows.length) * 100;
          const net = insSum(b.rows, (r) => r.net);
          return `<tr${drillAttr(sizeName(b, i), b.rows.map((r) => r.t), { row: true, sub: "By position size" })}><td>${sizeName(b, i)}</td><td class="mono num">${b.rows.length}</td>
            <td class="mono num">${insDur(insAvg(b.rows, (r) => r.mins))}</td>
            <td class="mono num ${wr >= 50 ? "up" : "down"}">${wr.toFixed(0)}%</td>
            <td class="mono num">${money(net)}</td>
            <td class="mono num ${insCls(insAvg(b.rows, (r) => r.net / r.notional))}">${insPct(insAvg(b.rows, (r) => (r.net / r.notional) * 100), 2)}</td>
            <td class="mono num">${money(perK(b.rows))}</td></tr>`;
        }).join("")}</tbody></table></div>`;

      // Size x hold-time grid: each cell = net P&L, with trade count and win rate under it.
      const holdB = insQuantileBuckets(both, "mins", k);
      const cells = sizeB.map((sb) => holdB.map((hb) => both.filter((r) => sb.rows.includes(r) && hb.rows.includes(r))));
      const maxAbs = cells.reduce((m, row) => row.reduce((mm, c) => Math.max(mm, Math.abs(insSum(c, (r) => r.net))), m), 0);
      grid = `<div class="table-scroll"><table class="report-table ins-heat"><thead><tr><th scope="col">Size \u2193 / Hold \u2192</th>
        ${holdB.map((hb) => `<th scope="col" class="num">${insDur(hb.lo)}\u2013${insDur(hb.hi)}</th>`).join("")}</tr></thead><tbody>
        ${sizeB.map((sb, i) => `<tr><td>${sizeName(sb, i)}</td>${cells[i].map((c, j) => {
          if (!c.length) return `<td class="cell dim">\u00b7</td>`;
          const net = insSum(c, (r) => r.net), wr = (c.filter((r) => r.win).length / c.length) * 100;
          const gridDrill = drillAttr(`${sizeName(sb, i)} \u00d7 hold ${insDur(holdB[j].lo)}\u2013${insDur(holdB[j].hi)}`, c.map((r) => r.t), { sub: "Size \u00d7 hold time" });
          return `<td class="cell"${insTint(net, maxAbs)}${gridDrill}><span class="${insCls(net)}">${fmtMoney(net)}</span><span class="sub">${c.length} \u00b7 ${wr.toFixed(0)}%</span></td>`;
        }).join("")}</tr>`).join("")}</tbody></table></div>
        <div class="ins-note">Each cell: net P&amp;L, then trade count \u00b7 win rate. Buckets hold roughly equal numbers of trades.</div>`;
    }

    el.innerHTML = `
      ${notes.length || timeLine ? `<p class="ins-lead">${notes.concat(timeLine ? [timeLine] : []).join(" ")}</p>` : ""}
      <div class="table-scroll"><table class="report-table"><thead><tr><th scope="col"></th>
        <th scope="col" class="num">All</th>
        <th scope="col" class="num">Winners</th>
        <th scope="col" class="num">Losers</th></tr></thead><tbody>
        ${line("Trades", (c) => c.n)}
        ${line("Avg position size", (c) => insUsd(c.size))}
        ${line("Avg hold time", (c) => insDur(c.hold))}
        ${line("Avg return on position", (c) => `<span class="${insCls(c.ret)}">${insPct(c.ret, 2)}</span>`)}
        ${line("Capital-hours ($1k\u00b7h)", (c) => c.capK.toFixed(1))}
        ${line("$ earned per $1k-hour", (c) => money(c.perK))}
      </tbody></table></div>
      ${k ? `<div class="ins-sub">By position size</div>${sizeTable}<div class="ins-sub">Size \u00d7 hold time</div>${grid}` : ""}
      <div class="ins-note">Position size = entry price \u00d7 shares. <b>$ per $1k-hour</b> = total P&amp;L \u00f7 (dollars tied up \u00d7 hours held, in thousands): how much each $1,000 earned for every hour it sat in a trade.
      ${both.length < rows.length ? ` ${insPlural(rows.length - both.length, "trade", "trades")} without a price, share count or hold time ${rows.length - both.length === 1 ? "is" : "are"} left out.` : ""}</div>`;
  }

  // ---------------------------------------------------------------- Behavior
  function renderInsightsBehavior(rows) {
    const el = document.getElementById("insights-behavior");
    if (!el) return;
    if (rows.length < 6) { el.innerHTML = insEmpty("Needs at least 6 trades."); return; }
    // Walk each day in entry order, tagging every trade with what came right before it.
    const byDay = new Map();
    rows.forEach((r) => { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); });
    const seq = [];
    byDay.forEach((list) => {
      list.sort((a, b) => String(a.t.entry_time || "").localeCompare(String(b.t.entry_time || "")));
      let lossRun = 0, prev = null, prevRow = null;
      list.forEach((r, i) => {
        // Minutes between the previous trade's exit and this trade's entry (negative = entered while still in it).
        const gapMin = prevRow ? insToMin(r.t.entry_time) - insToMin(prevRow.t.exit_time) : NaN;
        seq.push({ ...r, nth: i + 1, prev, lossRun, prevRow, gap: Number.isFinite(gapMin) ? gapMin : null });
        prev = r.win ? "win" : "loss";
        prevRow = r;
        lossRun = r.win ? 0 : lossRun + 1;
      });
    });
    const stat = (arr) => ({
      trades: arr.map((r) => r.t),
      n: arr.length,
      size: insAvg(arr.filter((r) => r.notional != null), (r) => r.notional),
      wr: arr.length ? (arr.filter((r) => r.win).length / arr.length) * 100 : null,
      avg: insAvg(arr, (r) => r.net),
      net: insSum(arr, (r) => r.net),
    });
    const groups = [
      ["First trade of the day", seq.filter((r) => r.nth === 1)],
      ["After a win", seq.filter((r) => r.prev === "win")],
      ["After a loss", seq.filter((r) => r.prev === "loss")],
      ["After 2+ losses in a row", seq.filter((r) => r.lossRun >= 2)],
    ].map(([label, arr]) => [label, stat(arr)]).filter(([, s]) => s.n);
    const after = Object.fromEntries(groups);
    const notes = [];
    const aw = after["After a win"], al = after["After a loss"];
    if (aw && al && aw.n >= 5 && al.n >= 5) {
      if (aw.size && al.size) {
        const r = al.size / aw.size;
        const szL = (txt) => insLink(txt, "Trades after a loss", al.trades, "Compared with trades after a win");
        notes.push(r >= 1.15 ? `You size up ${szL(`${Math.round((r - 1) * 100)}%`)} after a loss, compared with after a win \u2014 a common tilt pattern.`
          : r <= 0.87 ? `You size down ${szL(`${Math.round((1 - r) * 100)}%`)} after a loss, compared with after a win.`
          : `Your size stays about the same after a win or a loss.`);
      }
      const d = al.wr - aw.wr;
      if (Math.abs(d) >= 5) notes.push(`Your win rate is ${insLink(`${Math.abs(d).toFixed(0)} points ${d < 0 ? "lower" : "higher"}`, "Trades after a loss", al.trades, `Win rate ${al.wr.toFixed(0)}% after a loss vs ${aw.wr.toFixed(0)}% after a win`)} after a loss than after a win.`);
    }
    const behTable = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Situation</th><th scope="col" class="num">Trades</th><th scope="col" class="num">Avg size</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">Avg P&amp;L</th><th scope="col" class="num">Net P&amp;L</th></tr></thead><tbody>
      ${groups.map(([label, s]) => `<tr${drillAttr(label, s.trades, { row: true, sub: "After a win or a loss" })}><td>${label}</td><td class="mono num">${s.n}</td><td class="mono num">${insUsd(s.size)}</td>
        <td class="mono num ${s.wr >= 50 ? "up" : "down"}">${s.wr.toFixed(0)}%</td>
        <td class="mono num ${insCls(s.avg)}">${fmtMoney(s.avg)}</td><td class="mono num ${insCls(s.net)}">${fmtMoney(s.net)}</td></tr>`).join("")}
      </tbody></table></div>`;

    // P&L by which trade of the day it was.
    const NTH = [[1, 1, "1st trade"], [2, 2, "2nd"], [3, 3, "3rd"], [4, 4, "4th"], [5, 5, "5th"], [6, 10, "6th\u201310th"], [11, Infinity, "11th +"]];
    const nthTable = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Trade of the day</th><th scope="col" class="num">Trades</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">Avg P&amp;L</th><th scope="col" class="num">Net P&amp;L</th></tr></thead><tbody>
      ${NTH.map(([lo, hi, label]) => {
        const arr = seq.filter((r) => r.nth >= lo && r.nth <= hi);
        if (!arr.length) return "";
        const s = stat(arr);
        return `<tr${drillAttr(label, s.trades, { row: true, sub: "By trade number of the day" })}><td>${label}</td><td class="mono num">${s.n}</td><td class="mono num ${s.wr >= 50 ? "up" : "down"}">${s.wr.toFixed(0)}%</td>
          <td class="mono num ${insCls(s.avg)}">${fmtMoney(s.avg)}</td><td class="mono num ${insCls(s.net)}">${fmtMoney(s.net)}</td></tr>`;
      }).join("")}</tbody></table></div>`;

    // Days grouped by how many trades were taken (overtrading check).
    const DAYB = [[1, 3, "1\u20133 trades"], [4, 6, "4\u20136 trades"], [7, 10, "7\u201310 trades"], [11, 20, "11\u201320 trades"], [21, Infinity, "21+ trades"]];
    const dayList = Array.from(byDay.values()).map((list) => ({ n: list.length, net: insSum(list, (r) => r.net), trades: list.map((r) => r.t) }));
    const dayTable = `<div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Trades taken that day</th><th scope="col" class="num">Days</th><th scope="col" class="num">Winning days</th><th scope="col" class="num">Avg day P&amp;L</th><th scope="col" class="num">Avg per trade</th></tr></thead><tbody>
      ${DAYB.map(([lo, hi, label]) => {
        const d = dayList.filter((x) => x.n >= lo && x.n <= hi);
        if (!d.length) return "";
        const w = (d.filter((x) => x.net > 0).length / d.length) * 100;
        const avgDay = insAvg(d, (x) => x.net), avgTr = insSum(d, (x) => x.net) / insSum(d, (x) => x.n);
        return `<tr${drillAttr(label, d.flatMap((x) => x.trades), { row: true, sub: "Every trade on days with this many trades" })}><td>${label}</td><td class="mono num">${d.length}</td><td class="mono num ${w >= 50 ? "up" : "down"}">${w.toFixed(0)}%</td>
          <td class="mono num ${insCls(avgDay)}">${fmtMoney(avgDay)}</td><td class="mono num ${insCls(avgTr)}">${fmtMoney(avgTr)}</td></tr>`;
      }).join("")}</tbody></table></div>`;

    el.innerHTML = `
      ${notes.length ? `<p class="ins-lead">${notes.join(" ")}</p>` : ""}
      <div class="ins-sub">What happens after a win or a loss</div>${behTable}
      <div class="ins-sub">How fast you re-enter <span class="ins-inline">· "fast" = within <input type="number" id="ins-fast-min" class="filter-input ins-rule-input" min="0" step="any" value="${insFastMin}" aria-label="Fast re-entry threshold in minutes" /> min</span></div>
      <div id="ins-reentry-body">${insReentryBody(seq)}</div>
      <div class="ins-sub">By trade number of the day</div>${nthTable}
      <div class="ins-sub">By number of trades taken in a day</div>${dayTable}
      <div class="ins-note">Trades are ordered by entry time within each day; "after" means the trade taken immediately before. Small samples (a handful of trades) can look dramatic by chance \u2014 weigh the Trades column.</div>`;
    const fastInput = document.getElementById("ins-fast-min");
    if (fastInput) fastInput.addEventListener("input", () => {
      const v = parseFloat(fastInput.value);
      if (!(v >= 0)) return;
      insFastMin = v;
      document.getElementById("ins-reentry-body").innerHTML = insReentryBody(seq);
    }, { signal: App.signal });
  }

  // ---------------------------------------------------------------- Concentration
  function renderInsightsConcentration(rows) {
    const el = document.getElementById("insights-concentration");
    if (!el) return;
    if (rows.length < 6) { el.innerHTML = insEmpty("Needs at least 6 trades."); return; }
    const total = insSum(rows, (r) => r.net);
    const tradesDesc = rows.map((r) => r.net).sort((a, b) => b - a);
    const dayMap = new Map();
    rows.forEach((r) => dayMap.set(r.date, (dayMap.get(r.date) || 0) + r.net));
    const daysDesc = Array.from(dayMap.values()).sort((a, b) => b - a);
    // Same orderings, but carrying the trades so each row can open them.
    const rowsDesc = rows.slice().sort((a, b) => b.net - a.net);
    const daysDescFull = Array.from(dayMap.entries()).map(([date, net]) => ({ net, trades: rows.filter((r) => r.date === date).map((r) => r.t) })).sort((a, b) => b.net - a.net);
    const tr = (arr) => arr.map((r) => r.t);
    const dy = (arr) => arr.flatMap((d) => d.trades);
    const top = (arr, n) => arr.slice(0, n);
    const bottom = (arr, n) => arr.slice(Math.max(0, arr.length - n));
    const tenPct = Math.max(1, Math.ceil(rows.length * 0.1));
    const defs = [
      ["Your best trade", top(tradesDesc, 1), "trade", tr(top(rowsDesc, 1))],
      ["Your best 3 trades", top(tradesDesc, 3), "trade", tr(top(rowsDesc, 3))],
      ["Your best 5 trades", top(tradesDesc, 5), "trade", tr(top(rowsDesc, 5))],
      [`Your best 10% of trades (${tenPct})`, top(tradesDesc, tenPct), "trade", tr(top(rowsDesc, tenPct))],
      ["Your best day", top(daysDesc, 1), "day", dy(top(daysDescFull, 1))],
      ["Your best 3 days", top(daysDesc, 3), "day", dy(top(daysDescFull, 3))],
      ["Your worst 3 trades", bottom(tradesDesc, 3), "trade", tr(bottom(rowsDesc, 3))],
      ["Your worst day", bottom(daysDesc, 1), "day", dy(bottom(daysDescFull, 1))],
    ];
    // What's left once a set of trades is taken out (by identity, so equal P&L can't confuse it).
    const without_ = (set) => { const gone = new Set(set); return tr(rows).filter((t) => !gone.has(t)); };
    const rowsHtml = defs.map(([label, removed, unit, set]) => {
      const rem = insSum(removed, (x) => x);
      const without = total - rem;
      return `<tr${drillAttr(label, set, { row: true, sub: "The trades being taken out" })}><td>${label}</td><td class="mono num ${insCls(rem)}">${fmtMoney(rem)}</td><td class="mono num ${insCls(without)}"><b>${fmtMoney(without)}</b></td></tr>`;
    }).join("");

    const best3 = insSum(top(tradesDesc, 3), (x) => x);
    const worst3 = insSum(bottom(tradesDesc, 3), (x) => x);
    const best3T = tr(top(rowsDesc, 3)), worst3T = tr(bottom(rowsDesc, 3));
    const allL = (v) => insLink(fmtMoney(v), "All trades", tr(rows), "Every trade in this view");
    let read;
    if (total > 0) {
      const leftL = insLink(fmtMoney(total - best3), "Everything except your best 3 trades", without_(best3T), "The trades that are left");
      read = total - best3 <= 0
        ? `Your profit leans on a few trades: without your best 3 you'd be at ${leftL} instead of ${allL(total)}.`
        : `Your profit is fairly spread out: even without your best 3 trades you'd still be at ${leftL}.`;
    } else {
      const leftL = insLink(fmtMoney(total - worst3), "Everything except your 3 worst trades", without_(worst3T), "The trades that are left");
      read = total - worst3 > 0
        ? `Your 3 worst trades account for the whole loss: without them you'd be at ${leftL} instead of ${allL(total)}.`
        : `The loss isn't just a few bad trades: even without your 3 worst you'd be at ${leftL}.`;
    }
    el.innerHTML = `
      <p class="ins-lead">${read}</p>
      <div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">If you took out\u2026</th><th scope="col" class="num">Their P&amp;L</th><th scope="col" class="num">Net P&amp;L without them</th></tr></thead><tbody>
        <tr><td><b>Everything (as is)</b></td><td class="mono num dim">\u2014</td><td class="mono num ${insCls(total)}"><b>${fmtMoney(total)}</b></td></tr>
        ${rowsHtml}</tbody></table></div>
      <div class="ins-note">Across ${insPlural(rows.length, "trade", "trades")} on ${insPlural(dayMap.size, "trading day", "trading days")}. Days are net P&amp;L per calendar day.</div>`;
  }

  // ---------------------------------------------------------------- Breakeven & costs
  const insUsd2 = (v) => (v == null || !Number.isFinite(v) ? "\u2014" : "$" + v.toFixed(2));
  const insPts = (v) => (v == null || !Number.isFinite(v) ? "\u2014" : (v >= 0 ? "+" : "\u2212") + Math.abs(v).toFixed(1) + " pts");
  // Break-even maths for a set of winning amounts and losing amounts (both
  // positive numbers). Break-even is where winRate x avgWin == lossRate x avgLoss,
  // i.e. winRate = avgLoss / (avgWin + avgLoss) = 1 / (1 + avgWin/avgLoss).
  function insBreakeven(winAmts, lossAmts) {
    const n = winAmts.length + lossAmts.length;
    if (!n) return null;
    const w = winAmts.length / n;
    const avgWin = winAmts.length ? winAmts.reduce((a, b) => a + b, 0) / winAmts.length : null;
    const avgLoss = lossAmts.length ? lossAmts.reduce((a, b) => a + b, 0) / lossAmts.length : null;
    const out = { n, w, winRate: w * 100, avgWin, avgLoss, be: null, cushion: null, needWin: null, maxLoss: null };
    if (avgWin != null && avgLoss != null && avgWin > 0 && avgLoss > 0) {
      out.be = (avgLoss / (avgWin + avgLoss)) * 100;
      out.cushion = out.winRate - out.be;
      // "Change only one thing" versions of break-even, at today's win rate:
      if (w > 0) out.needWin = ((1 - w) / w) * avgLoss;   // average win you'd need
      if (w < 1) out.maxLoss = (w / (1 - w)) * avgWin;    // biggest average loss you could afford
    }
    return out;
  }
  function insNetBreakeven(rows) {
    return insBreakeven(rows.filter((r) => r.win).map((r) => r.net), rows.filter((r) => !r.win).map((r) => Math.abs(r.net)));
  }
  function insGauge(b, allTrades) {
    const fill = Math.max(0, Math.min(100, b.winRate)), mark = Math.max(0, Math.min(100, b.be));
    const ok = b.winRate >= b.be;
    return `<div class="be-gauge">
      <div class="be-track"><div class="be-fill ${ok ? "ok" : "short"}" style="width:${fill.toFixed(1)}%"></div>
        <div class="be-mark" style="left:${mark.toFixed(1)}%"></div></div>
      <div class="be-legend"><span class="${ok ? "up" : "down"}">bar: your win rate</span><span>line: break-even point</span></div></div>`;
  }
  function insBreakevenTable(title, groups) {
    const list = groups.map(([label, arr]) => [label, arr, insNetBreakeven(arr)]).filter(([, arr, s]) => arr.length >= 5 && s && s.be != null);
    if (!list.length) return "";
    return `<div class="ins-sub">${title}</div><div class="table-scroll"><table class="report-table"><thead><tr>
      <th scope="col"></th><th scope="col" class="num">Trades</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">Avg win</th><th scope="col" class="num">Avg loss</th>
      <th scope="col" class="num">Needed</th><th scope="col" class="num">Vs needed</th><th scope="col" class="num">Net P&amp;L</th></tr></thead><tbody>
      ${list.map(([label, arr, s]) => `<tr${drillAttr(unescHtml(label), arr.map((r) => r.t), { row: true, sub: title })}><td>${label}</td><td class="mono num">${s.n}</td><td class="mono num">${s.winRate.toFixed(0)}%</td>
        <td class="mono num">${insUsd2(s.avgWin)}</td><td class="mono num">${insUsd2(s.avgLoss)}</td><td class="mono num">${s.be.toFixed(0)}%</td>
        <td class="mono num ${insCls(s.cushion)}">${insPts(s.cushion)}</td>
        <td class="mono num ${insCls(insSum(arr, (r) => r.net))}">${fmtMoney(insSum(arr, (r) => r.net))}</td></tr>`).join("")}
      </tbody></table></div>`;
  }
  function renderInsightsBreakeven(rows) {
    const el = document.getElementById("insights-breakeven");
    if (!el) return;
    if (rows.length < 5) { el.innerHTML = insEmpty("Needs at least 5 trades."); return; }
    const B = insNetBreakeven(rows);
    if (!B || B.be == null) {
      el.innerHTML = insEmpty("Needs at least one winning and one losing trade to work out a break-even win rate.");
      return;
    }
    // "1.4 points" when the gap is small (whole numbers would hide it), "34 points" when it's big.
    const gapTxt = (v) => { const g = Math.abs(v); const t = g < 10 ? g.toFixed(1) : g.toFixed(0); return `${t} point${t === "1.0" || t === "1" ? "" : "s"}`; };
    const allT = rows.map((r) => r.t), winT = rows.filter((r) => r.win).map((r) => r.t), lossT = rows.filter((r) => !r.win).map((r) => r.t);
    const wrB = insLink(`${B.winRate.toFixed(0)}%`, "Your win rate", allT, "Every trade in this view");
    const awB = insLink(insUsd2(B.avgWin), "Winning trades", winT, "The trades behind your average win");
    const alB = insLink(insUsd2(B.avgLoss), "Losing trades", lossT, "The trades behind your average loss");
    const beB = insLink(`${B.be.toFixed(0)}%`, "Break-even win rate", allT, "Worked out from every trade in this view");
    const gapB = insLink(gapTxt(B.cushion), "Gap to break-even", allT, "Your win rate minus the break-even rate, over every trade");
    const lead = B.cushion < 0
      ? `You win ${wrB} of trades. With an average win of ${awB} and an average loss of ${alB}, you'd need ${beB} to break even \u2014 ${gapB} short.`
      : `You win ${wrB} of trades. With an average win of ${awB} and an average loss of ${alB}, you need ${beB} to break even \u2014 you're ${gapB} above it.`;

    // The three ways to close (or protect) the gap, changing one thing at a time.
    const lever = (label, set, now, needed, fmt, needsUp, inPoints) => {
      if (needed == null) return `<tr${drillAttr(unescHtml(label), set, { row: true, sub: "Break-even levers" })}><td>${label}</td><td class="mono num">${fmt(now)}</td><td class="mono num">\u2014</td><td class="mono num dim">\u2014</td></tr>`;
      const short = needsUp ? needed > now : needed < now;
      const pct = now ? Math.abs((needed - now) / now) * 100 : null;
      const sign = needed > now ? "+" : "\u2212";
      // Win rate is already a percentage, so its gap is in points; the dollar rows also get a % change.
      const gap = inPoints ? `${sign}${Math.abs(needed - now).toFixed(1)} pts`
        : `${sign}${fmt(Math.abs(needed - now))}${pct != null ? ` (${Math.round(pct)}%)` : ""}`;
      return `<tr${drillAttr(unescHtml(label), set, { row: true, sub: "Break-even levers" })}><td>${label}</td><td class="mono num">${fmt(now)}</td><td class="mono num">${fmt(needed)}</td>
        <td class="mono num ${short ? "down" : "up"}">${short ? "need " : "room "}${gap}</td></tr>`;
    };
    const pctFmt = (v) => v.toFixed(1) + "%";
    const levers = `<div class="ins-sub">What it would take to break even (change one thing, keep the others)</div>
      <div class="table-scroll"><table class="report-table"><thead><tr><th scope="col"></th><th scope="col" class="num">Now</th><th scope="col" class="num">Break-even</th><th scope="col" class="num">Gap</th></tr></thead><tbody>
        ${lever("Win rate", rows.map((r) => r.t), B.winRate, B.be, pctFmt, true, true)}
        ${lever("Average win", rows.filter((r) => r.win).map((r) => r.t), B.avgWin, B.needWin, insUsd2, true)}
        ${lever("Average loss (smaller is better)", rows.filter((r) => !r.win).map((r) => r.t), B.avgLoss, B.maxLoss, insUsd2, false)}
      </tbody></table></div>`;

    const bySetup = new Map();
    rows.forEach((r) => { const k = r.t.setup_type || ""; if (!bySetup.has(k)) bySetup.set(k, []); bySetup.get(k).push(r); });
    const setupTable = bySetup.size > 1
      ? insBreakevenTable("By setup", Array.from(bySetup.entries()).map(([k, arr]) => [k ? escapeHtml(prettifyTag(k)) : "Unlabeled", arr])) : "";
    const sideTable = insBreakevenTable("By side", ["long", "short"].map((s) => [s[0].toUpperCase() + s.slice(1), rows.filter((r) => String(r.t.side || "").toLowerCase() === s)]));

    // ---- Cost drag: the same numbers before vs after commissions.
    const withGross = rows.filter((r) => r.gross != null);
    const totalComm = insSum(rows, (r) => r.comm);
    let cost = "";
    if (withGross.length >= 5 && totalComm > 0) {
      const G = insBreakeven(withGross.filter((r) => r.gross > 0).map((r) => r.gross), withGross.filter((r) => r.gross <= 0).map((r) => Math.abs(r.gross)));
      const N = insNetBreakeven(withGross);
      const grossTotal = insSum(withGross, (r) => r.gross), netTotal = insSum(withGross, (r) => r.net), commTotal = insSum(withGross, (r) => r.comm);
      const shares = insSum(withGross.filter((r) => r.shares > 0), (r) => r.shares);
      const cps = (v) => (shares > 0 ? (v / shares) * 100 : null);
      const flips = withGross.filter((r) => r.gross > 0 && r.net <= 0);
      const grossWinners = withGross.filter((r) => r.gross > 0).length;
      const c2 = (v) => (v == null ? "\u2014" : `${v >= 0 ? "+" : "\u2212"}${Math.abs(v).toFixed(2)}\u00a2`);
      const line = (label, a, b, d, cls) => `<tr><td>${label}</td><td class="mono num">${a}</td><td class="mono num">${b}</td><td class="mono num ${cls || "dim"}">${d}</td></tr>`;
      const beRow = G && N && G.be != null && N.be != null
        ? line("Break-even win rate", G.be.toFixed(1) + "%", N.be.toFixed(1) + "%", insPts(N.be - G.be), N.be > G.be ? "down" : "up") : "";
      const wgT = withGross.map((r) => r.t);
      const grossL = insLink(fmtMoney(grossTotal), "P&L before commissions", wgT, "Trades with before-commission P&L");
      const netL = insLink(fmtMoney(netTotal), "P&L after commissions", wgT, "Trades with before-commission P&L");
      const commL = insLink(insUsd2(commTotal), "Commissions paid", wgT, "Trades with before-commission P&L");
      const read = grossTotal > 0 && netTotal <= 0
        ? `You're profitable <b>before</b> commissions (${grossL}), but commissions of ${commL} turn that into ${netL}.`
        : grossTotal <= 0
        ? `You're losing money even <b>before</b> commissions (${grossL}) \u2014 commissions (${commL}) make it worse rather than being the cause.`
        : `Commissions took ${commL} (${((commTotal / grossTotal) * 100).toFixed(0)}% of your gross profit of ${grossL}).`;
      cost = `<div class="ins-sub">Cost drag \u2014 before vs after commissions</div>
        <p class="ins-lead">${read}</p>
        <div class="table-scroll"><table class="report-table"><thead><tr><th scope="col"></th><th scope="col" class="num">Before commissions</th><th scope="col" class="num">After commissions</th><th scope="col" class="num">Change</th></tr></thead><tbody>
          ${line("Total P&amp;L", fmtMoney(grossTotal), fmtMoney(netTotal), fmtMoney(netTotal - grossTotal), "down")}
          ${G && N ? line("Win rate", G.winRate.toFixed(1) + "%", N.winRate.toFixed(1) + "%", insPts(N.winRate - G.winRate), N.winRate < G.winRate ? "down" : "dim") : ""}
          ${G && N ? line("Average win", insUsd2(G.avgWin), insUsd2(N.avgWin), G.avgWin != null && N.avgWin != null ? fmtMoney(N.avgWin - G.avgWin) : "\u2014") : ""}
          ${G && N ? line("Average loss", insUsd2(G.avgLoss), insUsd2(N.avgLoss), G.avgLoss != null && N.avgLoss != null ? fmtMoney(N.avgLoss - G.avgLoss) : "\u2014") : ""}
          ${beRow}
          ${shares > 0 ? line("P&amp;L per share", c2(cps(grossTotal)), c2(cps(netTotal)), c2(cps(netTotal - grossTotal)), "down") : ""}
        </tbody></table></div>
        <div class="ins-note"><b${drillAttr("Made money before commissions, lost after", flips.map((r) => r.t), { sub: "Commission flips" })}>${flips.length}</b> of your ${withGross.length} trades (${((flips.length / withGross.length) * 100).toFixed(0)}%) made money before commissions but lost after them${grossWinners ? ` \u2014 ${((flips.length / grossWinners) * 100).toFixed(0)}% of your gross winners` : ""}.
        Commissions average ${insLink(insUsd2(commTotal / withGross.length), "Commissions per trade", wgT, "Trades with before-commission P&L")} a trade${shares > 0 ? ` (${(cps(commTotal)).toFixed(2)}\u00a2 a share)` : ""}.</div>`;
    } else if (totalComm <= 0) {
      cost = `<div class="ins-note">No commissions are recorded on these trades, so there is no cost-drag comparison to show.</div>`;
    }

    el.innerHTML = `
      <p class="ins-lead">${lead}</p>${insGauge(B, allT)}${levers}${setupTable}${sideTable}${cost}
      <div class="ins-note">Break-even win rate = average loss \u00f7 (average win + average loss), using P&amp;L after commissions. It's the win rate at which winners and losers cancel out exactly. Groups with fewer than 5 trades are hidden \u2014 small samples swing wildly.</div>`;
  }

  // ---------------------------------------------------------------- Re-entry timing + rule simulator
  // "HH:MM:SS" -> minutes since midnight (NaN when missing/garbled).
  function insToMin(s) {
    if (typeof s !== "string" || !s) return NaN;
    const [h, m, sec] = s.split(":").map(Number);
    return h * 60 + m + (sec || 0) / 60;
  }
  let insFastMin = 5; // "fast re-entry" = opened within this many minutes of the previous trade closing

  // How quickly you go back in after a loss (vs after a win), and whether the fast ones do worse.
  function insReentryBody(seq) {
    const withGap = seq.filter((r) => r.prev && r.gap != null);
    if (withGap.length < 8) return insEmpty("Needs at least 8 trades that follow another trade on the same day, with entry and exit times recorded.");
    const BUCKETS = [
      ["While still in the last trade", (g) => g < 0],
      ["Under 1 min", (g) => g >= 0 && g < 1],
      ["1\u20135 min", (g) => g >= 1 && g < 5],
      ["5\u201315 min", (g) => g >= 5 && g < 15],
      ["15\u201330 min", (g) => g >= 15 && g < 30],
      ["30+ min", (g) => g >= 30],
    ];
    const st = (arr) => (arr.length ? { trades: arr.map((r) => r.t), n: arr.length, wr: (arr.filter((r) => r.win).length / arr.length) * 100, avg: insAvg(arr, (r) => r.net), net: insSum(arr, (r) => r.net) } : null);
    // All three numbers in a group open the same trades.
    const cell = (s, title) => {
      if (!s) return `<td class="mono num dim">0</td><td class="mono num dim">\u2014</td><td class="mono num dim">\u2014</td>`;
      const a = drillAttr(title, s.trades, { sub: "Re-entry timing" });
      return `<td class="mono num"${a}>${s.n}</td><td class="mono num ${s.wr >= 50 ? "up" : "down"}"${a}>${s.wr.toFixed(0)}%</td><td class="mono num ${insCls(s.avg)}"${a}>${fmtMoney(s.avg)}</td>`;
    };
    const rowsHtml = BUCKETS.map(([label, f]) => {
      const inBucket = withGap.filter((r) => f(r.gap));
      const L = st(inBucket.filter((r) => r.prev === "loss")), W = st(inBucket.filter((r) => r.prev === "win"));
      return L || W ? `<tr><td${drillAttr(label, inBucket.map((r) => r.t), { row: true, sub: "Re-entry timing \u00b7 after a win or a loss" })}>${label}</td>${cell(L, label + " \u00b7 after a loss")}${cell(W, label + " \u00b7 after a win")}</tr>` : "";
    }).join("");

    // Fast vs slow after a loss, using the adjustable threshold.
    const T = insFastMin;
    const lossRows = withGap.filter((r) => r.prev === "loss");
    const fast = lossRows.filter((r) => r.gap <= T), slow = lossRows.filter((r) => r.gap > T);
    const notes = [];
    const fs = st(fast), ss = st(slow);
    if (fs && ss && fs.n >= 8 && ss.n >= 8) {
      const d = fs.wr - ss.wr;
      const fL = (txt) => insLink(txt, `Opened within ${T} min of a loss`, fs.trades, "Re-entry timing");
      const sL = (txt) => insLink(txt, `Opened more than ${T} min after a loss`, ss.trades, "Re-entry timing");
      notes.push(`Trades opened within ${fL(`${T} min`)} of a loss win ${fL(`${fs.wr.toFixed(0)}%`)} (net ${fL(fmtMoney(fs.net))}, ${fs.n} trades) versus ${sL(`${ss.wr.toFixed(0)}%`)} when you wait longer (net ${sL(fmtMoney(ss.net))}, ${ss.n} trades)${Math.abs(d) >= 5 ? ` \u2014 ${Math.abs(d).toFixed(0)} points ${d < 0 ? "worse" : "better"} when you rush back in` : ""}.`);
    } else {
      notes.push(`Not enough trades on both sides of ${T} min after a loss to compare (need 8 each) \u2014 try a different threshold.`);
    }
    // Fast AND bigger than the trade just closed: the classic "make it back" signature.
    const bigger = fast.filter((r) => r.notional != null && r.prevRow && r.prevRow.notional != null && r.notional >= 1.25 * r.prevRow.notional);
    const bs = st(bigger);
    if (bs && bs.n >= 3) {
      const bL = (txt) => insLink(txt, `Fast and 25%+ bigger (within ${T} min of a loss)`, bs.trades, "The \"make it back\" pattern");
      notes.push(`Of the ${fast.length} trades opened within ${T} min of a loss, ${bL(String(bs.n))} were also at least 25% bigger than the trade before \u2014 they won ${bL(`${bs.wr.toFixed(0)}%`)} and netted ${bL(fmtMoney(bs.net))}.`);
    }
    return `<p class="ins-lead">${notes.join(" ")}</p>
      <div class="table-scroll"><table class="report-table"><thead>
        <tr><th scope="col" rowspan="2">Time since the last trade closed</th><th scope="col" class="num" colspan="3">After a loss</th><th scope="col" class="num" colspan="3">After a win</th></tr>
        <tr><th scope="col" class="num">Trades</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">Avg P&amp;L</th><th scope="col" class="num">Trades</th><th scope="col" class="num">Win rate</th><th scope="col" class="num">Avg P&amp;L</th></tr>
      </thead><tbody>${rowsHtml}</tbody></table></div>
      <div class="ins-note">Measured from the previous trade's exit to this trade's entry, same day only. "While still in the last trade" means you entered before the previous one closed.</div>`;
  }

  // ---- Rule simulator: replay your own days with a rule applied, one rule at a time.
  const INS_RULES = [
    { key: "streak", label: "Stop for the day after", unit: "losses in a row", step: 1 },
    { key: "dailyLoss", label: "Stop for the day once down", unit: "dollars", step: "any" },
    { key: "maxTrades", label: "Stop after", unit: "trades in a day", step: 1 },
    { key: "cooldown", label: "Wait after every loss", unit: "minutes", step: "any" },
    { key: "profitLock", label: "Stop for the day once up", unit: "dollars", step: "any" },
  ];
  let insRuleParams = { streak: 2, dailyLoss: null, maxTrades: null, cooldown: 5, profitLock: null }; // null = default worked out from the data
  let insRuleDays = [], insRuleDefaults = {}, insRuleTotal = 0;

  function insSimulate(days, key, p) {
    const skipped = [];
    let daysAffected = 0;
    days.forEach((list) => {
      let run = 0, net = 0, taken = 0, stopped = false, blockedUntil = -Infinity, hit = false;
      list.forEach((r) => {
        if (stopped) { skipped.push(r); hit = true; return; }
        if (key === "cooldown") {
          const e = insToMin(r.t.entry_time);
          if (Number.isFinite(e) && e < blockedUntil) { skipped.push(r); hit = true; return; }
        }
        taken++; net += r.net; run = r.win ? 0 : run + 1;
        if (key === "cooldown" && !r.win) { const x = insToMin(r.t.exit_time); blockedUntil = Number.isFinite(x) ? x + p : -Infinity; }
        if (key === "streak" && run >= p) stopped = true;
        if (key === "dailyLoss" && net <= -p) stopped = true;
        if (key === "profitLock" && net >= p) stopped = true;
        if (key === "maxTrades" && taken >= p) stopped = true;
      });
      if (hit) daysAffected++;
    });
    return { skipped, daysAffected };
  }
  const insRuleValue = (key) => (insRuleParams[key] != null ? insRuleParams[key] : insRuleDefaults[key]);
  function insRuleOutcome(rule) {
    const p = insRuleValue(rule.key);
    const sim = insSimulate(insRuleDays, rule.key, p);
    const skippedNet = insSum(sim.skipped, (r) => r.net);
    const skippedSet = new Set(sim.skipped);
    return {
      rule, p, n: sim.skipped.length, days: sim.daysAffected, skipped: sim.skipped,
      kept: insRuleDays.flat().filter((r) => !skippedSet.has(r)),
      wr: sim.skipped.length ? (sim.skipped.filter((r) => r.win).length / sim.skipped.length) * 100 : null,
      pnl: insRuleTotal - skippedNet, change: -skippedNet,
    };
  }
  function insFillRuleRow(tr, o) {
    const set = (cls, html) => { const c = tr.querySelector("." + cls); if (c) c.innerHTML = html; };
    const ruleName = `${o.rule.label} ${o.rule.unit === "dollars" ? "$" + o.p : o.p + " " + o.rule.unit}`;
    const skipA = o.n ? drillAttr(`Skipped by rule: ${ruleName}`, o.skipped.map((r) => r.t), { sub: "The trades this rule would have kept you out of" }) : "";
    const keptA = "";
    set("r-n", o.n ? `<span${skipA}>${o.n}</span>` : "0");
    set("r-days", o.n ? `<span${skipA}>${o.days}</span>` : String(o.days));
    set("r-wr", o.wr == null ? "\u2014" : `<span class="${o.wr >= 50 ? "up" : "down"}"${skipA}>${o.wr.toFixed(0)}%</span>`);
    set("r-pnl", `<span class="${insCls(o.pnl)}"${keptA}>${fmtMoney(o.pnl)}</span>`);
    set("r-chg", o.n ? `<span class="${insCls(o.change)}"${skipA}><b>${fmtMoney(o.change)}</b></span>` : `<span class="dim">no effect</span>`);
  }
  function insRefreshRules() {
    const panel = document.getElementById("insights-rules");
    if (!panel) return;
    const outs = INS_RULES.map(insRuleOutcome);
    panel.querySelectorAll("tr[data-rule]").forEach((tr) => insFillRuleRow(tr, outs.find((o) => o.rule.key === tr.dataset.rule)));
    const affecting = outs.filter((o) => o.n > 0);
    const best = affecting.reduce((b, o) => (!b || o.change > b.change ? o : b), null);
    const lead = document.getElementById("ins-rules-lead");
    if (lead) lead.innerHTML = !affecting.length
      ? "None of these rules would have changed anything with the values below."
      : best.change > 0
        ? (() => {
          const bestSet = best.skipped.map((r) => r.t);
          const bestSub = "The trades this rule would have kept you out of";
          const bestName = `${best.rule.label} ${best.rule.unit === "dollars" ? "$" + best.p : best.p + " " + best.rule.unit}`;
          return `In hindsight, the rule that would have helped most is ${insLink(`${best.rule.label.toLowerCase()} ${best.rule.unit === "dollars" ? "$" + best.p : best.p + " " + best.rule.unit}`, `Skipped by rule: ${bestName}`, bestSet, bestSub)}: ${insLink(fmtMoney(best.change), `Skipped by rule: ${bestName}`, bestSet, bestSub)} better, by skipping ${best.n} ${best.n === 1 ? "trade" : "trades"} on ${best.days} ${best.days === 1 ? "day" : "days"}.`;
        })()
        : "None of these rules would have improved your P&amp;L \u2014 the trades they'd have skipped made about as much as they lost.";
  }
  function renderInsightsRules(rows) {
    const el = document.getElementById("insights-rules");
    if (!el) return;
    if (rows.length < 10) { el.innerHTML = insEmpty("Needs at least 10 trades."); return; }
    const byDay = new Map();
    rows.forEach((r) => { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); });
    insRuleDays = Array.from(byDay.values()).map((l) => l.slice().sort((a, b) => String(a.t.entry_time || "").localeCompare(String(b.t.entry_time || ""))));
    insRuleTotal = insSum(rows, (r) => r.net);
    // Starting values come from your own trade sizes (3x an average loss / win, a busy-day trade count), not from tuning against the results.
    const wins = rows.filter((r) => r.win), losses = rows.filter((r) => !r.win);
    const counts = insRuleDays.map((l) => l.length).sort((a, b) => a - b);
    insRuleDefaults = {
      dailyLoss: Math.max(1, Math.round(3 * (losses.length ? insAvg(losses, (r) => Math.abs(r.net)) : 1))),
      profitLock: Math.max(1, Math.round(3 * (wins.length ? insAvg(wins, (r) => r.net) : 1))),
      maxTrades: Math.max(3, counts[Math.floor(counts.length * 0.75)] || 3),
    };
    const rowsHtml = INS_RULES.map((rule) => `<tr data-rule="${rule.key}">
      <td>${rule.label}</td>
      <td><input type="number" class="filter-input ins-rule-input" data-rule="${rule.key}" min="0" step="${rule.step}" value="${insRuleValue(rule.key)}" aria-label="${rule.label} (${rule.unit})" /> <span class="dim">${rule.unit}</span></td>
      <td class="mono num r-n"></td><td class="mono num r-days"></td><td class="mono num r-wr"></td><td class="mono num r-pnl"></td><td class="mono num r-chg"></td></tr>`).join("");
    el.innerHTML = `
      <p class="ins-lead" id="ins-rules-lead"></p>
      <div class="table-scroll"><table class="report-table"><thead><tr><th scope="col">Rule</th><th scope="col">Value</th><th scope="col" class="num">Trades skipped</th><th scope="col" class="num">Days affected</th><th scope="col" class="num">Skipped win rate</th><th scope="col" class="num">P&amp;L with rule</th><th scope="col" class="num">Change</th></tr></thead>
        <tbody>${rowsHtml}
        <tr class="dim"><td>Your actual results</td><td></td><td class="mono num">0</td><td class="mono num">0</td><td class="mono num">\u2014</td><td class="mono num"><span class="${insCls(insRuleTotal)}">${fmtMoney(insRuleTotal)}</span></td><td class="mono num">\u2014</td></tr></tbody></table></div>
      <div class="ins-note">Each rule is tested on its own against your real days, in the order you entered trades. It assumes the trades a rule would have skipped are simply not taken, and that the rest go exactly as they did \u2014 in reality you'd also trade differently after stopping, so treat this as a hint, not a forecast. Change the values to see how sensitive the result is: a rule that only helps at one exact number is probably fitting noise. The starting values are 3\u00d7 your average loss / win and a busy-day trade count, not tuned to your results.</div>`;
    insRefreshRules();
    if (!el.__rulesBound) {
      el.__rulesBound = true;
      el.addEventListener("input", (e) => {
        const inp = e.target.closest && e.target.closest("input.ins-rule-input");
        if (!inp) return;
        const v = parseFloat(inp.value);
        if (!(v >= 0)) return;
        insRuleParams[inp.dataset.rule] = v;
        insRefreshRules();
      }, { signal: App.signal });
    }
  }

  function renderInsights() {
    const trades = App.state.trades;
    const rows = insRows(trades);
    if (!rows.length) {
      ["insights-breakeven", "insights-timesize", "insights-behavior", "insights-rules", "insights-concentration"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = insEmpty("No data yet.");
      });
      return;
    }
    // Independent panels: one failing shouldn't blank the others.
    App.safeRender(() => renderInsightsBreakeven(rows), "renderInsightsBreakeven");
    App.safeRender(() => renderInsightsTimeSize(rows, trades), "renderInsightsTimeSize");
    App.safeRender(() => renderInsightsBehavior(rows), "renderInsightsBehavior");
    App.safeRender(() => renderInsightsRules(rows), "renderInsightsRules");
    App.safeRender(() => renderInsightsConcentration(rows), "renderInsightsConcentration");
  }

  App.tabs.reports.initReportFilters = initReportFilters;
  App.tabs.reports.applyReportFiltersAndRender = applyReportFiltersAndRender;
  Object.assign(R, { renderInsights });
})();
