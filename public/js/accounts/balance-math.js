// balance-math.js -- pure balance / return maths shared by the dashboard and Accounts page.
// No DOM, no network. Runs in the browser (window.BalanceMath) and under Node (tests/balance-math.test.js).
//
// Conventions (ISO "YYYY-MM-DD" strings, compared as text):
//   entries  [{date, amount}]                      deposits (+) and withdrawals (-)
//   trades   [{trade_date, pnl_after_comm}]
//   period   {start, end}   end is EXCLUSIVE; null = still open
// A period's balance CARRIES OVER: it is everything deposited/withdrawn plus all P&L up to its end.
(function (root) {
  "use strict";
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pnlOf(t) { return num(t && t.pnl_after_comm); }
  function sum(list, f) { var s = 0; for (var i = 0; i < list.length; i++) s += f(list[i]); return s; }
  function inRange(d, p) { return !!d && d >= p.start && (p.end === null || p.end === undefined || d < p.end); }

  // Money in the account just BEFORE `date` (deposits/withdrawals dated earlier + P&L of earlier trades).
  function balanceBefore(entries, trades, date) {
    return sum(entries.filter(function (e) { return e.date < date; }), function (e) { return num(e.amount); }) +
           sum(trades.filter(function (t) { return (t.trade_date || "") < date; }), pnlOf);
  }

  // Day-by-day time-weighted return. Money added/withdrawn on a day counts BEFORE that day's P&L,
  // so a deposit never looks like profit and a withdrawal never looks like a loss. Days where the
  // account is empty (equity <= 0) can't produce a return and are skipped. Returns a fraction
  // (0.05 = +5%) or null when there was nothing to measure.
  function timeWeightedReturn(openingEquity, entries, trades) {
    var flow = {}, pnl = {}, days = {};
    entries.forEach(function (e) { flow[e.date] = (flow[e.date] || 0) + num(e.amount); days[e.date] = 1; });
    trades.forEach(function (t) { if (t.trade_date) { pnl[t.trade_date] = (pnl[t.trade_date] || 0) + pnlOf(t); days[t.trade_date] = 1; } });
    var equity = num(openingEquity), factor = 1, measured = false;
    Object.keys(days).sort().forEach(function (d) {
      equity += flow[d] || 0;
      var p = pnl[d] || 0;
      if (d in pnl && equity > 0) { factor *= 1 + p / equity; measured = true; }
      equity += p;
    });
    return measured ? factor - 1 : null;
  }

  // Lowest balance the account ever reached (money added/withdrawn counts before that day's P&L).
  // Returns {min, date} or null when there is no history. A dip below zero is impossible in a real
  // account, so it points at a missing deposit (or a withdrawal entered twice).
  function lowestBalance(entries, trades) {
    var flow = {}, pnl = {}, days = {};
    entries.forEach(function (e) { flow[e.date] = (flow[e.date] || 0) + num(e.amount); days[e.date] = 1; });
    trades.forEach(function (t) { if (t.trade_date) { pnl[t.trade_date] = (pnl[t.trade_date] || 0) + pnlOf(t); days[t.trade_date] = 1; } });
    var eq = 0, low = null;
    Object.keys(days).sort().forEach(function (d) {
      eq += flow[d] || 0; if (low === null || eq < low.min) low = { min: eq, date: d };
      eq += pnl[d] || 0;  if (low === null || eq < low.min) low = { min: eq, date: d };
    });
    return low;
  }

  function periodSummary(entries, trades, p) {
    var pe = entries.filter(function (e) { return inRange(e.date, p); });
    var pt = trades.filter(function (t) { return inRange(t.trade_date, p); });
    var carryIn = balanceBefore(entries, trades, p.start);
    var added = sum(pe, function (e) { return num(e.amount); });
    var pnl = sum(pt, pnlOf);
    return { carryIn: carryIn, added: added, pnl: pnl, trades: pt.length, endBalance: carryIn + added + pnl,
             twr: timeWeightedReturn(carryIn, pe, pt) };
  }

  var api = { balanceBefore: balanceBefore, timeWeightedReturn: timeWeightedReturn, lowestBalance: lowestBalance, periodSummary: periodSummary, inRange: inRange };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.BalanceMath = api;
})(typeof window !== "undefined" ? window : this);
