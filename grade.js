// grade.js — self-graded execution-quality rating for a trade (1-5
// stars), completely separate from win/loss (a trade can be a winner
// with sloppy execution, or a loser that was played exactly to plan).
//
// Schema: `grade` (integer 1-5, optional) on both the data/trades.json
// index row and the data/trades/<id>.json detail file -- same "flat
// optional field, missing = no data yet" pattern as sector/country and
// the avg_volume_tag/rvol_tag/float_tag trio. See README's Data Schema
// section.
//
// Unlike those fields, `grade` isn't produced by chart_service.py or the
// vision LLM -- it's the trader's own after-the-fact call on how well
// *they* executed, so nothing in the pipeline can fill it in for you.
// Until the publish step is wired to persist it (a manual field on
// import, or a future small n8n form), this file lets you self-grade
// right in the dashboard: grades set here are kept in localStorage,
// per-browser, keyed by trade id -- same tradeoff as everywhere else in
// this app that stores something client-side (practice account balance,
// rewind session history): it's not synced to GitHub Pages or visible
// on another device, but it works today with zero backend changes. Once
// a trade row/detail file actually has a numeric `grade` on it, that
// value wins over the local one everywhere in this file.
(function () {
  "use strict";
  const STORAGE_KEY = "trade.log:grades"; // { [tradeId]: 1-5 }
  const STAR_COLOR = "#e8a94c";
  const EMPTY_COLOR = "var(--border, #2a2f38)";
  const LABELS = { 1: "Poor execution", 2: "Below plan", 3: "On plan", 4: "Clean", 5: "Flawless" };

  function clamp(g) {
    const n = Math.round(Number(g));
    return n >= 1 && n <= 5 ? n : null;
  }

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch (e) { return {}; }
  }
  function writeStore(store) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* ignore -- self-grading just won't persist this session */ }
  }

  // Resolves the effective grade for a trade row (index or detail --
  // both use the same flat `grade` field): the published field wins when
  // present, since that's the durable value the pipeline would own once
  // it's wired up; the local self-grade is the fallback for today.
  function get(trade) {
    if (!trade) return null;
    const published = clamp(trade.grade);
    if (published) return published;
    return getById(trade.id);
  }
  function getById(id) {
    const store = readStore();
    return clamp(store[id]);
  }
  // grade: 1-5, or null/0 to clear. No-op if trade.id is missing.
  function set(tradeId, grade) {
    if (!tradeId) return;
    const store = readStore();
    const g = clamp(grade);
    if (g === null) delete store[tradeId];
    else store[tradeId] = g;
    writeStore(store);
  }
  function label(grade) {
    return LABELS[clamp(grade)] || "";
  }

  // Renders a 5-star row. Pass interactive:true + a tradeId to make it
  // clickable (see attachInteractive) -- otherwise it's a plain readonly
  // display, safe to drop into a table cell.
  function starsHtml(grade, opts) {
    opts = opts || {};
    const g = clamp(grade) || 0;
    const size = opts.size || 15;
    let html = `<span class="grade-stars${opts.interactive ? " interactive" : ""}" style="display:inline-flex; gap:1px; ${opts.interactive ? "cursor:pointer;" : ""}" title="${g ? escapeAttr(label(g) + " (" + g + "/5)") : "Not graded"}">`;
    for (let i = 1; i <= 5; i++) {
      html += `<span class="grade-star" data-star="${i}" style="font-size:${size}px; line-height:1; color:${i <= g ? STAR_COLOR : EMPTY_COLOR}; transition:color .1s;">★</span>`;
    }
    html += `</span>`;
    return html;
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, "&quot;");
  }

  // Wires click/hover onto a container that already has starsHtml()
  // inside it. Clicking the star matching the current grade clears it
  // (toggle-off, same as most star-rating widgets); clicking any other
  // star sets it and persists immediately. onChange(newGradeOrNull) runs
  // after every change so the caller can refresh anything else on the
  // page that depends on the grade (e.g. a "graded" pill).
  function attachInteractive(container, tradeId, currentGrade, onChange) {
    const wrap = container.querySelector(".grade-stars");
    if (!wrap) return;
    let current = clamp(currentGrade);
    function paint(g) {
      wrap.querySelectorAll(".grade-star").forEach((s) => {
        const i = Number(s.getAttribute("data-star"));
        s.style.color = g && i <= g ? STAR_COLOR : EMPTY_COLOR;
      });
      wrap.title = g ? label(g) + " (" + g + "/5)" : "Not graded — click to rate";
    }
    wrap.querySelectorAll(".grade-star").forEach((s) => {
      const i = Number(s.getAttribute("data-star"));
      s.addEventListener("mouseenter", () => paint(i));
      s.addEventListener("click", (e) => {
        e.preventDefault();
        const next = current === i ? null : i;
        current = next;
        set(tradeId, next);
        paint(next);
        if (typeof onChange === "function") onChange(next);
      });
    });
    wrap.addEventListener("mouseleave", () => paint(current));
  }

  // Pearson correlation coefficient between grade and P&L across a set
  // of trades -- used by stats.html's Grade vs P&L panel. Only trades
  // with both a resolved grade and a numeric pnl_after_comm count.
  // Returns null when there isn't enough spread to compute one (fewer
  // than 2 graded trades, or every graded trade has the same grade).
  function correlationWithPnl(rows) {
    const pairs = rows
      .map((r) => [get(r), r.pnl_after_comm])
      .filter(([g, p]) => g !== null && typeof p === "number");
    const n = pairs.length;
    if (n < 2) return null;
    const gs = pairs.map((p) => p[0]), ps = pairs.map((p) => p[1]);
    const gMean = gs.reduce((s, v) => s + v, 0) / n;
    const pMean = ps.reduce((s, v) => s + v, 0) / n;
    let num = 0, gVar = 0, pVar = 0;
    for (let i = 0; i < n; i++) {
      const dg = gs[i] - gMean, dp = ps[i] - pMean;
      num += dg * dp; gVar += dg * dg; pVar += dp * dp;
    }
    if (gVar === 0 || pVar === 0) return null;
    return num / Math.sqrt(gVar * pVar);
  }

  window.TradeGrade = { get, getById, set, label, starsHtml, attachInteractive, correlationWithPnl, LABELS };
})();
