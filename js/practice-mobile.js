// practice-mobile.js
// Phone layout for the Practice play screen (portrait AND landscape).
//
//   Portrait (<=760px):  the order ticket becomes a dock pinned above the
//     bottom tab bar -- your shortcut buttons plus big BUY / SELL are always
//     one thumb away; tapping the size handle slides the full ticket up
//     (size, % presets, position, fills) as a sheet.
//   Landscape phone (short + touch): the play screen goes full-screen -- chart
//     fills it, the dock is a slim strip along the bottom (size - shortcuts -
//     BUY - SELL), and the same slide-up sheet holds the rest of the ticket.
//
// Nothing here changes how orders work: practice.js still owns every button,
// input and listener. This file only re-parents the existing ticket node into
// a body-level dock (body-level so no ancestor's transform / backdrop-filter
// can trap position:fixed), adds a handle, and toggles layout classes on
// <html>. On desktop widths it does nothing and puts the ticket back.
(function () {
  "use strict";

  var root = document.documentElement;
  var panel = document.querySelector(".pp-order-panel");
  var playScreen = document.getElementById("pr-play-screen");
  if (!panel || !playScreen || !window.matchMedia) {
    window.PracticeMobile = { sync: function () {}, onChartBuilt: function () {} };
    return;
  }

  var mqPhone = window.matchMedia("(max-width: 760px)");
  var mqLand = window.matchMedia("(orientation: landscape) and (max-height: 500px) and (pointer: coarse)");

  var adopted = false;
  var open = false;
  var home = null, origKids = [];
  var dock, scrim, handle, body, foot, sizeEl, priceEl;
  var dockRo = null, wrapRo = null, priceMo = null;
  var landscapeApplied = false;
  var lastLand = false;

  function visible(el) { return !!(el && el.getClientRects().length); }
  function $(id) { return document.getElementById(id); }

  // ---------------------------------------------------------------- dock
  function adopt() {
    if (adopted) return;
    var btnRow = panel.querySelector(".pp-order-btn-row");
    var shortcuts = $("pp-shortcuts-block");
    var msg = $("pp-order-msg");
    origKids = Array.prototype.slice.call(panel.children);
    home = document.createComment("pp-dock-home");
    panel.parentNode.insertBefore(home, panel);

    dock = document.createElement("div");
    dock.id = "pp-dock";
    dock.className = "pp-dock";

    scrim = document.createElement("div");
    scrim.className = "pp-dock-scrim";
    scrim.addEventListener("click", function () { setOpen(false); });

    handle = document.createElement("button");
    handle.type = "button";
    handle.className = "pp-dock-handle";
    handle.setAttribute("aria-expanded", "false");
    handle.setAttribute("aria-label", "Open or close the order ticket");
    handle.innerHTML =
      '<span class="pp-dock-grip" aria-hidden="true"></span>' +
      '<span class="pp-dock-price"></span>' +
      '<span class="pp-dock-size"></span>' +
      '<span class="pp-dock-chev" aria-hidden="true">\u25B4</span>';
    priceEl = handle.querySelector(".pp-dock-price");
    sizeEl = handle.querySelector(".pp-dock-size");
    handle.addEventListener("click", function () { setOpen(!open); });

    body = document.createElement("div");
    body.className = "pp-dock-body";
    foot = document.createElement("div");
    foot.className = "pp-dock-foot";

    origKids.forEach(function (k) {
      if (k === btnRow || k === shortcuts || k === msg) return;
      body.appendChild(k);
    });
    if (shortcuts) foot.appendChild(shortcuts);
    if (btnRow) foot.appendChild(btnRow);

    panel.appendChild(handle);
    panel.appendChild(body);
    panel.appendChild(foot);
    dock.insertBefore(panel, dock.firstChild);
    dock.insertBefore(scrim, dock.firstChild);
    document.body.appendChild(dock);
    // Order feedback ("No open position to sell.") floats just above the
    // panel's top edge so it never shifts the buttons under your thumb.
    if (msg) panel.appendChild(msg);

    // Keep the handle label (live price + order size) current.
    panel.addEventListener("click", queueLabel);
    panel.addEventListener("input", queueLabel);
    panel.addEventListener("change", queueLabel);
    var price = $("pp-live-price");
    if (price && window.MutationObserver) {
      priceMo = new MutationObserver(refreshLabel);
      priceMo.observe(price, { childList: true, characterData: true, subtree: true });
    }
    if (window.ResizeObserver) {
      dockRo = new ResizeObserver(measureDock);
      dockRo.observe(panel);
    }
    document.addEventListener("keydown", onKey, true);
    adopted = true;
    refreshLabel();
    measureDock();
  }

  function release() {
    if (!adopted) return;
    document.removeEventListener("keydown", onKey, true);
    panel.removeEventListener("click", queueLabel);
    panel.removeEventListener("input", queueLabel);
    panel.removeEventListener("change", queueLabel);
    if (priceMo) { priceMo.disconnect(); priceMo = null; }
    if (dockRo) { dockRo.disconnect(); dockRo = null; }
    origKids.forEach(function (k) { panel.appendChild(k); }); // original order
    [handle, body, foot].forEach(function (n) { if (n && n.parentNode) n.parentNode.removeChild(n); });
    if (home && home.parentNode) { home.parentNode.insertBefore(panel, home); home.parentNode.removeChild(home); }
    if (dock && dock.parentNode) dock.parentNode.removeChild(dock);
    dock = scrim = handle = body = foot = home = null;
    adopted = false;
    root.style.removeProperty("--pp-dock-h");
  }

  function setOpen(next) {
    if (!adopted) next = false;
    open = !!next;
    if (dock) dock.classList.toggle("open", open);
    root.classList.toggle("pp-dock-open", open);
    if (handle) handle.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open) requestAnimationFrame(measureDock);
  }

  function onKey(e) { if (open && e.key === "Escape") setOpen(false); }

  var labelTimer = 0;
  function queueLabel() { clearTimeout(labelTimer); labelTimer = setTimeout(refreshLabel, 0); }
  function refreshLabel() {
    if (!adopted) return;
    var inp = $("pp-shares-input"), unit = $("pp-size-unit"), price = $("pp-live-price");
    var n = inp && inp.value ? inp.value : "\u2014";
    var u = unit ? unit.textContent.trim() : "";
    sizeEl.textContent = n + (u ? " " + u : "");
    priceEl.textContent = price ? price.textContent.trim() : "";
  }

  // Dock height drives the page's bottom padding and the fullscreen chart's
  // bottom edge, so nothing ever sits underneath the buy / sell buttons. Only
  // the CLOSED strip height counts: the open sheet overlays the page, and the
  // chart must not resize (jump) every time the sheet slides up.
  var stripH = 0;
  function measureDock() {
    if (!adopted) return;
    if (!open) stripH = Math.ceil(panel.getBoundingClientRect().height);
    if (stripH) root.style.setProperty("--pp-dock-h", stripH + "px");
    fitChart();
  }

  // ----------------------------------------------------------- chart fit
  function fitChart() {
    var h = window.__ppChart;
    var el = $("pp-candle-chart"), wrap = $("pp-chart-wrap");
    if (!h || !h.chart || !el || !wrap) return;
    try {
      if (root.classList.contains("pp-landscape")) {
        var hh = Math.floor(wrap.clientHeight - 2);
        if (hh < 120) return;
        landscapeApplied = true;
        el.style.height = hh + "px";
        h.chart.applyOptions({ width: el.clientWidth, height: hh });
      } else if (landscapeApplied) {
        landscapeApplied = false;
        var base = window.ChartIndicators && window.ChartIndicators.isPhone()
          ? window.ChartIndicators.phoneChartHeight(380) : 380;
        el.style.height = base + "px";
        h.chart.applyOptions({ width: el.clientWidth, height: base });
      }
    } catch (e) {}
  }

  function onChartBuilt(handleObj) {
    // A rebuilt chart (Replay / Change chart) starts at the portrait height;
    // re-apply the landscape fit if we're in it.
    landscapeApplied = false;
    var wrap = $("pp-chart-wrap");
    if (wrap && window.ResizeObserver) {
      if (wrapRo) wrapRo.disconnect();
      wrapRo = new ResizeObserver(function () { fitChart(); });
      wrapRo.observe(wrap);
    }
    if (root.classList.contains("pp-landscape") && handleObj && handleObj.fullscreen) {
      try { handleObj.fullscreen.exit(); } catch (e) {}
    }
    setTimeout(fitChart, 0);
  }

  // ---------------------------------------------------------------- sync
  function sync() {
    var phone = mqPhone.matches || mqLand.matches;
    var playing = phone && visible(playScreen);
    var land = playing && mqLand.matches;
    if (land) {
      // Landscape layout is already full-screen; close the generic one.
      var h = window.__ppChart;
      if (h && h.fullscreen && h.fullscreen.isOn()) { try { h.fullscreen.exit(); } catch (e) {} }
    }
    if (adopted && land !== lastLand) setOpen(false); // rotated: start from the strip
    lastLand = land;
    if (playing) adopt(); else { setOpen(false); release(); }
    root.classList.toggle("pp-playing", playing);
    root.classList.toggle("pp-landscape", land);
    // Layout classes change the chart's box; measure after they apply.
    requestAnimationFrame(function () { measureDock(); fitChart(); });
  }

  function bindMq(mq) {
    if (mq.addEventListener) mq.addEventListener("change", sync);
    else if (mq.addListener) mq.addListener(sync);
  }
  bindMq(mqPhone);
  bindMq(mqLand);
  window.addEventListener("orientationchange", function () { setTimeout(sync, 250); });
  window.addEventListener("resize", function () { fitChart(); });

  window.PracticeMobile = { sync: sync, onChartBuilt: onChartBuilt, setOpen: setOpen };
  sync();
})();
