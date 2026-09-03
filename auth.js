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

  // Renders as a small round avatar icon (initial letter) rather than
  // the full email address -- the email/join-date/logout/settings all
  // live in the dropdown panel instead of sitting in the topbar as
  // permanent text.
  function addAccountWidget(session) {
    if (document.getElementById("auth-account-widget")) return;
    var user = session.user || {};
    var email = user.email || "Account";
    var initial = email.charAt(0).toUpperCase() || "?";

    var wrap = document.createElement("div");
    wrap.id = "auth-account-widget";
    wrap.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:9999;font:12.5px system-ui,sans-serif;";

    var btn = document.createElement("button");
    btn.id = "auth-account-btn";
    btn.type = "button";
    btn.title = email;
    btn.setAttribute("aria-label", "Account menu (" + email + ")");
    btn.textContent = initial;
    btn.style.cssText =
      "width:32px;height:32px;border-radius:50%;padding:0;" +
      "display:flex;align-items:center;justify-content:center;" +
      "border:1px solid rgba(255,255,255,.18);" +
      "background:rgba(20,20,28,.85);color:#eee;font:600 13px inherit;" +
      "cursor:pointer;backdrop-filter:blur(4px);";

    var panel = document.createElement("div");
    panel.style.cssText =
      "display:none;position:absolute;top:40px;right:0;min-width:220px;" +
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

    var settingsLink = document.createElement("a");
    settingsLink.href = "settings.html";
    settingsLink.textContent = "Account settings";
    settingsLink.style.cssText =
      "display:block;margin-bottom:10px;color:#9d8bff;text-decoration:none;font-size:12.5px;";
    panel.appendChild(settingsLink);

    var logoutBtn = document.createElement("button");
    logoutBtn.id = "auth-logout-btn";
    logoutBtn.type = "button";
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
  // Capital ledger -- deposits/withdrawals the user records on the
  // Settings page (KV key "capital_ledger": array of {date, amount, note},
  // positive amount = deposit, negative = withdrawal). No entries yet ->
  // [] -> computeAccountBalances below degrades to plain cumulative P&L,
  // i.e. unchanged behavior for anyone who hasn't touched Settings.
  window.fetchCapitalLedger = function () {
    return window.AUTH_READY.then(function (session) {
      if (!session || !window.KV) return [];
      return window.KV.ready.then(function () {
        var entries = window.KV.get("capital_ledger");
        if (!Array.isArray(entries)) return [];
        return entries
          .filter(function (e) { return e && typeof e.date === "string" && isFinite(e.amount); })
          .slice()
          .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
      });
    });
  };

  // Given trades (sorted ascending by trade_date/entry_time, each with
  // pnl_after_comm) and a date-sorted capital ledger, returns a same-
  // length array of real account-balance figures: the ledger balance as
  // of that trade's date (ledger entries dated on/before a trade count
  // toward it -- entries only carry a date, not a time, so same-day is
  // treated as "before") plus cumulative P&L up to and including that
  // trade. Deliberately kept separate from `equity_after` (pure
  // cumulative P&L) -- the Risk Calculator and the Cumulative P&L report
  // chart both depend on that figure staying exactly what it's always
  // been, so this never overwrites it, just adds an aligned array.
  window.computeAccountBalances = function (trades, ledger) {
    var cum = 0, li = 0, balance = 0;
    var out = new Array(trades.length);
    for (var i = 0; i < trades.length; i++) {
      var t = trades[i];
      while (li < ledger.length && ledger[li].date <= t.trade_date) {
        balance += ledger[li].amount;
        li++;
      }
      cum += t.pnl_after_comm || 0;
      out[i] = balance + cum;
    }
    return out;
  };

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
