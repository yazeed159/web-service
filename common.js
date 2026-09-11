// shared-format.js — canonical escapeHtml()/fmtMoney(), exposed on
// `window`. escapeHtml is duplicated across 17 files and fmtMoney across
// 10, with real drift between copies -- e.g. live-trading.js's fmtMoney
// never prefixed a "+" on positive amounts the way every other page's
// did, and practice.js/practice-analytics.js added comma
// thousands-separators no other copy used, so the same P&L number
// rendered as a visibly different string depending which page you were
// on (both fixed directly in their own files below, rather than pointed
// at this copy -- see note).
//
// NOTE ON WHY THIS ISN'T USED EVERYWHERE YET: common.js loads near the
// END of the <script> list on every page except calculator.html (it
// does its sidebar/chat-widget DOM injection last, after the page's own
// content exists) -- so a page script that calls fmtMoney/escapeHtml
// from its own synchronous top-level render path, before common.js has
// run, would hit a ReferenceError. calculator.js is the one page where
// common.js already loads first, so it's the one page wired to this
// copy for now. Retiring the rest safely means moving common.js earlier
// in each of those pages first, which is a separate, riskier change
// than fixing the two behavioral bugs on their own.
window.escapeHtml = function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
};

// Canonical form: "+$1234.56" / "-$1234.56", no thousands separator (7 of
// the 10 duplicate copies already formatted it this way), "—" for
// anything that isn't a finite number rather than silently coercing to
// $0.00 or rendering the literal string "NaN".
window.fmtMoney = function fmtMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return (n >= 0 ? "+$" : "-$") + Math.abs(n).toFixed(2);
};

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
  "use strict";

  // Single source of truth for the sidebar's "More" section -- every
  // page used to carry its own copy of this exact list (label, href,
  // and icon), hand-copied page to page. In practice that's already
  // drifted twice: quiz.html was the only page whose sidebar linked to
  // itself (added when the Quiz page shipped, never back-filled onto
  // the other 14 pages), and report.html's Import Trades tooltip picked
  // up extra wording ("...into your real journal") that never made it
  // back to the other copies. Both are folded into this single list
  // below, so every page shows the same items and the same wording,
  // and adding a page here is the only place it needs adding.
  const SIDEBAR_MORE_ITEMS = [
    {
      href: "#", id: "import-trades-link", title: "Upload a CSV of past trades to import into your real journal",
      icon: '<path d="M12 3v12"></path><path d="M7 8l5-5 5 5"></path><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>',
      label: "Import Trades",
    },
    {
      href: "stats.html",
      icon: '<path d="M3 3v18h18"></path><path d="M18.4 8.6 12 15l-3-3-4 4"></path>',
      label: "Performance",
    },
    {
      href: "edge-analysis.html",
      icon: '<path d="M3 3l7 7-4 11L21 3 10 14l11 7-7-4"></path><circle cx="3" cy="3" r="1.4" fill="currentColor" stroke="none"></circle>',
      label: "Edge Analysis",
    },
    {
      href: "patterns.html",
      icon: '<circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"></line><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"></line>',
      label: "Patterns",
    },
    {
      href: "calculator.html",
      icon: '<rect x="4" y="2" width="16" height="20" rx="2"></rect><line x1="8" y1="7" x2="16" y2="7"></line><line x1="8" y1="12" x2="8.01" y2="12"></line><line x1="12" y1="12" x2="12.01" y2="12"></line><line x1="16" y1="12" x2="16.01" y2="12"></line><line x1="8" y1="16" x2="8.01" y2="16"></line><line x1="12" y1="16" x2="12.01" y2="16"></line><line x1="16" y1="16" x2="16.01" y2="16"></line>',
      label: "Calculator",
    },
    {
      href: "backtester.html",
      icon: '<polyline points="3 17 9 11 13 15 21 6"></polyline><polyline points="15 6 21 6 21 12"></polyline>',
      label: "Backtester",
    },
    {
      href: "live-trading.html",
      icon: '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"></circle>',
      label: "Live Trading",
    },
    {
      href: "scanner.html",
      icon: '<path d="M3 11l18-8-8 18-2-8-8-2z"></path>',
      label: "Scanner",
    },
    {
      href: "rewind.html",
      icon: '<polygon points="11 19 2 12 11 5 11 19"></polygon><polygon points="22 19 13 12 22 5 22 19"></polygon>',
      label: "Rewind",
    },
    {
      href: "practice.html",
      icon: '<circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon>',
      label: "Practice",
    },
    {
      href: "quiz.html",
      icon: '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1"></circle>',
      label: "Quiz",
    },
    {
      href: "settings.html",
      icon: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
      label: "Settings",
    },
  ];

  const mount = document.getElementById("sidebar-more-section");
  if (!mount) return; // page has no app-shell sidebar, or hasn't adopted the mount point yet

  // The active item is whichever page we're actually on -- compared by
  // filename only (not the full href), since deep links can carry a
  // hash or query string (e.g. a filtered edge-analysis.html?setup=...).
  const currentFile = window.location.pathname.split("/").pop() || "index.html";

  mount.innerHTML =
    '<div class="nav-section-label">More</div>' +
    SIDEBAR_MORE_ITEMS.map((item) => {
      const isActive = item.href !== "#" && item.href.split("?")[0] === currentFile;
      const idAttr = item.id ? ` id="${item.id}"` : "";
      const titleAttr = item.title ? ` title="${item.title}"` : "";
      return (
        `<a class="nav-item${isActive ? " active" : ""}"${idAttr} href="${item.href}"${titleAttr}>` +
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>` +
        `<span class="nav-label">${item.label}</span>` +
        `</a>`
      );
    }).join("");
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

// ---------------------------------------------------------------------
// Hover-prefetch for sidebar navigation. Every nav-item is a real
// full-page link (journal.html, stats.html, etc.), so the biggest part
// of the "loading" feeling on navigation is just network wait for the
// next document. Warming the browser's cache for a link as soon as the
// pointer lands on it (people reliably pause on a link for a beat
// before clicking) means that by the time the click actually happens,
// the page is often already cached -- so the view-transition in
// common.css has nothing left to wait on and the switch reads as
// instant, without changing how any page loads or is built.
(function () {
  "use strict";
  var done = Object.create(null);
  function prefetch(url) {
    if (!url || done[url]) return;
    done[url] = true;
    var link = document.createElement("link");
    link.rel = "prefetch";
    link.href = url;
    document.head.appendChild(link);
  }
  document.addEventListener("pointerenter", function (e) {
    var a = e.target.closest && e.target.closest(".nav-item[href], .sidebar a[href]");
    if (!a) return;
    var href = a.getAttribute("href");
    if (href && !/^(https?:)?\/\//.test(href) && href.indexOf("#") !== 0) prefetch(href);
  }, true);
})();

// ================================================================
// SETUP/TAG COLOR CODING (shared by journal, trade detail, patterns,
// practice, rewind -- anywhere a setup_type or lesson tag is shown).
// Hashes the tag's own text to one of 8 accent hues so a given setup
// always renders in the same color everywhere it appears, instead of
// every tag looking identical. Purely a rendering rule off the string
// that's already there -- no new field, nothing to configure per tag.
// Hues are chosen to stay clear of the green/red bands already used
// for win/loss coloring throughout the app, so a tag color is never
// mistaken for a win/loss signal.
(function () {
  "use strict";
  var HUES = [255, 228, 200, 172, 42, 300, 322, 66]; // violet, blue, cyan, teal, amber, magenta, pink, gold
  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }
  window.setupTagStyle = function (name) {
    var key = String(name || "").trim().toLowerCase();
    var hue = HUES[hashStr(key) % HUES.length];
    return {
      hue: hue,
      bg: "hsla(" + hue + ", 65%, 55%, 0.16)",
      border: "hsla(" + hue + ", 65%, 55%, 0.38)",
      fg: "hsl(" + hue + ", 85%, 74%)",
    };
  };
  // Inline style-attribute shorthand for a colored pill: background +
  // border + text all in the tag's hue.
  window.setupTagStyleAttr = function (name) {
    var c = window.setupTagStyle(name);
    return "background:" + c.bg + ";border-color:" + c.border + ";color:" + c.fg + ";";
  };
  // Just a small dot, for places already showing the label as plain
  // text (table rows, breakdown lists) where a full recolored pill
  // would be too heavy -- a leading dot keys it to the pill color used
  // elsewhere without changing the row's own text styling.
  window.setupTagDot = function (name) {
    var c = window.setupTagStyle(name);
    return '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:' + c.fg + ';margin-right:6px;vertical-align:middle;"></span>';
  };
})();
