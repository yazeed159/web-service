// review-math.js -- pure maths for the weekly / monthly review page. No DOM, no network.
// Runs in the browser (window.ReviewMath) and under Node (tests/review-math.test.js).
// Dates are ISO "YYYY-MM-DD" strings, compared as text; calendar maths is done in UTC so DST never matters.
(function (root) {
  "use strict";
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function pad(n) { return String(n).padStart(2, "0"); }
  function utc(iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])); }
  function fmt(d) { return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()); }
  function addDays(iso, n) { var d = utc(iso); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function pretty(iso) { var d = utc(iso); return DOW[d.getUTCDay()] + " " + MON[d.getUTCMonth()] + " " + d.getUTCDate(); }

  // kind: "week" (Monday-Sunday) | "month". anchor: any date inside the period.
  function range(kind, anchor) {
    if (kind === "month") {
      var d = utc(anchor), y = d.getUTCFullYear(), m = d.getUTCMonth();
      var from = fmt(new Date(Date.UTC(y, m, 1))), to = fmt(new Date(Date.UTC(y, m + 1, 0)));
      return { kind: kind, from: from, to: to, label: MON[m] + " " + y, prev: addDays(from, -1), next: addDays(to, 1) };
    }
    var dow = utc(anchor).getUTCDay(), mon = addDays(anchor, -((dow + 6) % 7)), sun = addDays(mon, 6);
    return { kind: "week", from: mon, to: sun, label: pretty(mon) + " \u2013 " + pretty(sun), prev: addDays(mon, -1), next: addDays(sun, 1) };
  }

  function groupBy(list, keyFn) {
    var o = {}; list.forEach(function (t) { var k = keyFn(t); if (k) (o[k] = o[k] || []).push(t); }); return o;
  }

  // opts: { from, to, limitFor(date)->{amount}|null, days:{date:{followed_plan,...}}, isProcessTag(tag)->bool }
  function summarize(allTrades, opts) {
    opts = opts || {};
    var trades = (allTrades || []).filter(function (t) { return t.trade_date >= opts.from && t.trade_date <= opts.to; });
    var pnl = function (t) { return num(t.pnl_after_comm); };
    var net = 0, wins = 0;
    trades.forEach(function (t) { net += pnl(t); if (pnl(t) > 0) wins++; });

    var byDay = groupBy(trades, function (t) { return t.trade_date; });
    var perDay = Object.keys(byDay).sort().map(function (d) {
      var list = byDay[d].slice().sort(function (a, b) { return String(a.entry_time || "").localeCompare(String(b.entry_time || "")); });
      var cum = 0, low = 0, tot = 0;
      list.forEach(function (t) { cum += pnl(t); tot += pnl(t); if (cum < low) low = cum; });
      return { date: d, n: list.length, net: tot, worstLoss: -low || 0 };
    });
    var bestDay = perDay.length ? perDay.slice().sort(function (a, b) { return b.net - a.net; })[0] : null;
    var worstDay = perDay.length ? perDay.slice().sort(function (a, b) { return a.net - b.net; })[0] : null;

    var bySetup = groupBy(trades, function (t) { return t.setup_type; });
    var setups = Object.keys(bySetup).map(function (k) {
      var l = bySetup[k], tot = 0, w = 0;
      l.forEach(function (t) { tot += pnl(t); if (pnl(t) > 0) w++; });
      return { setup: k, n: l.length, total: tot, winRate: w / l.length };
    }).sort(function (a, b) { return b.total - a.total; });

    // Rule breaks: trades that are tagged but not clean, the process tags behind them, days that went through
    // the loss limit, and days you marked "didn't follow my plan".
    var tagged = trades.filter(function (t) { return Array.isArray(t.behavior_tags); });
    var notClean = tagged.filter(function (t) { return t.behavior_tags.indexOf("clean_trade") === -1; });
    var isProc = opts.isProcessTag || function (k) { return k !== "clean_trade"; };
    var tagMap = {};
    tagged.forEach(function (t) {
      t.behavior_tags.forEach(function (k) {
        if (k === "clean_trade" || !isProc(k)) return;
        var e = tagMap[k] = tagMap[k] || { tag: k, n: 0, net: 0 }; e.n++; e.net += pnl(t);
      });
    });
    var topTags = Object.keys(tagMap).map(function (k) { return tagMap[k]; }).sort(function (a, b) { return b.n - a.n || a.net - b.net; }).slice(0, 5);
    var limitBreaches = [];
    if (opts.limitFor) perDay.forEach(function (d) { var l = opts.limitFor(d.date); if (l && d.worstLoss >= l.amount) limitBreaches.push({ date: d.date, used: d.worstLoss, limit: l.amount }); });
    var days = opts.days || {};
    var notFollowed = perDay.filter(function (d) { return days[d.date] && days[d.date].followed_plan === false; }).map(function (d) { return d.date; });

    return {
      from: opts.from, to: opts.to, n: trades.length, net: net, wins: wins, losses: trades.length - wins,
      winRate: trades.length ? wins / trades.length : null, tradingDays: perDay.length, perDay: perDay,
      bestDay: bestDay, worstDay: worstDay, setups: setups,
      bestSetup: setups.length ? setups[0] : null, worstSetup: setups.length > 1 ? setups[setups.length - 1] : null,
      ruleBreaks: { taggedTrades: tagged.length, notClean: notClean.length, topTags: topTags, limitBreaches: limitBreaches, notFollowed: notFollowed,
        total: notClean.length + limitBreaches.length + notFollowed.length },
    };
  }

  var api = { range: range, summarize: summarize, addDays: addDays, pretty: pretty };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ReviewMath = api;
})(typeof window !== "undefined" ? window : this);
