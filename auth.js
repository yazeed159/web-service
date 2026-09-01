// Shared auth + data layer for every page (except login.html's own
// script, which uses window.sb directly once this has run).
//
// Load order matters -- every HTML page now has, in this order:
//   config.js  (sets window.SUPABASE_URL / SUPABASE_ANON_KEY)
//   supabase-js CDN  (defines window.supabase)
//   auth.js  (this file)
//
// RLS on trades / trade_details / broker_accounts scopes every query to
// auth.uid() automatically once the user is logged in -- there's no
// user_id filtering to do client-side, and no way for one logged-in user
// to see another's rows even though everyone shares the same anon key.
(function () {
  "use strict";

  var SUPABASE_URL = window.SUPABASE_URL;
  var SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("auth.js: window.SUPABASE_URL / SUPABASE_ANON_KEY are not set -- check config.js.");
    return;
  }
  if (!window.supabase || !window.supabase.createClient) {
    console.error("auth.js: supabase-js didn't load -- check the CDN <script> tag ran before auth.js.");
    return;
  }

  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  var isLoginPage = /\/login(\.html)?\/?$/.test(window.location.pathname);

  function addLogoutButton() {
    if (document.getElementById("auth-logout-btn")) return;
    var btn = document.createElement("button");
    btn.id = "auth-logout-btn";
    btn.textContent = "Log out";
    btn.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:9999;padding:6px 14px;" +
      "border-radius:8px;border:1px solid rgba(255,255,255,.18);" +
      "background:rgba(20,20,28,.85);color:#eee;font:12.5px system-ui,sans-serif;" +
      "cursor:pointer;backdrop-filter:blur(4px);";
    btn.addEventListener("click", function () {
      window.sb.auth.signOut().then(function () {
        window.location.href = "login";
      });
    });
    document.body.appendChild(btn);
  }

  // Every protected page awaits this before it's allowed to query data.
  // Resolves to the session object, or null (and redirects) if signed out.
  window.AUTH_READY = window.sb.auth.getSession().then(function (res) {
    var session = res && res.data && res.data.session;
    if (!session) {
      if (!isLoginPage) window.location.href = "login";
      return null;
    }
    if (isLoginPage) {
      window.location.href = "/";
      return null;
    }
    addLogoutButton();
    return session;
  });

  // Keep behavior in sync if the session changes in another tab, or
  // expires mid-visit.
  window.sb.auth.onAuthStateChange(function (_event, session) {
    if (!session && !isLoginPage) window.location.href = "login";
  });

  // ------------------------------------------------------------------
  // Data helpers. These replace the old fetch("data/trades.json") /
  // fetch("data/trades/<id>.json") calls -- same output shapes, so
  // existing page code only needs to swap the fetch call itself.
  // ------------------------------------------------------------------

  // Returns a Promise<Array> of trade rows, sorted the same way the
  // publish pipeline sorts data/trades.json (trade_date, entry_time).
  window.fetchTradesIndex = function () {
    return window.AUTH_READY.then(function (session) {
      if (!session) return [];
      return window.sb
        .from("trades")
        .select("*")
        .order("trade_date", { ascending: true })
        .order("entry_time", { ascending: true })
        .then(function (res) {
          if (res.error) throw new Error(res.error.message);
          return res.data || [];
        });
    });
  };

  // Returns a Promise<Object|null> matching the old data/trades/<id>.json
  // shape: the trades row and its trade_details row merged into one
  // object (verdict, indicators, bars, better_entry/better_exit, etc.
  // live in trade_details; symbol/prices/pnl/etc. live in trades).
  window.fetchTradeDetail = function (id) {
    return window.AUTH_READY.then(function (session) {
      if (!session) return null;
      return Promise.all([
        window.sb.from("trades").select("*").eq("id", id).maybeSingle(),
        window.sb.from("trade_details").select("*").eq("trade_id", id).maybeSingle(),
      ]).then(function (results) {
        var tradeRes = results[0];
        var detailRes = results[1];
        if (tradeRes.error) throw new Error(tradeRes.error.message);
        if (!tradeRes.data) throw new Error("Trade not found (or not yours)");
        if (detailRes.error) throw new Error(detailRes.error.message);
        return Object.assign({}, tradeRes.data, detailRes.data || {});
      });
    });
  };
})();
