// loss-limit.js -- pure maths for the dashboard's daily loss limit. No DOM, no network.
// Runs in the browser (window.LossLimit) and under Node (tests/loss-limit.test.js).
//
// "Used" is the WORST running loss reached during the day (peak-to-floor of cumulative P&L from the
// first trade), the same measure the plan's max-loss meter always used: once you have hit the limit
// at any point, a later win does not un-hit it.
//
// A day's limit comes from, in order: that day's plan (Daily plan page: max_loss), else the standing
// default saved from the dashboard (user_kv key "daily_loss_limit": {amount}).
(function (root) {
  "use strict";
  var WARN_AT = 0.75;   // "close to your limit" from here
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function worstLoss(trades) {
    var list = (trades || []).slice().sort(function (a, b) { return String(a.entry_time || "").localeCompare(String(b.entry_time || "")); });
    var cum = 0, low = 0;
    list.forEach(function (t) { cum += num(t.pnl_after_comm); if (cum < low) low = cum; });
    return -low || 0;   // >= 0 (the || 0 turns -0 into 0)
  }

  // standing: {amount, since:"YYYY-MM-DD"} or a bare number. A default only governs days on/after
  // `since`, so setting it today never rewrites how past days were scored.
  function resolve(dayPlan, standing, date) {
    var m = dayPlan && dayPlan.max_loss;
    if (m != null && isFinite(m) && Number(m) > 0) return { amount: Number(m), source: "plan" };
    var amount = standing && typeof standing === "object" ? Number(standing.amount) : Number(standing);
    var since = standing && typeof standing === "object" ? standing.since : null;
    if (!(isFinite(amount) && amount > 0)) return null;
    if (since && date && String(date) < String(since)) return null;
    return { amount: amount, source: "standing" };
  }

  // state: "ok" | "warn" | "breached" | "none" (no limit set)
  function evaluate(trades, limit) {
    var used = worstLoss(trades);
    if (!limit || !(limit.amount > 0)) return { state: "none", used: used, remaining: null, ratio: 0 };
    var ratio = used / limit.amount;
    var state = ratio >= 1 ? "breached" : ratio >= WARN_AT ? "warn" : "ok";
    return { state: state, used: used, remaining: Math.max(0, limit.amount - used), ratio: ratio, amount: limit.amount, source: limit.source };
  }

  // "$1,250.50" / "250" / " 75 " -> number > 0, else null. Whole cents only.
  function parseAmount(text) {
    var s = String(text == null ? "" : text).replace(/[\s$,]/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var n = Number(s);
    return n > 0 && n <= 1e9 ? n : null;
  }

  var api = { WARN_AT: WARN_AT, worstLoss: worstLoss, resolve: resolve, evaluate: evaluate, parseAmount: parseAmount };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.LossLimit = api;
})(typeof window !== "undefined" ? window : this);
