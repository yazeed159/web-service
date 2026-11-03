// setup-scorecards.js -- per-setup stats (win rate, expectancy, profit factor, hold time) split by
// time of day. Pure functions: window.SetupScorecards in the browser, module.exports under Node.
(function (root) {
  "use strict";
  // Buckets match the premarket split used by the behavior tags (4-7am vs 7-9:30am).
  var BUCKETS = [
    { id: "pm_early", label: "4:00-7:00",  from: 240, to: 420 },
    { id: "pm_late",  label: "7:00-9:30",  from: 420, to: 570 },
    { id: "open",     label: "9:30-10:30", from: 570, to: 630 },
    { id: "midday",   label: "10:30-16:00", from: 630, to: 960 },
    { id: "after",    label: "After 16:00", from: 960, to: 1440 },
  ];
  function minutesOf(s) {
    if (typeof s !== "string") return null;
    var m = /^(\d{1,2}):(\d{2})/.exec(s);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  function bucketOf(entryTime) {
    var m = minutesOf(entryTime);
    if (m === null) return null;
    for (var i = 0; i < BUCKETS.length; i++) if (m >= BUCKETS[i].from && m < BUCKETS[i].to) return BUCKETS[i];
    return null; // before 4:00
  }
  function holdMinutes(t) {
    var a = minutesOf(t.entry_time), b = minutesOf(t.exit_time);
    if (a === null || b === null) return null;
    var sa = a * 60 + (Number(String(t.entry_time).split(":")[2]) || 0), sb = b * 60 + (Number(String(t.exit_time).split(":")[2]) || 0);
    return sb > sa ? (sb - sa) / 60 : null;
  }
  function stats(trades) {
    var pnls = trades.map(function (t) { var v = Number(t.pnl_after_comm); return isFinite(v) ? v : 0; });
    var n = pnls.length;
    var wins = pnls.filter(function (v) { return v > 0; }), losses = pnls.filter(function (v) { return v < 0; });
    var gw = wins.reduce(function (a, b) { return a + b; }, 0), gl = -losses.reduce(function (a, b) { return a + b; }, 0);
    var holds = trades.map(holdMinutes).filter(function (v) { return v !== null; });
    return {
      n: n,
      winRate: n ? wins.length / n : null,
      expectancy: n ? pnls.reduce(function (a, b) { return a + b; }, 0) / n : null,
      total: pnls.reduce(function (a, b) { return a + b; }, 0),
      avgWin: wins.length ? gw / wins.length : null,
      avgLoss: losses.length ? -gl / losses.length : null,
      profitFactor: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null),
      avgHoldMin: holds.length ? holds.reduce(function (a, b) { return a + b; }, 0) / holds.length : null,
    };
  }
  // -> [{setup, ...stats, byTime: [{bucket, label, ...stats}]}] sorted by trade count desc.
  // `only` (optional array) limits/orders the setups shown; trades with no setup_type are ignored.
  function build(trades, only) {
    var groups = {};
    trades.forEach(function (t) { if (t.setup_type) (groups[t.setup_type] = groups[t.setup_type] || []).push(t); });
    var keys = only && only.length ? only.filter(function (k) { return groups[k]; }) : Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length; });
    return keys.map(function (k) {
      var r = stats(groups[k]); r.setup = k;
      r.byTime = BUCKETS.map(function (b) {
        var s = stats(groups[k].filter(function (t) { var x = bucketOf(t.entry_time); return x && x.id === b.id; }));
        s.bucket = b.id; s.label = b.label; return s;
      });
      return r;
    });
  }
  var api = { BUCKETS: BUCKETS, bucketOf: bucketOf, holdMinutes: holdMinutes, stats: stats, build: build };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SetupScorecards = api;
})(typeof window !== "undefined" ? window : this);
