// nav-render.js — renders the sidebar's Journal/More nav links and
// highlights the active page.
//
// Split out of common.js and loaded right after the sidebar markup
// (instead of at the bottom of the page with the rest of common.js).
// The mount points (#sidebar-main-section / #sidebar-more-section) used
// to sit empty until common.js ran as the very last <script> on the
// page -- on any page with a lot of markup/inline scripts above it,
// that meant a visibly empty nav (just the logo, no links) for a beat
// on every single page load, which on top of the full page navigation
// browsers already do made every click look like it had landed on a
// broken/different site. Running this immediately after the sidebar's
// HTML exists removes that gap entirely -- the nav is complete before
// the browser even gets to the rest of the page.
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

  const mainMount = document.getElementById("sidebar-main-section");
  const moreMount = document.getElementById("sidebar-more-section");
  if (!mainMount && !moreMount) return; // page has no app-shell sidebar, or hasn't adopted the mount points yet

  // The active item is whichever page we're actually on -- compared by
  // filename only (not the full href), since deep links can carry a
  // hash or query string (e.g. a filtered edge-analysis.html?setup=...).
  // Normalized (decoded + lowercased + trailing-slash-stripped) so a
  // trailing slash, URL-encoded character, or case difference from how
  // a link/bookmark was typed doesn't silently break the match.
  function normalizeFile(name) {
    try {
      return decodeURIComponent(name || "").toLowerCase().replace(/\/+$/, "");
    } catch (e) {
      return String(name || "").toLowerCase();
    }
  }
  const currentFile = normalizeFile(window.location.pathname.split("/").pop()) || "index.html";

  if (mainMount) {
    mainMount.innerHTML =
      '<div class="nav-section-label">Journal</div>' +
      SIDEBAR_MAIN_ITEMS.map((item) => {
        const hrefFile = normalizeFile(item.href.split("?")[0].split("#")[0]);
        const isActive =
          hrefFile === currentFile ||
          (item.extraActiveFiles || []).some((f) => normalizeFile(f) === currentFile);
        return (
          `<a class="nav-item${isActive ? " active" : ""}" href="${item.href}" title="${item.title}">` +
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>` +
          `<span class="nav-label">${item.label}</span>` +
          `</a>`
        );
      }).join("");
  }

  if (moreMount) {
    moreMount.innerHTML =
      '<div class="nav-section-label">More</div>' +
      SIDEBAR_MORE_ITEMS.map((item) => {
        const isActive = item.href !== "#" && normalizeFile(item.href.split("?")[0]) === currentFile;
        const idAttr = item.id ? ` id="${item.id}"` : "";
        // Every item gets a title tooltip (falling back to its label) so
        // hovering an icon identifies the page even when the sidebar is
        // collapsed and the text label is hidden -- previously only the
        // "Import Trades" item had one, so every other icon was unlabeled
        // once collapsed.
        const titleAttr = ` title="${item.title || item.label}"`;
        return (
          `<a class="nav-item${isActive ? " active" : ""}"${idAttr} href="${item.href}"${titleAttr}>` +
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${item.icon}</svg>` +
          `<span class="nav-label">${item.label}</span>` +
          `</a>`
        );
      }).join("");
  }

  // The shell (this nav + the topbar/page skeleton around it) is now
  // fully in place -- fade out the "page is loading" bar from
  // common.css. Data inside the page may still be fetching, but that's
  // this page's own "Loading…" placeholder to show, not this bar's job.
  var bar = document.getElementById("page-progress-bar");
  if (bar) {
    requestAnimationFrame(function () {
      bar.classList.add("done");
      setTimeout(function () {
        if (bar.parentNode) bar.parentNode.removeChild(bar);
      }, 300);
    });
  }
})();
