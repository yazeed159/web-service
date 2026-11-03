// import-gaps.js -- finds long quiet stretches in a list of trade dates, so the import page can offer
// "start a new period here". Pure: window.ImportGaps / module.exports.
(function (root) {
  "use strict";
  function dayNum(d) { return Math.round(Date.parse(d + "T12:00:00Z") / 86400000); }
  // dates: ["YYYY-MM-DD", ...] (any order, duplicates fine). Returns gaps (oldest first):
  // [{from: lastTradeBefore, to: firstTradeAfter, days}] where days >= minDays.
  function findGaps(dates, minDays) {
    var u = Array.from(new Set((dates || []).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }))).sort();
    var out = [];
    for (var i = 1; i < u.length; i++) {
      var days = dayNum(u[i]) - dayNum(u[i - 1]);
      if (days >= (minDays || 30)) out.push({ from: u[i - 1], to: u[i], days: days });
    }
    return out;
  }
  var api = { findGaps: findGaps };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ImportGaps = api;
})(typeof window !== "undefined" ? window : this);
