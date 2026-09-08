// global-search.js — the ONE header search control.
//
// Replaces two separate, overlapping search implementations (an old
// one baked into common.js and a newer one in this file) that were
// both self-mounting into every page at once -- hence two search
// icons in the topbar doing slightly different things. There is now
// exactly one: a permanent search box that lives in the header itself
// on desktop (not an icon you have to click to reveal a box), with a
// live-as-you-type dropdown (debounced, no need to press Enter) for a
// quick glance, and Enter (or "View all results") taking you to a
// dedicated full results page, search.html, for everything that
// matched. On narrow/mobile widths there isn't room for a permanent
// header box, so it collapses to a single icon button that expands
// the same box + dropdown as a docked panel under the topbar.
//
// Self-mounting: finds .topbar/.topbar-right on whatever page it's
// loaded from and injects itself. Nothing else to add per-page beyond
// the <script> tag.
(function () {
  "use strict";

  if (/\/login(\.html)?\/?$/.test(window.location.pathname)) return;
  const topbar = document.querySelector(".topbar");
  const topbarRight = document.querySelector(".topbar-right");
  if (!topbar || !topbarRight) return;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function fmtMoney(v) {
    if (v == null || !isFinite(v)) return "";
    return (v >= 0 ? "+$" : "-$") + Math.abs(v).toFixed(2);
  }
  function highlight(text, query) {
    const escaped = escapeHtml(text || "");
    const escapedQuery = escapeHtml(query || "");
    if (!escapedQuery) return escaped;
    const re = new RegExp(escapeRegex(escapedQuery), "ig");
    return escaped.replace(re, (m) => `<mark>${m}</mark>`);
  }

  // One search glyph, used everywhere search shows up (header box,
  // mobile trigger, search.html) -- drawn a little bolder than the
  // thin 2px nav icons since it's the header's primary action, not a
  // copy-pasted stand-in.
  const SEARCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"></circle><line x1="20" y1="20" x2="15.3" y2="15.3"></line></svg>`;
  const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
  window.SEARCH_ICON_SVG = SEARCH_ICON; // reused as-is by search.html's own header

  // ---- mount: header box (desktop) / trigger (mobile) -------------------

  const root = document.createElement("div");
  root.className = "header-search";
  root.id = "hs-root";
  root.innerHTML = `
    <form class="header-search-box" id="hs-form" autocomplete="off">
      ${SEARCH_ICON}
      <input type="text" id="hs-input" class="header-search-input" placeholder="Search trades\u2026" aria-label="Search your trades">
      <button type="button" class="header-search-clear" id="hs-clear" aria-label="Clear search" hidden>${CLOSE_ICON}</button>
      <kbd class="header-search-kbd">/</kbd>
      <button type="button" class="header-search-close" id="hs-mobile-close" aria-label="Close search">${CLOSE_ICON}</button>
    </form>
    <div class="header-search-panel" id="hs-panel">
      <div class="header-search-status" id="hs-status"></div>
      <div class="header-search-results" id="hs-results"></div>
    </div>
  `;
  topbar.insertBefore(root, topbarRight);

  // Mobile-only trigger -- reuses the existing .icon-btn convention
  // (display:none above 760px, flex below it), same as mobile-nav-btn,
  // so there's no separate breakpoint rule to keep in sync here.
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "icon-btn";
  trigger.id = "hs-trigger";
  trigger.title = "Search";
  trigger.setAttribute("aria-label", "Search your trades");
  trigger.innerHTML = SEARCH_ICON;
  topbarRight.insertBefore(trigger, topbarRight.firstChild);

  const formEl = root.querySelector("#hs-form");
  const inputEl = root.querySelector("#hs-input");
  const clearBtn = root.querySelector("#hs-clear");
  const mobileCloseBtn = root.querySelector("#hs-mobile-close");
  const panelEl = root.querySelector("#hs-panel");
  const statusEl = root.querySelector("#hs-status");
  const resultsEl = root.querySelector("#hs-results");

  // ---- data (fetched lazily, once, on first use) -------------------

  let trades = null;
  let tradesPromise = null;
  function loadTrades() {
    if (!tradesPromise) {
      tradesPromise = window.fetchTradesIndex().then((rows) => {
        trades = Array.isArray(rows) ? rows : [];
        return trades;
      });
    }
    return tradesPromise;
  }

  // ---- open / close --------------------------------------------------

  function openPanel() { panelEl.classList.add("open"); }
  function closePanel() { panelEl.classList.remove("open"); }

  function isMobile() { return window.innerWidth <= 760; }

  function openMobile() {
    root.classList.add("mobile-open");
    loadTrades().catch(() => {});
    // Focus after layout settles so the on-screen keyboard doesn't
    // fight the panel's own position:fixed transition.
    requestAnimationFrame(() => inputEl.focus());
    document.addEventListener("keydown", onEsc, true);
  }
  function closeMobile() {
    root.classList.remove("mobile-open");
    closePanel();
    document.removeEventListener("keydown", onEsc, true);
  }
  function onEsc(ev) {
    if (ev.key === "Escape") { closeMobile(); trigger.focus(); }
  }

  trigger.addEventListener("click", () => {
    if (!isMobile()) return; // hidden by CSS anyway above 760px
    root.classList.contains("mobile-open") ? closeMobile() : openMobile();
  });
  mobileCloseBtn.addEventListener("click", closeMobile);

  inputEl.addEventListener("focus", () => {
    loadTrades().catch(() => {});
    if (inputEl.value.trim()) openPanel();
  });

  document.addEventListener("click", (ev) => {
    if (root.contains(ev.target) || ev.target === trigger) return;
    closePanel();
    if (isMobile()) closeMobile();
  });

  // ---- live results, debounced, no Enter required --------------------

  const LIVE_LIMIT = 6;
  let debounceTimer = null;

  inputEl.addEventListener("input", () => {
    clearBtn.hidden = !inputEl.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runLiveSearch, 140);
  });

  clearBtn.addEventListener("click", () => {
    inputEl.value = "";
    clearBtn.hidden = true;
    closePanel();
    resultsEl.innerHTML = "";
    statusEl.textContent = "";
    inputEl.focus();
  });

  function runLiveSearch() {
    const q = inputEl.value.trim();
    if (!q) { closePanel(); resultsEl.innerHTML = ""; statusEl.textContent = ""; return; }
    openPanel();
    statusEl.textContent = trades ? "" : "Loading\u2026";
    loadTrades()
      .then((rows) => {
        const ql = q.toLowerCase();
        const matches = rows.filter((t) => (t.symbol || "").toLowerCase().includes(ql));
        // Most-recent-first: the useful default for "did I trade this
        // lately", with no sort picker needed for a 6-row glance --
        // the full sort options live on search.html, for the full list.
        matches.sort((a, b) => (b.trade_date + (b.entry_time || "")).localeCompare(a.trade_date + (a.entry_time || "")));

        if (!matches.length) {
          statusEl.textContent = `No trades match "${q}".`;
          resultsEl.innerHTML = "";
          return;
        }
        statusEl.textContent = "";
        const shown = matches.slice(0, LIVE_LIMIT);
        resultsEl.innerHTML = shown.map((t) => `
          <a class="header-search-item" href="trade.html?id=${encodeURIComponent(t.id)}">
            <span class="hs-sym">${highlight(t.symbol || "", q)}</span>
            <span class="hs-date">${escapeHtml(t.trade_date || "")}</span>
            <span class="pill ${t.win ? "win" : "loss"}">${t.win ? "WIN" : "LOSS"}</span>
            <span class="hs-pnl ${(t.pnl_after_comm || 0) >= 0 ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</span>
          </a>`).join("") +
          `<a class="header-search-viewall" href="search.html?q=${encodeURIComponent(q)}">
            ${matches.length > shown.length ? `View all ${matches.length} results` : "View full results"} \u2192
          </a>`;
      })
      .catch(() => { statusEl.textContent = "Couldn't search your trades."; });
  }

  // ---- Enter (or the mobile "go") -- full results page ----------------

  formEl.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const q = inputEl.value.trim();
    if (!q) { inputEl.focus(); return; }
    window.location.href = "search.html?q=" + encodeURIComponent(q);
  });

  // ---- keyboard shortcuts ---------------------------------------------
  // "/" and Ctrl/Cmd+K both just focus the box on desktop (it's always
  // there); on mobile they open it, since it's collapsed behind the icon.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/") {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement && document.activeElement.isContentEditable)) return;
      ev.preventDefault();
      isMobile() ? openMobile() : inputEl.focus();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      isMobile() ? openMobile() : inputEl.focus();
    }
  });
})();
