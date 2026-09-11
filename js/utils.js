// utils.js — shared formatting/escaping helpers, exposed on `window`.
// Loaded first on every page (before config.js) specifically so that
// page scripts can call these from their own synchronous top-level
// render path without a load-order ReferenceError, which is what kept
// this consolidation from happening earlier (see the removed note in
// common.js). Previously hand-duplicated per file:
//   escapeHtml   - 20 copies across .js/.html
//   fmtMoney     - 10 copies across .js/.html
//   toUnix       - 8 copies across .js
//   fmtShares    - 3 copies across .js
//   prettifyTag  - 1 copy (app.js only, centralized anyway)
// Each canonical form below was picked as the safest/most common
// existing behavior, not an arbitrary new one -- see comments per
// function for what drifted and why.

// Lightweight, non-blocking toast -- for background-failure notices
// (KV.set()/KV.delete() failing silently in auth.js, where the UI
// already updated optimistically before the network call even
// started) where UIModal.alert()'s blocking dialog would be wrong:
// nothing the user clicked triggered this, so it shouldn't demand a
// click to dismiss. Lives here (not common.js) so it's defined before
// auth.js runs, same reasoning as every other helper in this file.
// Multiple toasts stack; each auto-dismisses unless hovered.
window.showToast = function showToast(message, opts) {
  opts = opts || {};
  const tone = opts.tone || "default";
  const duration = opts.duration || 5000;
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const el = document.createElement("div");
  el.className = "toast" + (tone === "error" ? " error" : "");
  el.setAttribute("role", tone === "error" ? "alert" : "status");
  el.textContent = message;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  let timer = setTimeout(dismiss, duration);
  el.addEventListener("mouseenter", () => clearTimeout(timer));
  el.addEventListener("mouseleave", () => { timer = setTimeout(dismiss, duration); });
  function dismiss() {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 200);
  }
};

// Canonical form: null/undefined -> "" instead of the literal string
// "null"/"undefined". 20 of the 21 duplicate copies used bare
// String(s), which renders those literal words when a field is
// missing; only common.js/share-export.js/auth.js/ui-modal.js/
// import-trades.html already guarded against it.
window.escapeHtml = function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
};

// Canonical form: "+$1234.56" / "-$1234.56", no thousands separator (7
// of 10 duplicate copies already formatted it this way), "—" for
// anything that isn't a finite number rather than silently coercing to
// $0.00 or rendering the literal string "NaN". practice.js/
// practice-analytics.js previously added comma thousands-separators
// no other copy used (so the same P&L rendered as a visibly different
// string depending which page you were on); global-search.js/
// search.html previously returned "" instead of "—" for bad input.
// Both now match every other page.
window.fmtMoney = function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2);
};

// Canonical form: always 2 decimals, no "$" (callers prepend their own
// "$" at the render site -- 6 of 7 duplicate copies already did this,
// so this matches everywhere except scanner.js's old copy, which is
// updated to prepend "$" at its call sites instead). No "$5 cutoff"
// step-up to 4 decimals: 4 of 7 duplicate copies (practice.js,
// practice-analytics.js, quiz.js, rewind.js) used to switch to 4
// decimals under $5, which meant the same sub-$5 trade price rendered
// with a different number of decimals depending which page you were
// on (e.g. "2.35" on trade.js's chart overlay vs. "2.3456" on
// rewind.js) -- always-2-decimals removes that drift.
window.fmtPrice = function fmtPrice(v) {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? "—" : n.toFixed(2);
};

// Canonical form: String(t) first. 6 of 8 duplicate copies guarded with
// String(t) before .replace(), so a non-string `t` (e.g. a bar whose
// `t` came through as a Date or a raw number somewhere upstream)
// degrades to a parseable string instead of throwing. trade.js's own
// copy was the one missing this guard.
window.toUnix = function toUnix(t) {
  return Math.floor(new Date(String(t).replace(" ", "T") + "Z").getTime() / 1000);
};

