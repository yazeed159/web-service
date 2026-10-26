// app-boot.js -- tiny script loaded FIRST on every page (before utils.js). Three jobs:
//
//  1. MarketDate   -- "today" as the US market sees it (America/New_York), not the device's local
//                     date. From Cairo, after-hours trading runs past local midnight, so a trade
//                     taken at 6pm ET is already "tomorrow" locally and used to land on the wrong day.
//  2. Error safety net -- window.onerror / unhandledrejection used to fail silently. Now each one is
//                     logged (console + a small ring buffer in localStorage) and shown as a toast.
//  3. Cold-start notice -- the Render free tier sleeps outside the daily-sync window, so the first
//                     request can take 30-60s. We ping /health when a page loads and show a
//                     "waking up the server..." banner whenever a call to the service is slow.
//
// Pure parts (MarketDate) also run under Node: tests/market-date.test.js.
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ 1. MarketDate
  var MARKET_TZ = "America/New_York";
  var dtf = null;

  function parts(d) {
    if (!dtf) {
      dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: MARKET_TZ, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23",
      });
    }
    var o = {};
    dtf.formatToParts(d || new Date()).forEach(function (p) { o[p.type] = p.value; });
    return o;
  }

  // "YYYY-MM-DD" in New York for the given instant (default: now).
  function etDate(d) {
    var p = parts(d);
    return p.year + "-" + p.month + "-" + p.day;
  }

  // "HH:MM" in New York for the given instant (default: now).
  function etTime(d) {
    var p = parts(d);
    return p.hour + ":" + p.minute;
  }

  // Calendar arithmetic on ISO date strings -- no timezone involved, so no DST surprises.
  function addDays(iso, n) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
    if (!m) return iso;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n));
    return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
  }

  var MarketDate = { tz: MARKET_TZ, today: function () { return etDate(new Date()); }, etDate: etDate, etTime: etTime, addDays: addDays };

  if (typeof module !== "undefined" && module.exports) module.exports = MarketDate;
  if (typeof window === "undefined" || typeof document === "undefined") return;   // Node: pure part only

  var win = window;
  win.MarketDate = MarketDate;

  // ------------------------------------------------------------------ 2. Error safety net
  var LOG_KEY = "trade.log:errors";
  var LOG_MAX = 30;
  var TOAST_GAP_MS = 4000, SAME_MSG_GAP_MS = 30000;
  var lastToastAt = 0, seenAt = {};
  win.__errorLog = [];

  // Browser noise that isn't a bug in the app.
  var IGNORE = [/ResizeObserver loop/i, /^Script error\.?$/i, /AbortError/i, /operation was aborted/i, /Non-Error promise rejection/i];
  var NETWORK = /Failed to fetch|NetworkError|Load failed|network request failed/i;

  function text(x) {
    if (x == null) return "Unknown error";
    if (typeof x === "string") return x;
    return String(x.message || x.reason || x);
  }

  function remember(entry) {
    win.__errorLog.push(entry);
    if (win.__errorLog.length > LOG_MAX) win.__errorLog.shift();
    try { localStorage.setItem(LOG_KEY, JSON.stringify(win.__errorLog)); } catch (e) { /* storage full / blocked */ }
  }

  function toast(msg, details) {
    var now = Date.now();
    if (now - lastToastAt < TOAST_GAP_MS) return;
    if (seenAt[msg] && now - seenAt[msg] < SAME_MSG_GAP_MS) return;
    function go() {
      if (typeof win.showToast !== "function") return;
      lastToastAt = now; seenAt[msg] = now;
      var opts = { tone: "error", duration: 8000 };
      if (details && navigator.clipboard && navigator.clipboard.writeText) {
        opts.action = { label: "Copy details", onClick: function () { navigator.clipboard.writeText(details).catch(function () {}); } };
      }
      win.showToast(msg, opts);
    }
    if (document.body) go(); else document.addEventListener("DOMContentLoaded", go, { once: true });
  }

  // Sends an error to the chart service (POST /client-errors) so it shows up in Render's logs, not just
  // on this device. Best effort and silent: at most SHIP_MAX distinct errors per page load, signed-in
  // users only, and it uses the unwrapped fetch so a slow report never triggers the wake-up banner.
  var SHIP_MAX = 8, shipped = 0, shippedKeys = {};
  function ship(entry) {
    try {
      var key = entry.kind + "|" + entry.msg + "|" + entry.page;
      if (shippedKeys[key] || shipped >= SHIP_MAX) return;
      var base = String(win.CHART_SERVICE_URL || "").replace(/\/+$/, "");
      var send = (typeof origFetch === "function") ? origFetch : win.fetch;
      if (!base || typeof send !== "function" || !win.sb || !win.sb.auth || typeof win.sb.auth.getSession !== "function") return;
      shippedKeys[key] = 1; shipped++;
      Promise.resolve(win.sb.auth.getSession()).then(function (res) {
        var session = res && res.data && res.data.session;
        if (!session || !session.access_token) return;
        return send.call(win, base + "/client-errors", {
          method: "POST", keepalive: true,
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + session.access_token },
          body: JSON.stringify({ t: entry.t, kind: entry.kind, msg: entry.msg, where: entry.where, page: entry.page, stack: entry.stack, ua: (navigator.userAgent || "").slice(0, 200) })
        });
      }).catch(function () { /* reporting must never raise its own error */ });
    } catch (e) { /* ignore */ }
  }

  function report(kind, err, where) {
    var msg = text(err);
    for (var i = 0; i < IGNORE.length; i++) if (IGNORE[i].test(msg)) return;
    var entry = { t: new Date().toISOString(), kind: kind, msg: msg.slice(0, 300), where: where || "", page: location.pathname, stack: (err && err.stack ? String(err.stack) : "").slice(0, 800) };
    try { console.error("[trade.log] " + kind + ":", err); } catch (e) { /* console missing */ }
    remember(entry);
    if (NETWORK.test(msg)) {
      if (navigator.onLine === false) return;   // the offline handling elsewhere already says so
      toast("Couldn't reach the server. Check your connection and try again.");
    } else {
      ship(entry);
      toast("Something went wrong on this page. If it looks stuck, reload it.", entry.t + " " + entry.kind + " " + entry.page + "\n" + entry.msg + (entry.where ? "\n" + entry.where : "") + (entry.stack ? "\n" + entry.stack : ""));
    }
  }

  win.addEventListener("error", function (e) {
    // Resource load failures (an <img>/<script> 404) bubble here without e.message; ignore those.
    if (!e || (!e.message && !e.error)) return;
    report("error", e.error || e.message, (e.filename || "") + ":" + (e.lineno || 0));
  });
  win.addEventListener("unhandledrejection", function (e) { report("unhandledrejection", e && e.reason); });
  // Pages can call this from their own catch blocks to get the same logging + toast.
  win.reportAppError = function (err, where) { report("caught", err, where); };

  // ------------------------------------------------------------------ 3. Cold-start notice
  var SLOW_MS = 3500;                  // a call slower than this might be a sleeping server
  var AWAKE_FOR_MS = 5 * 60 * 1000;    // after any good response, don't blame a slow call on sleep
  var PING_GAP_MS = 4 * 60 * 1000;
  var PING_TIMEOUT_MS = 75000;
  var WAKE_KEY = "trade.log:wake_ping";
  var awakeUntil = 0, slowCount = 0, banner = null, bannerTimer = null;

  function serviceBase() { return String(win.CHART_SERVICE_URL || "").replace(/\/+$/, ""); }
  function markAwake() { awakeUntil = Date.now() + AWAKE_FOR_MS; }

  function ensureStyle() {
    if (document.getElementById("wake-style")) return;
    var s = document.createElement("style");
    s.id = "wake-style";
    s.textContent =
      "#wake-banner{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 10px);transform:translateX(-50%);z-index:99999;display:flex;align-items:center;gap:10px;" +
      "max-width:min(92vw,460px);padding:10px 16px;border-radius:999px;font:500 13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;" +
      "background:var(--panel,#1c1f26);color:var(--text,#e8eaf0);border:1px solid var(--border,#3a3f4b);box-shadow:0 8px 28px rgba(0,0,0,.35)}" +
      "#wake-banner .wake-dot{flex:none;width:14px;height:14px;border-radius:50%;border:2px solid var(--primary,#6aa7ff);border-top-color:transparent;animation:wakeSpin .9s linear infinite}" +
      "@keyframes wakeSpin{to{transform:rotate(360deg)}}" +
      "@media (prefers-reduced-motion:reduce){#wake-banner .wake-dot{animation:none}}";
    document.head.appendChild(s);
  }

  function showBanner() {
    if (banner || navigator.onLine === false) return;
    ensureStyle();
    banner = document.createElement("div");
    banner.id = "wake-banner";
    banner.setAttribute("role", "status");
    banner.setAttribute("aria-live", "polite");
    banner.innerHTML = '<span class="wake-dot" aria-hidden="true"></span><span class="wake-msg">Waking up the server\u2026 the first request after a quiet spell can take up to a minute.</span>';
    document.documentElement.appendChild(banner);
    bannerTimer = setTimeout(function () {
      var m = banner && banner.querySelector(".wake-msg");
      if (m) m.textContent = "Still waking up the server\u2026 almost there.";
    }, 20000);
  }

  function hideBanner() {
    clearTimeout(bannerTimer);
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  // Runs `startFn` (returns a promise) and shows the banner if it is still pending after SLOW_MS
  // while the server isn't known to be awake. Resolves/rejects exactly like startFn's promise.
  function watch(startFn) {
    var counted = false;
    var t = setTimeout(function () {
      if (Date.now() < awakeUntil) return;
      counted = true; slowCount++; showBanner();
    }, SLOW_MS);
    function done() {
      clearTimeout(t);
      if (counted) { slowCount = Math.max(0, slowCount - 1); if (!slowCount) hideBanner(); }
    }
    var p = startFn();
    p.then(function () { markAwake(); done(); }, done);
    return p;
  }

  // Wrap fetch ONLY for calls to the chart service; everything else is untouched.
  var origFetch = win.fetch;
  if (typeof origFetch === "function") {
    win.fetch = function (input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var b = serviceBase();
      var self = this, args = arguments;
      if (!b || url.indexOf(b) !== 0) return origFetch.apply(self, args);
      return watch(function () { return origFetch.apply(self, args); });
    };
  }

  function ping() {
    var b = serviceBase();
    if (!b || typeof origFetch !== "function" || navigator.onLine === false) return;
    var last = 0;
    try { last = Number(sessionStorage.getItem(WAKE_KEY)) || 0; } catch (e) { /* ignore */ }
    if (Date.now() - last < PING_GAP_MS) return;
    try { sessionStorage.setItem(WAKE_KEY, String(Date.now())); } catch (e) { /* ignore */ }
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var kill = ctl ? setTimeout(function () { ctl.abort(); }, PING_TIMEOUT_MS) : null;
    watch(function () {
      return origFetch(b + "/health", { cache: "no-store", signal: ctl ? ctl.signal : undefined });
    }).then(function () { clearTimeout(kill); }, function () {
      clearTimeout(kill);
      try { sessionStorage.removeItem(WAKE_KEY); } catch (e) { /* ignore */ }   // let the next page retry
    });
  }

  win.WakeServer = { ping: ping, watch: watch, isAwake: function () { return Date.now() < awakeUntil; } };

  // config.js loads after this file, so wait until the document has parsed to read CHART_SERVICE_URL.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ping, { once: true }); else ping();
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") ping(); });
})(typeof window !== "undefined" ? window : this);
