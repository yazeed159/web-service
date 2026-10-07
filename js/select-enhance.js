// select-enhance.js -- one polished dropdown for every <select> on the site.
//
// How it works (and why it's safe to drop onto 40+ existing selects):
//   * The real <select> stays in the page, in the same spot, still the source of
//     truth (value, options, events, forms). It's only made transparent, and
//     it keeps sizing its box exactly like before -- so no layout shifts.
//   * A button drawn on top of it shows the current choice; clicking it opens a
//     styled menu. Picking an item sets the real select and fires `input` +
//     `change` just like the native control, so existing page code is unchanged.
//   * Programmatic changes (select.value = ..., options re-rendered with
//     innerHTML, disabled toggled) are mirrored back onto the button.
//   * Phones / touch screens keep the native picker (it's the better UX there);
//     they still get the CSS-only chevron/colour fix in common.css.
//   * Opt out per select with data-native="1" (or class "ds-skip").
(function () {
  "use strict";
  if (window.__dsLoaded) return;
  window.__dsLoaded = true;

  var finePointer = false;
  try { finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches; } catch (e) {}
  if (!finePointer) return;

  var CHEV = '<svg class="ds-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
  var CHECK = '<svg class="ds-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

  var openInst = null;     // the instance whose menu is currently open
  var menuEl = null;       // single shared menu element
  var all = [];            // every live instance (for polling / cleanup)

  function eligible(sel) {
    return sel && sel.tagName === "SELECT" && !sel.__ds && !sel.multiple && !(sel.size > 1) &&
      !sel.hasAttribute("data-native") && !sel.classList.contains("ds-skip") && !sel.closest("[data-native-select]");
  }

  // ---------- keep programmatic changes in sync ----------
  function patchSetter(prop) {
    var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    if (!d || !d.set || !d.configurable) return;
    Object.defineProperty(HTMLSelectElement.prototype, prop, {
      configurable: true, enumerable: d.enumerable,
      get: d.get,
      set: function (v) { d.set.call(this, v); if (this.__ds) this.__ds.sync(); },
    });
  }
  patchSetter("value");
  patchSetter("selectedIndex");

  function selectedText(sel) {
    var o = sel.options[sel.selectedIndex];
    return o ? (o.text || "").trim() : "";
  }

  // ---------- one instance per select ----------
  function enhance(sel) {
    if (!eligible(sel) || !sel.parentNode) return;
    var cs = getComputedStyle(sel);

    // Width behaviour must be measured BEFORE wrapping (afterwards the wrapper
    // would shrink-wrap it). Full-width selects stay full width.
    var fullWidth = "";
    if (sel.offsetParent !== null || cs.position === "fixed") {
      var pr = sel.parentElement.getBoundingClientRect();
      var sr = sel.getBoundingClientRect();
      var pcs = getComputedStyle(sel.parentElement);
      var inner = pr.width - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight) - parseFloat(pcs.borderLeftWidth) - parseFloat(pcs.borderRightWidth);
      if (inner > 0 && sr.width >= inner - 1 && !/flex/.test(pcs.display)) fullWidth = "100%";
      else if (/flex/.test(pcs.display) && sr.width >= inner - 1) fullWidth = "100%";
    } else if (/%$/.test(cs.width)) {
      fullWidth = cs.width; // not rendered yet: the computed value is still the declared one
    }

    var wrap = document.createElement("span");
    wrap.className = "ds" + (cs.display === "block" ? " ds-block" : "");
    ["flex", "flexGrow", "flexShrink", "flexBasis", "alignSelf", "order", "gridColumn", "minWidth", "maxWidth"].forEach(function (p) {
      var v = cs[p];
      if (v && v !== "auto" && v !== "normal" && v !== "none" && v !== "0px" && !(p === "flexGrow" && v === "0") && !(p === "flexShrink" && v === "1")) wrap.style[p] = v;
    });
    wrap.style.margin = cs.margin;
    if (fullWidth) wrap.style.width = fullWidth;
    else if (sel.style.width) wrap.style.width = sel.style.width;

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add("ds-native");
    sel.style.margin = "0";
    sel.tabIndex = -1;
    sel.setAttribute("aria-hidden", "true");

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ds-trigger";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    var lbl = sel.id ? document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(sel.id) : sel.id) + '"]') : null;
    if (lbl) { if (!lbl.id) lbl.id = "dsl-" + Math.random().toString(36).slice(2, 8); btn.setAttribute("aria-labelledby", lbl.id); }
    else if (sel.getAttribute("aria-label")) btn.setAttribute("aria-label", sel.getAttribute("aria-label"));
    btn.innerHTML = '<span class="ds-label"></span>' + CHEV;
    wrap.appendChild(btn);

    var labelEl = btn.firstChild;
    var inst = { sel: sel, wrap: wrap, btn: btn, active: -1, items: [], typed: "", typedAt: 0 };
    sel.__ds = inst;
    all.push(inst);

    inst.styleFromSelect = function () {
      var c = getComputedStyle(sel);
      btn.style.fontSize = c.fontSize;
      btn.style.fontFamily = c.fontFamily;
      btn.style.fontWeight = c.fontWeight;
      btn.style.letterSpacing = c.letterSpacing;
      btn.style.textTransform = c.textTransform;
      btn.style.color = c.color;
      btn.style.borderRadius = c.borderTopLeftRadius;
      btn.style.paddingLeft = c.paddingLeft;
    };

    inst.sync = function () {
      var t = selectedText(sel);
      if (labelEl.textContent !== t) labelEl.textContent = t;
      labelEl.classList.toggle("ds-empty", !t);
      if (btn.disabled !== sel.disabled) btn.disabled = sel.disabled;
      var hidden = sel.hidden || sel.style.display === "none";
      wrap.style.display = hidden ? "none" : "";
      if (openInst === inst && menuEl) buildItems(inst); // options changed while open
    };

    sel.addEventListener("change", inst.sync);
    sel.addEventListener("input", inst.sync);
    new MutationObserver(inst.sync).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "hidden", "style", "label"] });

    inst.styleFromSelect();
    inst.sync();

    btn.addEventListener("click", function (e) { e.preventDefault(); if (openInst === inst) closeMenu(); else openMenu(inst); });
    btn.addEventListener("keydown", function (e) { onKey(inst, e); });
    btn.addEventListener("blur", function () { /* menu clicks use mousedown preventDefault, so a real blur means "left" */ if (openInst === inst) closeMenu(); });
  }

  // ---------- menu ----------
  function ensureMenu() {
    if (menuEl) return menuEl;
    menuEl = document.createElement("div");
    menuEl.className = "ds-menu";
    menuEl.setAttribute("role", "listbox");
    menuEl.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep focus on the trigger
    document.body.appendChild(menuEl);
    return menuEl;
  }

  function buildItems(inst) {
    var m = ensureMenu();
    m.innerHTML = "";
    inst.items = [];
    var id = 0;
    function addOpt(o, indent) {
      var el = document.createElement("div");
      el.className = "ds-opt" + (o.selected ? " selected" : "") + (o.disabled ? " disabled" : "") + (indent ? " indented" : "");
      el.setAttribute("role", "option");
      el.setAttribute("aria-selected", o.selected ? "true" : "false");
      el.id = "ds-o" + id++;
      var span = document.createElement("span");
      span.className = "ds-opt-t";
      span.textContent = (o.text || "").trim() || "\u00a0";
      el.appendChild(span);
      el.insertAdjacentHTML("beforeend", CHECK);
      var item = { opt: o, el: el };
      inst.items.push(item);
      m.appendChild(el);
      el.addEventListener("mousemove", function () { if (!o.disabled) setActive(inst, inst.items.indexOf(item), false); });
      el.addEventListener("click", function () { if (!o.disabled) choose(inst, o); });
    }
    Array.prototype.forEach.call(inst.sel.children, function (ch) {
      if (ch.tagName === "OPTGROUP") {
        var g = document.createElement("div");
        g.className = "ds-group";
        g.textContent = ch.label || "";
        m.appendChild(g);
        Array.prototype.forEach.call(ch.children, function (o) { if (o.tagName === "OPTION") addOpt(o, true); });
      } else if (ch.tagName === "OPTION") addOpt(ch, false);
    });
    var cur = inst.sel.selectedIndex;
    var curOpt = inst.sel.options[cur];
    var idx = -1;
    inst.items.forEach(function (it, i) { if (it.opt === curOpt) idx = i; });
    setActive(inst, idx >= 0 ? idx : firstEnabled(inst, 0, 1), true);
  }

  function firstEnabled(inst, from, dir) {
    var n = inst.items.length;
    for (var k = 0; k < n; k++) {
      var i = (from + dir * k + n * 4) % n;
      if (!inst.items[i].opt.disabled) return i;
    }
    return -1;
  }

  function setActive(inst, i, scroll) {
    inst.items.forEach(function (it, k) { it.el.classList.toggle("active", k === i); });
    inst.active = i;
    var it = inst.items[i];
    if (it) {
      inst.btn.setAttribute("aria-activedescendant", it.el.id);
      if (scroll && menuEl) {
        var top = it.el.offsetTop, bottom = top + it.el.offsetHeight;
        if (top < menuEl.scrollTop + 4) menuEl.scrollTop = Math.max(0, top - 6);
        else if (bottom > menuEl.scrollTop + menuEl.clientHeight - 4) menuEl.scrollTop = bottom - menuEl.clientHeight + 6;
      }
    }
  }

  function position(inst) {
    var m = menuEl, r = inst.btn.getBoundingClientRect();
    var c = getComputedStyle(inst.btn);
    m.style.fontSize = c.fontSize;
    m.style.fontFamily = c.fontFamily;
    m.style.minWidth = Math.max(r.width, 120) + "px";
    m.style.left = "0px"; m.style.top = "0px";
    var mh = m.offsetHeight, mw = m.offsetWidth;
    var vw = window.innerWidth, vh = window.innerHeight;
    var below = vh - r.bottom - 10, above = r.top - 10;
    var up = mh > below && above > below;
    var maxH = Math.max(120, Math.min(320, up ? above : below));
    m.style.maxHeight = maxH + "px";
    mh = Math.min(mh, maxH);
    var left = Math.min(Math.max(8, r.left), Math.max(8, vw - mw - 8));
    var top = up ? r.top - mh - 6 : r.bottom + 6;
    m.style.left = Math.round(left) + "px";
    m.style.top = Math.round(top) + "px";
    m.classList.toggle("up", up);
  }

  function openMenu(inst) {
    if (inst.sel.disabled) return;
    if (openInst && openInst !== inst) closeMenu(true);
    openInst = inst;
    inst.styleFromSelect();
    var m = ensureMenu();
    m.classList.remove("show");
    buildItems(inst);
    inst.wrap.classList.add("open");
    inst.btn.setAttribute("aria-expanded", "true");
    position(inst);
    var cur = inst.items[inst.active];
    if (cur) m.scrollTop = Math.max(0, cur.el.offsetTop - m.clientHeight / 2 + cur.el.offsetHeight / 2);
    requestAnimationFrame(function () { if (openInst === inst) m.classList.add("show"); });
    try { inst.btn.focus({ preventScroll: true }); } catch (e) { inst.btn.focus(); }
  }

  function closeMenu(immediate) {
    var inst = openInst;
    if (!inst) return;
    openInst = null;
    inst.wrap.classList.remove("open");
    inst.btn.setAttribute("aria-expanded", "false");
    inst.btn.removeAttribute("aria-activedescendant");
    if (menuEl) {
      menuEl.classList.remove("show");
      if (immediate) menuEl.innerHTML = "";
      else setTimeout(function () { if (!openInst && menuEl) menuEl.innerHTML = ""; }, 140);
    }
  }

  function choose(inst, opt) {
    var changed = inst.sel.value !== opt.value || inst.sel.options[inst.sel.selectedIndex] !== opt;
    if (changed) {
      opt.selected = true;
      inst.sync();
      inst.sel.dispatchEvent(new Event("input", { bubbles: true }));
      inst.sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    closeMenu();
    try { inst.btn.focus({ preventScroll: true }); } catch (e) {}
  }

  function onKey(inst, e) {
    var open = openInst === inst;
    var k = e.key;
    if (!open) {
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") { e.preventDefault(); openMenu(inst); }
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { typeAhead(inst, k, true); }
      return;
    }
    if (k === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (k === "Tab") { closeMenu(); }
    else if (k === "ArrowDown") { e.preventDefault(); setActive(inst, firstEnabled(inst, inst.active + 1, 1), true); }
    else if (k === "ArrowUp") { e.preventDefault(); setActive(inst, firstEnabled(inst, inst.active - 1, -1), true); }
    else if (k === "Home") { e.preventDefault(); setActive(inst, firstEnabled(inst, 0, 1), true); }
    else if (k === "End") { e.preventDefault(); setActive(inst, firstEnabled(inst, inst.items.length - 1, -1), true); }
    else if (k === "Enter" || k === " ") { e.preventDefault(); var it = inst.items[inst.active]; if (it) choose(inst, it.opt); }
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { typeAhead(inst, k, false); }
  }

  function typeAhead(inst, ch, closed) {
    var now = Date.now();
    inst.typed = (now - inst.typedAt > 700 ? "" : inst.typed) + ch.toLowerCase();
    inst.typedAt = now;
    var opts = closed ? Array.prototype.slice.call(inst.sel.options) : inst.items.map(function (i) { return i.opt; });
    var start = closed ? inst.sel.selectedIndex + 1 : inst.active + 1;
    for (var k = 0; k < opts.length; k++) {
      var i = (start + k) % opts.length;
      if (!opts[i].disabled && (opts[i].text || "").trim().toLowerCase().indexOf(inst.typed) === 0) {
        if (closed) { opts[i].selected = true; inst.sync(); inst.sel.dispatchEvent(new Event("input", { bubbles: true })); inst.sel.dispatchEvent(new Event("change", { bubbles: true })); }
        else setActive(inst, i, true);
        return;
      }
    }
  }

  // ---------- global listeners ----------
  document.addEventListener("mousedown", function (e) {
    if (!openInst) return;
    if (menuEl && menuEl.contains(e.target)) return;
    if (openInst.wrap.contains(e.target)) return;
    closeMenu();
  }, true);
  window.addEventListener("resize", function () { if (openInst) closeMenu(true); });
  window.addEventListener("scroll", function (e) {
    if (!openInst) return;
    if (menuEl && e.target && menuEl.contains(e.target)) return;
    closeMenu(true);
  }, true);

  // ---------- discovery ----------
  function scan(root) {
    var list = (root || document).querySelectorAll ? (root || document).querySelectorAll("select") : [];
    for (var i = 0; i < list.length; i++) enhance(list[i]);
    if (root && root.tagName === "SELECT") enhance(root);
  }

  var queued = false;
  var pending = [];
  function queueScan(nodes) {
    pending.push.apply(pending, nodes);
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var batch = pending; pending = [];
      batch.forEach(function (n) { if (n.nodeType === 1 && document.contains(n)) scan(n); });
    });
  }

  function start() {
    scan(document);
    new MutationObserver(function (muts) {
      var nodes = [];
      muts.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) { if (n.nodeType === 1) nodes.push(n); }); });
      if (nodes.length) queueScan(nodes);
    }).observe(document.body, { childList: true, subtree: true });

    // Catch `option.selected = true` style changes (no event, no attribute) and
    // drop instances whose select left the page.
    setInterval(function () {
      if (document.hidden) return;
      all = all.filter(function (i) { return document.contains(i.sel); });
      all.forEach(function (i) { if (selectedText(i.sel) !== i.wrap.querySelector(".ds-label").textContent || i.btn.disabled !== i.sel.disabled) i.sync(); });
    }, 400);
  }

  window.refreshSelects = function () { all.forEach(function (i) { i.styleFromSelect(); i.sync(); }); scan(document); };

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
})();
