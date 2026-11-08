// accounts.js -- multiple trading accounts per user, plus "periods".
//
// Loads right after auth.js on every page. Three jobs:
//
//   1. Account registry (`accounts` table): real ("live") accounts and
//      paper-trading attempts, each its own row. window.Accounts.*
//
//   2. A global SCOPE ("what am I looking at?") that every existing page
//      picks up for free: this file wraps window.fetchTradesIndex() and
//      window.fetchCapitalLedger() from auth.js so they only return the
//      selected account(s) -- and, optionally, one period of one account.
//      equity_after is recomputed over the filtered set, so equity curves
//      and the risk calculator are correct for whatever slice is selected
//      (the stored column is a running total over ALL of a user's trades).
//
//   3. A topbar pill that always shows the current scope and opens the "View" sheet
//      (account cards + period timeline) where you change it.
//
// Concepts
//   live account    a real brokerage account. Trades live in `trades`
//                   with trades.account_id.
//   paper attempt   a practice-simulator account (Practice tab). One row in
//                   `accounts` (kind='paper') + its fills in user_kv under
//                   "practice:account:v3:<id>". "Reset" = archive the old
//                   attempt and start a new one -- nothing is destroyed.
//   period          a named stretch of one live account, started by a
//                   capital-ledger entry flagged `period: true` (a deposit
//                   after a break, say). It runs until the next period
//                   starts. Deposits default to starting a period unless
//                   the entry says `period: false`.
//
// If the `accounts` table doesn't exist yet (001_accounts.sql not run),
// everything here degrades to the old single-account behavior.
(function () {
  "use strict";
  if (window.Accounts) return;
  if (!window.sb || !window.AUTH_READY || !window.KV || typeof window.fetchTradesIndex !== "function") return;

  var SCOPE_KEY = "scope:v1";               // localStorage: {ids:[...], period:id|null}
  var LEDGER_KEY = "capital_ledger";        // user_kv
  var PAPER_ACTIVE_KEY = "practice:active_account:v1"; // localStorage + user_kv
  var LEGACY_PAPER_KEY = "practice:account:v2";
  var PAPER_KEY_PREFIX = "practice:account:v3:";
  var BROKER_PAPER_KEY = "broker_paper_ids"; // user_kv: ids of live-structured accounts that are broker PAPER accounts
  var PALETTE = ["#8b7cf6", "#22d3ee", "#2fd08a", "#e8a94c", "#f2555a", "#5b93f0", "#e879c9", "#a3e635"];

  var accounts = [];
  var available = true;     // false when the accounts table isn't there yet
  var origTrades = window.fetchTradesIndex;
  var origLedger = window.fetchCapitalLedger;

  function q(fn) { return window.__withRetry ? window.__withRetry(fn) : Promise.resolve().then(fn); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }

  // ------------------------------------------------------------------
  // registry
  // ------------------------------------------------------------------
  // A "broker paper" account is a paper-trading account at the user's own broker. It is stored
  // exactly like a real account (kind='live': trades.account_id, imports, deposits, periods) and
  // flagged by id in user_kv, so no schema change is needed. live() is REAL accounts only, so the
  // default "All real accounts" view never mixes paper results in; liveAll() includes both.
  function paperIds() { var v = window.KV.get(BROKER_PAPER_KEY); return Array.isArray(v) ? v : []; }
  function isBrokerPaper(a) { return !!a && a.kind === "live" && paperIds().indexOf(a.id) !== -1; }
  function liveAll() { return accounts.filter(function (a) { return a.kind === "live"; }); }
  function live() { return accounts.filter(function (a) { return a.kind === "live" && !isBrokerPaper(a); }); }
  function brokerPaper() { return accounts.filter(isBrokerPaper); }
  function paper() { return accounts.filter(function (a) { return a.kind === "paper"; }); }
  function byId(id) { for (var i = 0; i < accounts.length; i++) if (accounts[i].id === id) return accounts[i]; return null; }
  function defaultLive() {
    var l = live();
    for (var i = 0; i < l.length; i++) if (l[i].status === "active") return l[i];
    return l[0] || null;
  }
  function pickColor() { return PALETTE[accounts.length % PALETTE.length]; }

  function loadAccounts() {
    return q(function () { return window.sb.from("accounts").select("*").order("created_at", { ascending: true }); })
      .then(function (res) {
        if (res.error) throw new Error(res.error.message);
        return res.data || [];
      });
  }

  function insertAccount(row) {
    return q(function () { return window.sb.from("accounts").insert(row).select().single(); }).then(function (res) {
      if (res.error) throw new Error(res.error.message);
      accounts.push(res.data);
      return res.data;
    });
  }

  function createAccount(o) {
    var name = String(o.name || "").trim();
    if (!name) return Promise.reject(new Error("Give the account a name."));
    return insertAccount({
      name: name,
      kind: o.kind === "paper" ? "paper" : "live",
      color: o.color || pickColor(),
      starting_balance: o.startingBalance != null ? o.startingBalance : null,
      note: o.note || null,
    }).then(function (acc) {
      if (!o.brokerPaper || acc.kind !== "live") return acc;
      var ids = paperIds().slice();
      ids.push(acc.id);
      return Promise.resolve(window.KV.set(BROKER_PAPER_KEY, ids)).then(function () { return acc; });
    });
  }

  function updateAccount(id, patch) {
    return q(function () { return window.sb.from("accounts").update(patch).eq("id", id).select().single(); }).then(function (res) {
      if (res.error) throw new Error(res.error.message);
      var i = accounts.findIndex(function (a) { return a.id === id; });
      if (i !== -1) accounts[i] = res.data;
      return res.data;
    });
  }

  function setStatus(id, status) {
    return updateAccount(id, { status: status, archived_at: status === "archived" ? new Date().toISOString() : null });
  }

  function removeAccount(id) {
    return q(function () { return window.sb.from("accounts").delete().eq("id", id); }).then(function (res) {
      if (res.error) {
        var m = /foreign key|violates/i.test(res.error.message || "")
          ? "This account still has trades. Archive it instead (nothing is lost), or delete its trades first."
          : res.error.message;
        throw new Error(m);
      }
      accounts = accounts.filter(function (a) { return a.id !== id; });
      if (paperIds().indexOf(id) !== -1) window.KV.set(BROKER_PAPER_KEY, paperIds().filter(function (x) { return x !== id; }));
    });
  }

  // ------------------------------------------------------------------
  // capital ledger (user_kv "capital_ledger"), made account-aware
  // ------------------------------------------------------------------
  function validEntry(e) { return e && typeof e.date === "string" && isFinite(e.amount); }

  function getLedger() {
    var v = window.KV.get(LEDGER_KEY);
    if (!Array.isArray(v)) return [];
    return JSON.parse(JSON.stringify(v.filter(validEntry)));
  }
  // The whole ledger is ONE stored value, so two devices saving at once used to mean "last save wins"
  // and the other device's deposits vanished. Saves now check that the stored copy is still the one
  // this page loaded; if another device/tab changed it, the person decides instead of us guessing.
  function setLedger(list, opts) {
    var kv = window.KV;
    if (!kv || !kv.setGuarded) return kv.set(LEDGER_KEY, list);
    return kv.setGuarded(LEDGER_KEY, list).then(function (r) {
      if (r.ok || !r.conflict) return;
      if (opts && opts.silent) return;   // background migration: just try again next load
      return resolveLedgerConflict(list, r.remote);
    });
  }

  function resolveLedgerConflict(mine, remote) {
    var msg = "Your deposits & periods were changed on another device or tab after this page loaded. " +
      "Saving now would erase those changes.\n\nLoad the other copy (your unsaved edit here is discarded), or overwrite it with what you have on this screen?";
    var ask = window.UIModal
      ? window.UIModal.confirm(msg, { title: "Deposits changed elsewhere", tone: "danger", confirmLabel: "Overwrite with mine", cancelLabel: "Load the other copy" })
      : Promise.resolve(window.confirm(msg + "\n\nOK = overwrite with mine. Cancel = load the other copy."));
    return ask.then(function (overwrite) {
      if (overwrite) return window.KV.set(LEDGER_KEY, mine);
      window.KV.adopt(LEDGER_KEY, remote);
      if (window.showToast) window.showToast("Loaded the latest deposits from your other device.");
      setTimeout(function () { window.location.reload(); }, 600);
    });
  }

  // Coming back to a tab that sat in the background: tell the person if the ledger moved on meanwhile.
  var staleWarned = false, staleCheckedAt = 0;
  function watchLedgerStale() {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState !== "visible" || staleWarned || !window.KV || !window.KV.isStale) return;
      if (Date.now() - staleCheckedAt < 30000) return;
      staleCheckedAt = Date.now();
      window.KV.isStale(LEDGER_KEY).then(function (stale) {
        if (!stale || staleWarned) return;
        staleWarned = true;
        if (window.showToast) window.showToast("Your deposits were changed on another device.", { duration: 12000, action: { label: "Reload", onClick: function () { window.location.reload(); } } });
      });
    });
  }

  function ledgerAccountId(e) { return e.account_id || (defaultLive() && defaultLive().id) || null; }

  function migrateLedger() {
    var d = defaultLive();
    var v = window.KV.get(LEDGER_KEY);
    if (!d || !Array.isArray(v)) return;
    var changed = false;
    var next = v.map(function (e) {
      if (!validEntry(e)) return e;
      var c = Object.assign({}, e);
      if (!c._id) { c._id = uid(); changed = true; }
      if (!c.account_id) { c.account_id = d.id; changed = true; }
      return c;
    });
    if (changed) setLedger(next, { silent: true });
  }

  // ------------------------------------------------------------------
  // periods
  // ------------------------------------------------------------------
  function startsPeriod(e) { return e.period === true || (e.period === undefined && e.amount > 0); }

  function periodsFor(accountId) {
    var starts = getLedger()
      .filter(function (e) { return ledgerAccountId(e) === accountId && startsPeriod(e); })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return starts.map(function (e, i) {
      return {
        id: e._id,
        accountId: accountId,
        index: i + 1,
        name: (e.period_name || "").trim() || ("Period " + (i + 1)),
        customName: !!(e.period_name || "").trim(),
        start: e.date,
        end: i + 1 < starts.length ? starts[i + 1].date : null, // exclusive; null = still open
        reflection: e.reflection || "",
        amount: e.amount,
      };
    });
  }
  function findPeriod(periodId) {
    var l = liveAll();
    for (var i = 0; i < l.length; i++) {
      var ps = periodsFor(l[i].id);
      for (var j = 0; j < ps.length; j++) if (ps[j].id === periodId) return ps[j];
    }
    return null;
  }
  function inRange(date, p) { return !!date && date >= p.start && (p.end === null || date < p.end); }

  // ------------------------------------------------------------------
  // scope
  // ------------------------------------------------------------------
  function getScope() {
    var raw = null;
    try { raw = JSON.parse(lsGet(SCOPE_KEY) || "null"); } catch (e) { /* ignore */ }
    var allIds = liveAll().map(function (a) { return a.id; });
    var realIds = live().map(function (a) { return a.id; });
    var ids = raw && Array.isArray(raw.ids) ? raw.ids.filter(function (id) { return allIds.indexOf(id) !== -1; }) : [];
    // "all" = every REAL account (broker paper accounts only show when picked on purpose)
    var sameAsReal = ids.length === realIds.length && realIds.every(function (id) { return ids.indexOf(id) !== -1; });
    var all = ids.length === 0 || sameAsReal;
    if (all) ids = realIds;
    var period = null;
    // A period belongs to ONE account, so it applies whenever exactly one account is in scope --
    // including when that account is the user's only real account (which counts as "all").
    if (ids.length === 1 && raw && raw.period) {
      var p = periodsFor(ids[0]).filter(function (x) { return x.id === raw.period; })[0];
      if (p) period = p.id;
    }
    if (period) all = false;
    return { ids: ids, all: all, period: period };
  }

  function setScope(scope, opts) {
    var next = { ids: (scope && scope.ids) || [], period: (scope && scope.period) || null };
    var prev = lsGet(SCOPE_KEY);
    lsSet(SCOPE_KEY, JSON.stringify(next));
    if (!opts || opts.reload !== false) {
      if (prev !== JSON.stringify(next)) window.location.reload();
    }
  }

  // Stable string for the current scope, used to keep cached snapshots of scoped data apart.
  function scopeKey() {
    if (!available) return "";
    var sc = getScope();
    return sc.ids.slice().sort().join(",") + "|" + (sc.period || "");
  }

  function scopeLabel() {
    if (!available) return "";
    var sc = getScope();
    if (sc.all && !sc.period) return live().length > 1 ? "All real accounts" : (live()[0] ? live()[0].name : "Real account");
    if (sc.ids.length === 1) {
      var a = byId(sc.ids[0]);
      var label = a ? a.name : "Account";
      if (isBrokerPaper(a) && !/paper/i.test(label)) label += " (paper)";
      if (sc.period) { var p = findPeriod(sc.period); if (p) label += " \u00b7 " + p.name; }
      return label;
    }
    return sc.ids.length + " accounts";
  }

  // ------------------------------------------------------------------
  // wrapped data helpers
  // ------------------------------------------------------------------
  function effAccountId(t) { return t.account_id || (defaultLive() && defaultLive().id) || null; }

  window.fetchTradesIndexRaw = origTrades;
  window.fetchTradesIndex = function () {
    return Promise.all([origTrades(), ready]).then(function (r) {
      var rows = r[0];
      if (!available) return rows;
      var sc = getScope();
      var allowed = {};
      sc.ids.forEach(function (id) { allowed[id] = true; });
      var p = sc.period ? findPeriod(sc.period) : null;
      var out = rows.filter(function (t) { return allowed[effAccountId(t)] && (!p || inRange(t.trade_date, p)); });
      var eq = 0;
      out.forEach(function (t) { eq += t.pnl_after_comm || 0; t.equity_after = Math.round(eq * 100) / 100; });
      return out;
    });
  };

  if (typeof origLedger === "function") {
    window.fetchCapitalLedgerRaw = origLedger;
    window.fetchCapitalLedger = function () {
      return Promise.all([origLedger(), ready]).then(function (r) {
        var list = r[0];
        if (!available) return list;
        var sc = getScope();
        var allowed = {};
        sc.ids.forEach(function (id) { allowed[id] = true; });
        var p = sc.period ? findPeriod(sc.period) : null;
        return list.filter(function (e) { return allowed[ledgerAccountId(e)] && (!p || inRange(e.date, p)); });
      });
    };
  }

  // every trade the user has, unscoped, with its effective account id (Accounts page)
  function fetchAllTrades() {
    return Promise.all([origTrades(), ready]).then(function (r) {
      return r[0].map(function (t) { t.account_id = effAccountId(t); return t; });
    });
  }

  // ------------------------------------------------------------------
  // paper attempts
  // ------------------------------------------------------------------
  function paperKey(id) { return PAPER_KEY_PREFIX + id; }

  function paperActiveId() {
    var v = window.KV.get(PAPER_ACTIVE_KEY);
    if (typeof v === "string" && byId(v)) return v;
    var l = lsGet(PAPER_ACTIVE_KEY);
    if (l && byId(l)) return l;
    return null;
  }
  function setPaperActive(id) {
    lsSet(PAPER_ACTIVE_KEY, id);
    return window.KV.set(PAPER_ACTIVE_KEY, id);
  }
  function paperLoad(id) {
    var v = window.KV.get(paperKey(id));
    if (v && typeof v === "object") return v;
    try { var raw = lsGet(paperKey(id)); if (raw) return JSON.parse(raw); } catch (e) { /* ignore */ }
    return null;
  }
  function paperSave(id, blob) {
    lsSet(paperKey(id), JSON.stringify(blob));
    return window.KV.set(paperKey(id), blob);
  }

  function nextPaperName(startingBalance) {
    var n = paper().length + 1;
    return "Attempt " + n + (startingBalance ? " \u00b7 $" + Math.round(startingBalance).toLocaleString("en-US") : "");
  }

  // Bring the very first paper account over from the old single-slot key.
  function migratePaper() {
    if (paper().length) return Promise.resolve();
    var blob = window.KV.get(LEGACY_PAPER_KEY);
    if (!blob || typeof blob !== "object") {
      try { blob = JSON.parse(lsGet(LEGACY_PAPER_KEY) || "null"); } catch (e) { blob = null; }
    }
    if (!blob || typeof blob !== "object" || !isFinite(blob.balance)) return Promise.resolve();
    return createAccount({ name: "Attempt 1", kind: "paper", startingBalance: blob.startingBalance || blob.balance })
      .then(function (acc) { paperSave(acc.id, blob); return setPaperActive(acc.id); });
  }

  // Resolves to the active paper account id, creating attempt 1 if none exist.
  function paperEnsureActive(opts) {
    return ready.then(function () {
      if (!available) return null;
      var id = paperActiveId();
      if (id) return id;
      var ps = paper();
      if (ps.length) {
        var latest = ps[ps.length - 1];
        return Promise.resolve(setPaperActive(latest.id)).then(function () { return latest.id; });
      }
      var sb = (opts && opts.startingBalance) || 10000;
      return createAccount({ name: "Attempt 1", kind: "paper", startingBalance: sb }).then(function (acc) {
        if (opts && opts.blob) paperSave(acc.id, opts.blob);
        return Promise.resolve(setPaperActive(acc.id)).then(function () { return acc.id; });
      });
    });
  }

  // "Reset": keep the old attempt (archived), start a fresh one.
  function paperNewAttempt(o) {
    var prev = paperActiveId();
    var sbal = o.startingBalance;
    var name = (o.name || "").trim() || nextPaperName(sbal);
    return createAccount({ name: name, kind: "paper", startingBalance: sbal }).then(function (acc) {
      paperSave(acc.id, o.blob);
      var done = prev ? setStatus(prev, "archived").catch(function () {}) : Promise.resolve();
      return done.then(function () { return setPaperActive(acc.id); }).then(function () { return acc; });
    });
  }

  function paperSwitch(id) {
    var acc = byId(id);
    if (!acc) return Promise.reject(new Error("No such attempt"));
    var p = acc.status === "archived" ? setStatus(id, "active") : Promise.resolve();
    return p.then(function () { return setPaperActive(id); });
  }

  function paperRemove(id) {
    return removeAccount(id).then(function () {
      try { localStorage.removeItem(paperKey(id)); } catch (e) { /* ignore */ }
      window.KV.delete(paperKey(id));
      if (paperActiveId() === id) {
        try { localStorage.removeItem(PAPER_ACTIVE_KEY); } catch (e) { /* ignore */ }
        window.KV.delete(PAPER_ACTIVE_KEY);
      }
    });
  }

  // ------------------------------------------------------------------
  // boot
  // ------------------------------------------------------------------
  var ready = window.AUTH_READY.then(function (session) {
    if (!session) { available = false; return null; }
    return window.KV.ready.then(function () { return loadAccounts(); }).then(function (rows) {
      accounts = rows;
      if (!live().length) return createAccount({ name: "Main account", kind: "live", color: PALETTE[0] });
    }).then(function () {
      migrateLedger();
      return migratePaper();
    }).then(function () {
      return session;
    }, function (err) {
      available = false;
      if (window.console) console.warn("accounts.js: running without accounts (" + (err && err.message) + ") -- has 001_accounts.sql been run?");
      return session;
    });
  });

  watchLedgerStale();

  // ------------------------------------------------------------------
  // "View" sheet -- the one place you choose WHAT you're looking at
  // ------------------------------------------------------------------
  // The topbar pill (always shows the current scope) opens a slide-over sheet (bottom sheet on phones):
  //
  //   Account   cards: "All real accounts" + one per account (+ broker paper accounts, kept apart).
  //             Tap = view that account. "Select several" turns the cards into checkboxes to combine some.
  //   Period    only when exactly one account is picked: a timeline, "Entire account" first, then each
  //             period newest-first with its P&L, return and balance. Tap = apply. No Apply button, no <select>.
  //
  // Nothing here changes the scope until you tap a final choice (an account with no periods, "All", a
  // period row, or "Show N accounts"). setScope() reloads the page, as it always has, so every page
  // re-fetches its data for the new slice.
  var CSS =
    ".scope-btn{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-radius:999px;background:var(--panel-2);border:1px solid var(--border);color:var(--text);font:600 12.5px var(--sans);cursor:pointer;max-width:280px}" +
    ".scope-btn:hover{border-color:var(--text-faint)}" +
    ".scope-btn.filtered{border-color:var(--primary);background:var(--primary-soft)}" +
    ".scope-btn svg{width:14px;height:14px;flex:none;color:var(--text-faint)}" +
    ".scope-dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--primary)}" +
    ".scope-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".sv-backdrop{position:fixed;inset:0;z-index:390;background:rgba(6,8,12,.5);opacity:0;transition:opacity .2s}" +
    ".sv-sheet{position:fixed;z-index:400;top:0;right:0;bottom:0;width:min(400px,100vw);display:flex;flex-direction:column;background:var(--panel);border-left:1px solid var(--border);box-shadow:-24px 0 60px -20px rgba(0,0,0,.55);transform:translateX(24px);opacity:0;transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .2s;outline:none}" +
    "html.sv-lock{overflow:hidden}html.sv-lock .chatw-launcher{display:none}" + // page doesn't scroll behind the sheet; chat bubble stays out of its way
    ".sv-open .sv-backdrop{opacity:1}.sv-open .sv-sheet{transform:none;opacity:1}" +
    ".sv-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:20px 20px 14px}" +
    ".sv-eyebrow{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-faint);margin-bottom:4px}" +
    ".sv-title{margin:0;font:600 18px/1.25 var(--sans);letter-spacing:-.015em;color:var(--text)}" +
    ".sv-title i{font-style:normal;color:var(--text-dim);font-weight:500}" +
    ".sv-x{flex:none;width:34px;height:34px;display:grid;place-items:center;border:0;border-radius:10px;background:transparent;color:var(--text-dim);cursor:pointer}" +
    ".sv-x:hover{background:var(--panel-2);color:var(--text)}.sv-x svg{width:18px;height:18px}" +
    ".sv-body{flex:1;overflow-y:auto;padding:0 20px 20px;overscroll-behavior:contain}" +
    ".sv-sec+.sv-sec{margin-top:22px}" +
    ".sv-sec-h{display:flex;align-items:center;justify-content:space-between;margin:0 2px 8px;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-faint)}" +
    ".sv-link{border:0;background:none;padding:0;font:500 12px var(--sans);letter-spacing:0;text-transform:none;color:var(--text-dim);cursor:pointer;text-decoration:underline;text-underline-offset:3px}" +
    ".sv-link:hover{color:var(--text)}" +
    ".sv-card{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:12px 14px;margin:0 0 8px;background:var(--panel-2);border:1px solid var(--border);border-radius:12px;color:var(--text);font:inherit;cursor:pointer;transition:border-color .15s,background-color .15s}" +
    ".sv-card:hover{border-color:var(--text-faint)}" +
    ".sv-card.on{border-color:var(--primary);background:var(--primary-soft)}" +
    ".sv-card:focus-visible,.sv-row:focus-visible,.sv-go:focus-visible{outline:2px solid var(--primary);outline-offset:2px}" +
    ".sv-card .scope-dot{width:11px;height:11px}" +
    ".sv-card-main{flex:1;min-width:0}.sv-card-name{display:block;font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".sv-sub{display:block;margin-top:2px;font-size:12px;color:var(--text-faint)}" +
    ".sv-card-val{font:600 14px var(--mono);color:var(--text);white-space:nowrap}" +
    ".sv-tick{flex:none;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--text-faint);display:grid;place-items:center}" +
    ".sv-card.on .sv-tick{border-color:var(--primary);background:var(--primary)}" +
    ".sv-card.on .sv-tick::after{content:'';width:6px;height:6px;border-radius:50%;background:#fff}" +
    ".sv-multi .sv-tick{border-radius:5px}.sv-multi .sv-card.on .sv-tick::after{width:9px;height:5px;border-radius:0;background:none;border:solid #fff;border-width:0 0 2px 2px;transform:rotate(-45deg) translate(1px,-1px)}" +
    ".sv-group-h{margin:16px 2px 8px;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-faint)}" +
    ".sv-tl{position:relative;margin:0;padding:0;list-style:none}" +
    ".sv-tl::before{content:'';position:absolute;left:8px;top:14px;bottom:14px;width:2px;background:var(--border)}" +
    ".sv-row{position:relative;display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:10px 12px 10px 0;margin:0 0 2px;border:0;border-radius:10px;background:transparent;color:var(--text);font:inherit;cursor:pointer}" +
    ".sv-row:hover{background:var(--panel-2)}" +
    ".sv-row.on{background:var(--primary-soft)}" +
    ".sv-pin{position:relative;flex:none;width:18px;height:18px;display:grid;place-items:center}" +
    ".sv-pin::after{content:'';width:10px;height:10px;border-radius:50%;background:var(--panel);border:2px solid var(--text-faint)}" +
    ".sv-row.on .sv-pin::after{border-color:var(--primary);background:var(--primary)}" +
    ".sv-row.now .sv-pin::after{border-color:var(--green)}.sv-row.now.on .sv-pin::after{background:var(--green)}" +
    ".sv-row-main{flex:1;min-width:0}.sv-row-name{display:block;font-weight:600;font-size:13.5px}" +
    ".sv-row-name em{font:600 10px var(--sans);font-style:normal;letter-spacing:.05em;text-transform:uppercase;color:var(--green);margin-left:6px}" +
    ".sv-row-end{text-align:right;white-space:nowrap}.sv-row-bal{display:block;font:600 13.5px var(--mono)}" +
    ".sv-row-pl{display:block;margin-top:2px;font-size:12px;color:var(--text-faint)}" +
    ".sv-up{color:var(--green)}.sv-down{color:var(--red)}" +
    ".sv-hint{margin:2px 2px 0;font-size:12.5px;line-height:1.5;color:var(--text-faint)}" +
    ".sv-foot{padding:12px 20px calc(14px + env(safe-area-inset-bottom,0px));border-top:1px solid var(--border-soft);display:flex;flex-direction:column;gap:8px}" +
    ".sv-go{width:100%;height:42px;border:0;border-radius:11px;background:var(--text);color:var(--bg);font:600 13.5px var(--sans);cursor:pointer}" +
    ".sv-go:disabled{opacity:.4;cursor:default}" +
    ".sv-links{display:flex;gap:16px;flex-wrap:wrap}.sv-links a{font-size:12.5px;color:var(--text-dim);text-decoration:none}.sv-links a:hover{color:var(--text);text-decoration:underline}" +
    "@media(max-width:640px){.scope-label{display:none}.scope-btn{padding:0 10px;height:38px}" +
    ".sv-sheet{top:auto;left:0;right:0;width:auto;max-height:88dvh;border-left:0;border-top:1px solid var(--border);border-radius:18px 18px 0 0;box-shadow:0 -24px 60px -20px rgba(0,0,0,.6);transform:translateY(24px)}" +
    ".sv-sheet::before{content:'';align-self:center;width:38px;height:4px;border-radius:4px;background:var(--border);margin-top:8px}" +
    ".sv-head{padding-top:12px}.sv-card,.sv-row{min-height:48px}}" +
    "@media(prefers-reduced-motion:reduce){.sv-backdrop,.sv-sheet{transition:none}}";

  function dotColor() {
    var sc = getScope();
    if (sc.ids.length === 1 && byId(sc.ids[0])) return byId(sc.ids[0]).color || PALETTE[0];
    return "var(--primary)";
  }

  // ---- small formatters (this file loads on every page, so it can't borrow the dashboard's) ----
  function money(v, signed) {
    var n = Math.round(Number(v) || 0);
    return (n < 0 ? "-" : signed && n > 0 ? "+" : "") + "$" + Math.abs(n).toLocaleString("en-US");
  }
  function pctTxt(v) { return v === null || v === undefined ? "" : (v >= 0 ? "+" : "") + (v * 100).toFixed(1) + "%"; }
  function shortDate(iso) {
    var d = new Date(iso + "T12:00:00");
    return isNaN(d) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  function cls(v) { return v > 0 ? "sv-up" : v < 0 ? "sv-down" : ""; }

  // The balance maths only ships on a couple of pages; fetch it on demand everywhere else.
  function withBalanceMath(cb) {
    if (window.BalanceMath) return cb(window.BalanceMath);
    var s = document.createElement("script");
    s.src = "js/accounts/balance-math.js";
    s.onload = function () { cb(window.BalanceMath || null); };
    s.onerror = function () { cb(null); };
    document.head.appendChild(s);
  }

  // Per-account and per-period numbers shown in the sheet. {accId: {trades, pnl, balance|null, periods:{pid:summary}}}
  function computeSheetStats(BM, allTrades) {
    var ledger = getLedger(), out = {};
    liveAll().forEach(function (a) {
      var entries = ledger.filter(function (e) { return ledgerAccountId(e) === a.id; });
      var tr = allTrades.filter(function (t) { return t.account_id === a.id; });
      var pnl = tr.reduce(function (s, t) { return s + (Number(t.pnl_after_comm) || 0); }, 0);
      var st = { trades: tr.length, pnl: pnl, balance: entries.length ? BM.balanceBefore(entries, tr, "9999-12-31") : null, periods: {} };
      periodsFor(a.id).forEach(function (p) { st.periods[p.id] = BM.periodSummary(entries, tr, p); });
      out[a.id] = st;
    });
    return out;
  }

  var sheet = null; // the open sheet, if any

  function openSheet() {
    if (sheet) return;
    var style = document.getElementById("sv-style");
    if (!style) { style = document.createElement("style"); style.id = "sv-style"; style.textContent = CSS; document.head.appendChild(style); }

    var cur = getScope();
    var realIds = live().map(function (a) { return a.id; });
    // What's ticked in the sheet right now (not applied until a final tap).
    var pick = { all: cur.all && !cur.period && realIds.length > 1, ids: cur.ids.slice(), multi: false, stats: null };
    var opener = document.activeElement;

    var root = document.createElement("div");
    root.className = "sv-root";
    root.innerHTML =
      '<div class="sv-backdrop"></div>' +
      '<aside class="sv-sheet" role="dialog" aria-modal="true" aria-labelledby="sv-title" tabindex="-1">' +
      '<header class="sv-head"><div><div class="sv-eyebrow">Viewing</div><h2 class="sv-title" id="sv-title"></h2></div>' +
      '<button type="button" class="sv-x" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg></button></header>' +
      '<div class="sv-body"></div><footer class="sv-foot"></footer></aside>';
    document.body.appendChild(root);
    document.documentElement.classList.add("sv-lock");
    var shell = root.querySelector(".sv-sheet");
    var body = root.querySelector(".sv-body");
    var foot = root.querySelector(".sv-foot");
    requestAnimationFrame(function () { root.classList.add("sv-open"); shell.focus(); });

    function close() {
      if (!sheet) return;
      sheet = null;
      document.documentElement.classList.remove("sv-lock");
      document.removeEventListener("keydown", onKey, true);
      root.classList.remove("sv-open");
      setTimeout(function () { root.remove(); }, 220);
      if (opener && opener.focus) opener.focus();
    }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); close(); return; }
      if (e.key !== "Tab") return; // keep Tab inside the sheet
      var f = shell.querySelectorAll("button:not([disabled]),a[href]");
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === shell)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey, true);
    root.querySelector(".sv-backdrop").addEventListener("click", close);
    root.querySelector(".sv-x").addEventListener("click", close);
    sheet = { close: close };

    function apply(ids, period) { close(); setScope({ ids: ids, period: period || null }); }
    function statOf(id) { return pick.stats && pick.stats[id]; }

    function cardHtml(a, paper) {
      var on = pick.multi ? pick.ids.indexOf(a.id) !== -1 : (!pick.all && pick.ids.length === 1 && pick.ids[0] === a.id);
      var st = statOf(a.id), nP = periodsFor(a.id).length;
      var sub = st ? st.trades + " trade" + (st.trades === 1 ? "" : "s") + ' · <span class="' + cls(st.pnl) + '">' + money(st.pnl, true) + "</span>" : "&nbsp;";
      if (nP > 1 && !pick.multi) sub += " · " + nP + " periods";
      return '<button type="button" class="sv-card' + (on ? " on" : "") + '" data-acc="' + esc(a.id) + '"' + (paper ? " data-paper" : "") + ' aria-pressed="' + on + '">' +
        '<span class="scope-dot" style="background:' + esc(a.color || PALETTE[0]) + '"></span>' +
        '<span class="sv-card-main"><span class="sv-card-name">' + esc(a.name) + (a.status === "archived" ? ' <i style="font-style:normal;color:var(--text-faint);font-weight:500">· archived</i>' : "") + "</span>" +
        '<span class="sv-sub">' + sub + "</span></span>" +
        (st && st.balance !== null ? '<span class="sv-card-val">' + money(st.balance) + "</span>" : "") +
        (pick.multi ? '<span class="sv-tick"></span>' : "") + "</button>";
    }

    function allCardHtml() {
      if (realIds.length < 2) return ""; // one real account: "All" would just be a duplicate of it
      var on = !pick.multi && pick.all;
      var n = realIds.length, tot = 0, haveBal = false, pnl = 0, trades = 0;
      realIds.forEach(function (id) { var st = statOf(id); if (!st) return; trades += st.trades; pnl += st.pnl; if (st.balance !== null) { tot += st.balance; haveBal = true; } });
      var sub = pick.stats ? trades + " trade" + (trades === 1 ? "" : "s") + ' · <span class="' + cls(pnl) + '">' + money(pnl, true) + "</span>" : "&nbsp;";
      return '<button type="button" class="sv-card' + (on ? " on" : "") + '" data-all aria-pressed="' + on + '">' +
        '<span class="scope-dot" style="background:var(--primary)"></span>' +
        '<span class="sv-card-main"><span class="sv-card-name">All real accounts</span><span class="sv-sub">' + (n > 1 ? n + " accounts · " : "") + sub + "</span></span>" +
        (haveBal ? '<span class="sv-card-val">' + money(tot) + "</span>" : "") + "</button>";
    }

    function periodsHtml(acc) {
      var ps = periodsFor(acc.id).slice().reverse(), st = statOf(acc.id);
      if (ps.length < 2) return ""; // one period = the whole account, nothing to choose
      var wholeOn = cur.ids.length === 1 && cur.ids[0] === acc.id && !cur.period;
      var html = '<div class="sv-sec-h"><span>Period · ' + esc(acc.name) + '</span></div><ul class="sv-tl">' +
        '<li><button type="button" class="sv-row' + (wholeOn ? " on" : "") + '" data-period="">' +
        '<span class="sv-pin"></span><span class="sv-row-main"><span class="sv-row-name">Entire account</span><span class="sv-sub">Every period together</span></span>' +
        '<span class="sv-row-end">' + (st && st.balance !== null ? '<span class="sv-row-bal">' + money(st.balance) + "</span>" : "") +
        (st ? '<span class="sv-row-pl ' + cls(st.pnl) + '">' + money(st.pnl, true) + " P&amp;L</span>" : "") + "</span></button></li>";
      ps.forEach(function (p) {
        var m = st && st.periods[p.id], open = p.end === null;
        html += '<li><button type="button" class="sv-row' + (open ? " now" : "") + (cur.period === p.id ? " on" : "") + '" data-period="' + esc(p.id) + '">' +
          '<span class="sv-pin"></span><span class="sv-row-main"><span class="sv-row-name">' + esc(p.name) + (open ? "<em>Current</em>" : "") + "</span>" +
          '<span class="sv-sub">' + esc(shortDate(p.start)) + (open ? " → now" : " → " + esc(shortDate(p.end))) + "</span></span>" +
          '<span class="sv-row-end">' + (m ? '<span class="sv-row-bal">' + money(m.endBalance) + '</span><span class="sv-row-pl ' + cls(m.pnl) + '">' + money(m.pnl, true) + (m.twr !== null ? " · " + pctTxt(m.twr) : "") + "</span>" : "") + "</span></button></li>";
      });
      return html + "</ul>";
    }

    function paint() {
      root.classList.toggle("sv-multi", pick.multi);
      var title = root.querySelector("#sv-title");
      title.innerHTML = esc(scopeLabel().split(" · ")[0]) + (cur.period ? " <i>· " + esc(scopeLabel().split(" · ").slice(1).join(" · ")) + "</i>" : "");

      var bp = brokerPaper();
      var html = '<div class="sv-sec"><div class="sv-sec-h"><span>Account</span>' +
        (liveAll().length > 1 ? '<button type="button" class="sv-link" data-multi>' + (pick.multi ? "Done" : "Select several") + "</button>" : "") + "</div>" +
        allCardHtml() + live().map(function (a) { return cardHtml(a, false); }).join("") +
        (bp.length ? '<div class="sv-group-h">Paper accounts (broker)</div>' + bp.map(function (a) { return cardHtml(a, true); }).join("") : "") + "</div>";

      // Periods: only when exactly one account is picked (a period belongs to one account).
      var single = !pick.multi && !pick.all && pick.ids.length === 1 ? byId(pick.ids[0]) : null;
      if (single && periodsFor(single.id).length > 1) html += '<div class="sv-sec">' + periodsHtml(single) + "</div>";
      else if (!pick.multi && pick.all && live().some(function (a) { return periodsFor(a.id).length > 1; }))
        html += '<div class="sv-sec"><p class="sv-hint">Pick one account to browse its periods.</p></div>';
      body.innerHTML = html;

      var n = pick.ids.length;
      foot.innerHTML = (pick.multi ? '<button type="button" class="sv-go"' + (n ? "" : " disabled") + ">" + (n ? "Show " + n + " account" + (n === 1 ? "" : "s") : "Pick at least one account") + "</button>" : "") +
        '<div class="sv-links"><a href="accounts.html">Manage accounts &amp; periods</a><a href="practice.html?tab=analytics">Practice attempts</a></div>';
    }

    // One delegated handler for everything in the sheet.
    shell.addEventListener("click", function (e) {
      var t = e.target.closest("button");
      if (!t || !shell.contains(t)) return;
      if (t.hasAttribute("data-multi")) {
        pick.multi = !pick.multi;
        if (pick.multi && pick.all) pick.ids = realIds.slice();
        paint(); return;
      }
      if (t.classList.contains("sv-go")) {
        var ids = pick.ids.slice();
        var onlyReal = ids.length === realIds.length && realIds.every(function (id) { return ids.indexOf(id) !== -1; });
        apply(onlyReal ? [] : ids, null); return;
      }
      if (t.hasAttribute("data-all")) { if (pick.multi) { pick.ids = realIds.slice(); paint(); } else apply([], null); return; }
      if (t.hasAttribute("data-acc")) {
        var id = t.getAttribute("data-acc");
        if (pick.multi) {
          var i = pick.ids.indexOf(id);
          if (i === -1) pick.ids.push(id); else pick.ids.splice(i, 1);
          paint(); return;
        }
        // Single account: if it has several periods, show them and let the next tap decide; otherwise apply now.
        if (periodsFor(id).length > 1) { pick.all = false; pick.ids = [id]; paint(); var r = body.querySelector(".sv-row.on") || body.querySelector(".sv-row"); if (r && r.scrollIntoView) r.scrollIntoView({ block: "nearest" }); }
        else apply([id], null);
        return;
      }
      if (t.hasAttribute("data-period")) apply([pick.ids[0]], t.getAttribute("data-period") || null);
    });

    paint();
    // Numbers arrive a moment later (they need every trade, not just the scoped ones).
    withBalanceMath(function (BM) {
      if (!BM) return;
      fetchAllTrades().then(function (all) {
        if (!sheet) return;
        pick.stats = computeSheetStats(BM, all);
        paint();
      }).catch(function (e) { if (window.console) console.warn("scope sheet numbers failed", e); });
    });
  }

  function mountSwitcher() {
    if (document.getElementById("scope-switch")) return;
    if (/\/login(\.html)?\/?$/.test(window.location.pathname)) return;
    var bar = document.querySelector(".topbar-right");
    if (!bar) return;
    // One real account and no periods -> nothing to switch between; stay out of the way.
    var onlyOne = liveAll().length <= 1 && liveAll().every(function (a) { return periodsFor(a.id).length <= 1; });
    if (onlyOne) return;

    var style = document.createElement("style");
    style.id = "sv-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    var sc = getScope();
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = "scope-switch";
    btn.className = "scope-btn" + (sc.all ? "" : " filtered");
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-label", "Choose which account and period to view");
    btn.title = "Which account and period the whole site is showing";
    btn.innerHTML =
      '<span class="scope-dot" style="background:' + dotColor() + '"></span>' +
      '<span class="scope-label">' + esc(scopeLabel()) + "</span>" +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="9" cy="7" r="2.2" fill="var(--panel-2)"/><circle cx="15" cy="17" r="2.2" fill="var(--panel-2)"/></svg>';
    bar.insertBefore(btn, bar.firstChild);
    btn.addEventListener("click", openSheet);
  }

  ready.then(function (session) {
    if (!session || !available) return;
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountSwitcher, { once: true });
    else mountSwitcher();
  });

  window.Accounts = {
    ready: ready,
    isAvailable: function () { return available; },
    all: function () { return accounts.slice(); },
    live: live,
    liveAll: liveAll,
    brokerPaper: brokerPaper,
    isBrokerPaper: isBrokerPaper,
    paper: paper,
    byId: byId,
    defaultLive: defaultLive,
    create: createAccount,
    update: updateAccount,
    setStatus: setStatus,
    remove: removeAccount,
    effAccountId: effAccountId,
    ledgerAccountId: ledgerAccountId,
    fetchAllTrades: fetchAllTrades,
    getLedger: getLedger,
    setLedger: setLedger,
    scopeKey: scopeKey,
    startsPeriod: startsPeriod,
    periodsFor: periodsFor,
    findPeriod: findPeriod,
    inRange: inRange,
    getScope: getScope,
    setScope: setScope,
    scopeLabel: scopeLabel,
    openScopeSheet: openSheet,   // the dashboard's balance line opens the same sheet
    newId: uid,
    paperApi: {
      key: paperKey,
      activeId: paperActiveId,
      ensureActive: paperEnsureActive,
      load: paperLoad,
      save: paperSave,
      newAttempt: paperNewAttempt,
      switchTo: paperSwitch,
      remove: paperRemove,
      nextName: nextPaperName,
    },
  };
})();
