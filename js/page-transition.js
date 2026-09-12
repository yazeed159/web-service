// page-transition.js — bridges the gap between one full page load and
// the next so switching pages reads as one continuous transition
// instead of a hard cut to blank/unstyled content.
//
// #page-loader-overlay (see common.css) paints by default, before any
// other JS runs, using the page's own --bg -- so the very first frame
// of any page already matches the "loading" screen of whatever page
// sent you here. This script's only job is to re-arm that overlay the
// instant someone clicks a link that's actually about to leave this
// document (there's no other hook for "about to unload"), so the
// outgoing page shows the same idle screen as the incoming one at the
// exact seam between the two documents. nav-render.js fades it back
// out once the next page's shell (sidebar/topbar) is actually ready.
(function () {
  "use strict";

  var overlay = document.getElementById("page-loader-overlay");
  if (!overlay) return;

  function showLoader() {
    overlay.classList.remove("done");
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
      // so there's nothing here for the loader to bridge.
      if (url.pathname === window.location.pathname && url.hash) return;

      showLoader();
    },
    true
  );

  // A back/forward navigation can restore this exact document from the
  // browser's bfcache mid-fade from whenever the loader was last shown
  // -- make sure a restored page always comes back clear instead of
  // possibly stuck on the loading screen.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) overlay.classList.add("done");
  });
})();
