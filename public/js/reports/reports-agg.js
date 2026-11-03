(function () {
  "use strict";
  const R = (App.reports = App.reports || {});
  const { drillAttr, renderPaginatedBreakdownTable } = R;

  // The actual trades behind each streak (trades are already chronological):
  // longest win run, longest loss run, and the run you're in right now.
  function streakInfo(list) {
    let bestWin = [], bestLoss = [], cur = [], curWin = null;
    list.forEach((t) => {
      const w = Boolean(t.win);
      if (cur.length && curWin === w) cur.push(t);
      else { cur = [t]; curWin = w; }
      if (w && cur.length > bestWin.length) bestWin = cur.slice();
      if (!w && cur.length > bestLoss.length) bestLoss = cur.slice();
    });
    return { bestWin, bestLoss, current: cur };
  }
  function symbolAgg() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!map.has(t.symbol)) map.set(t.symbol, { trades: [], net: 0 });
      const e = map.get(t.symbol);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return map;
  }
  // sector/country aren't in the documented index schema today (only
  // trade detail files carry symbol_info) -- this reads them from the
  // index row IF the publish step has been extended to copy them over
  // (same pattern as setup_type/lesson_tags), and just shows an empty
  // state otherwise rather than fetching every detail file to fill the
  // gap, which would defeat the whole point of the index existing.
  const countryName = (code) => { try { return new Intl.DisplayNames(undefined, { type: "region" }).of(String(code).toUpperCase()) || code; } catch (e) { return code; } };
  const FIELD_FALLBACKS = { country: "issuer_country", subtype: "sub_category" };
  function groupByField(field) {
    const map = new Map();
    let anyPresent = false;
    App.state.trades.forEach((t) => {
      let v = t[field] || t[FIELD_FALLBACKS[field]];
      if (!v) return;
      // The broker's own codes: CN -> China, ADR / COMMON -> ADR / Common stock.
      if (!t[field] && field === "country") v = countryName(v);
      if (!t[field] && field === "subtype") v = v === "COMMON" ? "Common stock" : String(v);
      anyPresent = true;
      if (!map.has(v)) map.set(v, { trades: [], net: 0 });
      const e = map.get(v);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return anyPresent ? map : null;
  }
  function renderBreakdownTable(elId, map, colLabel) {
    if (!map) {
      const el = document.getElementById(elId);
      if (el) el.innerHTML = `<div class="empty-state small">No ${escapeHtml(colLabel.toLowerCase())} data on these trades yet.</div>`;
      return;
    }
    const rows = Array.from(map.entries()).sort((a, b) => b[1].net - a[1].net);
    const maxAbs = Math.max(1, ...rows.map(([, e]) => Math.abs(e.net)));
    renderPaginatedBreakdownTable(elId, rows, colLabel, ([key, e]) => {
      const winRate = (e.trades.filter((t) => t.win).length / e.trades.length) * 100;
      const pct = (Math.abs(e.net) / maxAbs) * 100;
      const color = e.net >= 0 ? "var(--green)" : "var(--red)";
      return `<tr class="report-row"${drillAttr(key, e.trades, { row: true, sub: colLabel })}>
        <td style="font-weight:600;">${escapeHtml(key)}</td>
        <td class="mono dim">${e.trades.length}</td>
        <td class="mono">${winRate.toFixed(0)}%</td>
        <td class="mono"><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${pct.toFixed(0)}%;background:${color}"></span></span><span class="${e.net >= 0 ? "up" : "down"}">${fmtMoney(e.net)}</span></td>
      </tr>`;
    });
  }
  function dailyAgg() {
    const map = new Map();
    App.state.trades.forEach((t) => {
      if (!map.has(t.trade_date)) map.set(t.trade_date, { trades: [], net: 0 });
      const e = map.get(t.trade_date);
      e.trades.push(t);
      e.net += t.pnl_after_comm;
    });
    return map;
  }
  Object.assign(R, { dailyAgg, groupByField, renderBreakdownTable, streakInfo, symbolAgg });
})();