// Canonical form: typeof v === "number" && isFinite(v) guard (only
// report.js's copy had both checks; live-trading.js/backtester.js accepted
// any typeof "number" including NaN, which would have rendered "NaN%";
// share-export.js went the other direction and coerced any non-number to 0,
// rendering "0.0%" instead of flagging it), "—" for anything invalid to
// match fmtMoney/fmtPrice above.
window.fmtPct = function fmtPct(v) {
  return typeof v === "number" && isFinite(v) ? v.toFixed(1) + "%" : "—";
};

// Canonical form: "—" for non-finite input (calculator.js's copy lacked
// this guard; its own call sites already isFinite()-checked before calling,
// so nothing broke, but the guard now lives in the function itself like
// every other formatter here), "en-US" locale explicitly rather than the
// browser default (calculator.js passed `undefined`) so the grouping/decimal
// format doesn't shift for a user with a different regional locale --
// matches practice.js/practice-analytics.js's copies.
window.fmtUsd = function fmtUsd(v) {
  if (!Number.isFinite(v)) return "—";
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// IBKR's "Tiered" US stock commission schedule: $0.0035/share, with a
// $0.35 floor and a 1%-of-trade-value ceiling per order. Byte-identical
// across all 4 duplicate copies (practice.js, rewind.js, calculator.js,
// quiz.js) -- no behavioral drift, just quadruplicated, including the
// 3 constants it reads.
window.IBKR_PER_SHARE = 0.0035;
window.IBKR_MIN_PER_ORDER = 0.35;
window.IBKR_MAX_PCT_OF_TRADE_VALUE = 0.01;
window.ibkrTieredCommission = function ibkrTieredCommission(shares, price) {
  if (!(shares > 0) || !(price > 0)) return 0;
  const raw = shares * window.IBKR_PER_SHARE;
  const ceiling = shares * price * window.IBKR_MAX_PCT_OF_TRADE_VALUE;
  return Math.max(window.IBKR_MIN_PER_ORDER, Math.min(raw, ceiling));
};

// Canonical form: typeof v === "number" && isFinite(v) guard (report.js's
// copy had it; backtester.js's copy checked typeof only, so a NaN R-multiple
// would have rendered "NaNR" -- same drift class as fmtPct above). "—" for
// invalid input.
window.fmtR = function fmtR(v) {
  return typeof v === "number" && isFinite(v) ? v.toFixed(2) + "R" : "—";
};

// Canonical form: practice-analytics.js's copy special-cases sub-60-second
// durations as e.g. "45s"; app.js's copy had no such case and floored
// straight to "0m" for anything under a minute, silently discarding the
// value. Went with practice-analytics.js's version since it's strictly
// more informative and every existing caller passes a duration where "0m"
// vs "45s" is a real difference the reader would notice (session/trade
// durations, not always >= 1 minute).
window.fmtDuration = function fmtDuration(mins) {
  if (mins === null || mins === undefined || !Number.isFinite(mins)) return "—";
  const totalSec = Math.round(mins * 60);
  if (totalSec < 60) return totalSec + "s";
  const total = Math.round(mins);
  const h = Math.floor(total / 60), m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

// Deterministic string-seeded PRNG (mulberry32-style). Byte-identical
// across all 3 duplicate copies (practice.js, rewind.js, quiz.js) -- no
// drift, just triplicated. Used to generate reproducible within-bar
// "second ticks" for replay/practice playback, so the same trade_date +
// symbol always replays identically.
window.seededRng = function seededRng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
};

// One-line delegate to window.ChartIndicators.teardownStandardChart,
// identical across all 3 duplicate copies (practice.js, rewind.js,
// quiz.js) -- kept as its own named function (rather than inlining the
// call at each site) since callers read more clearly as teardownChart(h).
window.teardownChart = function teardownChart(handle) {
  return window.ChartIndicators.teardownStandardChart(handle);
};

// Generates REPLAY_SECONDS deterministic within-bar "second ticks" for
// replay/practice playback, walking a handful of OHLC waypoints with
// small random jitter so a 1-minute bar has something to animate through
// second-by-second. Byte-identical between practice.js and quiz.js -- no
// drift, just duplicated. NOT consolidated from rewind.js's copy: that
// one is a deliberately different/upgraded algorithm (extra randomized
// midpoint waypoints, volume-relative jitter scaled by an avgVolume
// param, exponentially-smoothed noise instead of independent per-tick
// jitter) written specifically for rewind.js's playback feel -- merging
// it in would silently change practice.js/quiz.js's replay behavior, so
// it stays a 3rd, separate implementation in rewind.js itself.
window.REPLAY_SECONDS = 60; // one sub-tick per real second of the 1-min bar
window.genSecondTicks = function genSecondTicks(bar, prevClose, seed) {
  const n = window.REPLAY_SECONDS;
  const rng = window.seededRng(seed);
  const o = bar.o, h = bar.h, l = bar.l, c = bar.c;
  const start = Number.isFinite(prevClose) ? prevClose : o;
  const highFirst = rng() < 0.5;
  const waypoints = [
    { t: 0, p: start },
    { t: Math.round(n * 0.1), p: o },
    { t: Math.round(n * 0.42), p: highFirst ? h : l },
    { t: Math.round(n * 0.74), p: highFirst ? l : h },
    { t: n - 1, p: c },
  ];
  const range = Math.max(h - l, 0.0001);
  const jitterAmp = range * 0.07;
  const ticks = [];
  for (let s = 0; s < n; s++) {
    let a = waypoints[0], b = waypoints[waypoints.length - 1];
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (s >= waypoints[i].t && s <= waypoints[i + 1].t) { a = waypoints[i]; b = waypoints[i + 1]; break; }
    }
    const span = Math.max(1, b.t - a.t);
    const frac = (s - a.t) / span;
    let price = a.p + (b.p - a.p) * frac;
    price += (rng() - 0.5) * 2 * jitterAmp;
    price = Math.min(h, Math.max(l, price));
    ticks.push(price);
  }
  ticks[n - 1] = c; // always land exactly on the bar's real close
  return ticks;
};

