// sw.js -- app-shell cache for trade.log.
//
// Goal: make every page-to-page navigation come out of the device instead of
// the network, so a navigation is limited by rendering, not by latency.
//
//  * On install, the core shell (pages, css, shared js, icons) is pre-cached. The big
//    single-page scripts (Reports, Rewind, Practice, Backtester, Live Trading, Edge
//    Analysis, report.js, the charts library) are NOT -- they're cached the first time
//    you open them, so a fresh install on mobile data doesn't pull what you haven't asked for.
//  * Same-origin GETs are NETWORK-FIRST (cache is the offline / slow-network fallback),
//    so an installed app always runs the latest deploy without bumping a version.
//  * The two CDN scripts every page loads (supabase-js, lightweight-charts) are
//    cached the same way, so they stop being a per-navigation network hop.
//  * Share target: the manifest registers this app to receive a shared CSV (a broker
//    export shared from the Files / Gmail / Drive share sheet). That arrives as a POST
//    to /share-target, which is answered here: the file is parked in its own cache
//    (survives the shell purge below) and the browser is redirected to the Import page,
//    which picks it up. Nothing is uploaded until you tap Import.
//  * Everything else (Supabase API calls, the Render API, the live-trading
//    tunnel, POSTs) is never touched -- it goes straight to the network.
//
// Bump CACHE_VERSION only if you ever want to force-purge every cached file.
var CACHE_VERSION = "v39";
var CACHE = "tradelog-shell-" + CACHE_VERSION;

var SHELL = [
  "/", "index.html", "journal.html", "stats.html", "edge-analysis.html", "patterns.html", "calculator.html", "daily.html", "backtester.html",
  "rewind.html", "practice.html", "settings.html", "trade.html", "report.html", "scanner.html", "search.html", "import-trades.html",
  "live-trading.html", "accounts.html", "login.html", "favicon.svg", "manifest.json", "icons/icon-192.png", "icons/icon-512.png", "icons/shortcut-trade-note.png", "icons/shortcut-day-note.png", "icons/shortcut-journal.png", "icons/shortcut-daily-plan.png",
  "js/vendor/supabase.js", "css/common.css", "css/glass.css", "css/buttons.css", "css/dashboard.css", "css/rewind.css", "css/practice.css", "css/quiz-shared.css",
  "css/report.css", "css/ui-modal.css", "css/search.css", "js/utils.js", "js/mobile-extras.js", "js/today-strip.js", "js/config.js",
  "js/auth.js", "js/accounts.js", "js/page-transition.js", "js/nav-render.js", "js/global-search.js", "js/common.js", "js/select-enhance.js", "js/mobile-tables.js",
  "js/pwa-register.js", "js/grade.js", "js/trade-notes.js", "js/daily-notes.js", "js/discipline.js", "js/ui-modal.js", "js/chart-draw.js", "js/chart-indicators.js", "js/practice-mobile.js",
  "js/strategy-presets.js", "js/share-export.js", "js/app-shared.js", "js/app-dashboard.js", "js/app-dayview.js", "js/calculator.js",
  "js/trade.js", "js/scanner.js", "js/edge-stats.js"
];

// The pages load supabase-js and lightweight-charts from js/vendor/, so the old
// CDN copies were being downloaded on install and never used. Empty on purpose;
// the fetch handler below still supports entries if you ever add one back.
var CDN = [];

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


// ---- Share target (see manifest.json "share_target") ----
var SHARE_CACHE = "tradelog-share"; // deliberately NOT prefixed "tradelog-shell-", so activate() never purges it
var SHARE_KEY = "/__shared-csv__";

function handleShare(event) {
  event.respondWith((async function () {
    var dest = new URL("/import-trades.html?shared=1", self.location.origin).href;
    try {
      var form = await event.request.formData();
      var file = form.get("csv");
      if (!file || typeof file === "string") {
        // Some apps share the CSV as plain text instead of a file part.
        var text = form.get("text");
        if (typeof text === "string" && text.indexOf(",") !== -1 && text.indexOf("\n") !== -1) {
          file = new File([text], "shared.csv", { type: "text/csv" });
        } else {
          return Response.redirect(dest.replace("shared=1", "shared=none"), 303);
        }
      }
      var cache = await caches.open(SHARE_CACHE);
      await cache.put(new URL(SHARE_KEY, self.location.origin).href, new Response(file, {
        headers: {
          "Content-Type": file.type || "text/csv",
          "X-File-Name": encodeURIComponent(file.name || "shared.csv"),
        },
      }));
    } catch (err) {
      return Response.redirect(dest.replace("shared=1", "shared=error"), 303);
    }
    return Response.redirect(dest, 303);
  })());
}

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method === "POST" && new URL(req.url).pathname === "/share-target") { handleShare(event); return; }
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
        if (!hit) return refresh;
        if (!sameOrigin) {
          refresh.catch(function () {}); // CDN libs: stale-while-revalidate is fine
          return hit;
        }
        // The app's own pages/scripts/styles: NETWORK FIRST. Stale-while-revalidate
        // meant an installed app (which rarely does a cold navigation) kept showing
        // the previous deploy indefinitely. Online you now always get the latest;
        // if the network is slow (>4s) or down, the cached copy is served instead.
        return new Promise(function (resolve) {
          var done = false;
          var timer = setTimeout(function () { if (!done) { done = true; resolve(hit); } }, 4000);
          refresh.then(function (res) {
            clearTimeout(timer);
            if (!done) { done = true; resolve(res && (res.ok || res.type === "opaque") ? res : (res && res.status >= 300 && res.status < 400 ? res : hit)); }
          }, function () {
            clearTimeout(timer);
            if (!done) { done = true; resolve(hit); }
          });
        });
      });
    })
  );
});
