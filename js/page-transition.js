// page-transition.js — lightweight SPA router for a subset of pages,
// full-page-navigation bridge for everything else.
//
// Two tiers of navigation live here:
//
// 1. SPA_PAGES (below): the click is intercepted, the destination is
//    fetched as plain HTML, and only the page's OWN content is swapped
//    in -- the sidebar, topbar (including global-search.js's injected
//    search box), loader overlay, and floating chat widget are never
//    touched. No document unload, no blank-white gap, no refetching
//    common.css/fonts. This is what actually removes the flicker.
//
// 2. Every other link: unchanged from before -- a normal full page
//    load, with the loader overlay/progress bar re-armed on click so
//    the outgoing and incoming page both show the same idle screen at
//    the seam (see common.css's "Full-screen loading screen" comment).
//
// Deliberately NOT in SPA_PAGES: stats.html / edge-analysis.html
// (own a lightweight-charts equity/price chart instance),
// backtester.html / rewind.html / practice.html / trade.html (chart +
// canvas), live-trading.html (polling), scanner.html, import-trades.html
// (polls an in-progress import with setInterval). None of those have
// been taught to tear down their chart instance / interval / observer
// before their DOM is replaced -- doing that blind, without a live
// browser + real backend to test against, risks a chart or a poll
// loop that keeps running invisibly against a page that's no longer
// on screen. Moving one of those into SPA_PAGES later means auditing
// that page's own script for exactly that first, then giving it a
// window.__pageTeardown() the swap can call before it goes.
(function () {
  "use strict";

  var overlay = document.getElementById("page-loader-overlay");
  var bar = document.getElementById("page-progress-bar");
  if (!overlay && !bar) return;

  // Keyed by the normalized destination filename (see normalizeFile
  // below -- matches with or without ".html", so it works whether the
  // link/URL is "journal.html" or the clean "/journal" the Worker
  // actually serves in production).
  //
  //   shared: utility scripts this page needs that are safe to load
  //   ONCE and never touch again (they expose an API / render on
  //   demand -- e.g. window.TradeGrade, window.UIModal -- rather than
  //   binding to specific DOM elements at load time). Injected only if
  //   not already present, so visiting these pages in a different
  //   order than usual (e.g. landing on Settings first) still works.
  //
  //   owned: this page's OWN script(s) -- always given a fresh
  //   <script> element on every visit, because their init code has to
  //   run again against the freshly-swapped DOM (the browser only
  //   RE-EXECUTES a script when a new element for it is inserted; it
  //   won't re-run just because the URL matches one already on the
  //   page). Same-URL re-insertion still comes out of the browser's
  //   HTTP cache, so this doesn't mean a fresh network request.
  //
  // Each page's inline <script> block(s) (if any) are handled
  // automatically below -- always re-run, in document order, no need
  // to list them here.
  var SPA_PAGES = {
    index: { shared: ["js/grade.js"], owned: ["js/app.js"] },
    journal: { shared: ["js/grade.js"], owned: ["js/share-export.js"] },
    patterns: { shared: [], owned: [] },
    calculator: { shared: [], owned: ["js/calculator.js"] },
    settings: { shared: ["js/ui-modal.js"], owned: [] }
  };

  function normalizeFile(name) {
    try {
      return decodeURIComponent(name || "").toLowerCase().replace(/\/+$/, "").replace(/\.html$/, "");
    } catch (e) {
      return String(name || "").toLowerCase().replace(/\.html$/, "");
    }
  }
  function keyFor(pathname) {
    return normalizeFile(pathname.split("/").pop()) || "index";
  }

  function showLoader() {
    // Both re-shows happen with transitions/animations forced off and
    // a synchronous reflow in between, so the "covered" state is what
    // paints on the very next frame -- not something that eases in
    // over a couple hundred ms while the page underneath is still
    // visible and about to be torn down anyway.
    if (overlay) {
      overlay.style.transition = "none";
      overlay.classList.remove("done");
      void overlay.offsetHeight;
      overlay.style.transition = "";
    }
    if (bar) {
      bar.classList.remove("done");
      bar.style.animation = "none";
      void bar.offsetWidth;
      bar.style.animation = "";
    }
  }

  function hideLoader() {
    if (window.__renderSidebarNav) {
      // nav-render.js's tail is what normally fades these back out
      // once a fresh page's shell is ready -- reuse the exact same
      // path here instead of duplicating its fade timing.
      window.__renderSidebarNav();
    } else {
      if (bar) bar.classList.add("done");
      if (overlay) overlay.classList.add("done");
    }
  }

  function loadScriptOnce(src) {
    if (document.querySelector('script[src="' + src + '"]')) return Promise.resolve();
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = resolve; // one missing/broken utility shouldn't stall the whole swap
      document.body.appendChild(s);
    });
  }

  function loadScriptFresh(src) {
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = resolve;
      document.body.appendChild(s);
    });
  }

  // Runs a page's scripts against the DOM that was just swapped in:
  // shared utilities first (only if missing), then this page's own
  // external script(s) in order, then its inline block(s) in order.
  function runPageScripts(cfg, newDoc) {
    var chain = Promise.resolve();
    (cfg.shared || []).forEach(function (src) {
      chain = chain.then(function () { return loadScriptOnce(src); });
    });
    (cfg.owned || []).forEach(function (src) {
      chain = chain.then(function () { return loadScriptFresh(src); });
    });
    return chain.then(function () {
      var inline = newDoc.querySelectorAll("body > script:not([src])");
      inline.forEach(function (old) {
        var s = document.createElement("script");
        s.textContent = old.textContent;
        document.body.appendChild(s);
      });
    });
  }

  // Swaps in the new page's content while leaving the topbar element
  // itself in place (only its #page-title text changes) -- the topbar
  // is where global-search.js self-mounts its search box exactly
  // once, on first load. Replacing the whole topbar element on every
  // navigation would take that search box with it, since it's DOM
  // that script injected, not markup that exists in the raw HTML.
  function swapContent(newDoc) {
    var curMain = document.querySelector(".main");
    var newMain = newDoc.querySelector(".main");
    if (!curMain || !newMain) throw new Error("no .main to swap");

    var curTopbar = curMain.querySelector(".topbar");
    var newTitleEl = newMain.querySelector("#page-title");
    if (curTopbar && newTitleEl) {
      var curTitleEl = curTopbar.querySelector("#page-title");
      if (curTitleEl) curTitleEl.textContent = newTitleEl.textContent;
    }

    Array.prototype.slice.call(curMain.children).forEach(function (el) {
      if (el !== curTopbar) el.remove();
    });
    Array.prototype.slice.call(newMain.children).forEach(function (el) {
      if (!el.classList || !el.classList.contains("topbar")) {
        curMain.appendChild(document.importNode(el, true));
      }
    });
  }

  function swapTo(url, cfg, push) {
    showLoader();
    fetch(url.href, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("bad response");
        return res.text();
      })
      .then(function (html) {
        var newDoc = new DOMParser().parseFromString(html, "text/html");
        if (push) history.pushState({ spa: true }, "", url.href);
        document.title = newDoc.title || document.title;
        swapContent(newDoc);
        return runPageScripts(cfg, newDoc);
      })
      .then(function () {
        window.scrollTo(0, 0);
        if (window.__rebootDecor) window.__rebootDecor();
        hideLoader();
      })
      .catch(function () {
        // Any failure (network, parse, missing .main) falls back to a
        // real navigation instead of leaving the page stuck mid-swap.
        window.location.href = url.href;
      });
  }

  document.addEventListener(
    "click",
    function (e) {
      if (e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      var a = e.target.closest("a");
      if (!a || !a.getAttribute("href")) return;
      if (a.target && a.target !== "_self") return;
      if (a.hasAttribute("download")) return;

      var href = a.getAttribute("href");
      if (
        href.charAt(0) === "#" ||
        href.indexOf("javascript:") === 0 ||
        href.indexOf("mailto:") === 0 ||
        href.indexOf("tel:") === 0
      ) {
        return;
      }

      var url;
      try {
        url = new URL(a.href, window.location.href);
      } catch (err) {
        return;
      }
      if (url.origin !== window.location.origin) return;

      // A same-document hash jump (in-page anchors, or the hash-based
      // tab switching some pages do in JS) never unloads this page,
      // so there's nothing here for the loader/router to bridge.
      if (url.pathname === window.location.pathname && url.hash) return;

      var cfg = SPA_PAGES[keyFor(url.pathname)];
      if (cfg) {
        e.preventDefault();
        swapTo(url, cfg, true);
        return;
      }

      showLoader();
    },
    true
  );

  // Back/forward between two SPA-swapped entries replays the same
  // in-place swap; anything else (e.g. the entry predates this page's
  // own load, or points at a non-SPA page) falls back to a real
  // reload, since there's no fetched document to diff against here.
  window.addEventListener("popstate", function (e) {
    var cfg = SPA_PAGES[keyFor(window.location.pathname)];
    if (cfg && e.state && e.state.spa) {
      swapTo(new URL(window.location.href), cfg, false);
    } else {
      window.location.reload();
    }
  });

  // A back/forward navigation can restore this exact document from the
  // browser's bfcache mid-fade from whenever the loader was last shown
  // -- make sure a restored page always comes back clear instead of
  // possibly stuck on the loading screen.
  window.addEventListener("pageshow", function (e) {
    if (!e.persisted) return;
    if (overlay) overlay.classList.add("done");
    if (bar) bar.classList.add("done");
  });
})();