// Fetches (and sessionStorage-caches) a symbol's full trading-day bars
// from chart_service.py's /full-day-bars route. Byte-identical logic
// across all 3 duplicate copies (practice.js, trade.js, rewind.js) with
// one real difference: practice.js/trade.js built their own base URL
// inline from window.CHART_SERVICE_URL with no placeholder check, while
// rewind.js's copy went through its own local chartServiceBase() helper,
// which also rejects the literal unconfigured "YOUR-NGROK-SUBDOMAIN"
// placeholder (still a live path for anyone self-hosting chart_service.py
// behind a tunnel, per the start-tunnel scripts in this repo -- see
// backtester.js/report.js's own placeholder checks). practice.js/trade.js
// would instead let a placeholder URL reach fetch() and surface a raw
// network-error message instead of the friendly "CHART_SERVICE_URL isn't
// set in config.js yet." Canonical form below carries that guard for all
// 3 callers.
window.FULL_DAY_CACHE_PREFIX = "chartSvc:fullDay:";
window.chartServiceBase = function chartServiceBase() {
  const base = (window.CHART_SERVICE_URL || "").replace(/\/+$/, "");
  if (!base || base.includes("YOUR-NGROK-SUBDOMAIN")) return "";
  return base;
};
window.fetchFullDayBars = function fetchFullDayBars(symbol, tradeDate) {
  const cacheKey = window.FULL_DAY_CACHE_PREFIX + symbol + ":" + tradeDate;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) return Promise.resolve(JSON.parse(cached));
  } catch (e) { /* sessionStorage unavailable/full -- fall through to network */ }
  const base = window.chartServiceBase();
  if (!base) return Promise.reject(new Error("CHART_SERVICE_URL isn't set in config.js"));
  return fetch(`${base}/full-day-bars`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
    body: JSON.stringify({ symbol, trade_date: tradeDate }),
  })
    .then((r) => r.json().then((data) => {
      if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
      return data;
    }))
    .then((data) => {
      const bars = Array.isArray(data.bars) ? data.bars : [];
      try { sessionStorage.setItem(cacheKey, JSON.stringify(bars)); } catch (e) { /* quota, etc -- fine, just skip caching */ }
      return bars;
    });
};

