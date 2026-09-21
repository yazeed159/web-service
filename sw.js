// sw.js -- app-shell cache for trade.log.
//
// Goal: make every page-to-page navigation come out of the device instead of
// the network, so a navigation is limited by rendering, not by latency.
//
//  * On install, the whole static shell (pages, css, js, icons) is pre-cached.
//  * Same-origin GETs are served stale-while-revalidate: instant from cache,
//    quietly refreshed in the background, so a deploy shows up one navigation
//    later without anyone bumping a version number.
//  * The two CDN scripts every page loads (supabase-js, lightweight-charts) are
//    cached the same way, so they stop being a per-navigation network hop.
//  * Everything else (Supabase API calls, the Render API, the live-trading
//    tunnel, POSTs) is never touched -- it goes straight to the network.
//
// Bump CACHE_VERSION only if you ever want to force-purge every cached file.
var CACHE_VERSION = "v3";
var CACHE = "tradelog-shell-" + CACHE_VERSION;

var SHELL = [
  "/", "index.html", "journal.html", "stats.html", "edge-analysis.html", "patterns.html",
  "calculator.html", "daily.html", "backtester.html", "rewind.html", "practice.html", "settings.html",
  "trade.html", "report.html", "scanner.html", "search.html", "import-trades.html",
  "live-trading.html", "login.html", "favicon.svg", "manifest.json",
  "icons/icon-192.png", "icons/icon-512.png",
  "css/common.css", "css/buttons.css", "css/dashboard.css", "css/rewind.css", "css/practice.css",
  "css/quiz-shared.css", "css/report.css", "css/ui-modal.css", "css/search.css",
  "js/utils.js", "js/config.js", "js/auth.js", "js/page-transition.js", "js/nav-render.js",
  "js/global-search.js", "js/common.js", "js/pwa-register.js", "js/grade.js", "js/trade-notes.js", "js/daily-notes.js", "js/discipline.js", "js/ui-modal.js",
  "js/chart-indicators.js", "js/strategy-presets.js", "js/share-export.js",
  "js/app-shared.js", "js/app-dashboard.js", "js/app-dayview.js", "js/app-reports.js",
  "js/calculator.js", "js/trade.js", "js/scanner.js", "js/rewind.js", "js/report.js",
  "js/practice.js", "js/practice-analytics.js", "js/live-trading.js", "js/edge-analysis.js", "js/edge-stats.js",
  "js/backtester.js", "js/backtester-ai.js"
];

var CDN = [
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js",
  "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"
];

// A response that followed a redirect can't be handed back for a navigation
// request, so rebuild it as a plain response before storing it.
function clean(res) {
  if (!res.redirected) return Promise.resolve(res);
  return res.blob().then(function (b) {
    return new Response(b, { status: 200, statusText: "OK", headers: res.headers });
  });
}

function keyFor(url) {
  var u = new URL(url, self.location.origin);
  u.search = "";
  u.hash = "";
  return u.href;
}

// "/journal", "/journal.html" and "/journal/" are all the same page.
function candidates(url) {
  var u = new URL(url, self.location.origin);
  var p = u.pathname;
  var out = [u.origin + p];
  if (p === "/" || p === "") out.push(u.origin + "/index.html");
  if (/\.html$/.test(p)) out.push(u.origin + p.replace(/\.html$/, ""));
  else if (!/\.[a-z0-9]+$/i.test(p)) out.push(u.origin + p.replace(/\/$/, "") + ".html");
  return out;
}

function cacheMatch(cache, url) {
  var list = candidates(url);
  var chain = Promise.resolve(undefined);
  list.forEach(function (k) {
    chain = chain.then(function (hit) { return hit || cache.match(k); });
  });
  return chain;
}

function store(cache, url, res) {
  if (!res || !(res.ok || res.type === "opaque")) return Promise.resolve();
  return clean(res.clone()).then(function (r) {
    // Store under every spelling of the URL so any of them hits.
    return Promise.all(candidates(url).map(function (k) { return cache.put(k, r.clone()); }));
  }).catch(function () {});
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      var jobs = SHELL.map(function (path) {
        var url = new URL(path, self.location.href).href;
        // cache:"reload" skips the HTTP cache so a fresh deploy is what gets stored.
        return fetch(url, { cache: "reload", credentials: "same-origin" })
          .then(function (res) { return store(cache, url, res); })
          .catch(function () {}); // a missing file must not fail the whole install
      });
      CDN.forEach(function (url) {
        jobs.push(
          fetch(new Request(url, { mode: "no-cors" }))
            .then(function (res) { return store(cache, url, res); })
            .catch(function () {})
        );
      });
      return Promise.all(jobs);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k.indexOf("tradelog-shell-") === 0 && k !== CACHE;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;
  var isCdn = CDN.indexOf(req.url) !== -1;
  if (!sameOrigin && !isCdn) return; // APIs, tunnels, fonts, etc. -> network as usual
  if (sameOrigin && url.pathname === "/sw.js") return;

  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      var lookup = sameOrigin ? cacheMatch(cache, req.url) : cache.match(req.url);
      return lookup.then(function (hit) {
        var refresh = fetch(req).then(function (res) {
          // Redirects (e.g. /journal.html -> /journal) are passed straight through for
          // navigations; the redirect target is fetched and cached on its own.
          if (res && (res.ok || res.type === "opaque")) {
            store(cache, sameOrigin ? keyFor(req.url) : req.url, res);
          }
          return res;
        });
        if (hit) {
          refresh.catch(function () {}); // background update; ignore failures (offline)
          return hit;
        }
        return refresh;
      });
    })
  );
});
