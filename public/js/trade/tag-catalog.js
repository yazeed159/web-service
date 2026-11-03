// tag-catalog.js -- what every auto tag means.
//
// The text below SNAPSHOT is generated from chart-service's tag_catalog.py (which builds each rule from
// the same constants the tagger uses). On first use the page also asks the chart service for the live
// copy (GET /tag-catalog) and swaps it in, so the criteria shown on screen follow the code even if this
// file is a little behind. Anything with a [data-tag-info="<key>"] attribute opens the criteria sheet
// when tapped; TagCatalog.pillHtml() makes such a pill.
(function () {
  "use strict";
  var SNAPSHOT = {"groups":[{"id":"process","label":"Process","blurb":"Did the trade follow the plan?"},{"id":"setup","label":"Setup","blurb":"Which of your planned entries this was. Exactly one per trade."},{"id":"session","label":"Session","blurb":"When you entered (ET)."},{"id":"hold","label":"Hold time","blurb":"Entry to exit."},{"id":"price","label":"Price","blurb":"Entry price bracket."},{"id":"entry","label":"Entry shape","blurb":"Read from the 1-minute bars at the moment you bought."},{"id":"exit","label":"In the trade & exit","blurb":"What price did while you held, and after you sold."},{"id":"size","label":"Size & fills","blurb":"How you built and sized the position."},{"id":"day","label":"Day behavior","blurb":"How this trade sits among the rest of the day's trades."},{"id":"context","label":"Stock context","blurb":"Volume and float of the stock itself."}],"tags":[{"key":"clean_trade","label":"Clean trade","group":"process","tone":"good","summary":"A planned setup with no process problems.","rule":"The entry matches red-to-green, green-over-green wick or 9 EMA dip buy (a chase does not count) AND the trade has none of: added to loser, revenge trade, overtrading, oversized, extended entry, sized up after loss, after losing streak. It judges process only, never the P&L. Needs the 1-minute bars; without them the tag is simply not applied. Oversized is only judged once you have 10+ trades of history."},{"key":"red_to_green","label":"Red-to-green","group":"setup","tone":"info","summary":"Bought the break over a red candle's high.","rule":"The last completed 1-min bar before your entry closed red (close < open) and your entry filled at or above that bar's high, but no more than 4% above that high, at least 1c (about 8c on a $2 stock, 20c on a $5 one). The prior bar must be within 5 min of your entry. The entry bar itself does not have to close green. If several setups match, this one wins."},{"key":"green_over_green_wick","label":"Green-over-green wick","group":"setup","tone":"info","summary":"Bought over the wick of a green candle.","rule":"The last completed bar was green with an upper wick of at least 25% of its full range (and at least 1c), and your entry filled above that bar's high, within the same allowance (4% above it, at least 1c)."},{"key":"ema9_dip_buy","label":"9 EMA dip buy","group":"setup","tone":"info","summary":"Bought the bounce off the 9 EMA.","rule":"In the last 3 bars (or the entry bar) the low reached the 9 EMA (at or under it plus 0.4%, minimum 1c), and before that dip price had been riding above it (at least 3 of the 8 bars before the dip closed over the EMA). Your fill is between 1% below and 1.5% above the EMA."},{"key":"chase","label":"Chase","group":"setup","tone":"watch","summary":"Right pattern, but you paid up for it.","rule":"A red-to-green or green-over-green wick pattern was there, but your fill was more than 4% above the prior bar's high, and no other setup fits. Tagged so a late entry stands out instead of hiding in Other."},{"key":"other","label":"Other","group":"setup","tone":"info","summary":"None of your planned setups.","rule":"None of the setups above matched. Every short trade is Other too, since the plan is buying long."},{"key":"session_early_premarket","label":"Early premarket (4–7)","group":"session","tone":"info","summary":"Entered 04:00–07:00 ET.","rule":"Entry time from 04:00 up to 07:00 ET."},{"key":"session_pre_open","label":"Pre-open (7–9:30)","group":"session","tone":"info","summary":"Entered 07:00–09:30 ET.","rule":"Entry time from 07:00 up to 09:30 ET."},{"key":"session_open","label":"Open (9:30–10)","group":"session","tone":"info","summary":"Entered 09:30–10:00 ET.","rule":"Entry time from 09:30 up to 10:00 ET."},{"key":"session_midday","label":"Midday (10–15)","group":"session","tone":"info","summary":"Entered 10:00–15:00 ET.","rule":"Entry time from 10:00 up to 15:00 ET."},{"key":"session_power_hour","label":"Power hour (15–16)","group":"session","tone":"info","summary":"Entered 15:00–16:00 ET.","rule":"Entry time from 15:00 up to 16:00 ET."},{"key":"session_after_hours","label":"After hours","group":"session","tone":"info","summary":"Entered after 16:00 ET.","rule":"Entry time 16:00 ET or later."},{"key":"hold_under_1m","label":"Held < 1 min","group":"hold","tone":"info","summary":"Out in under a minute.","rule":"Entry to exit under 60 seconds."},{"key":"hold_1_5m","label":"Held 1–5 min","group":"hold","tone":"info","summary":"Held 1 to 5 minutes.","rule":"Entry to exit from 60 seconds up to 5 minutes."},{"key":"hold_5_30m","label":"Held 5–30 min","group":"hold","tone":"info","summary":"Held 5 to 30 minutes.","rule":"Entry to exit from 5 up to 30 minutes."},{"key":"hold_30m_plus","label":"Held 30+ min","group":"hold","tone":"info","summary":"Held half an hour or more.","rule":"Entry to exit of 30 minutes or longer."},{"key":"price_under_2","label":"Price under $2","group":"price","tone":"info","summary":"Entry price under $2.","rule":"Entry price below $2.00."},{"key":"price_2_5","label":"Price $2–5","group":"price","tone":"info","summary":"Entry price $2 to $5.","rule":"Entry price from $2.00 up to $5.00."},{"key":"price_5_10","label":"Price $5–10","group":"price","tone":"info","summary":"Entry price $5 to $10.","rule":"Entry price from $5.00 up to $10.00."},{"key":"price_10_plus","label":"Price $10+","group":"price","tone":"info","summary":"Entry price $10 or more.","rule":"Entry price $10.00 or higher."},{"key":"below_vwap","label":"Entry below VWAP","group":"entry","tone":"watch","summary":"Bought under VWAP.","rule":"Your entry filled more than 0.5c under VWAP, read at the last completed bar before entry. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"below_ema9","label":"Entry below 9 EMA","group":"entry","tone":"watch","summary":"Bought under the 9 EMA.","rule":"Your entry filled more than 0.5c under the 9 EMA, read at the last completed bar before entry. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"extended_entry","label":"Extended entry","group":"entry","tone":"watch","summary":"Bought well above the 9 EMA.","rule":"Your entry filled 3% or more above the 9 EMA at the last completed bar. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"entry_after_spike","label":"Entry after spike","group":"entry","tone":"watch","summary":"Bought right after a fast run-up.","rule":"The 3 completed bars before your entry ran up 6% or more, from the first bar's open to the last bar's close. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"new_high_of_day","label":"New high of day","group":"entry","tone":"info","summary":"Bought a break of the day's high.","rule":"Your entry filled at or over the highest high of every bar so far that day (premarket included). Needs 5+ bars of the day before the entry. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"premarket_high_break","label":"Premarket high break","group":"entry","tone":"info","summary":"Bought the first break of the premarket high.","rule":"You entered after 09:30 ET at or over the premarket high, and no regular-session bar before your entry had already traded over it. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"vwap_reclaim","label":"VWAP reclaim","group":"entry","tone":"info","summary":"Bought as price got back over VWAP.","rule":"Within the last 10 bars before the last completed one, at least one closed under VWAP; the last completed bar closed back over it and you entered at or over VWAP. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"gave_back_winner","label":"Gave back winner","group":"exit","tone":"watch","summary":"Was up, then gave back most of it.","rule":"The trade peaked at least 2% over your entry, then you exited having given back 50% or more of that peak gain. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"winner_turned_loser","label":"Winner turned loser","group":"exit","tone":"watch","summary":"Was a winner, closed as a loss.","rule":"The trade peaked at least 2% over your entry, and you still closed it at a loss. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"overstayed","label":"Overstayed","group":"exit","tone":"watch","summary":"Stayed well past the peak.","rule":"You held 5+ minutes past the peak (a peak at least 2% over entry), having given back 25% or more of the peak gain. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"ran_after_exit","label":"Ran after exit","group":"exit","tone":"watch","summary":"It kept running after you sold.","rule":"Within 15 minutes of your exit, price traded 10% or more above your exit price. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"sold_the_low","label":"Sold the low","group":"exit","tone":"watch","summary":"Sold the bottom of a candle, then it bounced.","rule":"Your exit filled in the bottom 20% of its 1-minute bar's range, and within 5 minutes price traded 3% or more above your exit. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"sold_near_high","label":"Sold near the high","group":"exit","tone":"good","summary":"Kept most of the move.","rule":"The trade peaked at least 2% over your entry and you exited above entry having kept 80% or more of the peak gain. Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"deep_drawdown","label":"Deep drawdown","group":"exit","tone":"watch","summary":"Went well against you while you held.","rule":"Price traded 3% or more below your entry at some point between entry and exit (win or lose). Needs the 1-minute bars; without them the tag is simply not applied."},{"key":"scaled_in","label":"Scaled in","group":"size","tone":"info","summary":"More than one buy order.","rule":"The trade has more than one entry order (separate broker orders on the buy side)."},{"key":"scaled_out","label":"Scaled out","group":"size","tone":"info","summary":"More than one sell order.","rule":"The trade has more than one exit order (separate broker orders on the sell side)."},{"key":"added_to_loser","label":"Added to loser","group":"size","tone":"watch","summary":"Bought more while it was under water.","rule":"A later buy filled below the average cost of your earlier buys in the same trade."},{"key":"oversized","label":"Oversized","group":"size","tone":"watch","summary":"Bigger than your usual size.","rule":"Shares are more than 1.5x the median size of all your trades. Not judged until you have 10+ trades."},{"key":"revenge_trade","label":"Revenge trade","group":"day","tone":"watch","summary":"Jumped back into a stock right after losing in it.","rule":"The previous trade that day in this same symbol lost, and you entered again within 5 minutes of its exit."},{"key":"overtrading","label":"Overtrading","group":"day","tone":"watch","summary":"The 10th trade of the day, or later.","rule":"This is trade number 10 or later that day (by entry time)."},{"key":"repeat_symbol","label":"Repeat symbol","group":"day","tone":"watch","summary":"The 3rd+ trade in the same stock that day.","rule":"This is the 3rd or later trade in the same symbol that day (by entry time)."},{"key":"sized_up_after_loss","label":"Sized up after loss","group":"day","tone":"watch","summary":"Bigger right after a loser.","rule":"The previous trade of the day lost and this one is 1.5x its share count or more."},{"key":"after_losing_streak","label":"After 3 losses in a row","group":"day","tone":"watch","summary":"Kept trading through a losing streak.","rule":"The 3 trades right before this one that day all lost."},{"key":"rapid_fire","label":"Rapid-fire re-entry","group":"day","tone":"watch","summary":"Back in within a minute of your last exit.","rule":"You entered within 60 seconds of your latest exit that day (any symbol)."},{"key":"avgvol_under_500k","label":"Avg vol < 500K","group":"context","tone":"info","summary":"Average daily volume under 500,000.","rule":"The stock's average daily volume over the 30 trading days before the trade was under 500,000 shares. Computed when the trade is published or charted."},{"key":"avgvol_500k_1m","label":"Avg vol 500K–1M","group":"context","tone":"info","summary":"Average daily volume 500,000 to 1M.","rule":"The stock's average daily volume over the 30 trading days before the trade was 500,000 to 1M shares. Computed when the trade is published or charted."},{"key":"avgvol_1m_5m","label":"Avg vol 1M–5M","group":"context","tone":"info","summary":"Average daily volume 1M to 5M.","rule":"The stock's average daily volume over the 30 trading days before the trade was 1M to 5M shares. Computed when the trade is published or charted."},{"key":"avgvol_5m_20m","label":"Avg vol 5M–20M","group":"context","tone":"info","summary":"Average daily volume 5M to 20M.","rule":"The stock's average daily volume over the 30 trading days before the trade was 5M to 20M shares. Computed when the trade is published or charted."},{"key":"avgvol_20m_plus","label":"Avg vol 20M+","group":"context","tone":"info","summary":"Average daily volume 20M or more.","rule":"The stock's average daily volume over the 30 trading days before the trade was 20M or more shares. Computed when the trade is published or charted."},{"key":"avgvol_unknown","label":"Avg vol unknown","group":"context","tone":"info","summary":"No average volume available.","rule":"There wasn't enough daily history to work out an average. Computed when the trade is published or charted."},{"key":"rvol_under_1x","label":"RVol < 1x","group":"context","tone":"info","summary":"Relative volume below 1x.","rule":"The stock's total volume that day divided by its 30-day average daily volume was below 1x. Computed when the trade is published or charted."},{"key":"rvol_1x_2x","label":"RVol 1x–2x","group":"context","tone":"info","summary":"Relative volume 1x to 2x.","rule":"The stock's total volume that day divided by its 30-day average daily volume was 1x to 2x. Computed when the trade is published or charted."},{"key":"rvol_2x_5x","label":"RVol 2x–5x","group":"context","tone":"info","summary":"Relative volume 2x to 5x.","rule":"The stock's total volume that day divided by its 30-day average daily volume was 2x to 5x. Computed when the trade is published or charted."},{"key":"rvol_5x_10x","label":"RVol 5x–10x","group":"context","tone":"info","summary":"Relative volume 5x to 10x.","rule":"The stock's total volume that day divided by its 30-day average daily volume was 5x to 10x. Computed when the trade is published or charted."},{"key":"rvol_10x_plus","label":"RVol 10x+","group":"context","tone":"info","summary":"Relative volume 10x or more.","rule":"The stock's total volume that day divided by its 30-day average daily volume was 10x or more. Computed when the trade is published or charted."},{"key":"rvol_unknown","label":"RVol unknown","group":"context","tone":"info","summary":"No relative volume available.","rule":"Volume or the 30-day average wasn't available. Computed when the trade is published or charted."},{"key":"float_micro_under_10m","label":"Float < 10M","group":"context","tone":"info","summary":"Float under 10M shares.","rule":"The stock's float is under 10M shares. Filled in when you tap Get float on a trade or run Fill missing floats."},{"key":"float_low_10m_20m","label":"Float 10M–20M","group":"context","tone":"info","summary":"Float 10M to 20M shares.","rule":"The stock's float is 10M to 20M shares. Filled in when you tap Get float on a trade or run Fill missing floats."},{"key":"float_mid_20m_50m","label":"Float 20M–50M","group":"context","tone":"info","summary":"Float 20M to 50M shares.","rule":"The stock's float is 20M to 50M shares. Filled in when you tap Get float on a trade or run Fill missing floats."},{"key":"float_large_50m_200m","label":"Float 50M–200M","group":"context","tone":"info","summary":"Float 50M to 200M shares.","rule":"The stock's float is 50M to 200M shares. Filled in when you tap Get float on a trade or run Fill missing floats."},{"key":"float_mega_200m_plus","label":"Float 200M+","group":"context","tone":"info","summary":"Float 200M or more shares.","rule":"The stock's float is 200M or more shares. Filled in when you tap Get float on a trade or run Fill missing floats."},{"key":"float_unknown","label":"Float unknown","group":"context","tone":"info","summary":"Float not looked up yet.","rule":"Float is only fetched on demand (Get float on a trade, or Fill missing floats in the Journal)."}],"ai_note":"Tags like these in the Journal's Tags column that aren't in this guide come from the AI review of that trade. Open the trade to read the lesson behind each one."};
  var data = SNAPSHOT, byKey = Object.create(null), refreshing = null, liveChecked = false;
  var HAS_DOM = typeof document !== "undefined";

  // Tags the guide no longer lists. Old setups the AI used to guess (before your own three setups) get a
  // real explanation; anything else unknown falls back to the AI-review note below.
  var LEGACY = {
    breakout: { label: "Breakout (old)", group: "setup",
      summary: "An old AI-guessed setup, from before your own three setups.",
      rule: "Before the rule-based setups existed, the AI guessed a setup for each trade from the chart. \"Breakout\" meant it looked like a break of a recent high. It was a guess, not a rule, and it isn't produced any more. Tag my setups in the Journal re-reads the trade against red-to-green, green-over-green wick and 9 EMA dip buy." },
    dip_buy: { label: "Dip buy (old)", group: "setup",
      summary: "An old AI-guessed setup, from before your own three setups.",
      rule: "Before the rule-based setups existed, the AI guessed a setup for each trade from the chart. \"Dip buy\" meant it looked like a buy on a pullback. It was a guess, not a rule, and it isn't produced any more. Tag my setups in the Journal re-reads the trade against red-to-green, green-over-green wick and 9 EMA dip buy (the closest match to your own dip rule)." }
  };
  var OLD_NOTE = " Older tags from before the rule-based tagger never had exact criteria; if it's an old behavior tag, Tag my setups in the Journal re-reads the trade and swaps it for the current ones.";

  function index() { byKey = Object.create(null); data.tags.forEach(function (t) { byKey[t.key] = t; }); }
  index();

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function deslug(k) { return String(k).replace(/_/g, " ").replace(/^./, function (c) { return c.toUpperCase(); }); }
  var TONE_TEXT = { good: "Good habit", watch: "Worth a look", info: "Describes the trade" };
  function money(v) { return (v < 0 ? "-$" : "+$") + Math.abs(v).toFixed(2); }

  // ---- how each tag has paid off, from the trades this page knows about ----
  // Colour only covers tags about the entry or the exit (setups, entry shape, in-the-trade & exit); the rest
  // (session, hold time, price, size, day behavior, stock context, process) stay colourless.
  var SCORED = { setup: 1, entry: 1, exit: 1 };
  var MIN_N = 3;                                        // trades a tag needs before it earns a colour
  var CACHE_KEY = "trade.log:tagstats";
  var stats = Object.create(null), lessonSeen = Object.create(null), scale = 1, hasRows = false;

  function lsGet() { try { return JSON.parse(sessionStorage.getItem(CACHE_KEY)); } catch (e) { return null; } }
  function lsSet(v) { try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ } }

  // An entry for any key: tags the guide doesn't know (old ones, the AI review's own) still get a sheet.
  function get(key) {
    key = String(key);
    if (byKey[key]) return byKey[key];
    if (Object.prototype.hasOwnProperty.call(LEGACY, key)) {
      var lg = LEGACY[key];
      return { key: key, label: lg.label, group: lg.group, tone: "info", legacy: true, summary: lg.summary, rule: lg.rule };
    }
    var fromAi = !!lessonSeen[key];
    return { key: key, label: deslug(key), group: "ai", tone: "info", unknown: true,
      summary: fromAi ? "A tag from the AI review of your trades." : "An older tag the guide doesn't list any more.",
      rule: (data.ai_note || SNAPSHOT.ai_note) + (fromAi ? "" : OLD_NOTE) };
  }
  function tone(key) { return get(key).tone; }
  function label(key) { return get(key).label; }

  function computeScale() {
    var abs = [];
    Object.keys(stats).forEach(function (k) {
      var s = stats[k];
      if (SCORED[get(k).group] && s.n >= MIN_N) abs.push(Math.abs(s.net / s.n));
    });
    abs.sort(function (a, b) { return a - b; });
    scale = abs.length ? Math.max(abs[Math.floor(0.8 * (abs.length - 1))], 1) : 1;
  }
  // {hue, avg, n} for a tag that has earned a colour, else null. hue 0 = red (costs money), 120 = green (pays).
  function colorOf(key) {
    key = String(key);
    if (!SCORED[get(key).group]) return null;
    var s = stats[key];
    if (!s || s.n < MIN_N) return null;
    var avg = s.net / s.n, t = Math.max(-1, Math.min(1, avg / scale));
    return { hue: Math.round(60 + 60 * t), avg: avg, n: s.n };
  }
  function statsFor(key) { var s = stats[String(key)]; return s ? { n: s.n, wins: s.wins, net: s.net, avg: s.net / s.n } : null; }

  function setTrades(rows) {
    rows = Array.isArray(rows) ? rows : [];
    var s = Object.create(null), lessons = Object.create(null);
    rows.forEach(function (r) {
      if (!r) return;
      var pnl = Number(r.pnl_after_comm) || 0, seen = Object.create(null), keys = [];
      if (r.setup_type) keys.push(String(r.setup_type));
      [r.behavior_tags, r.lesson_tags].forEach(function (a) { if (Array.isArray(a)) a.forEach(function (t) { if (t) keys.push(String(t)); }); });
      if (Array.isArray(r.lesson_tags)) r.lesson_tags.forEach(function (t) { if (t) lessons[String(t)] = 1; });
      [r.avg_volume_tag, r.rvol_tag, r.float_tag].forEach(function (t) { if (t) keys.push(String(t)); });
      keys.forEach(function (k) {
        if (seen[k]) return; seen[k] = 1;
        var o = s[k] || (s[k] = { n: 0, wins: 0, net: 0 });
        o.n++; if (pnl > 0) o.wins++; o.net += pnl;
      });
    });
    stats = s; lessonSeen = lessons; hasRows = true;
    computeScale();
    lsSet({ stats: s, lessons: lessons });
    if (HAS_DOM) { paint(document); if (overlay) fillSheet(); }
  }
  function loadCached() {
    var c = lsGet();
    if (!c || !c.stats) return;
    stats = Object.assign(Object.create(null), c.stats);
    lessonSeen = Object.assign(Object.create(null), c.lessons || {});
    computeScale();
  }
  var loading = null;
  function loadTrades() {
    if (loading) return loading;
    if (typeof window.fetchTradesIndex !== "function") return (loading = Promise.resolve(false));
    loading = Promise.resolve().then(function () { return window.fetchTradesIndex(); })
      .then(function (rows) { setTrades(rows); return true; })
      .catch(function () { return false; });                // signed out / offline: pills just stay colourless
    return loading;
  }

  // ---- painting ----
  var SEL = "[data-tag-info],[data-tag-color]";
  function paintEl(el) {
    var key = el.getAttribute("data-tag-info") || el.getAttribute("data-tag-color"), c = key && colorOf(key);
    if (c) { el.classList.add("tc-scored"); el.style.setProperty("--tg-h", String(c.hue)); }
    else { el.classList.remove("tc-scored"); el.style.removeProperty("--tg-h"); }
  }
  function paint(root) {
    if (!HAS_DOM || !root) return;
    if (root.nodeType === 1 && root.matches && root.matches(SEL)) paintEl(root);
    if (root.querySelectorAll) { var list = root.querySelectorAll(SEL); for (var i = 0; i < list.length; i++) paintEl(list[i]); }
  }
  function legendHtml() {
    return '<span class="tc-legend"><span>Costs money</span><i></i><span>Pays</span></span>';
  }

  function pillHtml(key, opts) {
    var e = get(key); opts = opts || {};
    var c = colorOf(key);
    return '<button type="button" class="pill tagpill tc-pill tc-' + e.tone + (c ? " tc-scored" : "") + '" data-tag-info="' + esc(key) + '"' + (c ? ' style="--tg-h:' + c.hue + '"' : "") + ' title="' + esc(e.summary) + ' Tap for the exact criteria.">' + esc(opts.label || e.label) + "</button>";
  }

  // The automatic replacement for the old "followed my rules?" answer:
  //   true = tagged and clean, false = tagged but not clean, null = not tagged yet.
  function isClean(trade) {
    var tags = trade && trade.behavior_tags;
    if (!Array.isArray(tags)) return null;
    return tags.indexOf("clean_trade") !== -1;
  }

  // Asks the chart service for the live criteria. Resolves true only if it actually swapped newer text in,
  // gives up after 5s (the service is on a free host that can take a while to wake), and never rejects.
  function refresh() {
    if (refreshing) return refreshing;
    var base = window.CHART_SERVICE_URL;
    if (!base || typeof fetch !== "function") return (refreshing = Promise.resolve(false));
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 5000) : null;
    refreshing = fetch(base.replace(/\/$/, "") + "/tag-catalog", { headers: { "ngrok-skip-browser-warning": "1" }, signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && Array.isArray(j.tags) && j.tags.length) {
          if (!Array.isArray(j.groups) || !j.groups.length) j.groups = SNAPSHOT.groups;
          if (!j.ai_note) j.ai_note = SNAPSHOT.ai_note;
          data = j; index(); return true;
        }
        return false;
      })
      .catch(function () { return false; })
      .then(function (ok) { if (timer) clearTimeout(timer); return ok; });
    return refreshing;
  }

  // ---- the criteria sheet ----
  var css = HAS_DOM ? document.createElement("style") : { textContent: "" };
  css.textContent =
    "button.pill.tagpill.tc-good{background:var(--green-soft);color:var(--green);border-color:transparent}" +
    "button.pill.tagpill.tc-watch{background:var(--amber-soft);color:var(--amber);border-color:transparent}" +
    ".pill.tagpill.tc-scored{background:hsl(var(--tg-h) 70% 45% / .18)!important;color:hsl(var(--tg-h) 78% 68%)!important;border-color:hsl(var(--tg-h) 70% 50% / .4)!important}" +
    ":root[data-theme=\"light\"] .pill.tagpill.tc-scored{background:hsl(var(--tg-h) 75% 48% / .2)!important;color:hsl(var(--tg-h) 85% 24%)!important;border-color:hsl(var(--tg-h) 70% 38% / .45)!important}" +
    ".tc-legend{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--text-faint)}" +
    ".tc-legend i{display:inline-block;width:90px;height:8px;border-radius:99px;background:linear-gradient(90deg,hsl(0 70% 50%),hsl(60 70% 50%),hsl(120 70% 45%))}" +
    ".tc-overlay{position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;opacity:0;transition:opacity .15s ease}" +
    ".tc-overlay.open{opacity:1}" +
    ".tc-sheet{width:100%;max-width:520px;max-height:82vh;overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:16px 16px 0 0;padding:18px 18px calc(18px + var(--safe-bottom,0px));box-shadow:0 -8px 30px rgba(0,0,0,.35);transform:translateY(14px);transition:transform .18s ease}" +
    ".tc-overlay.open .tc-sheet{transform:none}" +
    "@media(min-width:700px){.tc-overlay{align-items:center}.tc-sheet{border-radius:16px}}" +
    ".tc-sheet h3{margin:0 0 4px;font-size:17px}.tc-meta{font-size:12px;color:var(--text-faint);margin-bottom:10px}" +
    ".tc-sum{font-size:14px;margin-bottom:12px}.tc-k{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint);margin-bottom:4px}" +
    ".tc-rule{font-size:13.5px;line-height:1.5;color:var(--text-dim);background:var(--panel-2);border-radius:10px;padding:10px 12px}" +
    ".tc-res{font-size:13px;margin:0 0 12px;display:flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}.tc-res i{width:10px;height:10px;border-radius:50%;flex:none;background:var(--text-faint)}" +
    ".tc-actions{display:flex;gap:10px;margin-top:14px;justify-content:flex-end}.tc-actions a,.tc-actions button{font:inherit;font-size:13px;padding:8px 14px;border-radius:9px;border:1px solid var(--border);background:var(--panel-2);color:var(--text);text-decoration:none;cursor:pointer}";
  if (HAS_DOM) document.head.appendChild(css);

  var overlay = null, openKey = null, returnFocus = null;
  function close(now) { if (!overlay) return; var o = overlay; overlay = null; openKey = null; document.removeEventListener("keydown", onKey);
    if (returnFocus && returnFocus.focus && document.body.contains(returnFocus)) { try { returnFocus.focus(); } catch (e) { /* ignore */ } } returnFocus = null; if (now === true) { o.remove(); return; } o.classList.remove("open"); setTimeout(function () { o.remove(); }, 160); }
  function onKey(e) { if (e.key === "Escape") close(); }

  function resultHtml(key) {
    var s = statsFor(key);
    if (!s) return "";
    var c = colorOf(key), e = get(key);
    var dot = c ? '<i style="background:hsl(' + c.hue + ' 70% 50%)"></i>' : "<i></i>";
    var note = SCORED[e.group] && s.n < MIN_N ? " · colour needs " + MIN_N + "+ trades" : "";
    return '<div class="tc-res">' + dot + "<span>Your trades: " + s.n + " · " + Math.round((s.wins / s.n) * 100) + "% win · avg " + money(s.avg) + " · net " + money(s.net) + note + "</span></div>";
  }
  function fillSheet() {
    if (!overlay || openKey == null) return;
    var key = openKey, e = get(key), group = (data.groups || []).filter(function (g) { return g.id === e.group; })[0];
    var metaTone = e.legacy ? "Old tag" : e.unknown ? "AI review / old tag" : (TONE_TEXT[e.tone] || "");
    overlay.innerHTML = '<div class="tc-sheet"><h3>' + esc(e.label) + '</h3><div class="tc-meta">' + esc(metaTone) + (group ? " · " + esc(group.label) : "") + "</div>" +
      '<div class="tc-sum">' + esc(e.summary) + "</div>" + resultHtml(key) + '<div class="tc-k">' + (e.unknown || e.legacy ? "About this tag" : "Exact criteria") + '</div><div class="tc-rule">' + esc(e.rule) + "</div>" +
      '<div class="tc-actions">' + (e.unknown || e.legacy ? "" : '<a href="tags.html#tag-' + esc(key) + '">Tag guide</a>') + '<button type="button" data-tc-close>Close</button></div></div>';
  }
  function openSheet(key) {
    var from = HAS_DOM ? document.activeElement : null;
    close(true);
    returnFocus = from;
    key = String(key);
    openKey = key;
    var e = get(key);
    overlay = document.createElement("div");
    overlay.className = "tc-overlay";
    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-label", e.label);
    fillSheet();
    overlay.addEventListener("click", function (ev) { if (ev.target === overlay || (ev.target.closest && ev.target.closest("[data-tc-close]"))) close(); });
    document.body.appendChild(overlay);
    requestAnimationFrame(function () { overlay && overlay.classList.add("open"); var b = overlay && overlay.querySelector("[data-tc-close]"); if (b) b.focus(); });
    document.addEventListener("keydown", onKey);
    // Swap in the live text once if the chart service has newer rules than this file. Redraws the open
    // sheet in place; it never re-opens it (re-opening is what used to loop and freeze the page).
    if (!liveChecked) {
      liveChecked = true;
      var mine = overlay;
      refresh().then(function (changed) { if (changed && overlay === mine && openKey === key) fillSheet(); });
    }
  }
  if (HAS_DOM) {
    document.addEventListener("click", function (ev) {
      var el = ev.target.closest && ev.target.closest("[data-tag-info]");
      if (!el) return;
      ev.preventDefault(); ev.stopPropagation();
      openSheet(el.getAttribute("data-tag-info"));
    }, true);
    loadCached();
    if (typeof MutationObserver === "function") {
      new MutationObserver(function (ms) {
        for (var i = 0; i < ms.length; i++) for (var j = 0; j < ms[i].addedNodes.length; j++) { var n = ms[i].addedNodes[j]; if (n.nodeType === 1) paint(n); }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
    // Pages that already have the trades (Journal, Tag guide) hand them over via setTrades; everywhere else
    // load them once, a moment after the page is up.
    window.addEventListener("load", function () { setTimeout(function () { if (!hasRows) loadTrades(); }, 600); });
  }

  window.TagCatalog = { get: get, tone: tone, label: label, pillHtml: pillHtml, isClean: isClean, refresh: refresh,
    openSheet: openSheet, groups: function () { return data.groups; }, all: function () { return data.tags; }, TONE_TEXT: TONE_TEXT,
    setTrades: setTrades, colorOf: colorOf, statsFor: statsFor, paint: paint, legendHtml: legendHtml, MIN_N: MIN_N };
})();