// Signed per-share P&L for a long or short. Identical between rewind.js
// and quiz.js -- no drift.
window.pnlPerShare = function pnlPerShare(entry, exit, side) {
  return side === "short" ? entry - exit : exit - entry;
};

// Grades whether entering (or skipping) a trade was the right call given
// how it actually played out. Canonical form includes quiz.js's `correct`
// boolean on each result (used for that page's scoring); rewind.js's copy
// lacked it, but rewind.js only ever reads `.label`/`.tone` off the
// result, never enumerates or serializes the whole object, so the extra
// field is inert there -- confirmed no drift beyond that one added field.
window.gradeEntry = function gradeEntry(win, entered) {
  if (entered && win) return { label: "Good call — this one was a real winner.", tone: "good", correct: true };
  if (entered && !win) return { label: "This one lost in real life too.", tone: "bad", correct: false };
  if (!entered && !win) return { label: "Good discipline — this one was a loser.", tone: "good", correct: true };
  return { label: "This one worked out — you'd have missed it.", tone: "warn", correct: false };
};

// Grades stop placement against the setup's own suggested stop (or, if
// none was logged, just reports the raw risk %). Identical between
// rewind.js and quiz.js -- no drift.
window.gradeStop = function gradeStop(side, entryPrice, stopPrice, suggestedStop) {
  const riskUser = side === "short" ? stopPrice - entryPrice : entryPrice - stopPrice;
  if (!(riskUser > 0)) return { label: "Stop was on the wrong side of your entry.", tone: "bad" };
  const sug = Number(suggestedStop);
  if (suggestedStop != null && Number.isFinite(sug)) {
    const riskSuggested = side === "short" ? sug - entryPrice : entryPrice - sug;
    if (riskSuggested > 0) {
      const ratio = riskUser / riskSuggested;
      if (ratio < 0.5) return { label: "Too tight — likely shaken out by normal noise.", tone: "bad" };
      if (ratio < 0.8) return { label: "A little tight versus the setup's stop.", tone: "warn" };
      if (ratio <= 1.3) return { label: "Well placed — close to the setup's stop.", tone: "good" };
      if (ratio <= 2.2) return { label: "A bit wide.", tone: "warn" };
      return { label: "Too wide — risking more than the setup called for.", tone: "bad" };
    }
  }
  const pct = (riskUser / entryPrice) * 100;
  return { label: `${pct.toFixed(1)}% risk — no AI stop logged on this trade to compare against.`, tone: "neutral" };
};

// Identical across all 3 duplicate copies (practice.js, scanner.js,
// trade.js) -- no behavioral drift here, just triplicated.
window.fmtShares = function fmtShares(n) {
  if (n === null || n === undefined) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
  return String(v);
};

// Only ever defined in app.js, but centralized here so every page
// hand-rolling a setup_type/label cleanup doesn't grow its own copy.
window.prettifyTag = function prettifyTag(s) {
  return String(s).replace(/_/g, " ");
};

