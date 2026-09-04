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
