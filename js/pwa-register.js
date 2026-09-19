// Registers the service worker (sw.js) that gives the site its instant,
// cache-backed page loads. Safe to load on every page; no-ops where
// service workers aren't available (e.g. plain http on a non-localhost host).
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function (err) {
      console.warn("service worker registration failed:", err);
    });
  });
})();
