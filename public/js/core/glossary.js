// glossary.js -- a tiny "!" next to jargon, tap it for a plain-English explanation.
//
// Two ways a tip appears:
//  1. Automatic: labels, table headers and row names whose text matches a term
//     below (e.g. "Profit Factor", "ADR", "Common stock") get a "!" appended.
//     A MutationObserver keeps this working for content rendered later.
//  2. Manual: add data-gl="term" to any element, or call
//     Glossary.tipHtml("term") from a template string.
//
// Add a term: put an entry in TERMS (keys are lower-case; "&" is normalised,
// parentheses and trailing colons are ignored when matching). Opt an element out
// with data-gl-skip.
(function () {
  "use strict";

  var TERMS = [
    // ---- Stock types / broker facts ----
    { keys: ["adr", "adr vs common stock", "adr / common stock", "stock type"], title: "ADR vs common stock",
      text: "ADR (American Depositary Receipt) is a US-listed share that stands in for a foreign company's stock. Common stock is an ordinary ownership share, which is what most US companies issue. ADRs often react to news and trading hours in the company's home country." },
    { keys: ["common stock", "common"], title: "Common stock",
      text: "Ordinary ownership shares of a company, which is what most US-listed stocks are. This is the usual 'plain' stock, as opposed to an ADR (a foreign company's shares listed in the US), an ETF or a preferred share." },
    { keys: ["country", "issuer country"], title: "Country",
      text: "Where the company is based (its issuer country), taken from your broker statement. It can differ from the exchange the stock trades on, e.g. a China-based company listed on Nasdaq." },
    { keys: ["float"], title: "Float",
      text: "The number of shares actually available for the public to trade, excluding shares held by insiders and locked up. A low float (under about 20M) can move very fast on little volume." },

    // ---- Per-trade money ----
    { keys: ["gross", "gross p&l", "gross profit", "gross loss", "gross pnl"], title: "Gross P&L",
      text: "Profit or loss on the trade before commissions and fees are taken out. Net P&L is what is left after them." },
    { keys: ["net", "net p&l", "net pnl", "realized p&l", "net p&l (context)"], title: "Net P&L",
      text: "Profit or loss after commissions and fees. This is the real money you made or lost." },
    { keys: ["comm", "commission", "commissions", "commission paid", "total commissions", "total fees"], title: "Commission",
      text: "What your broker charged to buy and sell, added up for both sides of the trade. On small, quick trades it can eat a big share of the profit." },
    { keys: ["c/sh", "c/share", "¢/share", "cents/share", "commission per share"], title: "Cents per share (C/sh)",
      text: "How many cents you made or lost on each share (exit price minus entry price). It lets you compare trades of different sizes." },
    { keys: ["sh", "shares", "total shares"], title: "Shares (Sh)",
      text: "How many shares you traded in this position." },
    { keys: ["commission % of gross p&l", "commissions as % of gross p&l"], title: "Commission % of gross",
      text: "How much of your gross profit went to commissions. A high number means fees are eating your edge." },
    { keys: ["scratch", "scratch trade", "scratch trades", "number of scratch trades"], title: "Scratch trade",
      text: "A trade that finished at about break-even (a tiny win or loss), usually an exit you made to get out without damage." },

    // ---- Performance ratios ----
    { keys: ["profit factor"], title: "Profit factor",
      text: "Total gross profit divided by total gross loss. Above 1.0 you are making more than you lose; 2.0 means $2 won for every $1 lost. Under 1.0 is a losing system." },
    { keys: ["expectancy", "expectancy / trade", "expectancy per trade", "edge vs. zero"], title: "Expectancy",
      text: "The average amount you expect to make (or lose) per trade over time: win rate times average win, minus loss rate times average loss. Positive means the strategy has an edge." },
    { keys: ["win rate", "win %"], title: "Win rate",
      text: "The percent of trades that made money. A high win rate alone does not mean you are profitable, so compare it with your average win and average loss." },
    { keys: ["avg win / avg loss ratio", "avg win/avg loss", "win/loss ratio", "payoff ratio", "avg win / avg loss"], title: "Avg win / avg loss",
      text: "Your average winning trade divided by your average losing trade. Above 1 means winners are bigger than losers." },
    { keys: ["avg r", "r-multiple", "r multiple", "average r", "r"], title: "R-multiple",
      text: "Your result measured in units of the risk you took. If you risked $50 and made $100, that trade is +2R. It makes trades of different sizes comparable." },
    { keys: ["max drawdown", "drawdown", "current drawdown", "number of drawdowns"], title: "Drawdown",
      text: "How far your account fell from its highest point to the next low before recovering. Max drawdown is the worst such drop, a measure of how painful the bad stretches get." },
    { keys: ["average position mae", "mae", "avg position mae"], title: "MAE (max adverse excursion)",
      text: "The worst the trade went against you while you held it, before you exited. It shows how much heat you take, even on winners." },
    { keys: ["average position mfe", "mfe", "avg position mfe"], title: "MFE (max favorable excursion)",
      text: "The best the trade ever looked while you held it. Compare it with what you actually kept to see if you exit too early or give profit back." },
    { keys: ["daily sharpe", "sharpe", "sharpe ratio", "daily sharpe (un-annualized)"], title: "Sharpe ratio",
      text: "Return per unit of volatility: your average daily result divided by how much it swings. Higher means smoother, more consistent profits. Here it is per day, not annualized." },
    { keys: ["k-ratio", "k ratio"], title: "K-ratio",
      text: "How straight and steady your equity curve climbs. A high K-ratio means consistent growth; a low one means profits came in lumps with big swings." },
    { keys: ["kelly percentage", "kelly", "kelly %"], title: "Kelly percentage",
      text: "A formula for the fraction of your account to risk per trade given your win rate and win/loss size. It is an upper bound; most traders use a half or a quarter of it." },
    { keys: ["system quality number", "sqn", "system quality number (sqn)"], title: "System Quality Number (SQN)",
      text: "Van Tharp's score for how good a trading system is: average R per trade divided by the spread of your R results, scaled by trade count. Roughly: under 1.6 is poor, 2 to 3 good, above 3 excellent." },
    { keys: ["probability of random chance", "p-value", "p-value (avg. p&l ≠ 0)", "p value", "p-value (avg. p&l != 0)"], title: "Probability of random chance (p-value)",
      text: "How likely your results would look this good by pure luck if you had no edge. Lower is better; under 5% suggests the edge is probably real. It needs many trades to mean much." },
    { keys: ["trade p&l standard deviation", "standard deviation", "std dev"], title: "Standard deviation",
      text: "How widely your trade results are spread around the average. A bigger number means a bumpier ride, with some trades far from the norm." },
    { keys: ["sample", "small sample"], title: "Sample size",
      text: "How many trades the numbers are based on. With only a handful, stats can be misleading, so treat them as rough." },

    // ---- Market terms ----
    { keys: ["rvol", "relative volume"], title: "Relative volume (RVol)",
      text: "Today's volume compared with the stock's normal volume. 3x means three times as many shares as usual have traded. High RVol means the stock is in play." },
    { keys: ["avg vol", "average daily volume", "avg volume", "adv"], title: "Average daily volume",
      text: "How many shares of this stock normally trade per day. Thin volume makes it harder to get in and out at the price you want." },
    { keys: ["premkt vol", "premarket volume", "pre-market volume"], title: "Premarket volume",
      text: "Shares traded before the 9:30 ET open (from 4:00 ET). A big premarket volume signals interest going into the open." },
    { keys: ["premarket", "pre-market"], title: "Premarket",
      text: "Trading before the regular session opens at 9:30 ET (from 4:00 ET). It has fewer participants, so prices jump around more." },
    { keys: ["vwap"], title: "VWAP",
      text: "Volume-weighted average price: the day's average price, weighted by how much traded at each level. Price above VWAP is seen as buyers in control; below, sellers." },
    { keys: ["ema9", "9 ema", "ema 9"], title: "9 EMA",
      text: "A fast moving average of the last 9 candles that leans toward recent prices. Traders watch price bounce off it as a short-term trend guide." },
    { keys: ["ema200", "200 ema", "ema 200"], title: "200 EMA",
      text: "A slow moving average of the last 200 candles. It marks the longer trend, and price often reacts when it reaches it." },
    { keys: ["gap", "avg gap", "gap %", "top gapper", "bar-perfect gap"], title: "Gap",
      text: "How far the stock opened (or traded premarket) above or below the previous day's close, in percent. Big gappers are the stocks that tend to move the most." },
    { keys: ["hod", "high of day", "day hi", "hi"], title: "High of day",
      text: "The highest price the stock has traded so far today." },

    // ---- Behaviour / tags ----
    { keys: ["revenge trade", "revenge trading"], title: "Revenge trade",
      text: "Jumping right back into a stock after a loss in it, to win the money back. It is driven by emotion, not by a setup." },
    { keys: ["overtrading"], title: "Overtrading",
      text: "Taking more trades than your plan calls for, often after the good setups are gone." },
    { keys: ["avg. capture of best bar", "best-bar capture", "avg capture of best bar"], title: "Best-bar capture",
      text: "How much of the best available move (the most favorable candle) you captured with your entries and exits. 100% would be a perfect fill." },
    { keys: ["left early", "gave back profit"], title: "Left early / gave back profit",
      text: "Left early: the stock kept running after you sold. Gave back profit: the trade was up more before you exited, and you gave some of it back." },
    { keys: ["positive $/share rate"], title: "Positive $/share rate",
      text: "The percent of trades where you made money per share, regardless of how many shares you traded." },
    { keys: ["streak to plan for"], title: "Streak to plan for",
      text: "A realistic losing streak to expect given your win rate, so you size your risk to survive it." },
    { keys: ["equity curve"], title: "Equity curve",
      text: "A line of your account balance over time. Up and to the right is growth; dips show drawdowns." }
  ];

  // Variant labels that should reuse an entry ("Average Hold Time (winning trades)" etc.)
  var PATTERNS = [
    [/^(avg\.?|average) hold time/, "hold time"],
    [/^hold( time)?$/, "hold time"],
    [/^(average|avg\.?) (winning|losing) trade$/, "avg win / avg loss ratio"],
    [/^(largest|best|worst) (gain|loss|trade)$/, null],
    [/^(max|best|worst) (consecutive|win streak|loss streak)/, "streak"]
  ];
  TERMS.push({ keys: ["hold time", "hold"], title: "Hold time",
    text: "How long you were in the trade, from your entry fill to your exit fill." });
  TERMS.push({ keys: ["streak", "streaks (w/l)", "current streak", "best win streak", "worst loss streak", "max consecutive wins", "max consecutive losses"], title: "Streak",
    text: "Wins or losses in a row. Knowing your normal losing streak helps you size trades so a bad run does not wipe you out." });

  var MAP = Object.create(null);
  TERMS.forEach(function (t) { t.keys.forEach(function (k) { MAP[k] = t; }); });
  var BY_ID = Object.create(null);
  TERMS.forEach(function (t) { BY_ID[t.keys[0]] = t; });

  function norm(s) {
    return String(s || "")
      .replace(/&amp;/g, "&")
      .replace(/\u00a0/g, " ")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/\s+[\u2014\u2013-]\s+.*$/, "")
      .replace(/[:.!?]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function lookup(text) {
    var n = norm(text);
    if (!n || n.length > 48) return null;
    if (MAP[n]) return MAP[n];
    for (var i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i][0].test(n) && PATTERNS[i][1]) return MAP[PATTERNS[i][1]] || null;
    }
    return null;
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function tipHtml(term) {
    var t = BY_ID[norm(term)] || MAP[norm(term)];
    if (!t) return "";
    return '<button type="button" class="gl-tip" data-gl-id="' + esc(t.keys[0]) + '" aria-label="What is ' + esc(t.title) + '?">!</button>';
  }

  // ---------- Auto-decoration ----------
  // Only short label-like elements; never anything that is itself a control.
  var SELECTOR = [
    ".stat .label", ".stat-line .k", ".setup-name", ".group-label", ".panel-box-head .title",
    ".section-label", ".setup-sub-label", ".kpi-card .label", ".kpi-label", ".label-row .label",
    ".report-table th", ".drill-table th", ".trade-table th", ".compare-table th", ".ins-heat th",
    ".report-table tbody td:first-child", "[data-gl]"
  ].join(",");

  function ownText(el) {
    var s = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) s += n.nodeValue;
      else if (n.nodeType === 1 && !n.classList.contains("gl-tip") && !n.classList.contains("pill") && !/^(SCRIPT|STYLE)$/.test(n.tagName)) s += n.textContent;
    }
    return s;
  }

  function decorate(el) {
    if (el.hasAttribute("data-gl-done") || el.hasAttribute("data-gl-skip")) return;
    if (el.closest("option, select, button, a, input, textarea, [contenteditable]")) { el.setAttribute("data-gl-done", ""); return; }
    // Table headers that hold sort controls etc. are left alone.
    if (el.querySelector("button, a, input, select")) { el.setAttribute("data-gl-done", ""); return; }
    var t = el.hasAttribute("data-gl") && el.getAttribute("data-gl") ? (MAP[norm(el.getAttribute("data-gl"))] || null) : lookup(ownText(el));
    el.setAttribute("data-gl-done", "");
    if (!t) return;
    var holder = document.createElement("span");
    holder.innerHTML = tipHtml(t.keys[0]);
    if (holder.firstChild) el.appendChild(holder.firstChild);
  }

  var pending = [], scheduled = false;
  function scan(root) {
    var scope = root && root.querySelectorAll ? root : document;
    if (scope !== document && scope.matches && scope.matches(SELECTOR + ":not([data-gl-done])")) decorate(scope);
    var list = scope.querySelectorAll(SELECTOR + ":not([data-gl-done])");
    for (var i = 0; i < list.length; i++) decorate(list[i]);
  }
  function flush() {
    scheduled = false;
    var nodes = pending; pending = [];
    for (var i = 0; i < nodes.length; i++) if (nodes[i].isConnected) scan(nodes[i]);
  }
  function queueNode(n) {
    if (n.nodeType !== 1 || n.classList.contains("gl-tip") || n.classList.contains("gl-pop")) return;
    pending.push(n);
    if (scheduled) return;
    scheduled = true;
    setTimeout(function () { (window.requestIdleCallback || function (f) { f(); })(flush); }, 150);
  }

  // ---------- Popover ----------
  var pop = null, activeBtn = null;
  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement("div");
    pop.className = "gl-pop";
    pop.setAttribute("role", "tooltip");
    pop.hidden = true;
    document.body.appendChild(pop);
    return pop;
  }
  function hide() {
    if (pop) pop.hidden = true;
    if (activeBtn) activeBtn.classList.remove("on");
    activeBtn = null;
  }
  function show(btn) {
    var t = BY_ID[btn.getAttribute("data-gl-id")];
    if (!t) return;
    var p = ensurePop();
    p.innerHTML = '<div class="gl-pop-t">' + esc(t.title) + '</div><div class="gl-pop-b">' + esc(t.text) + "</div>";
    p.hidden = false;
    if (activeBtn) activeBtn.classList.remove("on");
    activeBtn = btn; btn.classList.add("on");
    var r = btn.getBoundingClientRect();
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var w = Math.min(300, vw - 24);
    p.style.width = w + "px";
    var left = Math.max(12, Math.min(vw - w - 12, r.left + r.width / 2 - w / 2));
    p.style.left = left + "px";
    var h = p.offsetHeight;
    var below = r.bottom + 8 + h <= vh - 8;
    p.style.top = (below ? r.bottom + 8 : Math.max(8, r.top - 8 - h)) + "px";
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest(".gl-tip");
    if (btn) {
      // Stop the click from opening the row / drill-down the label sits inside.
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      if (activeBtn === btn) hide(); else show(btn);
      return;
    }
    if (pop && !pop.hidden && !(e.target.closest && e.target.closest(".gl-pop"))) hide();
  }, true);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });
  window.addEventListener("scroll", hide, { passive: true, capture: true });
  window.addEventListener("resize", hide);
  // Mouse users get it on hover too.
  if (window.matchMedia && window.matchMedia("(hover: hover)").matches) {
    document.addEventListener("mouseover", function (e) {
      var btn = e.target.closest && e.target.closest(".gl-tip");
      if (btn && btn !== activeBtn) show(btn);
    });
    document.addEventListener("mouseout", function (e) {
      var btn = e.target.closest && e.target.closest(".gl-tip");
      if (btn && activeBtn === btn && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".gl-pop"))) hide();
    });
  }

  function start() {
    scan(document);
    if (window.MutationObserver) {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) queueNode(added[j]);
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.Glossary = { tipHtml: tipHtml, scan: scan, terms: TERMS };
})();