// ---- Trade breakdown list w/ "Load more" ----------------------------
// Used by app.js, edge-analysis.js, patterns.html, and stats.html for
// the same UI: click a leaderboard/breakdown row (by symbol, tag, day,
// etc.) to reveal the trades behind it as a <ul>, paged
// TRADE_LIST_PAGE_SIZE at a time rather than dumping hundreds of <li>s
// into the DOM at once. All four had byte-identical copies of
// tradeListItemHtml/tradeListMoreHtml/tradeListHtml/
// TRADE_LIST_PAGE_SIZE/tradeListState; bindTradeToggles was identical
// in 3 of the 4 (edge-analysis.js, stats.html, and patterns.html's own
// inlined version all follow a toggle-open-row with a
// data-load-more-driven "reveal next page" click, then re-sync the
// tag/uid into the URL) -- app.js's copy is the same shape minus the
// URL-sync step, which is why bindTradeToggles below takes that step
// as an optional onChange callback instead of assuming it.
window.TRADE_LIST_PAGE_SIZE = 25;
window.tradeListState = new Map(); // uid -> { rows, shown }

window.tradeListItemHtml = function tradeListItemHtml(r) {
  return `<li><a href="trade.html?id=${encodeURIComponent(r.id)}">${escapeHtml(r.symbol)} — ${escapeHtml(r.trade_date)} <span class="${r.win ? "up" : "down"}">${r.win ? "WIN" : "LOSS"}</span></a></li>`;
};

window.tradeListMoreHtml = function tradeListMoreHtml(uid, remaining) {
  return `<li class="tag-trade-list-more"><button type="button" class="btn-load-more" data-load-more="${uid}">Load more (${remaining} left)</button></li>`;
};

window.tradeListHtml = function tradeListHtml(rowsList, uid) {
  const sorted = rowsList.slice().sort((a, b) => (b.trade_date || "").localeCompare(a.trade_date || ""));
  const shown = Math.min(window.TRADE_LIST_PAGE_SIZE, sorted.length);
  window.tradeListState.set(uid, { rows: sorted, shown });
  const items = sorted.slice(0, shown).map(window.tradeListItemHtml).join("");
  const more = shown < sorted.length ? window.tradeListMoreHtml(uid, sorted.length - shown) : "";
  return `<ul class="tag-trade-list" id="${uid}">${items}${more}</ul>`;
};

// onChange(uid, isOpen), if given, fires after every click:
// - a toggle-open click passes isOpen as true/false (the row's new
//   open state), so a caller tracking its own "which uids are open"
//   Set (for URL round-tripping) can update it correctly -- it runs
//   after the toggle already happened, so reading classList inside
//   onChange would also work, but passing it avoids that lookup.
// - a load-more click passes isOpen as undefined, since it doesn't
//   change open/closed state, just reveals more rows.
// edge-analysis.js/stats.html/patterns.html all pass a callback that
// updates their own openUids/openTags Set and then calls their own
// syncUrlState; app.js's dashboard has no such state, so it omits
// onChange entirely.
window.bindTradeToggles = function bindTradeToggles(container, onChange) {
  container.querySelectorAll("[data-trade-toggle]").forEach((row) => {
    row.addEventListener("click", () => {
      const uid = row.getAttribute("data-trade-toggle");
      const list = document.getElementById(uid);
      const nowOpen = list ? list.classList.toggle("open") : undefined;
      if (onChange) onChange(uid, nowOpen);
    });
  });
  container.querySelectorAll("[data-load-more]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const uid = btn.getAttribute("data-load-more");
      const state = window.tradeListState.get(uid);
      if (!state) return;
      const nextShown = Math.min(state.shown + window.TRADE_LIST_PAGE_SIZE, state.rows.length);
      const newItemsHtml = state.rows.slice(state.shown, nextShown).map(window.tradeListItemHtml).join("");
      state.shown = nextShown;
      const moreLi = btn.closest("li");
      moreLi.insertAdjacentHTML("beforebegin", newItemsHtml);
      if (state.shown < state.rows.length) {
        btn.textContent = `Load more (${state.rows.length - state.shown} left)`;
      } else {
        moreLi.remove();
      }
      if (onChange) onChange(uid);
    });
  });
};
