// mobile-tables.js -- on phones, any table that would scroll sideways is
// turned into stacked cards (label: value pairs) instead.
//
// How it works:
//  1. Every <td> gets a data-label copied from its column header, so the
//     card layout in common.css (table.mt-stack ...) can print "Label" above
//     each value.
//  2. At <=760px, a table inside .table-scroll whose wrapper overflows
//     horizontally gets the .mt-stack class. Tables that already fit stay
//     normal tables. Re-checked on resize/rotate and whenever content changes
//     (new renders, tab switches, SPA page swaps).
//
// Opt a table out with class "no-stack". Tables that already ship their own
// phone layout (journal, scanner, dashboard/day-view trade tables) are skipped.
(function () {
  "use strict";
  var MQ = window.matchMedia ? window.matchMedia("(max-width: 760px)") : { matches: false };
  var SKIP = ".no-stack, .journal-data-table, #sc-table, .tt-recent, .tt-day, .ins-heat, .compare-table, .quiz-review-table";

  function headerLabels(table) {
    var row = table.querySelector("thead tr");
    if (!row) return null;
    var out = [];
    Array.prototype.forEach.call(row.children, function (th) {
      // Journal-style headers hold extra buttons; prefer the real label.
      var el = th.querySelector(".headcell") || th;
      var txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      var span = parseInt(th.getAttribute("colspan") || "1", 10) || 1;
      for (var i = 0; i < span; i++) out.push(txt);
    });
    return out;
  }

  function labelTable(table) {
    var labels = headerLabels(table);
    if (!labels) return;
    Array.prototype.forEach.call(table.querySelectorAll("tbody tr"), function (tr) {
      var cells = tr.children;
      if (!cells.length || cells[0].hasAttribute("data-label")) return; // already done
      if (cells.length !== labels.length) return; // colspan/empty-state rows: leave alone
      Array.prototype.forEach.call(cells, function (td, i) {
        td.setAttribute("data-label", labels[i]);
        if (!(td.textContent || "").trim() && !td.querySelector("input,button,svg,img,a,select")) {
          td.setAttribute("data-empty", "1");
        }
      });
    });
  }

  function evaluate(table) {
    var wrap = table.parentElement;
    if (!wrap || !wrap.classList.contains("table-scroll")) return;
    table.classList.remove("mt-stack");
    if (!MQ.matches) return;
    if (!wrap.clientWidth) return; // hidden (inactive tab) -- re-checked when it gets a size
    if (wrap.scrollWidth > wrap.clientWidth + 1) table.classList.add("mt-stack");
  }

  var widths = typeof WeakMap === "function" ? new WeakMap() : null;
  var ro = typeof ResizeObserver === "function" ? new ResizeObserver(function (entries) {
    entries.forEach(function (en) {
      var w = Math.round(en.contentRect.width);
      if (widths.get(en.target) === w) return; // height-only change (e.g. stacking itself)
      widths.set(en.target, w);
      var t = en.target.querySelector(":scope > table");
      if (t && !t.matches(SKIP)) evaluate(t);
    });
  }) : null;

  // Right-edge fade on any wrapper that still scrolls sideways (heatmaps,
  // comparison tables...) so it's obvious there is more to swipe to.
  function updateFade(wrap) {
    var more = MQ.matches && wrap.clientWidth && wrap.scrollWidth > wrap.clientWidth + 1 &&
      wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 2;
    wrap.classList.toggle("mt-fade-r", !!more);
  }
  function bindFade(wrap) {
    if (wrap.__mtFade) return;
    wrap.__mtFade = true;
    wrap.addEventListener("scroll", function () { updateFade(wrap); }, { passive: true });
  }

  function scan() {
    Array.prototype.forEach.call(document.querySelectorAll(".table-scroll"), function (w) {
      bindFade(w); updateFade(w);
    });
    var tables = document.querySelectorAll(".table-scroll > table");
    Array.prototype.forEach.call(tables, function (table) {
      if (table.matches(SKIP)) return;
      labelTable(table);
      var wrap = table.parentElement;
      if (ro && !wrap.__mtObserved) { wrap.__mtObserved = true; ro.observe(wrap); }
      evaluate(table);
      updateFade(wrap);
    });
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; scan(); });
  }

  function start() {
    scan();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    if (MQ.addEventListener) MQ.addEventListener("change", schedule);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
