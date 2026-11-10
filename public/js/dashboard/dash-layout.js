// dash-layout.js -- Customize dashboard: choose which sections show, and in what order.
//
// The dashboard used to put everything in front of you at once. A "Customize" button in the topbar
// (dashboard tab only) opens a sheet with one row per section: an on/off switch and up/down arrows.
// Changes apply straight away and are remembered on this device (localStorage, so there's no flash of
// the old layout on load). "Calm" is a one-tap preset that keeps the essentials.
//
// How it works: index.html tags each section with data-dash-unit (a block that can move) or
// data-dash-part (one half of the Form guide / This month row, which move together). We only ever
// set CSS `order` on the units and toggle a hidden flag -- no nodes are moved, so every renderer that
// looks things up by id keeps working. #tab-dashboard is a flex column, which is what makes `order` work.
(function () {
  "use strict";
  const KEY = "tl:dash-layout:v1";
  const UNITS = ["hero", "kpis", "pair", "equity", "recent", "today"];          // default top-to-bottom order
  // Every switchable row. `unit` is what actually moves; the two `pair` rows share one position.
  const ITEMS = [
    { id: "hero", unit: "hero", name: "Net P&L", note: "The big number at the top" },
    { id: "kpis", unit: "kpis", name: "Key numbers", note: "Win rate, profit factor, average win and loss" },
    { id: "form", unit: "pair", name: "Form guide", note: "Streak and recent trade results" },
    { id: "month", unit: "pair", name: "This month", note: "Mini calendar", beside: true },
    { id: "equity", unit: "equity", name: "Equity curve", note: "Balance over time" },
    { id: "recent", unit: "recent", name: "Recent trades", note: "Your last few trades" },
    { id: "today", unit: "today", name: "Today's notes", note: "Plan and notes for the day" },
  ];
  const CALM_HIDDEN = ["form", "month", "recent"];
  // Looks (css/skins.css). `dots` are a bg / panel / accent preview for the chip.
  const SKINS = [
    { id: "pro", name: "Pro", note: "Graphite and blue, Inter", dots: ["#0d1014", "#1a1f27", "#5b9bff"] },
    { id: "navy", name: "Navy", note: "Deep navy, IBM Plex, monospace figures", dots: ["#0a1322", "#152642", "#5b8cff"] },
    { id: "mono", name: "Mono", note: "Black and white, Geist", dots: ["#0a0a0a", "#181818", "#f2f2f2"] },
    { id: "terminal", name: "Terminal", note: "Amber on black, all monospace", dots: ["#080808", "#151513", "#ffb000"] },
    { id: "verde", name: "Verde", note: "Fintech green, rounder", dots: ["#0b1210", "#172420", "#2fd18a"] },
    { id: "indigo", name: "Indigo", note: "Deep indigo, Linear-style", dots: ["#0e0f1a", "#1c1e31", "#7c7fff"] },
    { id: "paper", name: "Paper", note: "Warm cream, editorial serif", dots: ["#1b1916", "#292520", "#e8dcc3"] },
    { id: "ocean", name: "Ocean", note: "Deep teal and cyan", dots: ["#07151a", "#11292f", "#22c6d8"] },
    { id: "rose", name: "Rosé", note: "Plum and pink, very round", dots: ["#150b12", "#2a1722", "#ff7eb0"] },
    { id: "ember", name: "Ember", note: "Warm brown, orange, mono figures", dots: ["#120d09", "#231a12", "#ff8a2a"] },
    { id: "broadsheet", name: "Broadsheet", note: "A different layout: top masthead, one column, newspaper rules", dots: ["#f7f4ec", "#15130f", "#a8321f"] },
    { id: "ink", name: "Ink & brass", note: "Teal ink, brass accent, serif titles", dots: ["#0b1315", "#172428", "#e3b04b"] },
  ];
  const SKIN_KEY = "trade.log:skin";
  const curSkin = () => document.documentElement.getAttribute("data-skin") || "pro";
  function setSkin(id) {
    document.documentElement.setAttribute("data-skin", id);
    try { localStorage.setItem(SKIN_KEY, id); } catch (e) { /* ignore */ }
  }

  const tab = document.getElementById("tab-dashboard");
  if (!tab) return;

  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { /* ignore */ }
    const order = raw && Array.isArray(raw.order) ? raw.order.filter((u) => UNITS.includes(u)) : [];
    UNITS.forEach((u) => { if (!order.includes(u)) order.push(u); });   // new sections land at their default spot
    const ids = ITEMS.map((i) => i.id);
    const hidden = raw && Array.isArray(raw.hidden) ? raw.hidden.filter((h) => ids.includes(h)) : [];
    return { order, hidden };
  }
  let state = load();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ } }

  // ---- apply the layout to the page ----
  const note = document.createElement("div");
  note.className = "dash-hidden-note";
  note.style.order = "99";
  tab.appendChild(note);

  function apply() {
    state.order.forEach((u, i) => {
      const el = tab.querySelector('[data-dash-unit="' + u + '"]');
      if (el) el.style.order = String(10 + i);
    });
    const hide = (el, on) => { if (el) el.toggleAttribute("data-dash-hidden", on); };
    ["hero", "kpis", "equity", "recent", "today"].forEach((u) => hide(tab.querySelector('[data-dash-unit="' + u + '"]'), state.hidden.includes(u)));
    const form = tab.querySelector('[data-dash-part="form"]'), month = tab.querySelector('[data-dash-part="month"]');
    const hf = state.hidden.includes("form"), hm = state.hidden.includes("month");
    hide(form, hf); hide(month, hm);
    const pair = tab.querySelector('[data-dash-unit="pair"]');
    hide(pair, hf && hm);
    if (pair) pair.classList.toggle("dash-one", hf !== hm);   // one card left -> let it use the full width
    const n = state.hidden.length;
    note.innerHTML = n ? n + (n === 1 ? " section is" : " sections are") + ' hidden. <button type="button" class="dash-hidden-btn">Customize</button>' : "";
    const b = note.querySelector("button");
    if (b) b.addEventListener("click", openPanel);
  }

  // ---- the Customize sheet ----
  function move(unit, dir) {
    const i = state.order.indexOf(unit), j = i + dir;
    if (i < 0 || j < 0 || j >= state.order.length) return;
    [state.order[i], state.order[j]] = [state.order[j], state.order[i]];
    save(); apply();
  }
  function toggle(id) {
    const i = state.hidden.indexOf(id);
    if (i === -1) state.hidden.push(id); else state.hidden.splice(i, 1);
    save(); apply();
  }

  function openPanel() {
    const A = window.Accounts;
    if (!A || !A.openSheetShell) return;
    const ui = A.openSheetShell({ eyebrow: "Dashboard", title: "" });
    ui.setTitle("Customize");

    function rows() {
      const list = [];
      state.order.forEach((u) => ITEMS.filter((it) => it.unit === u).forEach((it) => list.push(it)));
      return list;
    }
    function paint() {
      const isCalm = CALM_HIDDEN.length === state.hidden.length && CALM_HIDDEN.every((h) => state.hidden.includes(h));
      const isAll = state.hidden.length === 0;
      const list = rows();
      ui.body.innerHTML =
        '<div class="sv-sec"><div class="sv-sec-h"><span>Look</span></div><div class="dl-skins">' +
        SKINS.map((k) => '<button type="button" class="dl-skin' + (curSkin() === k.id ? " on" : "") + '" data-skin="' + k.id + '" aria-pressed="' + (curSkin() === k.id) + '">' +
          '<span class="dl-dots">' + k.dots.map((c) => '<i style="background:' + c + '"></i>').join("") + '</span>' +
          '<span class="dl-skin-name">' + k.name + '<span class="sv-sub">' + k.note + '</span></span></button>').join("") +
        '<p class="sv-hint" style="margin-top:2px">The sun/moon button in the top bar switches each look between dark and light.</p></div></div>' +
        '<div class="sv-sec"><div class="sv-sec-h"><span>Start from</span></div><div class="sv-chips">' +
        '<button type="button" class="sv-chip' + (isAll ? " on" : "") + '" data-preset="all">Everything</button>' +
        '<button type="button" class="sv-chip' + (isCalm ? " on" : "") + '" data-preset="calm">Calm</button></div>' +
        '<p class="sv-hint" style="margin-top:8px">Calm keeps the Net P&amp;L, key numbers, equity curve and notes.</p></div>' +
        '<div class="sv-sec"><div class="sv-sec-h"><span>Sections</span></div><ul class="dl-list">' +
        list.map((it) => {
          const on = !state.hidden.includes(it.id), pos = state.order.indexOf(it.unit);
          const arrows = it.beside ? "" :
            '<button type="button" class="dl-arrow" data-move="' + it.unit + '" data-dir="-1" aria-label="Move ' + it.name + ' up"' + (pos === 0 ? " disabled" : "") + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 15 12 9 18 15"/></svg></button>' +
            '<button type="button" class="dl-arrow" data-move="' + it.unit + '" data-dir="1" aria-label="Move ' + it.name + ' down"' + (pos === state.order.length - 1 ? " disabled" : "") + '><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>';
          return '<li class="dl-row' + (on ? "" : " off") + (it.beside ? " beside" : "") + '">' +
            '<button type="button" class="dl-switch" role="switch" aria-checked="' + on + '" data-toggle="' + it.id + '" aria-label="Show ' + it.name + '"><i></i></button>' +
            '<span class="dl-name">' + it.name + '<span class="sv-sub">' + (it.beside ? "Sits beside Form guide" : it.note) + '</span></span>' + arrows + '</li>';
        }).join("") + "</ul></div>";
      ui.foot.innerHTML = '<div class="sv-links"><button type="button" class="sv-link" data-reset>Reset to default</button></div>';
    }
    const keepFocusSkin = (id) => { const n = ui.body.querySelector('[data-skin="' + id + '"]'); if (n) n.focus(); };
    ui.shell.addEventListener("click", (e) => {
      const t = e.target.closest("button");
      if (!t) return;
      const keepFocus = () => { const sel = t.getAttribute("data-toggle") ? '[data-toggle="' + t.getAttribute("data-toggle") + '"]' : t.getAttribute("data-move") ? '[data-move="' + t.getAttribute("data-move") + '"][data-dir="' + t.getAttribute("data-dir") + '"]' : null; const n = sel && ui.body.querySelector(sel + ":not([disabled])"); if (n) n.focus(); };
      if (t.hasAttribute("data-skin")) { setSkin(t.getAttribute("data-skin")); paint(); keepFocusSkin(t.getAttribute("data-skin")); }
      else if (t.dataset.preset === "all") { state.hidden = []; save(); apply(); paint(); }
      else if (t.dataset.preset === "calm") { state.hidden = CALM_HIDDEN.slice(); save(); apply(); paint(); }
      else if (t.hasAttribute("data-reset")) { state = { order: UNITS.slice(), hidden: [] }; save(); apply(); paint(); }
      else if (t.hasAttribute("data-toggle")) { toggle(t.getAttribute("data-toggle")); paint(); keepFocus(); }
      else if (t.hasAttribute("data-move")) { move(t.getAttribute("data-move"), Number(t.getAttribute("data-dir"))); paint(); keepFocus(); }
    });
    paint();
  }

  // ---- topbar button, shown only on the dashboard tab ----
  function mountButton() {
    const bar = document.querySelector(".topbar-right");
    if (!bar || document.getElementById("dash-customize")) return;
    const b = document.createElement("button");
    b.type = "button";
    b.id = "dash-customize";
    b.className = "icon-btn icon-btn-visible";
    b.title = "Choose what the dashboard shows";
    b.setAttribute("aria-label", "Customize dashboard");
    b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4" width="17" height="6" rx="1.8"/><rect x="3.5" y="14" width="7.5" height="6" rx="1.8"/><rect x="14" y="14" width="6.5" height="6" rx="1.8"/></svg>';
    bar.insertBefore(b, bar.querySelector("#scope-switch") ? bar.querySelector("#scope-switch").nextSibling : bar.firstChild);
    b.addEventListener("click", openPanel);
    const sync = () => { b.style.display = tab.classList.contains("active") ? "" : "none"; };
    sync();
    new MutationObserver(sync).observe(tab, { attributes: true, attributeFilter: ["class"] });
  }

  const css = document.createElement("style");
  css.textContent =
    "[data-dash-hidden]{display:none !important}" +
    ".dash-two-col.dash-one{grid-template-columns:1fr}" +
    ".dash-hidden-note{margin-top:18px;font-size:12.5px;color:var(--text-faint)}" +
    ".dash-hidden-btn{border:0;background:none;padding:0;font:inherit;color:var(--text-dim);text-decoration:underline;text-underline-offset:3px;cursor:pointer}" +
    ".dash-hidden-btn:hover{color:var(--text)}" +
    ".dl-skins{display:grid;grid-template-columns:1fr 1fr;gap:8px}@media(max-width:520px){.dl-skins{grid-template-columns:1fr}}" +
    ".dl-skin{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:var(--panel-2);color:var(--text);font:inherit;cursor:pointer}" +
    ".dl-skin:hover{border-color:var(--text-faint)}.dl-skin.on{border-color:var(--primary);background:var(--primary-soft)}.dl-skin:focus-visible{outline:2px solid var(--primary);outline-offset:2px}" +
    ".dl-dots{display:flex;flex:none;border-radius:8px;overflow:hidden;border:1px solid rgba(128,128,128,.35)}.dl-dots i{width:16px;height:30px}" +
    ".dl-skin-name{font-weight:600;font-size:14px}" +
    ".dl-list{list-style:none;margin:0;padding:0}" +
    ".dl-row{display:flex;align-items:center;gap:12px;padding:10px 4px;border-bottom:1px solid var(--border-soft)}" +
    ".dl-row.beside{padding-left:20px}" +
    ".dl-name{flex:1;min-width:0;font-weight:600;font-size:14px;color:var(--text)}.dl-row.off .dl-name{color:var(--text-faint)}" +
    ".dl-switch{flex:none;width:38px;height:22px;border-radius:999px;border:0;background:var(--panel-3);position:relative;cursor:pointer;transition:background-color .15s}" +
    ".dl-switch i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:var(--text-dim);transition:transform .15s,background-color .15s}" +
    ".dl-switch[aria-checked=true]{background:var(--primary)}.dl-switch[aria-checked=true] i{transform:translateX(16px);background:var(--on-primary,#fff)}" +
    ".dl-switch:focus-visible,.dl-arrow:focus-visible{outline:2px solid var(--primary);outline-offset:2px}" +
    ".dl-arrow{flex:none;width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:var(--text-dim);cursor:pointer}" +
    ".dl-arrow:hover:not([disabled]){background:var(--panel-2);color:var(--text)}.dl-arrow[disabled]{opacity:.25;cursor:default}.dl-arrow svg{width:16px;height:16px}" +
    "@media(prefers-reduced-motion:reduce){.dl-switch,.dl-switch i{transition:none}}";
  document.head.appendChild(css);

  apply();
  // The topbar is rendered by common.js; wait for the page to be ready, then add the button.
  const go = () => mountButton();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();
  if (window.AUTH_READY && window.AUTH_READY.then) window.AUTH_READY.then(go);
})();
