// broker-connections.js -- one IBKR Flex Query connection PER ACCOUNT.
//
// An IBKR paper account is a separate login from the live one, so each account
// (real or broker-paper) needs its own Flex Web Service token + Flex Query ID.
// Rows live in `account_flex` (sql/002_account_flex.sql), keyed by accounts.id.
//
// SECURITY: the token is WRITE-ONLY. This file never reads it back -- the
// browser reads `account_flex_status`, which only says whether a token exists.
//
// Loads after accounts.js. Used by settings.html and accounts.html (the editor)
// and import-trades.html (the status hint).
//
//   BrokerConnections.ready                       resolves once statuses are loaded
//   BrokerConnections.isAvailable()               false if 002_account_flex.sql hasn't run
//   BrokerConnections.get(accountId)              normalized status (never has the token)
//   BrokerConnections.chipHtml(accountId)         small status pill (html)
//   BrokerConnections.renderEditor(el, accId, {onChange})
//   BrokerConnections.save / clear / reload
(function () {
  "use strict";
  if (window.BrokerConnections) return;
  if (!window.sb || !window.AUTH_READY) return;

  var TABLE = "account_flex";
  var VIEW = "account_flex_status";
  var EXPIRY_WARN_DAYS = 14;

  var REPORT_KEY = "sync_report"; // user_kv, written by the daily sync: per-account details it could not turn into trades
  var rows = {};          // account_id -> row from the status view
  // Which parts of the sync details turn the pill amber. Open positions are normal while a trade is
  // held, so flip OPEN_NEEDS_ATTENTION to false if the pill gets too noisy.
  var OPEN_NEEDS_ATTENTION = true;
  var reports = {};       // account_id -> {at, open_positions, no_chart, skipped, deferred}
  var available = true;
  var loadError = "";
  var userId = null;

  var EYE_OPEN = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  var EYE_CLOSED = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.6 21.6 0 0 1 5.06-6.06M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 8 11 8a21.6 21.6 0 0 1-2.61 3.81M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
  var HELP_URL = "https://www.interactivebrokers.com/campus/ibkr-api-page/flex-web-service/";

  function esc(s) { return window.escapeHtml ? window.escapeHtml(s) : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function q(fn) { return window.__withRetry ? window.__withRetry(fn) : Promise.resolve().then(fn); }
  function toast(m, tone) { if (window.showToast) window.showToast(m, tone ? { tone: tone } : undefined); }
  function accountName(id) { var a = window.Accounts && window.Accounts.byId(id); return a ? a.name : "this account"; }
  function isPaperAccount(id) { var a = window.Accounts && window.Accounts.byId(id); return !!(a && window.Accounts.isBrokerPaper(a)); }

  // ------------------------------------------------------------------
  // load / read
  // ------------------------------------------------------------------
  function load() {
    return q(function () { return window.sb.from(VIEW).select("*"); }).then(function (res) {
      if (res.error) { available = false; loadError = res.error.message || "unknown error"; return; }
      available = true; loadError = "";
      rows = {};
      (res.data || []).forEach(function (r) { rows[r.account_id] = r; });
    }, function (err) { available = false; loadError = (err && err.message) || String(err); }).then(loadReports);
  }

  // The sync details are a nicety: if they can't be read, the page works exactly as before.
  function loadReports() {
    return q(function () { return window.sb.from("user_kv").select("value").eq("key", REPORT_KEY).limit(1); }).then(function (res) {
      reports = {};
      if (!res || res.error || !res.data || !res.data.length) return;
      var v = res.data[0].value;
      try { if (typeof v === "string") v = JSON.parse(v); } catch (e) { return; }
      if (v && v.accounts && typeof v.accounts === "object") reports = v.accounts;
    }, function () { reports = {}; }).then(dropSavedStuck);
  }

  // A "no chart yet" trade can get saved some other way (manual import) before the next sync runs.
  // Ask the trades table which of them exist now and drop those, so the list never nags about them.
  function dropSavedStuck() {
    var ids = [];
    Object.keys(reports).forEach(function (a) { listOf(reports[a] && reports[a].no_chart).forEach(function (t) { if (t && t.id) ids.push(t.id); }); });
    if (!ids.length) return;
    return q(function () { return window.sb.from("trades").select("id").in("id", ids); }).then(function (res) {
      if (!res || res.error || !res.data) return;   // can't tell: keep showing them
      var saved = {};
      res.data.forEach(function (r) { saved[r.id] = true; });
      Object.keys(reports).forEach(function (a) {
        var r = reports[a];
        if (r && Array.isArray(r.no_chart)) r.no_chart = r.no_chart.filter(function (t) { return !(t && saved[t.id]); });
      });
    }, function () {});
  }

  function listOf(x) { return Array.isArray(x) ? x : []; }

  var ready = window.AUTH_READY.then(function (session) {
    if (!session) { available = false; return null; }
    userId = session.user.id;
    return load();
  });

  function daysUntil(iso) {
    if (!iso) return null;
    var t = Date.parse(iso + "T00:00:00");
    if (isNaN(t)) return null;
    return Math.ceil((t - Date.now()) / 86400000);
  }

  function get(accountId) {
    var r = rows[accountId] || null;
    var hasToken = !!(r && r.has_ibkr_flex_token);
    var queryId = (r && r.ibkr_flex_query_id) || "";
    var days = r ? daysUntil(r.token_expires_on) : null;
    var rep = reports[accountId] || null;
    var stuckN = rep ? listOf(rep.no_chart).length : 0;       // trades the sync could not save yet
    var attention = rep ? stuckN + listOf(rep.skipped).length + (OPEN_NEEDS_ATTENTION ? listOf(rep.open_positions).length : 0) : 0;
    var health = "off";
    if (hasToken && queryId) {
      health = "ok";
      if (r.last_sync_status === "failed") health = "failed";
      if (days !== null && days < 0) health = "expired";
      else if (days !== null && days <= EXPIRY_WARN_DAYS && health === "ok") health = "expiring";
      if (health === "ok" && attention > 0) health = "attention";
    }
    return {
      connected: hasToken && !!queryId,
      hasToken: hasToken,
      queryId: queryId,
      expiresOn: (r && r.token_expires_on) || "",
      daysToExpiry: days,
      accountRef: (r && r.ibkr_account_ref) || "",
      lastSyncAt: (r && r.last_sync_at) || null,
      lastStatus: (r && r.last_sync_status) || "",
      lastMessage: (r && r.last_sync_message) || "",
      report: rep,
      attention: attention,
      stuck: stuckN,
      health: health,
    };
  }

  function connectedCount(accountIds) {
    return accountIds.filter(function (id) { return get(id).connected; }).length;
  }

  function chipText(st) {
    if (st.health === "off") return "Not connected";
    if (st.health === "expired") return "Token expired";
    if (st.health === "expiring") return "Token expires in " + st.daysToExpiry + "d";
    if (st.health === "failed") return "Last sync failed";
    if (st.health === "attention") {
      // "trades" only when every flagged item is a stuck trade; otherwise the count mixes in open/skipped items.
      var word = st.attention === st.stuck ? "trade" : "item";
      return st.attention + " " + word + (st.attention === 1 ? " needs" : "s need") + " attention";
    }
    return "Auto-sync on";
  }

  function chipHtml(accountId) {
    if (!available) return "";
    var st = get(accountId);
    var cls = st.health === "ok" ? " bc-ok" : (st.health === "off" ? "" : " bc-warn");
    return '<span class="pill bc-chip' + cls + '">' + esc(chipText(st)) + "</span>";
  }

  function otherAccountWithQuery(queryId, exceptId) {
    var ids = Object.keys(rows);
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] !== exceptId && rows[ids[i]].ibkr_flex_query_id === queryId) return ids[i];
    }
    return null;
  }

  // ------------------------------------------------------------------
  // write
  // ------------------------------------------------------------------
  // v = { token (blank = keep saved), queryId, expiresOn, accountRef }
  function validate(accountId, v) {
    var prev = get(accountId);
    var token = String(v.token || "").trim();
    var queryId = String(v.queryId || "").trim();
    var ref = String(v.accountRef || "").trim().toUpperCase();
    var expires = String(v.expiresOn || "").trim();
    if (!queryId) return { error: "Enter the Flex Query ID." };
    if (!/^\d{4,12}$/.test(queryId)) return { error: "The Flex Query ID is a number (digits only), e.g. 912345." };
    if (!token && !prev.hasToken) return { error: "Paste the Flex Web Service token." };
    if (token && !/^[A-Za-z0-9]{10,64}$/.test(token)) return { error: "That token looks off \u2014 it should be one unbroken string of letters/digits with no spaces." };
    if (ref && !/^[A-Z]{1,2}\d{5,9}$/.test(ref)) return { error: "IBKR account numbers look like U1234567 (real) or DU1234567 (paper)." };
    if (expires && isNaN(Date.parse(expires))) return { error: "Pick a valid expiry date or leave it empty." };
    return { token: token, queryId: queryId, ref: ref, expires: expires, prev: prev };
  }

  function save(accountId, v) {
    var c = validate(accountId, v);
    if (c.error) return Promise.reject(new Error(c.error));
    var credsChanged = !!c.token || c.queryId !== c.prev.queryId;
    var payload = {
      account_id: accountId,
      user_id: userId,
      ibkr_flex_query_id: c.queryId,
      token_expires_on: c.expires || null,
      ibkr_account_ref: c.ref || null,
      updated_at: new Date().toISOString(),
    };
    if (c.token) payload.ibkr_flex_token = c.token;
    if (credsChanged) { payload.last_sync_status = null; payload.last_sync_message = null; }
    // Not .upsert(): its ON CONFLICT ... SET col = EXCLUDED.col reads every column it writes, and the
    // token column deliberately has no SELECT grant, so Postgres answers "permission denied for table".
    // Update the row if there is one (RETURNING only the readable account_id), otherwise insert it.
    var changes = Object.assign({}, payload); delete changes.account_id; delete changes.user_id;
    return q(function () { return window.sb.from(TABLE).update(changes).eq("account_id", accountId).select("account_id"); }).then(function (res) {
      if (res.error || (res.data && res.data.length)) return res;
      return q(function () { return window.sb.from(TABLE).insert(payload); });
    }).then(function (res) {
      if (res.error) throw new Error(res.error.message);
      var r = Object.assign({}, rows[accountId] || { account_id: accountId });
      r.ibkr_flex_query_id = c.queryId;
      r.token_expires_on = c.expires || null;
      r.ibkr_account_ref = c.ref || null;
      r.has_ibkr_flex_token = !!c.token || c.prev.hasToken;
      if (credsChanged) { r.last_sync_status = null; r.last_sync_message = null; }
      rows[accountId] = r;
      return get(accountId);
    });
  }

  function clear(accountId) {
    return q(function () { return window.sb.from(TABLE).delete().eq("account_id", accountId); }).then(function (res) {
      if (res.error) throw new Error(res.error.message);
      delete rows[accountId];
    });
  }

  // ------------------------------------------------------------------
  // editor
  // ------------------------------------------------------------------
  var CSS =
    ".bc-chip.bc-ok{background:var(--green-soft);color:var(--green);border-color:rgba(47,208,138,.3)}" +
    ".bc-chip.bc-warn{background:var(--amber-soft);color:var(--amber);border-color:rgba(232,169,76,.3)}" +
    ".bc-editor{display:flex;flex-direction:column;gap:12px}" +
    ".bc-state{font-size:12px;color:var(--text-dim);line-height:1.5}" +
    ".bc-state.bad{color:var(--amber)}" +
    ".bc-details{border:1px solid var(--border,rgba(128,128,128,.25));border-radius:8px;padding:8px 10px;font-size:12px;color:var(--text-dim)}" +
    ".bc-details summary{cursor:pointer;font-weight:600;color:var(--text);display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;min-height:44px}" +
    ".bc-asof{font-weight:400;font-size:11px;color:var(--text-faint)}" +
    ".bc-sec{margin-top:10px}.bc-h{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-faint);margin-bottom:4px}" +
    ".bc-sec ul{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:6px;line-height:1.45}" +
    ".bc-sub{font-size:11.5px;color:var(--text-faint)}.bc-empty{margin-top:8px;font-size:12px;color:var(--text-faint)}" +
    ".bc-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}" +
    ".bc-grid label{display:block;font-size:11px;color:var(--text-faint);margin-bottom:4px}" +
    ".bc-grid input{width:100%;box-sizing:border-box}" +
    ".bc-row{display:flex;gap:6px}.bc-row input{flex:1;min-width:0}" +
    ".bc-note{font-size:11.5px;color:var(--text-faint);line-height:1.55;margin:0}" +
    ".bc-note a{color:var(--primary);text-decoration:none}.bc-note a:hover{text-decoration:underline}" +
    ".bc-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}" +
    ".bc-actions .btn-confirm{padding:7px 16px;font-size:12.5px}" +
    ".bc-saved{font-size:11.5px;color:var(--green);opacity:0;transition:opacity .2s}.bc-saved.show{opacity:1}" +
    ".bc-off{margin-left:auto;font-size:12px;color:var(--red);background:none;border:none;cursor:pointer;padding:4px}.bc-off:hover{text-decoration:underline}" +
    "@media(max-width:640px){.bc-grid{grid-template-columns:1fr}.bc-actions .btn-confirm{flex:1;min-height:44px}.bc-off{min-height:44px}}";
  var cssAdded = false;
  function addCss() {
    if (cssAdded) return;
    cssAdded = true;
    var s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function fmtWhen(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }

  function stateLine(st) {
    if (!st.connected) return { bad: false, text: "Not connected. Without it, this account only gets trades from manual imports." };
    var parts = [];
    if (st.lastSyncAt) {
      parts.push("Last sync " + fmtWhen(st.lastSyncAt) + (st.lastStatus === "failed" ? " \u2014 failed" + (st.lastMessage ? ": " + st.lastMessage : "") : st.lastStatus === "skipped" ? " \u2014 skipped" + (st.lastMessage ? ": " + st.lastMessage : "") : " \u2014 ok"));
    } else {
      parts.push("Connected. No sync has run for this account yet.");
    }
    if (st.health === "expired") parts.push("The token you noted has expired \u2014 generate a new one in IBKR and paste it below.");
    else if (st.health === "expiring") parts.push("Token expires in " + st.daysToExpiry + " day" + (st.daysToExpiry === 1 ? "" : "s") + " \u2014 generate a new one before then.");
    return { bad: st.health !== "ok" && st.health !== "attention", text: parts.join(" ") };
  }

  // "2026-10-13T06:00:00Z" -> local date/time; bare "HH:MM:SS" entry times pass through.
  function retryText(iso) {
    if (!iso) return "next sync";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "next sync";
    return d.getTime() <= Date.now() ? "next sync" : fmtWhen(iso);
  }
  function num(n) { var x = Number(n); return isFinite(x) ? String(Math.round(x * 100) / 100) : "?"; }
  function when(date, time) { return [date, time && String(time).slice(0, 5)].filter(Boolean).join(" "); }

  function detailsHtml(st) {
    var rep = st.report;
    if (!st.connected || !rep) return "";
    var open = listOf(rep.open_positions), stuck = listOf(rep.no_chart), skipped = listOf(rep.skipped);
    var deferred = Number(rep.deferred) || 0;
    var h = '<details class="bc-details"' + (st.attention ? " open" : "") + "><summary>Sync details <span class=\"bc-asof\">as of " + esc(fmtWhen(rep.at)) + "</span>" +
      (st.attention ? ' <span class="pill bc-chip bc-warn">' + st.attention + "</span>" : "") + "</summary>";
    if (!open.length && !stuck.length && !skipped.length && !deferred) {
      return h + '<div class="bc-empty">Nothing is open, stuck or skipped.</div></details>';
    }
    if (stuck.length) {
      h += '<div class="bc-sec"><div class="bc-h">No chart yet</div><ul>' + stuck.map(function (t) {
        return "<li><b>" + esc(t.symbol) + "</b> " + esc(when(t.date)) + " \u2014 " + esc(t.reason || "chart data unavailable") +
          '<div class="bc-sub">Not saved without its chart. Tried ' + esc(t.attempts || 0) + "\u00d7. Next retry: " + esc(retryText(t.next_retry)) + ".</div></li>";
      }).join("") + "</ul></div>";
    }
    if (deferred) h += '<div class="bc-sec"><div class="bc-h">Waiting</div><ul><li>' + deferred + " more new trade" + (deferred === 1 ? "" : "s") + " will be processed on the next sync.</li></ul></div>";
    if (open.length) {
      h += '<div class="bc-sec"><div class="bc-h">Open positions</div><ul>' + open.map(function (p) {
        return "<li><b>" + esc(p.symbol) + "</b> " + esc(p.side || "") + " " + esc(num(p.qty)) + " sh" + (p.avg_price ? " @ " + esc(num(p.avg_price)) : "") +
          ", entered " + esc(when(p.date, p.entry_time)) + '<div class="bc-sub">Still open \u2014 will be saved when it closes.</div></li>';
      }).join("") + "</ul></div>";
    }
    if (skipped.length) {
      h += '<div class="bc-sec"><div class="bc-h">Skipped fills</div><ul>' + skipped.map(function (k) {
        var bits = [];
        if (k.fills) bits.push(k.fills + " fill" + (k.fills === 1 ? "" : "s"));
        if (k.qty) bits.push(num(k.qty) + " sh");
        if (k.date) bits.push(when(k.date, k.first_time));
        return "<li><b>" + esc(k.symbol) + "</b>" + (bits.length ? " (" + esc(bits.join(", ")) + ")" : "") + " \u2014 " + esc(k.reason || "ignored") + "</li>";
      }).join("") + "</ul></div>";
    }
    return h + "</details>";
  }

  function confirmAsk(msg, opts) {
    if (window.UIModal && window.UIModal.confirm) return window.UIModal.confirm(msg, opts);
    return Promise.resolve(window.confirm(msg));
  }

  function renderEditor(el, accountId, opts) {
    opts = opts || {};
    addCss();
    if (!available) {
      el.innerHTML = '<div class="bc-note">Per-account broker connections aren\u2019t set up in your database yet. Run <b>sql/002_account_flex.sql</b> in the Supabase SQL editor, then reload.' + (loadError ? " (" + esc(loadError) + ")" : "") + "</div>";
      return;
    }
    var st = get(accountId);
    var line = stateLine(st);
    var paper = isPaperAccount(accountId);
    var tokenPh = st.hasToken ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 saved \u2014 leave blank to keep" : "e.g. 187xxxxxxxxxxxxxxx";
    var pre = "bc-" + accountId + "-";
    el.innerHTML =
      '<div class="bc-editor">' +
      '<div class="bc-state' + (line.bad ? " bad" : "") + '">' + esc(line.text) + "</div>" +
      detailsHtml(st) +
      '<div class="bc-grid">' +
      '<div><label for="' + pre + 'token">Flex Web Service token</label><div class="bc-row"><input class="filter-input" id="' + pre + 'token" type="password" autocomplete="new-password" placeholder="' + esc(tokenPh) + '">' +
      '<button type="button" class="btn-icon" data-eye title="Show/hide" aria-label="Show/hide">' + EYE_OPEN + "</button></div></div>" +
      '<div><label for="' + pre + 'query">Flex Query ID</label><input class="filter-input" id="' + pre + 'query" type="text" inputmode="numeric" autocomplete="off" placeholder="e.g. 912345" value="' + esc(st.queryId) + '"></div>' +
      '<div><label for="' + pre + 'ref">IBKR account no. <span style="opacity:.7">(optional)</span></label><input class="filter-input" id="' + pre + 'ref" type="text" autocomplete="off" autocapitalize="characters" placeholder="' + (paper ? "e.g. DU1234567" : "e.g. U1234567") + '" value="' + esc(st.accountRef) + '"></div>' +
      '<div><label for="' + pre + 'exp">Token expires <span style="opacity:.7">(optional)</span></label><input class="filter-input" id="' + pre + 'exp" type="date" value="' + esc(st.expiresOn) + '"></div>' +
      "</div>" +
      '<p class="bc-note">Use the token and query that belong to <b>' + esc(accountName(accountId)) + "</b>" + (paper ? " \u2014 your IBKR <b>paper</b> login" : "") + " only. Every IBKR login has its own. The account number lets the sync refuse a statement that came from a different IBKR account, so paper fills can\u2019t land in a real account. The expiry date just powers a reminder here. " +
      '<a href="' + HELP_URL + '" target="_blank" rel="noopener">Where do I find these? \u2197</a></p>' +
      '<div class="bc-actions"><button type="button" class="btn-confirm" data-save>Save</button><span class="bc-saved" data-saved>Saved</span>' +
      (st.connected || st.queryId ? '<button type="button" class="bc-off" data-off>Disconnect</button>' : "") + "</div></div>";

    function $(sel) { return el.querySelector(sel); }
    var tokenEl = $("#" + CSS_escape(pre + "token"));
    var queryEl = $("#" + CSS_escape(pre + "query"));
    var refEl = $("#" + CSS_escape(pre + "ref"));
    var expEl = $("#" + CSS_escape(pre + "exp"));

    $("[data-eye]").addEventListener("click", function (ev) {
      ev.stopPropagation();
      var showing = tokenEl.type === "text";
      tokenEl.type = showing ? "password" : "text";
      this.innerHTML = showing ? EYE_OPEN : EYE_CLOSED;
    });

    var saveBtn = $("[data-save]");
    saveBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      var v = { token: tokenEl.value, queryId: queryEl.value, accountRef: refEl.value, expiresOn: expEl.value };
      var c = validate(accountId, v);
      if (c.error) { toast(c.error, "error"); return; }
      var warnings = [];
      var dupe = otherAccountWithQuery(c.queryId, accountId);
      if (dupe) warnings.push("Query ID " + c.queryId + " is already connected to \u201c" + accountName(dupe) + "\u201d. Using the same query on two accounts would import the same trades twice.");
      if (c.ref) {
        var looksPaper = /^D[A-Z]\d/.test(c.ref);
        if (paper && !looksPaper) warnings.push("\u201c" + accountName(accountId) + "\u201d is a paper account, but " + c.ref + " doesn\u2019t look like an IBKR paper number (those start with DU).");
        if (!paper && looksPaper) warnings.push("\u201c" + accountName(accountId) + "\u201d is a real account, but " + c.ref + " looks like an IBKR paper number (DU\u2026). Paper trades would be mixed into your real account.");
      }
      var go = warnings.length
        ? confirmAsk(warnings.join("\n\n") + "\n\nSave anyway?", { title: "Check this before saving", tone: "danger", confirmLabel: "Save anyway" })
        : Promise.resolve(true);
      go.then(function (ok) {
        if (!ok) return;
        saveBtn.disabled = true;
        return save(accountId, v).then(function () {
          renderEditor(el, accountId, opts);
          var note = el.querySelector("[data-saved]");
          if (note) { note.classList.add("show"); setTimeout(function () { note.classList.remove("show"); }, 1800); }
          if (opts.onChange) opts.onChange(accountId);
        }, function (e) { saveBtn.disabled = false; toast(e.message || String(e), "error"); });
      });
    });

    var offBtn = $("[data-off]");
    if (offBtn) offBtn.addEventListener("click", function (ev) {
      ev.stopPropagation();
      confirmAsk("Remove the saved IBKR connection for \u201c" + accountName(accountId) + "\u201d? Its trades stay; the daily sync just stops pulling for it.", { title: "Disconnect?", tone: "danger", confirmLabel: "Disconnect" }).then(function (ok) {
        if (!ok) return;
        clear(accountId).then(function () {
          renderEditor(el, accountId, opts);
          if (opts.onChange) opts.onChange(accountId);
        }, function (e) { toast(e.message || String(e), "error"); });
      });
    });

    [tokenEl, queryEl, refEl, expEl].forEach(function (i) { i.addEventListener("click", function (ev) { ev.stopPropagation(); }); });
  }

  function CSS_escape(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }

  window.BrokerConnections = {
    ready: ready,
    isAvailable: function () { return available; },
    reload: load,
    get: get,
    connectedCount: connectedCount,
    chipHtml: chipHtml,
    renderEditor: renderEditor,
    save: save,
    clear: clear,
  };
})();
