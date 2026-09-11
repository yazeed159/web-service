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

// Canonical form: String(t) first. 6 of 8 duplicate copies guarded with
// String(t) before .replace(), so a non-string `t` (e.g. a bar whose
// `t` came through as a Date or a raw number somewhere upstream)
// degrades to a parseable string instead of throwing. trade.js's own
// copy was the one missing this guard.
window.toUnix = function toUnix(t) {
  return Math.floor(new Date(String(t).replace(" ", "T") + "Z").getTime() / 1000);
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
