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
//   3. A topbar switcher so the current scope is always visible.
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
  function setLedger(list) { return window.KV.set(LEDGER_KEY, list); }

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
    if (changed) setLedger(next);
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
    if (!all && ids.length === 1 && raw && raw.period) {
      var p = periodsFor(ids[0]).filter(function (x) { return x.id === raw.period; })[0];
      if (p) period = p.id;
    }
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

  function scopeLabel() {
    if (!available) return "";
    var sc = getScope();
    if (sc.all) return live().length > 1 ? "All real accounts" : (live()[0] ? live()[0].name : "Real account");
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

  // ------------------------------------------------------------------
  // topbar switcher
  // ------------------------------------------------------------------
  var CSS =
    ".scope-switch{position:relative;display:inline-flex;align-items:center}" +
    ".scope-btn{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-radius:999px;background:var(--panel-2);border:1px solid var(--border);color:var(--text);font:600 12.5px var(--sans);cursor:pointer;max-width:260px}" +
    ".scope-btn:hover{border-color:var(--text-faint)}" +
    ".scope-btn.filtered{border-color:var(--primary);background:var(--primary-soft)}" +
    ".scope-dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--primary)}" +
    ".scope-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".scope-btn svg{width:12px;height:12px;flex:none;color:var(--text-faint)}" +
    ".scope-panel{display:none;position:absolute;top:calc(100% + 10px);right:0;width:292px;z-index:120;background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 14px 28px -12px rgba(0,0,0,.55);padding:12px}" +
    ".scope-panel.open{display:block}" +
    ".scope-h{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint);margin:2px 2px 8px}" +
    ".scope-row{display:flex;align-items:center;gap:9px;padding:7px 8px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;color:var(--text)}" +
    ".scope-row:hover{background:var(--panel-2)}" +
    ".scope-row input{accent-color:var(--primary);margin:0}" +
    ".scope-row .tag{margin-left:auto;font-size:10.5px;color:var(--text-faint)}" +
    ".scope-sub{margin:8px 2px 0}.scope-sub label{display:block;font-size:11px;color:var(--text-faint);margin-bottom:4px}" +
    ".scope-sub select{width:100%}" +
    ".scope-apply{width:100%;margin-top:12px}" +
    ".scope-links{margin-top:10px;padding-top:10px;border-top:1px solid var(--border-soft);display:flex;flex-direction:column;gap:2px}" +
    ".scope-links a{font-size:12.5px;color:var(--text-dim);text-decoration:none;padding:6px 8px;border-radius:var(--radius-sm)}" +
    ".scope-links a:hover{background:var(--panel-2);color:var(--text)}" +
    "@media(max-width:640px){.scope-label{display:none}.scope-btn{padding:0 10px;height:38px}.scope-panel{position:fixed;left:12px;right:12px;top:calc(var(--topbar-h) + var(--safe-top) + 6px);width:auto;max-height:calc(100dvh - var(--topbar-h) - var(--safe-top) - 90px);overflow-y:auto;z-index:400}.scope-h{font-size:12px}.scope-row{min-height:44px;font-size:14px}.scope-links a{min-height:44px;display:flex;align-items:center;font-size:14px}}";

  function dotColor() {
    var sc = getScope();
    if (sc.ids.length === 1 && byId(sc.ids[0])) return byId(sc.ids[0]).color || PALETTE[0];
    return "var(--primary)";
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
    style.textContent = CSS;
    document.head.appendChild(style);

    var wrap = document.createElement("div");
    wrap.id = "scope-switch";
    wrap.className = "scope-switch";
    var sc = getScope();
    wrap.innerHTML =
      '<button type="button" class="scope-btn' + (sc.all ? "" : " filtered") + '" aria-haspopup="true" aria-label="Choose which accounts to view" title="Which accounts and period the whole site is showing">' +
      '<span class="scope-dot" style="background:' + dotColor() + '"></span>' +
      '<span class="scope-label">' + esc(scopeLabel()) + "</span>" +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg></button>' +
      '<div class="scope-panel" role="dialog" aria-label="Account scope"></div>';
    bar.insertBefore(wrap, bar.firstChild);

    var btn = wrap.querySelector(".scope-btn");
    var panel = wrap.querySelector(".scope-panel");

    function periodOptionLabel(p) {
      return p.name + " \u00b7 from " + p.start + (p.end === null ? " (current)" : "");
    }

    function renderPanel() {
      var cur = getScope();
      function rowHtml(a, paperRow) {
        var checked = cur.ids.indexOf(a.id) !== -1;
        return '<label class="scope-row"><input type="checkbox" data-acc="' + esc(a.id) + '"' + (paperRow ? " data-paper" : "") + (checked ? " checked" : "") + ">" +
          '<span class="scope-dot" style="background:' + esc(a.color || PALETTE[0]) + '"></span><span>' + esc(a.name) + "</span>" +
          (a.status === "archived" ? '<span class="tag">archived</span>' : "") + "</label>";
      }
      var rows = live().map(function (a) { return rowHtml(a, false); }).join("");
      var bp = brokerPaper();
      if (bp.length) rows += '<div class="scope-h" style="margin-top:12px">Paper accounts (broker)</div>' + bp.map(function (a) { return rowHtml(a, true); }).join("");
      panel.innerHTML =
        '<div class="scope-h">Showing trades from</div>' +
        '<label class="scope-row"><input type="checkbox" data-all' + (cur.all ? " checked" : "") + '><span style="font-weight:600">All real accounts</span></label>' +
        rows +
        '<div class="scope-sub" id="scope-period-wrap" style="display:none"><label for="scope-period">Period</label><select id="scope-period" class="filter-input"></select></div>' +
        '<button type="button" class="btn-confirm scope-apply">Apply</button>' +
        '<div class="scope-links"><a href="accounts.html">Manage accounts &amp; periods</a><a href="practice.html?tab=analytics">Practice simulator attempts</a></div>';

      var boxes = panel.querySelectorAll("input[data-acc]");
      var allBox = panel.querySelector("input[data-all]");
      var pWrap = panel.querySelector("#scope-period-wrap");
      var pSel = panel.querySelector("#scope-period");

      function checkedIds() { return Array.prototype.filter.call(boxes, function (b) { return b.checked; }).map(function (b) { return b.getAttribute("data-acc"); }); }
      function refreshPeriod() {
        var ids = checkedIds();
        var ps = ids.length === 1 ? periodsFor(ids[0]) : [];
        if (!ps.length) { pWrap.style.display = "none"; pSel.innerHTML = ""; return; }
        var keep = cur.ids.length === 1 && cur.ids[0] === ids[0] ? cur.period : null;
        pSel.innerHTML = '<option value="">All time</option>' + ps.map(function (p) {
          return '<option value="' + esc(p.id) + '"' + (p.id === keep ? " selected" : "") + ">" + esc(periodOptionLabel(p)) + "</option>";
        }).join("");
        pWrap.style.display = "block";
      }
      var realBoxes = Array.prototype.filter.call(boxes, function (b) { return !b.hasAttribute("data-paper"); });
      function onlyRealChecked() {
        return realBoxes.length > 0 && Array.prototype.every.call(boxes, function (b) { return b.checked === !b.hasAttribute("data-paper"); });
      }
      allBox.addEventListener("change", function () {
        Array.prototype.forEach.call(boxes, function (b) { b.checked = b.hasAttribute("data-paper") ? false : allBox.checked; });
        refreshPeriod();
      });
      Array.prototype.forEach.call(boxes, function (b) {
        b.addEventListener("change", function () {
          allBox.checked = onlyRealChecked();
          refreshPeriod();
        });
      });
      panel.querySelector(".scope-apply").addEventListener("click", function () {
        var ids = checkedIds();
        if (!ids.length) { if (window.showToast) window.showToast("Pick at least one account.", { tone: "error" }); return; }
        setScope({ ids: onlyRealChecked() ? [] : ids, period: ids.length === 1 ? (pSel.value || null) : null });
        panel.classList.remove("open");
      });
      refreshPeriod();
    }

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!panel.classList.contains("open")) renderPanel();
      panel.classList.toggle("open");
    });
    panel.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", function () { panel.classList.remove("open"); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") panel.classList.remove("open"); });
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
    startsPeriod: startsPeriod,
    periodsFor: periodsFor,
    findPeriod: findPeriod,
    inRange: inRange,
    getScope: getScope,
    setScope: setScope,
    scopeLabel: scopeLabel,
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
