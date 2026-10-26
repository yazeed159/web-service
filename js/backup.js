// backup.js -- "Download everything" for Settings. Pulls the signed-in user's rows (RLS limits every
// query to their own data) and saves one JSON file: accounts, the trades index, and the user_kv
// store (capital ledger, periods, trade notes, grades, daily notes, settings...). Chart data /
// AI verdicts (trade_details) are optional because they can be big. Keys that look like secrets
// (tokens, API keys, passwords) are left out of the file on purpose.
(function () {
  "use strict";
  var SECRET_RE = /token|secret|api[_-]?key|password|passwd|flex/i;
  var PAGE = 1000;

  function pageAll(table, orderCol, onProgress) {
    var rows = [];
    function go(from, ordered) {
      var q = window.sb.from(table).select("*");
      if (ordered && orderCol) q = q.order(orderCol, { ascending: true });
      return q.range(from, from + PAGE - 1).then(function (res) {
        if (res.error) {
          if (ordered && orderCol) return go(from, false); // column may not exist -> retry unordered
          throw new Error(table + ": " + (res.error.message || res.error));
        }
        var got = res.data || [];
        rows = rows.concat(got);
        if (onProgress) onProgress(table, rows.length);
        return got.length === PAGE ? go(from + PAGE, ordered) : rows;
      });
    }
    return go(0, true);
  }

  function build(opts, onProgress) {
    opts = opts || {};
    return window.AUTH_READY.then(function (session) {
      if (!session) throw new Error("Please log in first.");
      var out = { app: "trade.log", format: 1, exported_at: new Date().toISOString(), user_email: session.user && session.user.email || null };
      return pageAll("accounts", "created_at", onProgress).catch(function () { return []; })
        .then(function (a) { out.accounts = a; return pageAll("trades", "trade_date", onProgress); })
        .then(function (t) { out.trades = t; return pageAll("user_kv", "key", onProgress); })
        .then(function (kv) {
          var kept = [], skipped = 0;
          kv.forEach(function (r) { if (SECRET_RE.test(String(r.key))) skipped++; else kept.push(r); });
          out.user_kv = kept; out.user_kv_skipped_secret_keys = skipped;
          return opts.includeDetails ? pageAll("trade_details", "trade_id", onProgress) : null;
        })
        .then(function (d) {
          if (d) out.trade_details = d;
          out.counts = { accounts: out.accounts.length, trades: out.trades.length, user_kv: out.user_kv.length, trade_details: d ? d.length : "not included" };
          return out;
        });
    });
  }

  function download(obj) {
    var name = "trade-log-backup-" + new Date().toLocaleDateString("en-CA") + ".json";
    var blob = new Blob([JSON.stringify(obj)], { type: "application/json" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1500);
    return { name: name, bytes: blob.size };
  }

  // ------------------------------------------------------------------
  // Trades as CSV -- for your own spreadsheets or an accountant. Every account, every trade (not the
  // journal's filtered view). Text cells starting with = + - @ get a leading apostrophe so Excel never
  // runs them as formulas; numbers are left alone so negative P&L stays a number.
  // ------------------------------------------------------------------
  var CSV_COLUMNS = [
    ["Trade date", "trade_date"], ["Entry time", "entry_time"], ["Exit time", "exit_time"], ["Symbol", "symbol", true], ["Side", "side", true],
    ["Shares", "shares"], ["Entry price", "entry_price"], ["Exit price", "exit_price"], ["Commission", "commission"], ["Fees", "fees"],
    ["Net P&L", "pnl_after_comm"], ["Result", "_result"], ["Setup", "setup_type", true], ["Tags", "_tags", true], ["Account", "_account", true], ["Trade id", "id", true],
  ];
  function csvCell(v, isText) {
    var s = v == null ? "" : String(v);
    if (isText && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function tradesCsv(trades, accounts) {
    var names = {};
    (accounts || []).forEach(function (a) { names[a.id] = a.name; });
    var rows = (trades || []).slice().sort(function (a, b) {
      return String(a.trade_date).localeCompare(String(b.trade_date)) || String(a.entry_time || "").localeCompare(String(b.entry_time || ""));
    });
    var lines = [CSV_COLUMNS.map(function (c) { return csvCell(c[0]); }).join(",")];
    rows.forEach(function (t) {
      var v = Object.assign({}, t, {
        _result: t.pnl_after_comm == null ? "" : (t.win ? "WIN" : "LOSS"),
        _tags: (t.behavior_tags || []).concat(t.lesson_tags || []).filter(Boolean).join("; "),
        _account: names[t.account_id] || "",
      });
      lines.push(CSV_COLUMNS.map(function (c) { return csvCell(v[c[1]], c[2]); }).join(","));
    });
    return lines.join("\r\n");
  }
  function downloadCsv(csv) {
    var name = "trade-log-trades-" + new Date().toLocaleDateString("en-CA") + ".csv";
    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1500);
    return { name: name, bytes: blob.size };
  }
  function exportTradesCsv(onProgress) {
    return window.AUTH_READY.then(function (session) {
      if (!session) throw new Error("Please log in first.");
      return Promise.all([pageAll("trades", "trade_date", onProgress), pageAll("accounts", "created_at").catch(function () { return []; })]);
    }).then(function (r) { return { count: r[0].length, csv: tradesCsv(r[0], r[1]) }; });
  }

  // ------------------------------------------------------------------
  // Restore. Records in the file replace the SAME records now (same trade id / same key / same account
  // id); anything not in the file is left alone. Every row is re-stamped with the CURRENT user's id, so a
  // backup from another login imports into this one instead of being refused by row-level security.
  // ------------------------------------------------------------------
  var CHUNK = 500;

  function validate(obj) {
    if (!obj || typeof obj !== "object" || obj.app !== "trade.log") return { ok: false, error: "This isn't a trade.log backup file." };
    if (obj.format !== 1) return { ok: false, error: "This backup is from a newer or unknown version (format " + obj.format + ")." };
    var bad = ["accounts", "trades", "user_kv"].filter(function (k) { return !Array.isArray(obj[k]); });
    if (bad.length) return { ok: false, error: "The file is missing: " + bad.join(", ") + "." };
    return { ok: true, exported_at: obj.exported_at || null,
             counts: { accounts: obj.accounts.length, trades: obj.trades.length, user_kv: obj.user_kv.length, trade_details: Array.isArray(obj.trade_details) ? obj.trade_details.length : 0 } };
  }

  // -> [{table, onConflict, rows}] in the order they must be written.
  function prepare(obj, userId, opts) {
    var o = { accounts: true, trades: true, details: true, kv: true };
    Object.keys(opts || {}).forEach(function (k) { o[k] = opts[k]; });
    function stamp(rows) { return rows.map(function (r) { return "user_id" in r ? Object.assign({}, r, { user_id: userId }) : r; }); }
    var plan = [];
    if (o.accounts && obj.accounts.length) plan.push({ table: "accounts", onConflict: "id", rows: stamp(obj.accounts) });
    if (o.trades && obj.trades.length) plan.push({ table: "trades", onConflict: "user_id,id", rows: stamp(obj.trades) });
    if (o.details && Array.isArray(obj.trade_details) && obj.trade_details.length) plan.push({ table: "trade_details", onConflict: "user_id,trade_id", rows: stamp(obj.trade_details) });
    var kv = obj.user_kv.filter(function (r) { return r && typeof r.key === "string" && !SECRET_RE.test(r.key); });
    if (o.kv && kv.length) plan.push({ table: "user_kv", onConflict: "user_id,key", rows: stamp(kv) });
    return plan;
  }

  function restore(obj, opts, onProgress) {
    var v = validate(obj);
    if (!v.ok) return Promise.reject(new Error(v.error));
    return window.AUTH_READY.then(function (session) {
      if (!session) throw new Error("Please log in first.");
      var plan = prepare(obj, session.user.id, opts);
      if (!plan.length) throw new Error("Nothing selected to restore.");
      var safety = opts && opts.saveCopyFirst ? build({ includeDetails: false }).then(download) : Promise.resolve(null);
      return safety.then(function () {
        var done = {};
        function writeTable(i) {
          if (i >= plan.length) return done;
          var step = plan[i];
          function writeChunk(from) {
            if (from >= step.rows.length) return writeTable(i + 1);
            return window.sb.from(step.table).upsert(step.rows.slice(from, from + CHUNK), { onConflict: step.onConflict }).then(function (res) {
              if (res && res.error) throw new Error(step.table + ": " + (res.error.message || res.error) + " \u2014 restore stopped here" + (Object.keys(done).length ? " (already restored: " + Object.keys(done).join(", ") + ")" : ""));
              done[step.table] = Math.min(from + CHUNK, step.rows.length);
              if (onProgress) onProgress(step.table, done[step.table], step.rows.length);
              return writeChunk(from + CHUNK);
            });
          }
          return writeChunk(0);
        }
        return writeTable(0);
      });
    });
  }

  // ---------- Dry run: what would restoring change? (pure; `current` = {accounts, trades, user_kv} rows) ----------
  var IGNORED = { user_id: 1, created_at: 1, updated_at: 1 };
  function stable(v) {
    if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter(function (k) { return !IGNORED[k]; }).map(function (k) { return JSON.stringify(k) + ":" + stable(v[k]); }).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  function tally(backupRows, currentRows, idOf) {
    var cur = {}; currentRows.forEach(function (r) { cur[idOf(r)] = stable(r); });
    var t = { new: 0, changed: 0, same: 0 };
    backupRows.forEach(function (r) { var c = cur[idOf(r)]; if (c === undefined) t.new++; else if (c === stable(r)) t.same++; else t.changed++; });
    return t;
  }
  // How one stored value differs: items/keys that exist now but are NOT in the backup are the ones that disappear.
  function valueDelta(cur, bak) {
    if (stable(cur) === stable(bak)) return { status: "same", lost: 0, added: 0, changed: 0 };
    if (Array.isArray(cur) && Array.isArray(bak)) {
      var cs = cur.map(stable), bs = bak.map(stable);
      return { status: "changed", lost: cs.filter(function (x) { return bs.indexOf(x) === -1; }).length, added: bs.filter(function (x) { return cs.indexOf(x) === -1; }).length, changed: 0 };
    }
    if (cur && bak && typeof cur === "object" && typeof bak === "object" && !Array.isArray(cur) && !Array.isArray(bak)) {
      var ck = Object.keys(cur), bk = Object.keys(bak);
      return { status: "changed", lost: ck.filter(function (k) { return !(k in bak); }).length, added: bk.filter(function (k) { return !(k in cur); }).length,
               changed: ck.filter(function (k) { return k in bak && stable(cur[k]) !== stable(bak[k]); }).length };
    }
    return { status: "changed", lost: 0, added: 0, changed: 1 };
  }
  var FRIENDLY = { capital_ledger: "Deposits & periods", daily_loss_limit: "Daily loss limit", broker_paper_ids: "Broker paper accounts", "trade.log:grades": "Trade grades", "trade.log:daily_notes": "Daily notes" };
  function diff(obj, current, opts) {
    var o = { accounts: true, trades: true, details: true, kv: true };
    Object.keys(opts || {}).forEach(function (k) { o[k] = opts[k]; });
    var out = { accounts: null, trades: null, details: null, kv: [], lostTotal: 0, nothingChanges: true };
    if (o.accounts) out.accounts = tally(obj.accounts, current.accounts || [], function (r) { return r.id; });
    if (o.trades) out.trades = tally(obj.trades, current.trades || [], function (r) { return r.id; });
    if (o.details && Array.isArray(obj.trade_details)) out.details = obj.trade_details.length;
    if (o.kv) {
      var cur = {}; (current.user_kv || []).forEach(function (r) { cur[r.key] = r.value; });
      obj.user_kv.filter(function (r) { return r && typeof r.key === "string" && !SECRET_RE.test(r.key); }).forEach(function (r) {
        var d = r.key in cur ? valueDelta(cur[r.key], r.value) : { status: "new", lost: 0, added: 0, changed: 0 };
        if (d.status === "same") return;
        d.key = r.key; d.label = FRIENDLY[r.key] || r.key; out.kv.push(d); out.lostTotal += d.lost;
      });
    }
    out.nothingChanges = !((out.accounts && (out.accounts.new || out.accounts.changed)) || (out.trades && (out.trades.new || out.trades.changed)) || out.kv.length || out.details);
    return out;
  }

  function fetchCurrent() { return Promise.all([pageAll("accounts", "created_at").catch(function () { return []; }), pageAll("trades", "trade_date"), pageAll("user_kv", "key")]).then(function (r) { return { accounts: r[0], trades: r[1], user_kv: r[2] }; }); }

  window.Backup = { tradesCsv: tradesCsv, exportTradesCsv: exportTradesCsv, downloadCsv: downloadCsv, build: build, download: download, validate: validate, prepare: prepare, restore: restore, diff: diff, fetchCurrent: fetchCurrent, SECRET_RE: SECRET_RE };

  // Settings page wiring (no-ops on other pages)
  function wire() {
    var btn = document.getElementById("backup-btn"), st = document.getElementById("backup-status");
    if (!btn || btn.__wired) return; btn.__wired = true;
    btn.addEventListener("click", function () {
      btn.disabled = true; st.textContent = "Collecting your data\u2026";
      build({ includeDetails: !!(document.getElementById("backup-details") || {}).checked }, function (table, n) { st.textContent = "Reading " + table + "\u2026 " + n + " rows"; })
        .then(function (obj) {
          var r = download(obj);
          st.textContent = "Saved " + r.name + " (" + (r.bytes / 1048576).toFixed(1) + " MB) \u2014 " + obj.counts.trades + " trades, " + obj.counts.accounts + " accounts, " + obj.counts.user_kv + " settings/notes records" + (obj.user_kv_skipped_secret_keys ? "; " + obj.user_kv_skipped_secret_keys + " secret-looking key(s) left out" : "") + ".";
        })
        .catch(function (e) { st.textContent = "Backup failed: " + (e && e.message || e); })
        .then(function () { btn.disabled = false; });
    });
  }
  function wireCsv() {
    var btn = document.getElementById("export-csv-btn"), st = document.getElementById("backup-status");
    if (!btn || btn.__wired) return; btn.__wired = true;
    btn.addEventListener("click", function () {
      btn.disabled = true; st.textContent = "Collecting your trades\u2026";
      exportTradesCsv(function (table, n) { st.textContent = "Reading " + table + "\u2026 " + n + " rows"; })
        .then(function (r) {
          if (!r.count) { st.textContent = "No trades to export yet."; return; }
          var d = downloadCsv(r.csv);
          st.textContent = "Saved " + d.name + " \u2014 " + r.count + " trades from all accounts.";
        })
        .catch(function (e) { st.textContent = "CSV export failed: " + (e && e.message || e); })
        .then(function () { btn.disabled = false; });
    });
  }
  function wireRestore() {
    var file = document.getElementById("restore-file"), btn = document.getElementById("restore-btn"), st = document.getElementById("restore-status"), sum = document.getElementById("restore-summary");
    if (!file || file.__wired) return; file.__wired = true;
    var loaded = null;
    function opt(id) { var e = document.getElementById(id); return !!(e && e.checked); }
    var current = null, diffEl = document.getElementById("restore-diff");
    function esc(x) { return String(x).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
    function opts() { return { accounts: opt("restore-accounts"), trades: opt("restore-trades"), details: opt("restore-trades"), kv: opt("restore-kv") }; }
    function renderDiff() {
      if (!loaded) { diffEl.innerHTML = ""; return; }
      if (!current) { diffEl.textContent = "Couldn't read your current data to compare \u2014 you can still restore, but nothing is previewed."; return; }
      var d = diff(loaded, current, opts()), rows = [];
      function line(label, t) { if (t) rows.push("<li><b>" + label + "</b>: " + t.new + " new \u00b7 " + t.changed + " replaced \u00b7 " + t.same + " identical</li>"); }
      line("Trades", d.trades); line("Accounts", d.accounts);
      if (d.details) rows.push("<li><b>Chart data / verdicts</b>: " + d.details + " records will be written (not compared)</li>");
      d.kv.slice(0, 12).forEach(function (k) {
        var bits = [];
        if (k.status === "new") bits.push("new"); else {
          if (k.added) bits.push(k.added + " added"); if (k.changed) bits.push(k.changed + " edited");
          if (k.lost) bits.push('<span style="color:var(--red)">' + k.lost + " that you have now would be gone</span>");
          if (!bits.length) bits.push("replaced");
        }
        rows.push("<li><b>" + esc(k.label) + "</b>: " + bits.join(" \u00b7 ") + "</li>");
      });
      if (d.kv.length > 12) rows.push("<li>\u2026and " + (d.kv.length - 12) + " more settings/notes records</li>");
      diffEl.innerHTML = d.nothingChanges ? "This backup matches what you have now \u2014 restoring would change nothing." : "<div style=\"margin-bottom:4px\">Restoring would:</div><ul style=\"margin:0;padding-left:18px;line-height:1.6\">" + rows.join("") + "</ul>" + (d.lostTotal ? "<div style=\"color:var(--red);margin-top:6px\">" + d.lostTotal + " item(s) that exist now are not in this backup and would disappear from their lists.</div>" : "");
    }
    ["restore-accounts", "restore-trades", "restore-kv"].forEach(function (id) { var e = document.getElementById(id); if (e) e.addEventListener("change", renderDiff); });
    file.addEventListener("change", function () {
      loaded = null; current = null; btn.disabled = true; sum.textContent = ""; st.textContent = ""; diffEl.innerHTML = "";
      var f = file.files && file.files[0]; if (!f) return;
      f.text().then(function (t) {
        var obj; try { obj = JSON.parse(t); } catch (e) { st.textContent = "That file isn't valid JSON."; return; }
        var v = validate(obj);
        if (!v.ok) { st.textContent = v.error; return; }
        loaded = obj;
        sum.textContent = "Backup from " + (v.exported_at ? new Date(v.exported_at).toLocaleString() : "unknown date") + ": " + v.counts.trades + " trades, " + v.counts.accounts + " accounts, " + v.counts.user_kv + " settings/notes records" + (v.counts.trade_details ? ", " + v.counts.trade_details + " chart/verdict records" : "") + ".";
        diffEl.textContent = "Comparing with what you have now\u2026";
        return window.AUTH_READY.then(function (session) { if (!session) throw new Error("login"); return fetchCurrent(); })
          .then(function (c) { current = c; }, function () { current = null; })
          .then(function () { if (loaded === obj) { renderDiff(); btn.disabled = false; } });
      });
    });
    btn.addEventListener("click", function () {
      if (!loaded) return;
      var lost = current ? diff(loaded, current, opts()).lostTotal : 0;
      if (!window.confirm("Restore this backup?\n\nRecords in the file REPLACE the same records you have now. Anything not in the file is left alone." + (lost ? "\n\n" + lost + " item(s) you have now are not in this backup and would disappear from their lists." : ""))) return;
      btn.disabled = true; st.textContent = "Restoring\u2026";
      restore(loaded, { accounts: opt("restore-accounts"), trades: opt("restore-trades"), details: opt("restore-trades"), kv: opt("restore-kv"), saveCopyFirst: opt("restore-safety") },
        function (table, n, total) { st.textContent = "Restoring " + table + "\u2026 " + n + " / " + total; })
        .then(function (done) {
          st.textContent = "Restored: " + Object.keys(done).map(function (k) { return done[k] + " " + k; }).join(", ") + ". Reloading\u2026";
          if (window.TradeCache && window.TradeCache.clear) window.TradeCache.clear();
          setTimeout(function () { window.location.reload(); }, 1500);
        })
        .catch(function (e) { st.textContent = "Restore failed: " + (e && e.message || e); btn.disabled = false; });
    });
  }
  function wireAll() { wire(); wireCsv(); wireRestore(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireAll); else wireAll();
})();
