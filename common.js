// global-search.js — docked "Search symbols" bar for the topbar search
// icon. Used to be its own sidebar tab (notes.html), then a centered
// modal; now it's an inline bar that drops down as an actual part of
// the page (a sibling of .topbar inside .main, not a floating overlay)
// so it pushes .content down instead of covering the screen.
//
// Search matches against symbol first -- that's instant, straight off
// the lightweight rows fetchTradesIndex() already returns, no per-trade
// detail fetch needed. Flipping on "Search notes too" additionally
// matches each trade's verdict/lessons/walk-away rule/better-entry-exit
// reasoning/symbol description -- that needs each trade's full detail,
// so that heavier index is only built lazily, the first time it's
// switched on.
(function () {
  "use strict";

  if (/\/login(\.html)?\/?$/.test(window.location.pathname)) return;
  const topbar = document.querySelector(".topbar");
  const topbarRight = document.querySelector(".topbar-right");
  if (!topbar || !topbarRight) return;

  const INDEX_CACHE_PREFIX = "trade.log:notesIndex:";
  const CONCURRENCY = 6;
  const SORT_KEY = "trade.log:searchSort";

  // ---- inject the topbar trigger button --------------------------------
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "icon-btn icon-btn-visible";
  trigger.id = "gs-open-btn";
  trigger.title = "Search trades";
  trigger.setAttribute("aria-label", "Search trades");
  trigger.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`;
  const mobileBtn = document.getElementById("mobile-nav-btn");
  if (mobileBtn) topbarRight.insertBefore(trigger, mobileBtn);
  else topbarRight.appendChild(trigger);

  // ---- build the dock, as a real sibling of .topbar (not an overlay) ---
  const dock = document.createElement("div");
  dock.className = "gs-dock";
  dock.id = "gs-dock";
  dock.innerHTML = `
    <div class="gs-dock-inner">
      <div class="gs-dock-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        <input type="text" id="gs-query" class="gs-dock-input" placeholder="Search symbols… e.g. MARA, SOFI" aria-label="Search trades by symbol">
        <button type="button" class="gs-dock-toggle" id="gs-notes-toggle" aria-pressed="false" title="Also search verdict, lessons, walk-away rule, and better-entry/exit notes">Search notes too</button>
        <select id="gs-sort" class="gs-dock-sort" title="Sort results">
          <option value="recent">Most recent</option>
          <option value="symbol">Symbol A–Z</option>
          <option value="pnl-desc">P&amp;L: high to low</option>
          <option value="pnl-asc">P&amp;L: low to high</option>
        </select>
        <button type="button" class="gs-dock-close" id="gs-close-btn" title="Close" aria-label="Close search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>
      <div class="gs-dock-status" id="gs-status"></div>
      <div class="gs-dock-results" id="gs-results">
        <div class="empty-state">Type a symbol to search your trades.</div>
      </div>
    </div>
  `;
  topbar.insertAdjacentElement("afterend", dock);

  const queryEl = document.getElementById("gs-query");
  const statusEl = document.getElementById("gs-status");
  const resultsEl = document.getElementById("gs-results");
  const notesToggle = document.getElementById("gs-notes-toggle");
  const sortEl = document.getElementById("gs-sort");

  try { sortEl.value = sessionStorage.getItem(SORT_KEY) || "recent"; } catch (e) { /* ignore */ }

  // ---- lightweight symbol index (instant -- no per-trade fetch) --------
  let liteRows = null;
  let liteLoading = null;
  function loadLite() {
    if (liteRows) return Promise.resolve(liteRows);
    if (liteLoading) return liteLoading;
    liteLoading = window.fetchTradesIndex().then((rows) => {
      liteRows = Array.isArray(rows) ? rows : [];
      return liteRows;
    });
    return liteLoading;
  }

  // ---- heavier notes index (verdict/lessons/walk-away/better/symbol) ---
  // built lazily, only once "Search notes too" is switched on.
  let notesIndex = [];
  let notesReady = false;
  let notesBuilding = false;
  let notesFailed = 0;

  function extractFields(detail) {
    return {
      verdict: detail.verdict || "",
      lessons: Array.isArray(detail.lessons) ? detail.lessons.join(" \n ") : "",
      walkaway: detail.walk_away_rule || "",
      better: [detail.better_entry && detail.better_entry.reason, detail.better_exit && detail.better_exit.reason].filter(Boolean).join(" \n "),
      symbol: (detail.symbol_info && detail.symbol_info.description) || "",
    };
  }
  function cacheKey(rows) {
    const last = rows[rows.length - 1];
    return INDEX_CACHE_PREFIX + rows.length + ":" + (last ? last.id : "none");
  }
  async function fetchAll(rows, onProgress) {
    const out = new Array(rows.length);
    let next = 0, done = 0;
    async function worker() {
      while (next < rows.length) {
        const i = next++;
        const row = rows[i];
        try {
          const detail = await window.fetchTradeDetail(row.id);
          if (!detail) throw new Error("Trade not found");
          out[i] = { id: row.id, symbol: row.symbol, trade_date: row.trade_date, win: row.win, pnl_after_comm: row.pnl_after_comm, fields: extractFields(detail) };
        } catch (e) {
          notesFailed++;
          out[i] = null;
        }
        done++;
        onProgress(done, rows.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    return out.filter(Boolean);
  }
  function buildNotesIndex() {
    if (notesBuilding) return;
    notesBuilding = true;
    statusEl.textContent = "Indexing trade notes…";
    loadLite()
      .then(async (rows) => {
        if (!rows.length) { notesReady = true; render(queryEl.value); return; }
        const key = cacheKey(rows);
        let cached = null;
        try { cached = JSON.parse(sessionStorage.getItem(key) || "null"); } catch (e) { cached = null; }
        if (cached && Array.isArray(cached)) {
          notesIndex = cached;
          notesReady = true;
          render(queryEl.value);
          return;
        }
        notesFailed = 0;
        notesIndex = await fetchAll(rows, (done, total) => {
          statusEl.textContent = `Indexing trade notes… ${done}/${total}`;
        });
        notesReady = true;
        try { sessionStorage.setItem(key, JSON.stringify(notesIndex)); } catch (e) { /* dataset too big -- skip caching */ }
        render(queryEl.value);
      })
      .catch(() => {
        notesReady = true;
        render(queryEl.value);
      });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtMoney(v) {
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + Math.abs(v).toFixed(2);
  }
  function snippet(text, q, pad) {
    const lower = text.toLowerCase();
    const at = lower.indexOf(q.toLowerCase());
    if (at === -1) return "";
    const start = Math.max(0, at - pad);
    const end = Math.min(text.length, at + q.length + pad);
    const before = escapeHtml(text.slice(start, at));
    const match = escapeHtml(text.slice(at, at + q.length));
    const after = escapeHtml(text.slice(at + q.length, end));
    return `${start > 0 ? "…" : ""}${before}<mark>${match}</mark>${after}${end < text.length ? "…" : ""}`;
  }

  // One row per matching trade -- symbol matches first, then (if notes
  // search is on) trades whose notes matched but symbol didn't, tagged
  // with which field hit.
  function search(q) {
    const lowerQ = q.toLowerCase();
    const byId = new Map();
    (liteRows || []).forEach((row) => {
      if (row.symbol && row.symbol.toLowerCase().includes(lowerQ)) {
        byId.set(row.id, { row, field: null, snippet: "" });
      }
    });
    if (notesToggle.getAttribute("aria-pressed") === "true") {
      const fieldOrder = ["verdict", "lessons", "walkaway", "better", "symbol"];
      for (const row of notesIndex) {
        if (byId.has(row.id)) continue;
        for (const key of fieldOrder) {
          const text = row.fields[key];
          if (text && text.toLowerCase().includes(lowerQ)) {
            byId.set(row.id, { row, field: key, snippet: snippet(text, q, 60) });
            break;
          }
        }
      }
    }
    return Array.from(byId.values());
  }

  function applySort(matches) {
    const mode = sortEl.value;
    const sorted = matches.slice();
    if (mode === "symbol") sorted.sort((a, b) => a.row.symbol.localeCompare(b.row.symbol));
    else if (mode === "pnl-desc") sorted.sort((a, b) => b.row.pnl_after_comm - a.row.pnl_after_comm);
    else if (mode === "pnl-asc") sorted.sort((a, b) => a.row.pnl_after_comm - b.row.pnl_after_comm);
    else sorted.sort((a, b) => (a.row.trade_date < b.row.trade_date ? 1 : a.row.trade_date > b.row.trade_date ? -1 : 0));
    return sorted;
  }

  const FIELD_LABELS = { verdict: "Verdict", lessons: "Lessons", walkaway: "Walk-away rule", better: "Better entry/exit", symbol: "Symbol info" };

  function render(q) {
    q = (q || "").trim();
    if (!q) {
      resultsEl.innerHTML = `<div class="empty-state">Type a symbol to search your trades.</div>`;
      return;
    }
    if (!liteRows) {
      resultsEl.innerHTML = `<div class="empty-state">Loading your trades…</div>`;
      return;
    }
    const matches = applySort(search(q));
    if (!matches.length) {
      resultsEl.innerHTML = `<div class="empty-state">No matches for “${escapeHtml(q)}”.</div>`;
      return;
    }
    statusEl.textContent = `${matches.length} trade${matches.length === 1 ? "" : "s"}`;
    resultsEl.innerHTML = matches.map((m) => `
      <a class="gs-dock-item" href="trade.html?id=${encodeURIComponent(m.row.id)}">
        <span class="gs-sym">${escapeHtml(m.row.symbol)}</span>
        <span class="gs-date">${escapeHtml(m.row.trade_date)}</span>
        <span class="pill ${m.row.win ? "win" : "loss"}">${m.row.win ? "WIN" : "LOSS"}</span>
        ${m.field ? `<span class="gs-snip"><span class="pill" style="margin-right:6px;">${escapeHtml(FIELD_LABELS[m.field])}</span>${m.snippet}</span>` : `<span class="gs-snip"></span>`}
        <span class="gs-pnl ${m.row.pnl_after_comm >= 0 ? "up" : "down"}">${fmtMoney(m.row.pnl_after_comm)}</span>
      </a>
    `).join("");
  }

  let debounceTimer = null;
  queryEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => render(queryEl.value), 120);
  });
  sortEl.addEventListener("change", () => {
    try { sessionStorage.setItem(SORT_KEY, sortEl.value); } catch (e) { /* ignore */ }
    render(queryEl.value);
  });
  notesToggle.addEventListener("click", () => {
    const on = notesToggle.getAttribute("aria-pressed") === "true";
    notesToggle.setAttribute("aria-pressed", on ? "false" : "true");
    if (!on && !notesReady) buildNotesIndex();
    else render(queryEl.value);
  });

  // ---- open/close wiring -------------------------------------------------
  function openDock() {
    dock.classList.add("open");
    if (!liteRows) {
      statusEl.textContent = "Loading your trades…";
      loadLite().then(() => render(queryEl.value));
    }
    setTimeout(() => queryEl.focus(), 10);
  }
  function closeDock() { dock.classList.remove("open"); }

  trigger.addEventListener("click", () => {
    dock.classList.contains("open") ? closeDock() : openDock();
  });
  document.getElementById("gs-close-btn").addEventListener("click", closeDock);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dock.classList.contains("open")) { closeDock(); return; }
    // "/" opens search from anywhere, same as most sites -- unless the
    // person is already typing in some other field.
    if (e.key === "/" && !dock.classList.contains("open")) {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement.isContentEditable) return;
      e.preventDefault();
      openDock();
    }
  });
})();


// chat-widget.js — floating "AI Chat" launcher, shared by every app-shell
// page. Used to be its own sidebar tab pointing at chat.html; now it's a
// small popup like most normal sites' chat widgets, with a maximize
// button for a bigger view. Injects the launcher button + panel markup
// into the page, then loads chat.js (unmodified) against it -- chat.js
// only ever touches elements by id (#chat-messages, #chat-form, etc.),
// so it works identically whether those ids live on a full page or in
// this floating panel.
(function () {
  "use strict";

  // Login page has no trade data and no sidebar/topbar chrome -- skip.
  if (/\/login(\.html)?\/?$/.test(window.location.pathname)) return;
  if (!document.getElementById("sidebar")) return;

  const OPEN_KEY = "trade.log:chatWidgetOpen";

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.id = "chatw-launcher";
  launcher.className = "chatw-launcher";
  launcher.title = "AI Chat";
  launcher.setAttribute("aria-label", "Open AI chat");
  launcher.innerHTML = `
    <svg class="chatw-icon-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
    <svg class="chatw-icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
  `;

  const panel = document.createElement("div");
  panel.id = "chatw-panel";
  panel.className = "chatw-panel";
  panel.innerHTML = `
    <div class="chatw-panel-head">
      <span class="chatw-head-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l1.9 5.8L20 10l-6.1 2.2L12 18l-1.9-5.8L4 10l6.1-2.2z"></path></svg></span>
      <span class="chatw-panel-title">AI Chat</span>
      <span class="chatw-panel-actions">
        <button type="button" class="chatw-icon-action" id="chatw-hints-btn" title="Suggested questions" aria-label="Show suggested questions" aria-pressed="false">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2.05V17h6v-.25c0-.85.4-1.55 1-2.05A7 7 0 0 0 12 2z"></path></svg>
        </button>
        <button type="button" class="chatw-icon-action" id="chatw-maximize-btn" title="Maximize" aria-label="Maximize chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>
        </button>
        <button type="button" class="chatw-icon-action" id="chatw-close-btn" title="Close" aria-label="Close chat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </span>
    </div>
    <div class="chatw-body chat-content">
      <div class="chat-shell">
        <div class="chat-data-status" id="chat-data-status">
          <span class="chat-data-status-dot"></span> Loading your trade data…
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-chips" id="chat-chips"></div>
        <form class="chat-input-row" id="chat-form">
          <input
            type="text"
            id="chat-input"
            class="chat-input"
            placeholder="Ask about a trade, setup, or your stats…"
            autocomplete="off"
            disabled
          >
          <button type="submit" class="chat-send-btn" id="chat-send-btn" disabled>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
        </form>
      </div>
    </div>
  `;

  document.body.appendChild(panel);
  document.body.appendChild(launcher);

  function setOpen(open) {
    panel.classList.toggle("open", open);
    launcher.classList.toggle("open", open);
    if (!open) {
      // Reset maximize state on close so the launcher (hidden while
      // maximized, see below) always comes back once the panel isn't
      // covering it anymore, and the panel reopens at its normal size.
      panel.classList.remove("maximized");
      launcher.classList.remove("chatw-launcher-hidden");
    }
    try { sessionStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch (e) { /* ignore */ }
  }

  launcher.addEventListener("click", () => setOpen(!panel.classList.contains("open")));
  document.getElementById("chatw-close-btn").addEventListener("click", () => setOpen(false));
  document.getElementById("chatw-maximize-btn").addEventListener("click", (e) => {
    const isMax = panel.classList.toggle("maximized");
    // The round launcher button sits fixed at bottom-right in every
    // state, but the maximized panel's own bottom-right corner grows
    // to almost the same spot -- without this it sat directly on top
    // of the input row/send button. The header already has its own
    // close button, so just hide the redundant launcher while maximized.
    launcher.classList.toggle("chatw-launcher-hidden", isMax);
    e.currentTarget.title = isMax ? "Restore" : "Maximize";
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) setOpen(false);
  });

  // Reopen automatically if the person had it open before navigating to
  // this page -- conversation history itself is per-page-load (same as
  // the old chat.html always was), only the open/closed state persists.
  let startOpen = false;
  try { startOpen = sessionStorage.getItem(OPEN_KEY) === "1"; } catch (e) { /* ignore */ }
  if (startOpen) setOpen(true);

  // chat.js expects #chat-messages/#chat-form/etc. to already exist (it
  // looks them up as soon as it runs, not on DOMContentLoaded), so it's
  // only loaded now that the panel markup above is in the DOM.
  const chatScript = document.createElement("script");
  chatScript.src = "chat.js";
  document.body.appendChild(chatScript);
})();


// nav.js — shared sidebar/mobile-nav wiring for every page, plus a
// shared URL-state helper (see NavState below).
//
// Every page ships the same app-shell sidebar (#sidebar), a desktop
// collapse toggle (#sidebar-toggle), and a mobile hamburger button
// (#mobile-nav-btn) in the topbar. This used to be ~20 lines of
// identical inline <script> duplicated across nine pages, and three
// more pages (practice.html, quiz.html, rewind.html) shipped the
// hamburger button with no wiring at all, so tapping it did nothing.
// This file is the single implementation, loaded by every page.

// ---------------------------------------------------------------------
// NavState — mirrors a page's in-memory UI state (which month/day is
// open, which filters/sort/tab are active, how many rows are shown,
// ...) into that page's own query string, instead of only living in a
// JS variable.
//
// Every page here is a full navigation, not an SPA route -- clicking a
// trade opens trade.html as a real new document, and hitting Back
// reloads THIS page fresh, re-running all its JS from scratch. Any
// state that only ever lived in a `let` variable is gone at that
// point; the page falls back to whatever its hardcoded defaults are
// (today's month, no filters, first page of rows, ...) instead of
// where the person actually was. That's the "back button forgets
// where I was" bug.
//
// The fix: whenever that state changes, write it into the URL with
// history.replaceState (so browsing around doesn't pile up new
// history entries -- there's still exactly one entry for this page,
// it just keeps getting its query string updated). Back navigation
// then reloads this exact URL, and reading the same query string back
// out on boot puts the page back where it was.
window.NavState = (function () {
  "use strict";

  function readParams() {
    return new URLSearchParams(window.location.search);
  }

  // Reads one field back out of the URL. Always returns a string (or
  // `fallback`) -- callers are responsible for parsing numbers/JSON/etc.
  function get(key, fallback) {
    const v = readParams().get(key);
    return v === null ? fallback : v;
  }

  // Merges `updates` into the current query string and replaces the
  // current history entry with the result (hash is left untouched, so
  // this plays nicely with pages like index.html that use the hash for
  // which tab is active). A value of null/undefined/"" removes that key
  // instead of writing it, so optional/default state doesn't clutter
  // every URL.
  function set(updates) {
    const params = readParams();
    Object.keys(updates).forEach((k) => {
      const v = updates[k];
      if (v === null || v === undefined || v === "") params.delete(k);
      else params.set(k, String(v));
    });
    const qs = params.toString();
    const url = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
    history.replaceState(history.state, "", url);
  }

  return { get, set };
})();

(function () {
  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebar-toggle");
  const mobileNavBtn = document.getElementById("mobile-nav-btn");
  if (!sidebar) return; // page doesn't use the app-shell sidebar

  // Every page is a separate load (this isn't an SPA), so without this
  // the collapsed/expanded choice was thrown away and reset to expanded
  // on every single click into a new page -- that's the "collapse
  // never sticks" bug. Applied synchronously, before anything else runs,
  // so the sidebar never flashes expanded-then-collapsed on load.
  const COLLAPSE_KEY = "sidebar-collapsed";
  try {
    if (localStorage.getItem(COLLAPSE_KEY) === "1") {
      sidebar.classList.add("collapsed");
    }
  } catch (e) {
    // localStorage unavailable (private browsing, etc.) -- collapse
    // just won't persist across pages; the toggle itself still works.
  }

  const sidebarBackdrop = document.createElement("div");
  sidebarBackdrop.className = "sidebar-backdrop";
  document.body.appendChild(sidebarBackdrop);

  function closeMobileNav() {
    sidebar.classList.remove("mobile-open");
  }

  sidebarBackdrop.addEventListener("click", closeMobileNav);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMobileNav();
  });

  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => {
      if (window.innerWidth <= 760 && sidebar.classList.contains("mobile-open")) {
        closeMobileNav();
      } else {
        sidebar.classList.toggle("collapsed");
        try {
          localStorage.setItem(COLLAPSE_KEY, sidebar.classList.contains("collapsed") ? "1" : "0");
        } catch (e) {
          // ignore -- see comment above
        }
      }
    });
  }

  if (mobileNavBtn) {
    mobileNavBtn.addEventListener("click", () => {
      sidebar.classList.toggle("mobile-open");
    });
  }

  // Exposed so pages with their own tab-switching logic (index.html)
  // can close the mobile drawer on navigation without re-implementing it.
  window.closeMobileNav = closeMobileNav;
})();


/* modern.js — additive interactivity layer.
 * Safe by design: only ever *adds* classes/listeners to elements
 * that already exist. Never touches app.js/trade.js/etc. state. */
(function () {
  'use strict';
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 1. Scroll-reveal for panels/cards ---------- */
  function initReveal() {
    if (reduced || !('IntersectionObserver' in window)) return;
    var targets = document.querySelectorAll(
      '.panel-box, .card, .chart-panel, .equity-panel, .day-group, .playbook-card, .highlight-card, .dash-hero, .kpi-card'
    );
    if (!targets.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry, i) {
        if (entry.isIntersecting) {
          var el = entry.target;
          setTimeout(function () { el.classList.add('reveal-in'); }, Math.min(i * 40, 240));
          io.unobserve(el);
        }
      });
    }, { threshold: 0, rootMargin: '0px 0px -40px 0px' });
    targets.forEach(function (el) {
      if (el.dataset.revealBound) return; // boot() can run more than once
      el.dataset.revealBound = '1';
      // Elements that start (or are later toggled) display:none -- like
      // #bt-progress-box, hidden until a backtest starts -- report a 0x0
      // box here and can never satisfy the IntersectionObserver once
      // they're shown, since they aren't "scrolled into view" so much as
      // switched on by other JS. Binding them anyway meant they sat at
      // opacity:0 (from .reveal-init) until the 1800ms safety net caught
      // up -- so clicking "Run Backtest" soon after page load unhid an
      // invisible box, looking like the page had emptied out. Skip
      // reveal-on-scroll for anything not actually laid out right now;
      // it'll just render normally (opacity:1) whenever it's shown.
      if (getComputedStyle(el).display === 'none') return;
      // Tall content (e.g. a 300+ row table inside a panel) can be so much
      // taller than the viewport that it never satisfies an area-based
      // threshold. Only defer elements short enough to plausibly start
      // off-screen; anything else just reveals immediately.
      if (el.getBoundingClientRect().height > window.innerHeight * 1.2) return;
      el.classList.add('reveal-init');
      io.observe(el);
    });
    // Safety net: never leave anything stuck invisible (e.g. content that
    // grows taller than the viewport only after app.js populates it async).
    setTimeout(function () {
      document.querySelectorAll('.reveal-init:not(.reveal-in)').forEach(function (el) {
        el.classList.add('reveal-in');
      });
    }, 1800);
  }

  /* ---------- 2. Ripple on click for buttons ---------- */
  function initRipple() {
    if (reduced) return;
    var selector = '.filter-btn, .icon-btn, .cal-nav-btn, .sidebar-toggle, .nav-item, .btn-advanced, .btn-confirm, .btn-danger, .btn-icon, .sr-run-btn, .toptab-btn, .pp-order-btn, .quiz-answer-btn, .quiz-mode-btn, .quiz-preset-btn, .qz-speed-btn, .quiz-speed-btn';
    document.addEventListener('click', function (e) {
      var el = e.target.closest(selector);
      if (!el) return;
      var rect = el.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      // Radius reaches the button's farthest corner from the click point.
      // Using rect.width/height directly (the old approach) blew the
      // ripple way past the button on wide, short controls like the
      // report tab bar -- the circle ballooned way beyond the button.
      var radius = Math.sqrt(Math.pow(Math.max(x, rect.width - x), 2) + Math.pow(Math.max(y, rect.height - y), 2));
      var size = radius * 2;
      var span = document.createElement('span');
      span.className = 'ripple';
      span.style.width = span.style.height = size + 'px';
      span.style.left = (x - radius) + 'px';
      span.style.top = (y - radius) + 'px';
      var prevPos = getComputedStyle(el).position;
      if (prevPos === 'static') el.style.position = 'relative';
      if (getComputedStyle(el).overflow === 'visible') el.style.overflow = 'hidden';
      el.appendChild(span);
      span.addEventListener('animationend', function () { span.remove(); });
    }, true);
  }

  /* ---------- 3. Flash numeric values when app.js updates them ---------- */
  function initValueFlash() {
    if (reduced || !('MutationObserver' in window)) return;
    var selector = '.stat .value, .pnl-breakdown .cell .value, .streak-strip .cell .value, ' +
      '.cal-summary-strip .cell .value, .equity-head .value, .score-gauge .num, .pb-value';
    var seen = new WeakMap();
    var mo = new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        var el = m.target.nodeType === 3 ? m.target.parentElement : m.target;
        if (!el || !el.matches || !el.matches(selector)) return;
        var text = el.textContent;
        if (seen.get(el) === text) return;
        seen.set(el, text);
        el.classList.remove('value-settled');
        void el.offsetWidth;
        el.classList.add('value-settled');
      });
    });
    document.querySelectorAll(selector).forEach(function (el) {
      seen.set(el, el.textContent);
      mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  /* ---------- 4. Subtle magnetic tilt on stat cards (desktop only) ---------- */
  function initTilt() {
    if (reduced || window.matchMedia('(pointer: coarse)').matches) return;
    document.querySelectorAll('.stat, .highlight-card').forEach(function (card) {
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width - 0.5;
        var y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(600px) rotateX(' + (-y * 3) + 'deg) rotateY(' + (x * 3) + 'deg)';
      });
      card.addEventListener('mouseleave', function () { card.style.transform = ''; });
    });
  }

  function boot() {
    initReveal();
    initRipple();
    initValueFlash();
    initTilt();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* Re-run reveal/tilt hookup after tab switches or late DOM insertions
     (app.js renders dashboard content async on load). */
  window.addEventListener('load', function () {
    setTimeout(boot, 250);
  });
})();
