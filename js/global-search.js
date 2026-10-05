// global-search.js — the ONE header search control.
//
// Replaces two separate, overlapping search implementations (an old
// one baked into common.js and a newer one in this file) that were
// both self-mounting into every page at once -- hence two search
// icons in the topbar doing slightly different things. There is now
// exactly one: a single icon button in the topbar that expands into a
// docked search box + dropdown (a live-as-you-type list, debounced,
// no need to press Enter). Enter (or "View all results") takes you to
// a dedicated full results page, search.html, for everything that
// matched. Same collapsed-icon behavior at every width -- narrower
// viewports just get a full-width banner instead of a small anchored
// dropdown (see the max-width:760px override in common.css).
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

// escapeHtml() now in utils.js (loads first on every page).
  function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
// fmtMoney() now in utils.js (loads first on every page).
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
  trigger.className = "icon-btn icon-btn-visible";
  trigger.id = "hs-trigger";
  trigger.title = "Search (Ctrl+K)";
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

  // ---- quick nav (command-palette-style "go to page") ----------------
  // Kept as its own short, self-contained list rather than reaching into
  // nav-render.js's IIFE-scoped item arrays -- if a page here is ever
  // renamed, keep this in sync with SIDEBAR_MAIN_ITEMS/SIDEBAR_MORE_ITEMS/
  // SIDEBAR_WIP_ITEMS there.
  const QUICK_NAV = [
    { label: "Dashboard", href: "index.html" },
    { label: "Day View", href: "index.html#dayview" },
    { label: "Reports", href: "index.html#reports" },
    { label: "Journal", href: "journal.html" },
    { label: "Daily plan and review", href: "daily.html" },
    { label: "Import Trades", href: "import-trades.html" },
    { label: "Performance", href: "stats.html" },
    { label: "Edge Analysis", href: "edge-analysis.html" },
    { label: "Patterns", href: "patterns.html" },
    { label: "Calculator", href: "calculator.html" },
    { label: "Backtester", href: "backtester.html" },
    { label: "Rewind", href: "rewind.html" },
    { label: "Practice", href: "practice.html" },
    { label: "Settings", href: "settings.html" },
    { label: "Live Trading", href: "live-trading.html" },
    { label: "Scanner", href: "scanner.html" },
  ];
  const NAV_ITEM_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>`;

  function matchNav(q) {
    if (!q) return QUICK_NAV;
    const ql = q.toLowerCase();
    return QUICK_NAV.filter((n) => n.label.toLowerCase().includes(ql));
  }

  function renderNavSection(items, q, heading) {
    if (!items.length) return "";
    return `<div class="hs-section-label">${heading}</div>` +
      items.map((n) => `
        <a class="header-search-item hs-nav-item" href="${n.href}">
          <span class="hs-nav-icon">${NAV_ITEM_ICON}</span>
          <span class="hs-nav-label">${highlight(n.label, q)}</span>
        </a>`).join("");
  }

  // ---- data (fetched lazily, once, on first use) -------------------

  let trades = null;
  let tradesPromise = null;
  function loadTrades() {
    if (!tradesPromise) {
      tradesPromise = (window.fetchTradesIndexRaw || window.fetchTradesIndex)().then((rows) => {
        trades = Array.isArray(rows) ? rows : [];
        return trades;
      });
    }
    return tradesPromise;
  }

  // ---- open / close --------------------------------------------------

  function openPanel() { panelEl.classList.add("open"); }
  function closePanel() { panelEl.classList.remove("open"); }

  // The topbar has a backdrop-filter, which makes it the containing block for
  // any position:fixed descendant -- so the phone's bottom-docked sheet would
  // anchor to the topbar instead of the screen. While it is open on a phone,
  // move it to <body>; closeMobile() puts it back where desktop CSS expects it.
  const phoneMq = window.matchMedia ? window.matchMedia("(max-width: 760px)") : { matches: false };
  function openMobile() {
    if (phoneMq.matches && root.parentNode !== document.body) document.body.appendChild(root);
    root.classList.add("mobile-open");
    loadTrades().catch(() => {});
    // Focus after layout settles so the on-screen keyboard doesn't
    // fight the panel's own position:fixed transition.
    requestAnimationFrame(() => inputEl.focus());
    document.addEventListener("keydown", onEsc, true);
  }
  function closeMobile() {
    root.classList.remove("mobile-open");
    root.style.removeProperty("--hs-kb");
    root.style.removeProperty("--hs-vvh");
    if (root.parentNode !== topbar) topbar.insertBefore(root, topbarRight);
    closePanel();
    document.removeEventListener("keydown", onEsc, true);
  }
  function onEsc(ev) {
    if (ev.key === "Escape") { closeMobile(); trigger.focus(); }
  }

  function toggleMobile() {
    root.classList.contains("mobile-open") ? closeMobile() : openMobile();
  }
  trigger.addEventListener("click", toggleMobile);
  // The phone's bottom tab bar has a Search button (js/nav-render.js) that
  // drives this same control; the topbar icon is hidden at phone widths.
  window.GlobalSearch = { open: openMobile, close: closeMobile, toggle: toggleMobile };

  // On a phone the open search is a sheet docked to the bottom edge (see the
  // max-width:760px block in common.css), so lift it above the on-screen
  // keyboard the same way the quick-note sheet does.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fitToKeyboard = () => {
      if (!root.classList.contains("mobile-open")) return;
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty("--hs-kb", kb + "px");
      root.style.setProperty("--hs-vvh", vv.height + "px");
    };
    vv.addEventListener("resize", fitToKeyboard);
    vv.addEventListener("scroll", fitToKeyboard);
  }
  mobileCloseBtn.addEventListener("click", closeMobile);

  inputEl.addEventListener("focus", () => {
    loadTrades().catch(() => {});
    if (inputEl.value.trim()) {
      openPanel();
    } else {
      // Command-palette-style landing state: with nothing typed yet,
      // show where you can jump to instead of an empty box -- the
      // point of Ctrl/Cmd+K is skipping the trip through the sidebar.
      statusEl.textContent = "";
      resultsEl.innerHTML = renderNavSection(QUICK_NAV, "", "Jump to");
      openPanel();
    }
  });

  document.addEventListener("click", (ev) => {
    if (root.contains(ev.target) || ev.target === trigger) return;
    if (ev.target.closest && ev.target.closest("#bn-search")) return; // the bottom-bar button toggles it itself
    closePanel();
    closeMobile();
  });

  // Following a result closes the sheet: an in-place SPA navigation would
  // otherwise leave it sitting open over the new page.
  resultsEl.addEventListener("click", (ev) => {
    if (ev.target.closest && ev.target.closest("a")) setTimeout(closeMobile, 0);
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
    if (!q) { inputEl.dispatchEvent(new Event("focus")); return; }
    openPanel();
    const navMatches = matchNav(q).slice(0, 5);
    const navHtml = renderNavSection(navMatches, q, "Pages");
    statusEl.textContent = trades ? "" : "Loading\u2026";
    loadTrades()
      .then((rows) => {
        const ql = q.toLowerCase();
        const matches = rows.filter((t) => (t.symbol || "").toLowerCase().includes(ql));
        // Most-recent-first: the useful default for "did I trade this
        // lately", with no sort picker needed for a 6-row glance --
        // the full sort options live on search.html, for the full list.
        matches.sort((a, b) => (b.trade_date + (b.entry_time || "")).localeCompare(a.trade_date + (a.entry_time || "")));

        if (!matches.length && !navMatches.length) {
          statusEl.textContent = `No trades or pages match "${q}".`;
          resultsEl.innerHTML = "";
          return;
        }
        statusEl.textContent = "";
        const shown = matches.slice(0, LIVE_LIMIT);
        const tradesHtml = matches.length
          ? `<div class="hs-section-label">Trades</div>` +
            shown.map((t) => `
              <a class="header-search-item" href="trade.html?id=${encodeURIComponent(t.id)}">
                <span class="hs-sym">${highlight(t.symbol || "", q)}</span>
                <span class="hs-date">${escapeHtml(t.trade_date || "")}</span>
                <span class="pill ${t.win ? "win" : "loss"}">${t.win ? "WIN" : "LOSS"}</span>
                <span class="hs-pnl ${(t.pnl_after_comm || 0) >= 0 ? "up" : "down"}">${fmtMoney(t.pnl_after_comm)}</span>
              </a>`).join("") +
            `<a class="header-search-viewall" href="search.html?q=${encodeURIComponent(q)}">
              ${matches.length > shown.length ? `View all ${matches.length} results` : "View full results"} \u2192
            </a>`
          : "";
        resultsEl.innerHTML = navHtml + tradesHtml;
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

  // ---- arrow-key navigation through results ---------------------------
  // A command palette that only works with a mouse isn't really a
  // command palette. ArrowDown from the input hands focus to the first
  // result; ArrowUp/Down then walk the list (real <a> elements, so Enter
  // and click both just work); ArrowUp off the top returns to the input.
  function resultItems() {
    return Array.from(resultsEl.querySelectorAll(".header-search-item, .header-search-viewall"));
  }
  inputEl.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowDown") return;
    const items = resultItems();
    if (!items.length) return;
    ev.preventDefault();
    items[0].focus();
  });
  resultsEl.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    const items = resultItems();
    const i = items.indexOf(document.activeElement);
    if (i === -1) return;
    ev.preventDefault();
    if (ev.key === "ArrowDown") {
      if (i < items.length - 1) items[i + 1].focus();
    } else if (i === 0) {
      inputEl.focus();
    } else {
      items[i - 1].focus();
    }
  });

  // ---- keyboard shortcuts ---------------------------------------------
  // "/" and Ctrl/Cmd+K both just focus the box on desktop (it's always
  // there); on mobile they open it, since it's collapsed behind the icon.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/") {
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement && document.activeElement.isContentEditable)) return;
      ev.preventDefault();
      openMobile();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      openMobile();
    }
  });
})();
