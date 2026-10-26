// review.js -- weekly / monthly review page. All numbers come from js/review-math.js; this file only
// loads the data and draws it. "This period" follows the US market date (see app-boot.js).
(function () {
  "use strict";
  var body = document.getElementById("rv-body");
  if (!body) return;
  var KEY = "trade.log:review_kind";
  var kind = "week";
  try { if (localStorage.getItem(KEY) === "month") kind = "month"; } catch (e) { /* ignore */ }
  var todayISO = function () { return window.MarketDate ? window.MarketDate.today() : new Date().toLocaleDateString("en-CA"); };
  var anchor = todayISO();
  var trades = null;

  var esc = function (s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? "" : s); };
  var money = function (v) { return (v < 0 ? "-$" : "+$") + Math.abs(v).toFixed(2); };
  var plain = function (v) { return "$" + Math.abs(v).toFixed(0); };
  var cls = function (v) { return v > 0 ? "up" : v < 0 ? "down" : ""; };
  var tagLabel = function (k) { return window.TagCatalog ? window.TagCatalog.label(k) : k; };

  function standing() { var v = window.KV && window.KV.get("daily_loss_limit"); return v && Number(v.amount) > 0 ? v : null; }
  function limitFor(date) {
    var days = window.DailyNotes ? window.DailyNotes.allDays() : {};
    return window.LossLimit.resolve(days[date], standing(), date);
  }

  function render() {
    var R = window.ReviewMath, r = R.range(kind, anchor);
    document.getElementById("rv-label").textContent = r.label;
    Array.prototype.forEach.call(document.querySelectorAll("#rv-kind button"), function (b) {
      var on = b.getAttribute("data-kind") === kind; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    });
    var s = R.summarize(trades, {
      from: r.from, to: r.to, limitFor: limitFor,
      days: window.DailyNotes ? window.DailyNotes.allDays() : {},
      isProcessTag: function (k) { return !window.TagCatalog || window.TagCatalog.get(k).group === "process"; },
    });
    body.setAttribute("aria-busy", "false");
    if (!s.n) { body.innerHTML = '<div class="rv-empty">No trades in this ' + (kind === "week" ? "week" : "month") + '. Use the arrows to look at another period.</div>'; return; }

    var kpis =
      '<div class="rv-kpi"><span>Net P&amp;L</span><b class="' + cls(s.net) + '">' + esc(money(s.net)) + '</b></div>' +
      '<div class="rv-kpi"><span>Trades</span><b>' + s.n + '</b><small>' + s.wins + 'W \u00b7 ' + s.losses + 'L \u00b7 ' + Math.round(s.winRate * 100) + '% win</small></div>' +
      '<div class="rv-kpi"><span>Trading days</span><b>' + s.tradingDays + '</b></div>' +
      '<div class="rv-kpi"><span>Rule breaks</span><b class="' + (s.ruleBreaks.total ? "down" : "up") + '">' + s.ruleBreaks.total + '</b><small>' + (s.ruleBreaks.total ? "see below" : "clean period") + '</small></div>';

    var maxAbs = Math.max.apply(null, s.perDay.map(function (d) { return Math.abs(d.net); }).concat([1]));
    var bars = s.perDay.map(function (d) {
      return '<div class="rv-day" title="' + esc(R.pretty(d.date) + ": " + money(d.net)) + '"><i class="' + (d.net < 0 ? "neg" : "") + '" style="height:' + Math.max(4, Math.round(Math.abs(d.net) / maxAbs * 56)) + 'px"></i><span>' + esc(R.pretty(d.date).split(" ")[0]) + '</span></div>';
    }).join("");

    var row = function (k, v, c) { return '<div class="rv-row"><span>' + k + '</span><span class="mono ' + (c || "") + '">' + v + '</span></div>'; };
    var days = '<div class="rv-card"><h2>Days</h2>' +
      (s.bestDay ? row("Best day \u00b7 " + esc(R.pretty(s.bestDay.date)), esc(money(s.bestDay.net)), cls(s.bestDay.net)) : "") +
      (s.worstDay && s.worstDay.date !== s.bestDay.date ? row("Worst day \u00b7 " + esc(R.pretty(s.worstDay.date)), esc(money(s.worstDay.net)), cls(s.worstDay.net)) : "") +
      '<div class="rv-days" role="img" aria-label="Net P&amp;L per trading day">' + bars + '</div></div>';

    var su = '<div class="rv-card"><h2>Setups</h2>';
    if (s.bestSetup) su += row("Best \u00b7 " + esc(s.bestSetup.setup) + " (" + s.bestSetup.n + ")", esc(money(s.bestSetup.total)), cls(s.bestSetup.total));
    if (s.worstSetup) su += row("Worst \u00b7 " + esc(s.worstSetup.setup) + " (" + s.worstSetup.n + ")", esc(money(s.worstSetup.total)), cls(s.worstSetup.total));
    if (!s.bestSetup) su += '<div class="rv-empty" style="padding:8px 0">No trades had a setup tag.</div>';
    su += '</div>';

    var rb = s.ruleBreaks, br = '<div class="rv-card"><h2>Rule breaks</h2>';
    if (!rb.total) br += '<div class="rv-empty" style="padding:8px 0">None. Every tagged trade was clean, no limit was hit, and no day was marked off-plan.</div>';
    else {
      if (rb.notClean) br += row("Trades that weren\u2019t clean", rb.notClean + " of " + rb.taggedTrades, "rv-break");
      rb.topTags.forEach(function (t) { br += row("\u00a0\u00a0" + esc(tagLabel(t.tag)), t.n + "\u00d7 \u00b7 " + esc(money(t.net)), cls(t.net)); });
      rb.limitBreaches.forEach(function (b) { br += row("Loss limit hit \u00b7 " + esc(R.pretty(b.date)), plain(b.used) + " / " + plain(b.limit), "rv-break"); });
      rb.notFollowed.forEach(function (d) { br += row("Plan not followed \u00b7 " + esc(R.pretty(d)), "marked in review", "rv-break"); });
    }
    br += '</div>';

    body.innerHTML = '<div class="rv-kpis">' + kpis + '</div><div class="rv-grid">' + days + su + br + '</div>';
  }

  document.getElementById("rv-kind").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-kind]"); if (!b) return;
    kind = b.getAttribute("data-kind"); try { localStorage.setItem(KEY, kind); } catch (err) { /* ignore */ }
    if (trades) render();
  });
  document.getElementById("rv-prev").addEventListener("click", function () { anchor = window.ReviewMath.range(kind, anchor).prev; if (trades) render(); });
  document.getElementById("rv-next").addEventListener("click", function () { anchor = window.ReviewMath.range(kind, anchor).next; if (trades) render(); });
  document.getElementById("rv-now").addEventListener("click", function () { anchor = todayISO(); if (trades) render(); });

  window.AUTH_READY.then(function (session) {
    if (!session) { body.setAttribute("aria-busy", "false"); body.innerHTML = '<div class="rv-empty">Please log in to see your review.</div>'; return; }
    return Promise.all([window.fetchTradesIndex(), window.KV.ready]).then(function (r) {
      trades = r[0] || [];
      if (window.TagCatalog && window.TagCatalog.refresh) { try { window.TagCatalog.refresh(); } catch (e) { /* labels fall back to the key */ } }
      render();
    });
  }).catch(function (err) {
    body.setAttribute("aria-busy", "false");
    body.innerHTML = '<div class="rv-empty">Couldn\u2019t load your trades. Check your connection and reload.</div>';
    if (window.reportAppError) window.reportAppError(err, "review.js");
  });
  window.addEventListener("kv-recovered", function () { if (trades) render(); });
})();
