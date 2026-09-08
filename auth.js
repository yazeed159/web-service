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

  // computeAccountBalances is pure math -- no Supabase dependency -- so it's
  // defined unconditionally, before either guard below, and never needs a
  // fallback of its own.
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

  // Installs safe fallback stubs for the rest of this file's public API
  // (window.AUTH_READY / window.KV / window.fetchTradesIndex / etc.) when
  // either guard below trips and the file has to bail out early.
  //
  // Every page on the site calls window.fetchTradesIndex() (and several
  // call window.AUTH_READY.then(...) directly) with no typeof check,
  // because until now this file unconditionally defined them -- so a
  // dropped/blocked/slow request for the Supabase CDN script (ad blocker,
  // corporate firewall, transient CDN outage, offline) left those globals
  // undefined and every page threw a synchronous, uncaught
  // "window.fetchTradesIndex is not a function" / "Cannot read properties
  // of undefined (reading 'then')" TypeError -- before the nice
  // `.catch(err => showEmptyState(...))` handlers already written on every
  // page ever got a chance to run. The site just silently failed to render
  // any data with no explanation to the person looking at it.
  //
  // The fix: still fail, but fail as a *rejected promise* through the
  // exact same functions callers already expect -- so their existing
  // .catch() blocks fire with a clear, honest error message instead of
  // the whole page's script dying partway through.
  function installOfflineStubs(reason) {
    var err = function () { return new Error(reason); };
    window.AUTH_READY = Promise.resolve(null); // treat as "logged out" for anything that already handles !session gracefully (KV, the account widget)
    window.KV = { ready: Promise.resolve(null), get: function () { return undefined; }, set: function () {}, delete: function () {}, sync: function () {}, isLoaded: function () { return false; } };
    window.fetchTradesIndex = function () { return Promise.reject(err()); };
    window.fetchCapitalLedger = function () { return Promise.reject(err()); };
    window.fetchTradeDetail = function () { return Promise.reject(err()); };
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("auth.js: window.SUPABASE_URL / SUPABASE_ANON_KEY are not set -- check config.js.");
    installOfflineStubs("Auth isn't configured (missing SUPABASE_URL/SUPABASE_ANON_KEY in config.js).");
    return;
  }
  if (!window.supabase || !window.supabase.createClient) {
    console.error("auth.js: supabase-js didn't load -- check the CDN <script> tag ran before auth.js.");
    installOfflineStubs("Couldn't reach Supabase (the auth/data library failed to load -- check your connection, ad blocker, or firewall, then reload).");
    return;
  }

  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  var isLoginPage = /\/login(\.html)?\/?$/.test(window.location.pathname);

  // Builds the top-right "account" widget: a pill showing the user's
  // email that, when clicked, drops down a small panel with their
  // email, sign-up date, and a Log out button.
  //
  // IMPORTANT: this runs from <head> before <body> exists, and session
  // lookups that resolve from local cache can finish before the parser
  // even gets to <body> -- so document.body can still be null here.
  // Drops the widget into the topbar's own icon row (same row the
  // search button and mobile-nav button live in), right after
  // whatever's already there. Falls back to a fixed corner placement
  // on the handful of pages that don't have the app-shell topbar at
  // all (chat, import flows, notes).
  function insertIntoTopbar(el) {
    function tryInsert() {
      var topbarRight = document.querySelector(".topbar-right");
      if (topbarRight) {
        topbarRight.appendChild(el);
        return true;
      }
      return false;
    }
    if (tryInsert()) return;
    document.addEventListener(
      "DOMContentLoaded",
      function () {
        if (!tryInsert()) {
          el.style.cssText += "position:fixed;top:12px;right:12px;z-index:9999;";
          document.body.appendChild(el);
        }
      },
      { once: true }
    );
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // Renders as a round gradient avatar (initials) with a chevron, rather
  // than the full email address -- name/email/join-date/settings/logout
  // all live in the dropdown panel instead of sitting in the topbar as
  // permanent text. Styling lives in common.css (.account-*) so this
  // widget matches the rest of the app's glass/gradient theme instead of
  // carrying its own hardcoded look.
  //
  // The account-settings link below used to point at a settings.html
  // that had no actual account section -- just capital ledger and
  // integrations -- so "Account settings" was a dead promise. It now
  // deep-links to settings.html#account-section, which has a real
  // profile/security panel (see settings.html).
  function addAccountWidget(session) {
    if (document.getElementById("auth-account-widget")) return;
    var user = session.user || {};
    var meta = user.user_metadata || {};
    var email = user.email || "Account";
    var displayName = (meta.full_name || "").trim();
    var initialsSource = displayName || email;
    var initial = initialsSource.charAt(0).toUpperCase() || "?";

    // Was position:fixed at a hardcoded viewport corner (top:12px;
    // right:12px), completely outside the topbar's own layout -- that's
    // why it sat directly on top of the search icon, which lives in
    // .topbar-right just a few pixels away. Now it's a normal flex
    // child of that same row (see insertIntoTopbar below), so it can
    // never overlap a neighboring icon again.
    var wrap = document.createElement("div");
    wrap.id = "auth-account-widget";
    wrap.className = "account-widget";

    var btn = document.createElement("button");
    btn.id = "auth-account-btn";
    btn.type = "button";
    btn.className = "account-trigger";
    btn.title = displayName ? displayName + " (" + email + ")" : email;
    btn.setAttribute("aria-label", "Account menu");
    btn.innerHTML =
      '<span class="account-avatar" id="auth-account-avatar">' + escapeHtml(initial) + "</span>" +
      '<svg class="account-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

    var panel = document.createElement("div");
    panel.id = "auth-account-panel";
    panel.className = "account-panel";

    var head = document.createElement("div");
    head.className = "account-panel-head";
    head.innerHTML =
      '<span class="account-panel-avatar" id="auth-account-panel-avatar">' + escapeHtml(initial) + "</span>" +
      '<span class="account-panel-id">' +
        '<span class="account-panel-name" id="auth-account-panel-name">' + escapeHtml(displayName || "Trader") + "</span>" +
        '<span class="account-panel-email" id="auth-account-panel-email">' + escapeHtml(email) + "</span>" +
      "</span>";
    panel.appendChild(head);

    var menu = document.createElement("div");
    menu.className = "account-menu";

    var settingsLink = document.createElement("a");
    settingsLink.href = "settings.html#account-section";
    settingsLink.className = "account-menu-item";
    settingsLink.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>' +
      "Account settings";
    menu.appendChild(settingsLink);

    var divider = document.createElement("div");
    divider.className = "account-menu-divider";
    menu.appendChild(divider);

    var logoutBtn = document.createElement("button");
    logoutBtn.id = "auth-logout-btn";
    logoutBtn.type = "button";
    logoutBtn.className = "account-menu-item danger";
    logoutBtn.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>' +
      "Log out";
    logoutBtn.addEventListener("click", function () {
      window.sb.auth.signOut().then(function () {
        window.location.href = "login";
      });
    });
    menu.appendChild(logoutBtn);

    panel.appendChild(menu);

    function closePanel() {
      panel.classList.remove("open");
      btn.classList.remove("open");
    }
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var isOpen = panel.classList.toggle("open");
      btn.classList.toggle("open", isOpen);
    });
    document.addEventListener("click", closePanel);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closePanel();
    });

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    insertIntoTopbar(wrap);

    // settings.html's Account section dispatches this after a successful
    // display-name save, so the topbar avatar/panel update immediately
    // without needing a full page reload (they're both on the same page).
    window.addEventListener("account:profile-updated", function (ev) {
      var name = ((ev.detail && ev.detail.fullName) || "").trim();
      var src = name || email;
      var ch = src.charAt(0).toUpperCase() || "?";
      var avatarEl = document.getElementById("auth-account-avatar");
      var panelAvatarEl = document.getElementById("auth-account-panel-avatar");
      var nameEl = document.getElementById("auth-account-panel-name");
      if (avatarEl) avatarEl.textContent = ch;
      if (panelAvatarEl) panelAvatarEl.textContent = ch;
      if (nameEl) nameEl.textContent = name || "Trader";
      btn.title = name ? name + " (" + email + ")" : email;
    });
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
  // Supabase mints a fresh JWT (on sign-in, on tab focus, or its periodic
  // silent refresh) with an `iat` claim stamped by the Auth server's own
  // clock. If a query using that token reaches PostgREST a moment before
  // PostgREST's own clock reaches that same second -- ordinary clock drift
  // between Supabase's services, nothing wrong on this end -- PostgREST
  // rejects an otherwise-valid token with "JWT issued at future". It's a
  // one-off: the exact same token succeeds a second later, which is why
  // hitting refresh always "fixed" it. Rather than surface that as a real
  // error (or make every page load wait it out up front), retry the one
  // query that hit it, once, after a short delay.
  function isClockSkewError(err) {
    var msg = ((err && err.message) || "").toLowerCase();
    return msg.indexOf("issued at future") !== -1 || (msg.indexOf("jwt") !== -1 && msg.indexOf("future") !== -1);
  }
  function withClockSkewRetry(runQuery) {
    return runQuery().then(function (res) {
      if (res && res.error && isClockSkewError(res.error)) {
        return new Promise(function (resolve) { setTimeout(resolve, 1200); }).then(runQuery);
      }
      return res;
    });
  }

  window.KV = (function () {
    var cache = {};
    var loaded = false;

    var ready = window.AUTH_READY.then(function (session) {
      if (!session) return null;
      return withClockSkewRetry(function () {
        return window.sb.from("user_kv").select("key,value");
      }).then(function (res) {
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
      return withClockSkewRetry(function () {
        return window.sb
          .from("trades")
          .select("*")
          .order("trade_date", { ascending: true })
          .order("entry_time", { ascending: true });
      }).then(function (res) {
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

  // computeAccountBalances is defined near the top of this file, above
  // both guards, since it's pure math with no Supabase dependency. (Given
  // trades sorted ascending by trade_date/entry_time, each with
  // pnl_after_comm, and a date-sorted capital ledger, it returns a
  // same-length array of real account-balance figures: the ledger
  // balance as of that trade's date plus cumulative P&L up to and
  // including that trade -- deliberately kept separate from
  // `equity_after`, which the Risk Calculator and Cumulative P&L report
  // chart depend on staying pure cumulative P&L.)

  window.fetchTradeDetail = function (id) {
    return window.AUTH_READY.then(function (session) {
      if (!session) return null;
      return Promise.all([
        withClockSkewRetry(function () { return window.sb.from("trades").select("*").eq("id", id).maybeSingle(); }),
        withClockSkewRetry(function () { return window.sb.from("trade_details").select("*").eq("trade_id", id).maybeSingle(); }),
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
