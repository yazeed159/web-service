// nav-render.js — renders the sidebar's Journal/More/Work-in-Progress
// nav links and highlights the active page.
//
// Split out of common.js and loaded right after the sidebar markup
// (instead of at the bottom of the page with the rest of common.js).
// The mount points (#sidebar-main-section / #sidebar-more-section /
// #sidebar-wip-section) used to sit empty until common.js ran as the
// very last <script> on the page -- on any page with a lot of markup/
// inline scripts above it, that meant a visibly empty nav (just the
// logo, no links) for a beat on every single page load, which on top
// of the full page navigation browsers already do made every click
// look like it had landed on a broken/different site. Running this
// immediately after the sidebar's HTML exists removes that gap
// entirely -- the nav is complete before the browser even gets to the
// rest of the page.
(function () {
  "use strict";

  // Single source of truth for the sidebar's "Journal" section -- the
  // first four items (Dashboard/Day View/Reports/Journal) used to be
  // hand-copied into every page's sidebar markup individually (16 files
  // carried an identical copy), rather than generated like the "More"
  // section below. Folded into the same mount-point pattern so a future
  // nav change (add/reorder/tooltip) is one edit here instead of a sweep
  // across every page.
  //
  // index.html is deliberately NOT part of this: its first three items
  // are <button data-tab> elements wired to in-page tab switching by
  // app.js (not links to other pages), and app.js's click-binding for
  // them runs *before* common.js on that page, so templating them here
  // would leave them unbound. They stay hand-written in index.html.
  const SIDEBAR_MAIN_ITEMS = [
    {
      href: "index.html", title: "Dashboard",
      icon: '<rect x="3" y="3" width="7" height="9" rx="1.5"></rect><rect x="14" y="3" width="7" height="5" rx="1.5"></rect><rect x="14" y="12" width="7" height="9" rx="1.5"></rect><rect x="3" y="16" width="7" height="5" rx="1.5"></rect>',
      label: "Dashboard",
    },
    {
      href: "index.html#dayview", title: "Day View",
      icon: '<rect x="3" y="4.5" width="18" height="16" rx="2"></rect><line x1="3" y1="9.5" x2="21" y2="9.5"></line><line x1="8" y1="2.5" x2="8" y2="6.5"></line><line x1="16" y1="2.5" x2="16" y2="6.5"></line>',
      label: "Day View",
    },
    {
      href: "index.html#reports", title: "Reports",
      icon: '<line x1="5" y1="21" x2="5" y2="10"></line><line x1="12" y1="21" x2="12" y2="4"></line><line x1="19" y1="21" x2="19" y2="14"></line>',
      label: "Reports",
    },
    {
      href: "journal.html", title: "Journal",
      icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>',
      label: "Journal",
      // trade.html (a single trade's detail view) is conceptually part
      // of the Journal section, so it lights this up too even though
      // its own filename doesn't match "journal.html".
      extraActiveFiles: ["trade.html"],
    },
    {
      href: "daily.html", title: "Daily plan and review",
      icon: '<polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>',
      label: "Daily",
    },
  ];

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
  //
  // Quiz itself has been removed (it duplicated Rewind's setup-quiz-
  // history-play flow) -- quiz.html, css/quiz.css and js/quiz.js are
  // gone. css/quiz-shared.css stays: Practice and Rewind's quiz-style
  // screens still use those classes.
  const SIDEBAR_MORE_ITEMS = [
    {
      // Real target is user-configurable (window.N8N_IMPORT_URL, set by
      // config.js) -- resolved at render time below, not hardcoded here,
      // since config.js hasn't run yet the first time this file executes
      // (it loads later in every page's <script> order) and this item's
      // HTML gets rebuilt from scratch on every SPA navigation, not just
      // once on initial page load. "import-trades.html" is just the
      // fallback for the (in-practice-unreachable) case config.js hasn't
      // set it yet.
      id: "import-trades-link", title: "Upload a CSV of past trades to import into your real journal",
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
      href: "rewind.html",
      icon: '<polygon points="11 19 2 12 11 5 11 19"></polygon><polygon points="22 19 13 12 22 5 22 19"></polygon>',
      label: "Rewind",
    },
    {
      href: "practice.html",
      icon: '<circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon>',
      label: "Practice",
    },
  ];

  // Pinned group at the very bottom of the sidebar (above the status
  // strip), visually separate from the page lists -- Accounts and Settings
  // are app-level places, not analysis tools, so they live where users
  // expect them. Both are also in the top-right account menu (auth.js).
  const SIDEBAR_PINNED_ITEMS = [
    {
      href: "accounts.html", title: "Real accounts, deposits/periods and paper-trading attempts",
      icon: '<path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v3"></path><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"></path><path d="M17 14h4v4h-4a2 2 0 0 1 0-4z"></path>',
      label: "Accounts",
    },
    {
      href: "settings.html",
      icon: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
      label: "Settings",
    },
  ];

  // Sidebar's third section, for pages that are live in the nav but
  // not finished yet -- kept visually separate (its own "Work in
  // Progress" label) rather than mixed into "More" so it doesn't read
  // as a finished feature.
  const SIDEBAR_WIP_ITEMS = [
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
  ];

  // Wrapped in a named, re-callable function (instead of running once
  // inline) so the SPA router (js/page-transition.js) can call this
  // again after swapping in a new page's content -- the mount points
  // below live in the persistent sidebar, which the router never
  // touches, so re-running this is just "recompute the active item
  // for wherever we are now", safe to call as many times as needed.
  function renderNav() {
  const mainMount = document.getElementById("sidebar-main-section");
  const moreMount = document.getElementById("sidebar-more-section");
  const wipMount = document.getElementById("sidebar-wip-section");
  if (!mainMount && !moreMount && !wipMount) return; // page has no app-shell sidebar, or hasn't adopted the mount points yet

  // The active item is whichever page we're actually on -- compared by
  // filename only (not the full href), since deep links can carry a
  // hash or query string (e.g. a filtered edge-analysis.html?setup=...).
  // Normalized (decoded + lowercased + trailing-slash-stripped) so a
  // trailing slash, URL-encoded character, or case difference from how
  // a link/bookmark was typed doesn't silently break the match.
  // Also strips a trailing ".html" so this matches regardless of
  // whether the page is reached via its raw filename (journal.html)
  // or via the clean URL the Worker actually serves in production
  // (…/journal, no extension) -- without this, currentFile ("journal")
  // never matched any item's hrefFile ("journal.html") and the active
  // state silently never lit up on ANY page.
  function normalizeFile(name) {
    try {
      return decodeURIComponent(name || "").toLowerCase().replace(/\/+$/, "").replace(/\.html$/, "");
    } catch (e) {
      return String(name || "").toLowerCase().replace(/\.html$/, "");
    }
  }
  const currentFile = normalizeFile(window.location.pathname.split("/").pop()) || "index";

  // Dashboard / Day View / Reports are all index.html, distinguished
  // only by #hash -- stripping the hash before comparing (as the
  // generic filename check below does) collapses all three to the
  // same "index" identifier and lights all three up together whenever
  // we're anywhere on index.html. Only index.html's own tab hashes are
  // compared this way; every other item keeps the filename-only check.
  const currentHash = (window.location.hash || "").replace(/^#/, "");
  if (mainMount) {
    // No section heading above this first block of links (it used to say
    // "Journal" on every page, including ones that live under "More").
    mainMount.innerHTML =
      SIDEBAR_MAIN_ITEMS.map((item) => {
        const hrefFile = normalizeFile(item.href.split("?")[0].split("#")[0]);
        const hrefHash = (item.href.split("#")[1] || "");
        const isActive =
          (hrefFile === currentFile && (hrefFile !== "index" || hrefHash === currentHash)) ||
          (item.extraActiveFiles || []).some((f) => normalizeFile(f) === currentFile);
        return (
          `<a class="nav-item${isActive ? " active" : ""}" href="${item.href}" title="${item.title}">` +
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>` +
          `<span class="nav-label">${item.label}</span>` +
          `</a>`
        );
      }).join("");
  }

  // Shared renderer for the "More" and "Work in Progress" sections --
  // same item shape, same markup, just a different label and list.
  function renderSection(mount, label, items) {
    if (!mount) return;
    mount.innerHTML =
      `<div class="nav-section-label">${label}</div>` +
      items.map((item) => {
        const href = item.href || window.N8N_IMPORT_URL || "import-trades.html";
        const isActive = href !== "#" && normalizeFile(href.split("?")[0]) === currentFile;
        const idAttr = item.id ? ` id="${item.id}"` : "";
        // Every item gets a title tooltip (falling back to its label) so
        // hovering an icon identifies the page even when the sidebar is
        // collapsed and the text label is hidden -- previously only the
        // "Import Trades" item had one, so every other icon was unlabeled
        // once collapsed.
        const titleAttr = ` title="${item.title || item.label}"`;
        return (
          `<a class="nav-item${isActive ? " active" : ""}"${idAttr} href="${href}"${titleAttr}>` +
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>` +
          `<span class="nav-label">${item.label}</span>` +
          `</a>`
        );
      }).join("");
  }
  renderSection(moreMount, "More", SIDEBAR_MORE_ITEMS);
  renderSection(wipMount, "Work in Progress", SIDEBAR_WIP_ITEMS);

  // Pinned Accounts/Settings group. Created here (not hand-written into
  // every page's sidebar markup) and placed as a sibling of .sidebar-nav,
  // so it stays pinned at the bottom while the nav above scrolls, and the
  // SPA router (which only rewrites .sidebar-bottom's children) never
  // wipes it.
  var sidebarEl = document.getElementById("sidebar");
  if (sidebarEl) {
    var pinned = document.getElementById("sidebar-pinned-section");
    if (!pinned) {
      pinned = document.createElement("div");
      pinned.id = "sidebar-pinned-section";
      pinned.className = "sidebar-pinned";
      var bottom = sidebarEl.querySelector(".sidebar-bottom");
      sidebarEl.insertBefore(pinned, bottom || null);
    }
    pinned.innerHTML = SIDEBAR_PINNED_ITEMS.map((item) => {
      const isActive = normalizeFile(item.href.split("?")[0].split("#")[0]) === currentFile;
      return (
        `<a class="nav-item${isActive ? " active" : ""}" href="${item.href}" title="${item.title || item.label}">` +
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>` +
        `<span class="nav-label">${item.label}</span>` +
        `</a>`
      );
    }).join("");
  }

  // The shell (this nav + the topbar/page skeleton around it) is now
  // fully in place -- fade out the top progress bar and the full-screen
  // loading screen from common.css together. Data inside the page may
  // still be fetching, but that's this page's own "Loading…"
  // placeholder to show, not this bar/overlay's job.
  //
  // Both elements are only *hidden* here (the "done" class), never
  // removed from the document. page-transition.js re-arms them the
  // instant someone clicks a link to leave this page -- if they'd been
  // torn out of the DOM already (as an earlier version of this file
  // did, via removeChild on a timeout), that re-arm would be flipping
  // a class on a detached node nobody can see, and the departing page
  // would flash its raw content with nothing covering it right up
  // until the browser actually unloads it. Leaving them in place is
  // what makes them reusable for that split second.
  var bar = document.getElementById("page-progress-bar");
  var loader = document.getElementById("page-loader-overlay");
  requestAnimationFrame(function () {
    if (bar) bar.classList.add("done");
    if (loader) loader.classList.add("done");
  });
  } // end renderNav()

  // ---- Phone bottom tab bar ------------------------------------------
  // The sidebar is a hidden drawer on phones, so every page change cost
  // two taps (hamburger, then link). This is a thumb-reach tab bar: four
  // pages the person picks (defaults below), Search, and "More", which
  // opens that same drawer -- five slots in all, so nothing is cramped. It's hidden above 760px by
  // CSS (.bottom-nav), so desktop is unchanged.
  //
  // The four tabs are stored per device in localStorage (a phone's tab bar
  // is a per-device choice, and the bar has to render synchronously on
  // load, before any network-backed store could answer).
  const TABS_KEY = "trade.log:bottom-tabs";
  const RECENT_KEY = "trade.log:recent-pages";
  const TAB_COUNT = 3;
  const DEFAULT_TABS = ["index", "journal", "daily"];

  // Bar-specific icons for the four default pages (thinner, bar-sized
  // glyphs); every other page falls back to its sidebar icon.
  const BAR_ICONS = {
    index: '<rect x="3" y="3" width="7" height="9" rx="1.5"></rect><rect x="14" y="3" width="7" height="5" rx="1.5"></rect><rect x="14" y="12" width="7" height="9" rx="1.5"></rect><rect x="3" y="16" width="7" height="5" rx="1.5"></rect>',
    journal: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"></path><line x1="9" y1="9" x2="15" y2="9"></line><line x1="9" y1="13" x2="15" y2="13"></line>',
    daily: '<rect x="3" y="4.5" width="18" height="16" rx="2"></rect><line x1="3" y1="9.5" x2="21" y2="9.5"></line><line x1="8" y1="2.5" x2="8" y2="6.5"></line><line x1="16" y1="2.5" x2="16" y2="6.5"></line>',
    practice: '<polyline points="3 17 9 11 13 15 21 7"></polyline><polyline points="15 7 21 7 21 13"></polyline>',
  };
  BAR_ICONS["index#dayview"] = '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline>';
  const BAR_LABELS = { index: "Home" };
  // Seven slots share a 360-390px bar, so long names get a short form there
  // (the editor and the Recent list keep the full name).
  const BAR_SHORT = {
    "index#dayview": "Day", "stats": "Stats", "edge-analysis": "Edge", "live-trading": "Live",
    "backtester": "Backtest", "calculator": "Calc", "import-trades": "Import",
  };

  function fileOf(href) {
    return String(href || "").split("?")[0].split("#")[0].replace(/\.html$/, "").toLowerCase();
  }
  // Every page that can go on the bar or show up under "Recent", built from
  // the sidebar lists above so a page added there is available here too.
  // Day View / Reports live on index.html behind a #hash, so they are keyed
  // as "index#dayview" / "index#reports" and compared by hash. Import Trades
  // is left out (its target is configurable and may be external).
  const CATALOG = (function () {
    const out = [];
    const seen = {};
    [SIDEBAR_MAIN_ITEMS, SIDEBAR_MORE_ITEMS, SIDEBAR_WIP_ITEMS, SIDEBAR_PINNED_ITEMS].forEach((list) => {
      list.forEach((item) => {
        if (!item.href) return;
        const hash = item.href.split("#")[1] || "";
        const file = fileOf(item.href);
        const id = hash ? file + "#" + hash : file;
        if (seen[id]) return;
        seen[id] = true;
        out.push({
          id: id, file: file, hash: hash, href: item.href,
          label: BAR_LABELS[id] || item.label,
          short: BAR_SHORT[id] || BAR_LABELS[id] || item.label,
          icon: BAR_ICONS[id] || item.icon,
          extra: (item.extraActiveFiles || []).map(fileOf),
        });
      });
    });
    return out;
  })();
  function catalogItem(id) {
    for (let i = 0; i < CATALOG.length; i++) if (CATALOG[i].id === id) return CATALOG[i];
    return null;
  }
  // Which catalog entry is the page on screen right now.
  function currentId() {
    let file = "index";
    try { file = decodeURIComponent(location.pathname.split("/").pop() || "index").toLowerCase().replace(/\.html$/, "") || "index"; } catch (e) { /* keep default */ }
    const hash = (location.hash || "").replace(/^#/, "");
    if (file === "index" && (hash === "dayview" || hash === "reports")) return "index#" + hash;
    for (let i = 0; i < CATALOG.length; i++) {
      if (CATALOG[i].file === file && !CATALOG[i].hash) return CATALOG[i].id;
      if (CATALOG[i].extra.indexOf(file) !== -1) return CATALOG[i].id;
    }
    return null;
  }

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; }
  }
  function writeJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* private mode -- just won't persist */ }
  }
  function getTabs() {
    const saved = readJson(TABS_KEY);
    if (Array.isArray(saved)) {
      const ok = saved.filter((id, i) => catalogItem(id) && saved.indexOf(id) === i);
      // The bar used to hold four tabs (plus a centre "+"); keep the first
      // three of an older saved layout rather than throwing it away.
      if (ok.length >= TAB_COUNT) return ok.slice(0, TAB_COUNT);
    }
    return DEFAULT_TABS.slice();
  }
  function setTabs(ids) {
    const same = ids.length === DEFAULT_TABS.length && ids.every((id, i) => id === DEFAULT_TABS[i]);
    if (same) { try { localStorage.removeItem(TABS_KEY); } catch (e) { /* ignore */ } } else writeJson(TABS_KEY, ids);
  }

  const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  function tabLinkHtml(i) {
    return `<a class="bn-item" data-id="${i.id}" href="${i.href}">${SVG_OPEN}${i.icon}</svg><span>${i.short}</span></a>`;
  }
  const SEARCH_GLYPH = '<circle cx="10.5" cy="10.5" r="6.5"></circle><line x1="20" y1="20" x2="15.3" y2="15.3"></line>';

  function paintTabs(nav) {
    const items = getTabs().map(catalogItem);
    nav.innerHTML =
      items.map(tabLinkHtml).join("") +
      `<button type="button" class="bn-item" id="bn-search" aria-label="Search">${SVG_OPEN}${SEARCH_GLYPH}</svg><span>Search</span></button>` +
      `<button type="button" class="bn-item" id="bn-more" aria-label="More pages"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"></line><line x1="4" y1="12" x2="20" y2="12"></line><line x1="4" y1="17" x2="20" y2="17"></line></svg><span>More</span></button>`;
  }

  function bottomNav() {
    if (!document.getElementById("sidebar")) return; // not an app-shell page (login etc.)
    let nav = document.getElementById("bottom-nav");
    if (!nav) {
      nav = document.createElement("nav");
      nav.id = "bottom-nav";
      nav.className = "bottom-nav";
      nav.setAttribute("aria-label", "Primary");
      paintTabs(nav);
      document.body.appendChild(nav);
      // Delegated, so the buttons keep working when the tabs are repainted.
      nav.addEventListener("click", (e) => {
        if (e.target.closest("#bn-search")) {
          if (window.GlobalSearch) window.GlobalSearch.toggle();
        } else if (e.target.closest("#bn-more")) {
          const btn = document.getElementById("mobile-nav-btn");
          if (btn) btn.click();
        }
      });
      // Press and hold any tab to rearrange the bar.
      let holdTimer = null;
      const cancelHold = () => { clearTimeout(holdTimer); holdTimer = null; };
      nav.addEventListener("touchstart", (e) => {
        if (!e.target.closest("a.bn-item")) return;
        cancelHold();
        holdTimer = setTimeout(() => { holdTimer = null; editTabs(); }, 550);
      }, { passive: true });
      ["touchend", "touchmove", "touchcancel"].forEach((t) => nav.addEventListener(t, cancelHold, { passive: true }));
      nav.addEventListener("contextmenu", (e) => { if (e.target.closest("a.bn-item")) e.preventDefault(); });
    }
    const cur = currentId();
    nav.querySelectorAll("a.bn-item").forEach((a) => {
      const on = a.getAttribute("data-id") === cur;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }

  // ---- Recent pages (phone drawer) -------------------------------------
  // The last few pages visited, pinned above the drawer's scrolling list so
  // getting back to one does not mean scrolling the whole sidebar. Pages
  // that already have a tab are left out (they are one tap away anyway), and
  // so is the page you are on.
  const RECENT_KEEP = 8;
  const RECENT_SHOW = 2;
  function trackRecent() {
    if (!document.getElementById("sidebar")) return;
    const id = currentId();
    if (!id) return;
    const list = (readJson(RECENT_KEY) || []).filter((x) => typeof x === "string" && x !== id);
    list.unshift(id);
    writeJson(RECENT_KEY, list.slice(0, RECENT_KEEP));
  }
  function renderRecent() {
    const sidebarEl = document.getElementById("sidebar");
    if (!sidebarEl) return;
    let box = document.getElementById("sidebar-recent-section");
    if (!box) {
      box = document.createElement("div");
      box.id = "sidebar-recent-section";
      box.className = "sidebar-recent";
      // A sibling ahead of .sidebar-nav (like the pinned group), so the SPA
      // router's rewrite of the nav's contents never wipes it.
      sidebarEl.insertBefore(box, sidebarEl.querySelector(".sidebar-nav") || null);
    }
    const cur = currentId();
    const tabs = getTabs();
    const items = (readJson(RECENT_KEY) || [])
      .filter((id) => id !== cur && tabs.indexOf(id) === -1)
      .map(catalogItem).filter(Boolean).slice(0, RECENT_SHOW);
    box.hidden = !items.length;
    box.innerHTML = items.length
      ? `<div class="nav-section-label">Recent</div><div class="sidebar-recent-list">` +
        items.map((i) =>
          `<a class="recent-item" href="${i.href}" title="${i.label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${i.icon}</svg><span>${i.label}</span></a>`
        ).join("") + `</div>`
      : "";
  }

  // ---- Tab editor (bottom sheet) ---------------------------------------
  // Pick exactly three pages. Tapping a page adds it to the end of the bar;
  // tapping it again (or its chip in the preview) removes it, so the order on
  // the bar is the order picked.
  let editor = null;
  function editTabs() {
    if (editor) return;
    let picked = getTabs();
    const backdrop = document.createElement("div");
    backdrop.className = "tabedit-backdrop";
    const sheet = document.createElement("div");
    sheet.className = "tabedit-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Edit tab bar");
    editor = { backdrop: backdrop, sheet: sheet };
    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
    if (typeof window.closeMobileNav === "function") window.closeMobileNav();
    document.documentElement.classList.add("tabedit-open");

    function close() {
      backdrop.remove(); sheet.remove(); editor = null;
      document.documentElement.classList.remove("tabedit-open");
    }
    function svg(icon) {
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
    }
    function paint() {
      const full = picked.length === TAB_COUNT;
      sheet.innerHTML =
        '<div class="tabedit-grab" aria-hidden="true"></div>' +
        '<div class="tabedit-head"><span class="tabedit-title">Edit tab bar</span><button type="button" class="tabedit-x" data-act="close" aria-label="Close">&#10005;</button></div>' +
        `<p class="tabedit-hint">${full ? "Tap a tab below to remove it, or tap a page to swap it in." : `Pick ${TAB_COUNT - picked.length} more page${TAB_COUNT - picked.length === 1 ? "" : "s"}.`}</p>` +
        '<div class="tabedit-preview">' +
        Array.from({ length: TAB_COUNT }, (_, n) => {
          const it = picked[n] ? catalogItem(picked[n]) : null;
          return it
            ? `<button type="button" class="tabedit-slot filled" data-remove="${it.id}" aria-label="Remove ${it.label}">${svg(it.icon)}<span>${it.label}</span></button>`
            : `<div class="tabedit-slot empty"><span>${n + 1}</span></div>`;
        }).join("") +
        '</div>' +
        '<div class="tabedit-list">' +
        CATALOG.map((it) => {
          const n = picked.indexOf(it.id);
          return `<button type="button" class="tabedit-row${n !== -1 ? " on" : ""}" data-pick="${it.id}" aria-pressed="${n !== -1}">${svg(it.icon)}<span class="tabedit-name">${it.label}</span><span class="tabedit-badge">${n !== -1 ? n + 1 : ""}</span></button>`;
        }).join("") +
        '</div>' +
        '<div class="tabedit-foot"><button type="button" class="tabedit-reset" data-act="reset">Reset</button>' +
        `<button type="button" class="tabedit-done" data-act="done"${full ? "" : " disabled"}>Done</button></div>`;
    }
    backdrop.addEventListener("click", close);
    sheet.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-remove]");
      const pk = e.target.closest("[data-pick]");
      const act = e.target.closest("[data-act]");
      if (rm) {
        picked = picked.filter((id) => id !== rm.getAttribute("data-remove"));
      } else if (pk) {
        const id = pk.getAttribute("data-pick");
        if (picked.indexOf(id) !== -1) picked = picked.filter((x) => x !== id);
        else if (picked.length < TAB_COUNT) picked = picked.concat(id);
        else picked = picked.slice(0, TAB_COUNT - 1).concat(id); // full: the newest pick replaces the last tab
      } else if (act) {
        const a = act.getAttribute("data-act");
        if (a === "close") { close(); return; }
        if (a === "reset") picked = DEFAULT_TABS.slice();
        if (a === "done" && picked.length === TAB_COUNT) {
          setTabs(picked);
          const nav = document.getElementById("bottom-nav");
          if (nav) { paintTabs(nav); bottomNav(); }
          renderRecent();
          close();
          return;
        }
      } else return;
      paint();
    });
    document.addEventListener("keydown", function onKey(e) {
      if (!editor) { document.removeEventListener("keydown", onKey); return; }
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });
    paint();
  }
  window.editBottomTabs = editTabs;

  // A "Customize tab bar" row at the foot of the drawer's scrolling list, so
  // the feature can be found without knowing about the long-press.
  function renderEditLink() {
    const sidebarEl = document.getElementById("sidebar");
    if (!sidebarEl) return;
    let btn = document.getElementById("sidebar-edit-tabs");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.id = "sidebar-edit-tabs";
      btn.className = "sidebar-edit-tabs";
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg><span>Customize tab bar</span>';
      btn.addEventListener("click", editTabs);
      const pinned = document.getElementById("sidebar-pinned-section");
      sidebarEl.insertBefore(btn, pinned || sidebarEl.querySelector(".sidebar-bottom") || null);
    }
  }

  // Exposed for the SPA router to call after an in-place content swap.
  function refresh() {
    renderNav();
    bottomNav();
    trackRecent();
    renderRecent();
    renderEditLink();
  }
  window.__renderSidebarNav = refresh;
  refresh();
  // Day View / Reports are hash tabs on index.html, which change without a
  // page load, so keep the bar's highlight in step with them.
  window.addEventListener("hashchange", function () { bottomNav(); trackRecent(); renderRecent(); });
})();
