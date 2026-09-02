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

  // Builds the top-right "account" widget: a pill showing the user's
  // email that, when clicked, drops down a small panel with their
  // email, sign-up date, and a Log out button.
  //
  // IMPORTANT: this used to call document.body.appendChild() directly,
  // but this script runs from <head> before <body> exists. Session
  // lookups that resolve from local cache can finish before the parser
  // even gets to <body>, so document.body was sometimes still null --
  // that's the "Cannot read properties of null (reading 'appendChild')"
  // crash. insertWhenReady() below waits for DOMContentLoaded if body
  // isn't there yet, so this now always works.
  function insertWhenReady(el) {
    if (document.body) {
      document.body.appendChild(el);
    } else {
      document.addEventListener(
        "DOMContentLoaded",
        function () {
          document.body.appendChild(el);
        },
        { once: true }
      );
    }
  }

  function addAccountWidget(session) {
    if (document.getElementById("auth-account-widget")) return;
    var user = session.user || {};
    var email = user.email || "Account";

    // Every app-shell page puts a 40px hamburger button (#mobile-nav-btn)
    // flush against the same top-right corner once the viewport narrows
    // past 760px (see core.css's .icon-btn media query) -- and this
    // widget's base position below is fixed top:12px/right:12px with a
    // z-index high enough to always paint above it, so on a phone the
    // two sat directly on top of each other: the email pill visually
    // covered the hamburger AND ate its taps. This override (kept in a
    // <style> tag rather than core.css so it applies even on pages that
    // don't load core.css, like import-legacy.html) shifts the pill left
    // and shrinks it just enough to clear that button's footprint. Only
    // injected once, same as the widget itself.
    if (!document.getElementById("auth-account-widget-style")) {
      var style = document.createElement("style");
      style.id = "auth-account-widget-style";
      style.textContent =
        "@media (max-width:760px){" +
        "#auth-account-widget{right:58px !important;}" +
        "#auth-account-btn{max-width:130px !important;padding:6px 10px !important;font-size:12px !important;}" +
        "}";
      insertWhenReady(style);
    }

    var wrap = document.createElement("div");
    wrap.id = "auth-account-widget";
    wrap.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:9999;font:12.5px system-ui,sans-serif;";

    var btn = document.createElement("button");
    btn.id = "auth-account-btn";
    btn.textContent = email;
    btn.style.cssText =
      "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
      "padding:6px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.18);" +
      "background:rgba(20,20,28,.85);color:#eee;font:inherit;" +
      "cursor:pointer;backdrop-filter:blur(4px);display:block;";

    var panel = document.createElement("div");
    panel.style.cssText =
      "display:none;position:absolute;top:36px;right:0;min-width:220px;" +
      "padding:14px;border-radius:10px;border:1px solid rgba(255,255,255,.18);" +
      "background:rgba(20,20,28,.97);color:#eee;backdrop-filter:blur(6px);" +
      "box-shadow:0 8px 24px rgba(0,0,0,.4);";

    var emailRow = document.createElement("div");
    emailRow.textContent = "Signed in as " + email;
    emailRow.style.cssText = "margin-bottom:6px;word-break:break-all;";
    panel.appendChild(emailRow);

    if (user.created_at) {
      var sinceRow = document.createElement("div");
      var created = new Date(user.created_at);
      sinceRow.textContent = "Member since " + created.toLocaleDateString();
      sinceRow.style.cssText = "color:#999;font-size:11.5px;margin-bottom:12px;";
      panel.appendChild(sinceRow);
    }

    var logoutBtn = document.createElement("button");
    logoutBtn.id = "auth-logout-btn";
    logoutBtn.textContent = "Log out";
    logoutBtn.style.cssText =
      "width:100%;padding:8px 0;border:none;border-radius:8px;" +
      "background:linear-gradient(90deg,#8457ff,#22d3ee);color:#0b0b12;" +
      "font-weight:600;font:inherit;cursor:pointer;";
    logoutBtn.addEventListener("click", function () {
      window.sb.auth.signOut().then(function () {
        window.location.href = "login";
      });
    });
    panel.appendChild(logoutBtn);

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      panel.style.display = panel.style.display === "none" ? "block" : "none";
    });
    document.addEventListener("click", function () {
      panel.style.display = "none";
    });

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    insertWhenReady(wrap);
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
    addAccountWidget(session);
    return session;
  });

  // Keep behavior in sync if the session changes in another tab, or
  // expires mid-visit.
  window.sb.auth.onAuthStateChange(function (_event, session) {
    if (!session && !isLoginPage) window.location.href = "login";
  });

  // ------------------------------------------------------------------
  // KV -- generic per-user key/value sync against the `user_kv` table,
  // for everything that used to live ONLY in localStorage (practice
  // account, rewind/quiz history, calculator + backtester settings,
  // locally-imported backtest reports, trade grades' pre-Sept-2026
  // history, etc). Nothing here removes localStorage -- every module
  // still reads/writes it directly for an instant, offline-safe first
  // paint -- this just makes sure the same value also lands in
  // Supabase, so switching browsers or clearing site data doesn't lose
  // it. See README/grade.js-style comments in each module for the
  // per-feature key names.
  //
  //   KV.ready               -- Promise<session|null>, resolves once the
  //                              whole user_kv table has been pulled down
  //   KV.get(key)             -- sync read of the cached remote value
  //                              (undefined until KV.ready resolves, or
  //                              if nothing's been synced under that key)
  //   KV.set(key, value)      -- fire-and-forget upsert; updates the
  //                              local cache immediately
  //   KV.sync(key, onRemote)  -- call once per feature at page load:
  //                              once KV.ready resolves, if Supabase
  //                              already has a value for `key` it wins
  //                              (onRemote(value) is called so the
  //                              caller can overwrite its localStorage
  //                              copy + re-render); otherwise, whatever
  //                              is currently in localStorage under that
  //                              same key gets pushed up as the seed
  //                              (one-time migration, so old
  //                              browser-only data isn't stranded).
  window.KV = (function () {
    var cache = {};
    var loaded = false;

    var ready = window.AUTH_READY.then(function (session) {
      if (!session) return null;
      return window.sb
        .from("user_kv")
        .select("key,value")
        .then(function (res) {
          if (!res.error && res.data) {
            res.data.forEach(function (row) {
              cache[row.key] = row.value;
            });
          } else if (res.error) {
            console.error("KV: initial load failed:", res.error.message);
          }
          loaded = true;
          return session;
        });
    });

    function get(key) {
      return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : undefined;
    }

    function set(key, value) {
      cache[key] = value;
      ready.then(function (session) {
        if (!session) return;
        return window.sb
          .from("user_kv")
          .upsert({ user_id: session.user.id, key: key, value: value })
          .then(function (res) {
            if (res.error) console.error("KV.set(" + key + ") failed:", res.error.message);
          });
      });
    }

    function del(key) {
      delete cache[key];
      ready.then(function (session) {
        if (!session) return;
        return window.sb
          .from("user_kv")
          .delete()
          .eq("user_id", session.user.id)
          .eq("key", key);
      });
    }

    function sync(key, onRemote) {
      ready.then(function (session) {
        if (!session) return;
        var remote = get(key);
        if (remote !== undefined) {
          if (typeof onRemote === "function") onRemote(remote);
        } else {
          var raw = null;
          try { raw = localStorage.getItem(key); } catch (e) { /* ignore */ }
          if (raw !== null) {
            try { set(key, JSON.parse(raw)); } catch (e) { /* not JSON, skip */ }
          }
        }
      });
    }

    return { ready: ready, get: get, set: set, delete: del, sync: sync, isLoaded: function () { return loaded; } };
  })();

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
