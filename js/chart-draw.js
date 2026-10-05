// chart-draw.js -- drawing tools for the price charts (support / resistance
// lines, trend lines, rays, zones, fib retracements, a measure tool, text).
//
// Attached by ChartIndicators.buildStandardChart(), so every price chart that
// goes through it (Trade, Report, Practice, Rewind) gets the tools. The tools
// only show up in fullscreen (the toolbar is hidden otherwise); drawings you
// already made stay visible on the normal chart but are not interactive there,
// so they never get in the way of scrolling the page.
//
// How it works
//   * Drawings render through a lightweight-charts series primitive, so they are
//     painted on the chart's own canvas and follow every pan / zoom / resize with
//     no sync code.
//   * Each point is stored as { t: unix seconds, p: price }. Time is mapped to a
//     (fractional) bar index and back, so a drawing made on the 1m chart still
//     lands in the right place on 5m / 15m / 1h, and can extend past the last bar.
//   * Drawings are saved in localStorage per `drawKey` (the symbol), so they
//     survive a reload and show up again the next time that symbol's chart opens.
//     Without a drawKey they live for the page session only.
(function () {
  "use strict";

  var STORE_PREFIX = "trade.log:draw:v1:";
  var PREFS_KEY = "trade.log:draw:prefs";
  var COLORS = ["#e8a94c", "#5b93f0", "#2fd08a", "#f2555a", "#b57bee", "#e6e9ee"];
  var FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  var MAX_UNDO = 50;
  var MAX_PER_KEY = 80;

  // 24x24 line icons
  function svg(inner) {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>";
  }
  var ICON = {
    cursor: svg('<path d="M5 3l14 7-6 2-2 6z"/>'),
    hline: svg('<line x1="3" y1="12" x2="21" y2="12"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/>'),
    trend: svg('<line x1="4" y1="19" x2="20" y2="5"/><circle cx="4" cy="19" r="1.8" fill="currentColor"/><circle cx="20" cy="5" r="1.8" fill="currentColor"/>'),
    ray: svg('<line x1="4" y1="18" x2="21" y2="6"/><circle cx="4" cy="18" r="1.8" fill="currentColor"/><polyline points="17 5 21 6 19.5 10"/>'),
    rect: svg('<rect x="4" y="6" width="16" height="12" rx="1.5"/>'),
    fib: svg('<line x1="3" y1="5" x2="21" y2="5"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="19" x2="21" y2="19"/>'),
    measure: svg('<line x1="4" y1="12" x2="20" y2="12"/><polyline points="7 9 4 12 7 15"/><polyline points="17 9 20 12 17 15"/>'),
    text: svg('<polyline points="5 7 5 5 19 5 19 7"/><line x1="12" y1="5" x2="12" y2="19"/><line x1="9" y1="19" x2="15" y2="19"/>'),
    magnet: svg('<path d="M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3z"/><line x1="6" y1="7" x2="10" y2="7"/><line x1="14" y1="7" x2="18" y2="7"/>'),
    stay: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    undo: svg('<polyline points="9 14 4 9 9 4"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
    trash: svg('<polyline points="4 7 20 7"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
    clear: svg('<line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>'),
  };

  var TOOLS = [
    { id: "cursor", label: "Select / move (Esc)" },
    { id: "hline", label: "Horizontal line \u2014 support / resistance" },
    { id: "trend", label: "Trend line" },
    { id: "ray", label: "Ray" },
    { id: "rect", label: "Zone (rectangle)" },
    { id: "fib", label: "Fib retracement" },
    { id: "measure", label: "Measure" },
    { id: "text", label: "Text note" },
  ];

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fmtPrice(p) {
    if (p == null || !isFinite(p)) return "\u2014";
    var a = Math.abs(p);
    return p.toFixed(a >= 1 ? 2 : 4);
  }
  function hexA(hex, a) {
    var h = String(hex || "#e8a94c").replace("#", "");
    if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
    var n = parseInt(h, 16);
    if (!isFinite(n)) return "rgba(232,169,76," + a + ")";
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }
  function segDist(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    if (l2 < 1e-9) return Math.hypot(px - x1, py - y1);
    var t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function pill(ctx, text, x, y, bg, fg, align) {
    ctx.font = "600 11px system-ui, -apple-system, Segoe UI, sans-serif";
    var w = ctx.measureText(text).width + 10, h = 18, r = 4;
    var x0 = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    var y0 = y - h / 2;
    ctx.beginPath();
    ctx.moveTo(x0 + r, y0); ctx.lineTo(x0 + w - r, y0); ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
    ctx.lineTo(x0 + w, y0 + h - r); ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
    ctx.lineTo(x0 + r, y0 + h); ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
    ctx.lineTo(x0, y0 + r); ctx.quadraticCurveTo(x0, y0, x0 + r, y0); ctx.closePath();
    ctx.fillStyle = bg; ctx.fill();
    ctx.fillStyle = fg; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillText(text, x0 + 5, y0 + h / 2 + 0.5);
  }

  function attach(o) {
    o = o || {};
    var chart = o.chart, series = o.series, el = o.el;
    if (!chart || !series || !el || typeof series.attachPrimitive !== "function") return null;
    var ts = chart.timeScale();
    var isFs = o.isFs || function () { return false; };
    var storeKey = o.drawKey ? STORE_PREFIX + String(o.drawKey).toUpperCase() : null;

    var prefs = {};
    try { prefs = JSON.parse(lsGet(PREFS_KEY) || "{}") || {}; } catch (e) { prefs = {}; }

    var drawings = [];
    var temp = null;          // measure readout (never saved)
    var placing = null;       // two-point drawing being placed
    var placingMoved = false;
    var downPt = null;
    var selId = null;
    var tool = "cursor";
    var color = COLORS.indexOf(prefs.color) !== -1 ? prefs.color : COLORS[0];
    var magnet = !!prefs.magnet;
    var stay = !!prefs.stay;
    var undoStack = [];
    var drag = null;          // { kind: "move"|"handle", ... }
    var swallow = false;      // we own the current gesture; keep it from the chart
    var requestUpdate = function () {};
    var disposed = false;

    if (storeKey) {
      try { var saved = JSON.parse(lsGet(storeKey) || "[]"); if (Array.isArray(saved)) drawings = saved.filter(validDrawing); } catch (e) { /* ignore */ }
    }
    function validDrawing(d) { return d && d.type && Array.isArray(d.points) && d.points.length >= 1 && d.points.every(function (p) { return p && isFinite(p.t) && isFinite(p.p); }); }
    function savePrefs() { lsSet(PREFS_KEY, JSON.stringify({ color: color, magnet: magnet, stay: stay })); }
    function persist() {
      if (!storeKey) return;
      if (!drawings.length) { try { localStorage.removeItem(storeKey); } catch (e) { /* ignore */ } return; }
      lsSet(storeKey, JSON.stringify(drawings.slice(-MAX_PER_KEY)));
    }
    function snap() { undoStack.push(JSON.stringify(drawings)); if (undoStack.length > MAX_UNDO) undoStack.shift(); refreshBar(); }
    function changed() { persist(); requestUpdate(); refreshBar(); }

    // ------------------------------------------------------------------
    // time <-> bar index <-> pixels
    // ------------------------------------------------------------------
    var tcache = { n: -1, first: null, last: null, T: [] };
    function times() {
      var data;
      try { data = series.data(); } catch (e) { data = []; }
      var n = data ? data.length : 0;
      if (n === tcache.n && n && data[0].time === tcache.first && data[n - 1].time === tcache.last) return tcache.T;
      var T = new Array(n);
      for (var i = 0; i < n; i++) T[i] = data[i].time;
      tcache = { n: n, first: n ? T[0] : null, last: n ? T[n - 1] : null, T: T };
      return T;
    }
    function stepOf(T) { return T.length > 1 ? Math.max(1, T[T.length - 1] - T[T.length - 2]) : 60; }
    function timeToIdx(t, T) {
      var n = T.length;
      if (!n) return null;
      var st = stepOf(T);
      if (t <= T[0]) return (t - T[0]) / st;
      if (t >= T[n - 1]) return n - 1 + (t - T[n - 1]) / st;
      var lo = 0, hi = n - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (T[mid] <= t) lo = mid; else hi = mid; }
      return lo + (t - T[lo]) / (T[lo + 1] - T[lo]);
    }
    function idxToTime(i, T) {
      var n = T.length;
      if (!n) return null;
      var st = stepOf(T);
      if (i <= 0) return T[0] + i * st;
      if (i >= n - 1) return T[n - 1] + (i - (n - 1)) * st;
      var k = Math.floor(i);
      return T[k] + (i - k) * (T[k + 1] - T[k]);
    }
    function px(pt, T) {
      var idx = timeToIdx(pt.t, T);
      if (idx == null) return null;
      var x = ts.logicalToCoordinate(idx);
      var y = series.priceToCoordinate(pt.p);
      if (x == null || y == null) return null;
      return { x: x, y: y, idx: idx };
    }
    function plot() {
      var w = el.clientWidth, h = el.clientHeight;
      try { var tw = ts.width(); if (tw > 0) w = tw; } catch (e) { /* ignore */ }
      try { var th = ts.height(); if (th > 0) h = h - th; else h = h - 26; } catch (e) { h = h - 26; }
      return { w: w, h: h };
    }

    function localPt(e) {
      var r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function inPlot(pt) { var p = plot(); return pt.x >= 0 && pt.y >= 0 && pt.x <= p.w && pt.y <= p.h; }

    function toAnchor(pt) {
      var T = times();
      if (!T.length) return null;
      var lg = ts.coordinateToLogical(pt.x);
      var price = series.coordinateToPrice(pt.y);
      if (lg == null || price == null) return null;
      var t = idxToTime(lg, T);
      if (magnet) {
        var i = Math.round(lg);
        if (i >= 0 && i < T.length) {
          var bar = barAt(i);
          if (bar) {
            var best = price, bd = Infinity;
            [bar.open, bar.high, bar.low, bar.close].forEach(function (v) {
              if (v == null) return;
              var y = series.priceToCoordinate(v);
              if (y != null && Math.abs(y - pt.y) < bd) { bd = Math.abs(y - pt.y); best = v; }
            });
            if (bd <= 16) { price = best; t = T[i]; }
          }
        }
      }
      return { t: t, p: price };
    }
    function barAt(i) { try { return series.data()[i] || null; } catch (e) { return null; } }

    // ------------------------------------------------------------------
    // geometry + hit testing (pixels)
    // ------------------------------------------------------------------
    function geom(d, T) {
      var pts = [];
      for (var i = 0; i < d.points.length; i++) {
        var q = px(d.points[i], T);
        if (!q) return null;
        pts.push(q);
      }
      return pts;
    }
    function extendRay(a, b, far) {
      var dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 1e-6) return { x: a.x + far, y: a.y };
      return { x: a.x + (dx / len) * far, y: a.y + (dy / len) * far };
    }
    function fibLevels(d) {
      var p0 = d.points[0].p, p1 = d.points[1].p;
      return FIB.map(function (lvl) { return { lvl: lvl, price: p1 + (p0 - p1) * lvl }; });
    }
    function hit(d, pt, tol, T) {
      var g = geom(d, T);
      if (!g) return false;
      if (d.type === "hline") return Math.abs(pt.y - g[0].y) <= tol;
      if (d.type === "text") return Math.abs(pt.x - g[0].x) <= 60 && Math.abs(pt.y - g[0].y) <= 12 + tol / 2;
      if (g.length < 2) return false;
      if (d.type === "trend") return segDist(pt.x, pt.y, g[0].x, g[0].y, g[1].x, g[1].y) <= tol;
      if (d.type === "ray") { var e2 = extendRay(g[0], g[1], 20000); return segDist(pt.x, pt.y, g[0].x, g[0].y, e2.x, e2.y) <= tol; }
      if (d.type === "rect") {
        var x0 = Math.min(g[0].x, g[1].x), x1 = Math.max(g[0].x, g[1].x), y0 = Math.min(g[0].y, g[1].y), y1 = Math.max(g[0].y, g[1].y);
        return pt.x >= x0 - tol && pt.x <= x1 + tol && pt.y >= y0 - tol && pt.y <= y1 + tol;
      }
      if (d.type === "fib") {
        var xl = Math.min(g[0].x, g[1].x), xr = Math.max(Math.max(g[0].x, g[1].x), xl + 120);
        if (pt.x < xl - tol || pt.x > xr + tol) return false;
        var lv = fibLevels(d);
        for (var i = 0; i < lv.length; i++) { var y = series.priceToCoordinate(lv[i].price); if (y != null && Math.abs(pt.y - y) <= tol) return true; }
        return segDist(pt.x, pt.y, g[0].x, g[0].y, g[1].x, g[1].y) <= tol;
      }
      return false;
    }
    function hitTest(pt) {
      var T = times();
      var tol = coarse() ? 14 : 7;
      for (var i = drawings.length - 1; i >= 0; i--) if (hit(drawings[i], pt, tol, T)) return drawings[i];
      return null;
    }
    function hitHandle(d, pt) {
      var T = times(), g = geom(d, T);
      if (!g) return null;
      var r = coarse() ? 18 : 10;
      for (var i = 0; i < g.length; i++) {
        var gx = d.type === "hline" ? (plot().w - 14) : g[i].x;
        if (Math.hypot(pt.x - gx, pt.y - g[i].y) <= r) return i;
      }
      return null;
    }
    function coarse() { try { return window.matchMedia("(pointer: coarse)").matches; } catch (e) { return false; } }

    // ------------------------------------------------------------------
    // painting (runs inside the chart's own render)
    // ------------------------------------------------------------------
    function paintOne(ctx, d, w, h, selected) {
      var T = times();
      var g = geom(d, T);
      if (!g) return;
      var c = d.color || COLORS[0];
      ctx.lineWidth = selected ? 2.25 : 1.5;
      ctx.lineCap = "round";
      ctx.setLineDash([]);
      ctx.strokeStyle = c;
      ctx.fillStyle = c;

      if (d.type === "hline") {
        var y = g[0].y;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        pill(ctx, fmtPrice(d.points[0].p), w - 4, y, c, "#0a0b0f", "right");
      } else if (d.type === "trend") {
        ctx.beginPath(); ctx.moveTo(g[0].x, g[0].y); ctx.lineTo(g[1].x, g[1].y); ctx.stroke();
      } else if (d.type === "ray") {
        var e = extendRay(g[0], g[1], 20000);
        ctx.beginPath(); ctx.moveTo(g[0].x, g[0].y); ctx.lineTo(e.x, e.y); ctx.stroke();
      } else if (d.type === "rect") {
        var x0 = Math.min(g[0].x, g[1].x), y0 = Math.min(g[0].y, g[1].y);
        var rw = Math.abs(g[1].x - g[0].x), rh = Math.abs(g[1].y - g[0].y);
        ctx.fillStyle = hexA(c, 0.14); ctx.fillRect(x0, y0, rw, rh);
        ctx.strokeRect(x0, y0, rw, rh);
        var top = Math.max(d.points[0].p, d.points[1].p), bot = Math.min(d.points[0].p, d.points[1].p);
        pill(ctx, fmtPrice(top), x0 + rw + 4, y0, hexA(c, 0.9), "#0a0b0f", "left");
        pill(ctx, fmtPrice(bot), x0 + rw + 4, y0 + rh, hexA(c, 0.9), "#0a0b0f", "left");
      } else if (d.type === "fib") {
        var xl = Math.min(g[0].x, g[1].x), xr = Math.max(Math.max(g[0].x, g[1].x), xl + 120);
        var lv = fibLevels(d);
        var y50 = series.priceToCoordinate(lv[3].price), y618 = series.priceToCoordinate(lv[4].price);
        if (y50 != null && y618 != null) { ctx.fillStyle = hexA(c, 0.1); ctx.fillRect(xl, Math.min(y50, y618), xr - xl, Math.abs(y618 - y50)); }
        ctx.lineWidth = selected ? 1.75 : 1;
        lv.forEach(function (L) {
          var yy = series.priceToCoordinate(L.price);
          if (yy == null) return;
          ctx.strokeStyle = hexA(c, L.lvl === 0 || L.lvl === 1 ? 0.95 : 0.7);
          ctx.beginPath(); ctx.moveTo(xl, yy); ctx.lineTo(xr, yy); ctx.stroke();
          ctx.font = "600 11px system-ui, -apple-system, Segoe UI, sans-serif";
          ctx.fillStyle = c; ctx.textBaseline = "bottom"; ctx.textAlign = "left";
          ctx.fillText(L.lvl + "  (" + fmtPrice(L.price) + ")", xl + 4, yy - 2);
        });
        ctx.setLineDash([4, 4]); ctx.strokeStyle = hexA(c, 0.6); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(g[0].x, g[0].y); ctx.lineTo(g[1].x, g[1].y); ctx.stroke();
        ctx.setLineDash([]);
      } else if (d.type === "text") {
        var tx = d.text || "Note";
        pill(ctx, tx.length > 40 ? tx.slice(0, 39) + "\u2026" : tx, g[0].x, g[0].y, hexA(c, 0.92), "#0a0b0f", "left");
      } else if (d.type === "measure") {
        var dp = d.points[1].p - d.points[0].p;
        var pct = d.points[0].p ? (dp / d.points[0].p) * 100 : 0;
        var up = dp >= 0, mc = up ? "#2fd08a" : "#f2555a";
        var mx0 = Math.min(g[0].x, g[1].x), my0 = Math.min(g[0].y, g[1].y);
        ctx.fillStyle = hexA(mc, 0.12); ctx.fillRect(mx0, my0, Math.abs(g[1].x - g[0].x), Math.abs(g[1].y - g[0].y));
        ctx.strokeStyle = mc; ctx.lineWidth = 1.25; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(g[0].x, g[0].y); ctx.lineTo(g[1].x, g[1].y); ctx.stroke(); ctx.setLineDash([]);
        var bars = Math.round(g[1].idx - g[0].idx);
        var secs = Math.abs(d.points[1].t - d.points[0].t);
        var dur = secs >= 3600 ? (secs / 3600).toFixed(1) + "h" : Math.round(secs / 60) + "m";
        var txt = (up ? "+" : "") + fmtPrice(dp) + "  (" + (up ? "+" : "") + pct.toFixed(2) + "%)  \u00b7  " + Math.abs(bars) + " bars  \u00b7  " + dur;
        var ly = g[1].y + (up ? -16 : 16);
        pill(ctx, txt, Math.max(8, Math.min(w - 8, (g[0].x + g[1].x) / 2)), Math.max(12, Math.min(h - 12, ly)), mc, "#0a0b0f", "center");
      }

      if (selected && d.type !== "measure") {
        ctx.setLineDash([]); ctx.lineWidth = 2;
        g.forEach(function (q) {
          var hx = d.type === "hline" ? w - 14 : q.x;
          ctx.beginPath(); ctx.arc(hx, q.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.strokeStyle = c; ctx.stroke();
        });
      }
    }

    function paint(ctx, w, h) {
      ctx.save();
      try {
        for (var i = 0; i < drawings.length; i++) paintOne(ctx, drawings[i], w, h, drawings[i].id === selId);
        if (placing) paintOne(ctx, placing, w, h, false);
        if (temp) paintOne(ctx, temp, w, h, false);
      } finally { ctx.restore(); }
    }

    var primitive = {
      attached: function (p) { requestUpdate = p.requestUpdate; },
      detached: function () { requestUpdate = function () {}; },
      updateAllViews: function () {},
      paneViews: function () {
        return [{
          zOrder: function () { return "top"; },
          renderer: function () {
            return {
              draw: function (target) {
                target.useMediaCoordinateSpace(function (scope) {
                  if (!drawings.length && !placing && !temp) return;
                  paint(scope.context, scope.mediaSize.width, scope.mediaSize.height);
                });
              },
            };
          },
        }];
      },
    };
    series.attachPrimitive(primitive);

    // ------------------------------------------------------------------
    // interaction
    // ------------------------------------------------------------------
    function select(id) { if (selId !== id) { selId = id; requestUpdate(); refreshBar(); } }
    function selected() { for (var i = 0; i < drawings.length; i++) if (drawings[i].id === selId) return drawings[i]; return null; }

    function setTool(id, silent) {
      if (tool !== id) { placing = null; placingMoved = false; downPt = null; }
      tool = id;
      if (id !== "measure") temp = null;
      if (id !== "cursor") select(null);
      if (!silent) { requestUpdate(); refreshBar(); }
    }
    function finish(d) {
      if (d.type === "measure") { temp = d; placing = null; placingMoved = false; downPt = null; tool = "cursor"; requestUpdate(); refreshBar(); return; }
      snap();
      drawings.push(d);
      placing = null; placingMoved = false; downPt = null;
      select(d.id);
      if (!stay) setTool("cursor", true);
      changed();
    }
    function newDrawing(type, pts) { return { id: uid(), type: type, color: color, points: pts }; }

    async function askText() {
      var msg = "Note text:";
      try {
        if (window.UIModal && typeof window.UIModal.prompt === "function") return await window.UIModal.prompt(msg, "", { title: "Chart note", confirmLabel: "Add" });
      } catch (e) { /* fall through */ }
      try { return window.prompt(msg, ""); } catch (e) { return null; }
    }

    function ownEvent(e) { e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); }

    function onPointerDown(e) {
      if (disposed || !isFs()) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest(".chart-draw-bar, .cd-pop, .chart-fs-btn, .chart-zoom-tools, .chart-fs-only")) return;
      var pt = localPt(e);
      if (!inPlot(pt)) return;

      if (tool === "cursor") {
        var sel = selected();
        if (sel) {
          var hi = hitHandle(sel, pt);
          if (hi != null) { snap(); drag = { kind: "handle", idx: hi, id: sel.id }; swallow = true; ownEvent(e); return; }
        }
        var h = hitTest(pt);
        if (h) {
          select(h.id);
          snap();
          var a0 = toAnchorRaw(pt);
          drag = { kind: "move", id: h.id, start: a0, orig: clone(h.points) };
          swallow = true; ownEvent(e); return;
        }
        if (temp) { temp = null; requestUpdate(); }
        select(null);
        return; // empty space: let the chart pan as usual
      }

      swallow = true; ownEvent(e);
      var a = toAnchor(pt);
      if (!a) return;

      if (placing) { placing.points[1] = a; finish(placing); return; }
      if (tool === "hline") { finish(newDrawing("hline", [a])); return; }
      if (tool === "text") {
        askText().then(function (txt) {
          if (txt == null || !String(txt).trim()) return;
          var d = newDrawing("text", [a]); d.text = String(txt).trim().slice(0, 80);
          finish(d);
        });
        return;
      }
      if (temp) temp = null;
      placing = newDrawing(tool, [a, { t: a.t, p: a.p }]);
      placingMoved = false; downPt = pt;
      requestUpdate();
    }

    // Raw (un-snapped) anchor for drag maths.
    function toAnchorRaw(pt) {
      var T = times();
      var lg = ts.coordinateToLogical(pt.x), price = series.coordinateToPrice(pt.y);
      if (lg == null || price == null || !T.length) return null;
      return { lg: lg, p: price };
    }

    function onPointerMove(e) {
      if (disposed || (!placing && !drag)) return;
      var pt = localPt(e);
      if (drag) {
        var d = null;
        for (var i = 0; i < drawings.length; i++) if (drawings[i].id === drag.id) d = drawings[i];
        if (!d) return;
        var T = times();
        if (drag.kind === "handle") {
          var a = toAnchor(pt);
          if (!a) return;
          if (d.type === "hline") d.points[0].p = a.p; else d.points[drag.idx] = a;
        } else {
          var cur = toAnchorRaw(pt);
          if (!cur || !drag.start) return;
          var dIdx = cur.lg - drag.start.lg, dP = cur.p - drag.start.p;
          d.points = drag.orig.map(function (op) {
            if (d.type === "hline") return { t: op.t, p: op.p + dP };
            var oi = timeToIdx(op.t, T);
            return { t: idxToTime(oi + dIdx, T), p: op.p + dP };
          });
        }
        persist(); requestUpdate();
        e.preventDefault();
        return;
      }
      if (placing) {
        if (downPt && Math.hypot(pt.x - downPt.x, pt.y - downPt.y) > 5) placingMoved = true;
        var an = toAnchor(pt);
        if (an) { placing.points[1] = an; requestUpdate(); }
      }
    }

    function onPointerUp() {
      if (drag) { drag = null; changed(); }
      if (placing && placingMoved) finish(placing); // press-drag-release draws in one gesture
      swallow = false;
    }

    // The chart listens for mouse / touch events (not pointer events), so when
    // we own the gesture we stop those before they reach it.
    function onSwallow(e) { if (swallow) ownEvent(e); }

    function onKey(e) {
      if (disposed || !isFs()) return;
      var tg = e.target, tag = tg && tg.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (tg && tg.isContentEditable)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected()) { e.preventDefault(); removeSelected(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) { e.preventDefault(); undo(); }
    }

    el.addEventListener("pointerdown", onPointerDown, true);
    el.addEventListener("mousedown", onSwallow, true);
    el.addEventListener("touchstart", onSwallow, { capture: true, passive: false });
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKey);

    // ------------------------------------------------------------------
    // actions
    // ------------------------------------------------------------------
    function removeSelected() {
      var s = selected();
      if (!s) return;
      snap();
      drawings = drawings.filter(function (d) { return d.id !== s.id; });
      selId = null;
      changed();
    }
    function undo() {
      if (!undoStack.length) return;
      try { drawings = JSON.parse(undoStack.pop()); } catch (e) { return; }
      if (!selected()) selId = null;
      placing = null; temp = null;
      changed();
    }
    async function clearAll() {
      if (!drawings.length) return;
      var ok = true;
      try {
        if (window.UIModal && typeof window.UIModal.confirm === "function") ok = await window.UIModal.confirm("Remove all drawings on this chart?", { title: "Clear drawings", tone: "danger", confirmLabel: "Clear all" });
        else ok = window.confirm("Remove all drawings on this chart?");
      } catch (e) { ok = true; }
      if (!ok) return;
      snap();
      drawings = []; selId = null; temp = null; placing = null;
      changed();
    }
    function setColor(c) {
      color = c; savePrefs();
      var s = selected();
      if (s) { snap(); s.color = c; changed(); } else refreshBar();
    }

    // ------------------------------------------------------------------
    // toolbar (only visible while the chart is fullscreen -- see common.css)
    // ------------------------------------------------------------------
    var cs = null;
    try { cs = window.getComputedStyle(el); } catch (e) { /* ignore */ }
    if (cs && cs.position === "static") el.style.position = "relative";

    var bar = document.createElement("div");
    bar.className = "chart-draw-bar";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Drawing tools");
    var pop = document.createElement("div");
    pop.className = "cd-pop";
    COLORS.forEach(function (c) {
      var s = document.createElement("button");
      s.type = "button"; s.className = "cd-swatch"; s.style.background = c; s.setAttribute("aria-label", "Color " + c);
      s.addEventListener("click", function (ev) { ev.stopPropagation(); setColor(c); pop.classList.remove("open"); });
      pop.appendChild(s);
    });

    var btns = {};
    function mk(id, icon, label, onClick, extraClass) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "cd-btn" + (extraClass ? " " + extraClass : "");
      b.setAttribute("aria-label", label); b.title = label;
      b.innerHTML = icon;
      b.addEventListener("click", function (ev) { ev.stopPropagation(); onClick(ev); });
      bar.appendChild(b); btns[id] = b;
      return b;
    }
    function sep() { var s = document.createElement("div"); s.className = "cd-sep"; bar.appendChild(s); }

    TOOLS.forEach(function (t) {
      mk(t.id, ICON[t.id], t.label, function () { setTool(tool === t.id && t.id !== "cursor" ? "cursor" : t.id); pop.classList.remove("open"); });
    });
    sep();
    var colorBtn = mk("color", '<span class="cd-dot"></span>', "Line color", function () { pop.classList.toggle("open"); });
    mk("magnet", ICON.magnet, "Snap to candle highs / lows / opens / closes", function () { magnet = !magnet; savePrefs(); refreshBar(); });
    mk("stay", ICON.stay, "Stay in the selected tool after each drawing", function () { stay = !stay; savePrefs(); refreshBar(); });
    sep();
    mk("undo", ICON.undo, "Undo (Ctrl+Z)", undo);
    mk("trash", ICON.trash, "Delete selected (Del)", removeSelected);
    mk("clear", ICON.clear, "Clear all drawings on this chart", clearAll);
    el.appendChild(bar);
    el.appendChild(pop); // outside the bar: the bar scrolls, which would clip the popover
    document.addEventListener("click", function closePop(ev) {
      if (disposed) { document.removeEventListener("click", closePop); return; }
      if (!bar.contains(ev.target) && !pop.contains(ev.target)) pop.classList.remove("open");
    });

    function refreshBar() {
      if (disposed) return;
      TOOLS.forEach(function (t) { btns[t.id].classList.toggle("on", tool === t.id); });
      btns.magnet.classList.toggle("on", magnet);
      btns.stay.classList.toggle("on", stay);
      btns.undo.disabled = !undoStack.length;
      btns.trash.disabled = !selected();
      btns.clear.disabled = !drawings.length;
      var s = selected();
      colorBtn.querySelector(".cd-dot").style.background = (s && s.color) || color;
    }
    refreshBar();

    return {
      setActive: function (on) {
        // fullscreen opened / closed
        if (!on) { placing = null; placingMoved = false; drag = null; swallow = false; temp = null; selId = null; tool = "cursor"; pop.classList.remove("open"); }
        requestUpdate(); refreshBar();
      },
      // Esc: back out of the tool / selection first; only then close fullscreen.
      escape: function () {
        if (placing || temp || tool !== "cursor" || selId) {
          placing = null; placingMoved = false; temp = null; tool = "cursor"; selId = null;
          requestUpdate(); refreshBar();
          return true;
        }
        return false;
      },
      count: function () { return drawings.length; },
      dispose: function () {
        disposed = true;
        el.removeEventListener("pointerdown", onPointerDown, true);
        el.removeEventListener("mousedown", onSwallow, true);
        el.removeEventListener("touchstart", onSwallow, true);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        window.removeEventListener("keydown", onKey);
        try { series.detachPrimitive(primitive); } catch (e) { /* chart may already be gone */ }
        if (bar.parentNode) bar.parentNode.removeChild(bar);
        if (pop.parentNode) pop.parentNode.removeChild(pop);
      },
    };
  }

  window.ChartDraw = { attach: attach };
})();
