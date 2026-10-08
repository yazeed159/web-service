// Registers the service worker (sw.js) and keeps the installed app current.
// Safe to load on every page; no-ops where service workers aren't available.
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;
  // Only auto-reload when an EXISTING worker is replaced (an update), not on first install.
  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController || reloading) return;
    // Don't yank the page out from under a fullscreen chart or a focused field.
    var busy = document.documentElement.classList.contains("chart-fs-lock") ||
      (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName));
    if (busy) { window.addEventListener("pagehide", function () {}, { once: true }); return; }
    reloading = true;
    window.location.reload();
  });
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      function check() { try { reg.update(); } catch (e) {} }
      // An installed PWA is resumed, not reloaded: re-check whenever it comes back to the foreground.
      document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") check(); });
      window.addEventListener("focus", check);
      setInterval(check, 30 * 60 * 1000);
    }).catch(function (err) {
      console.warn("service worker registration failed:", err);
    });
  });
})();
