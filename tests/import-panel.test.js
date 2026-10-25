// Import page: preview -> choose range / period / trades -> confirm. Needs jsdom (npm i); skipped without it.
// Run: node --test tests/import-panel.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let JSDOM = null;
try { JSDOM = require("jsdom").JSDOM; } catch (e) { /* skipped below */ }

const PERIODS = [{ id: "p1", name: "Period 1", start: "2025-01-01", end: "2025-06-01" }, { id: "p2", name: "Period 2", start: "2025-06-01", end: null }];
const mk = (d, sym, pnl) => ({ trade_id: `${sym}-${d.replace(/-/g, "")}-093500`, Symbol: sym, "Trade Date": d, "Entry Time": "09:35:00", Side: "Long", "P&L After Comm": pnl });
const TRADES = [mk("2025-01-10", "AAA", 10), mk("2025-07-01", "BBB", -5), mk("2025-07-02", "CCC", 20), mk("2026-03-05", "DDD", 7)];

function boot(previewResponse) {
  let html = fs.readFileSync(path.join(__dirname, "..", "import-trades.html"), "utf8").replace(/<script[^>]*src=[^>]*><\/script>/g, "");
  const sent = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", url: "https://x.test/import-trades.html", pretendToBeVisual: true,
    beforeParse(w) {
      w.escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
      w.CHART_SERVICE_URL = "https://svc.test";
      w.AUTH_READY = Promise.resolve({ access_token: "t", user: { id: "u" } });
      w.showToast = () => {}; w.NavState = { get: () => null, set() {} };
      const acct = { id: "a", name: "Main", status: "active" };
      w.__ledger = null;
      w.Accounts = { isAvailable: () => true, defaultLive: () => acct, live: () => [acct], liveAll: () => [acct], isBrokerPaper: () => false, periodsFor: () => PERIODS,
        getLedger: () => [], setLedger: (l) => { w.__ledger = l; }, newId: () => "nid", ready: Promise.resolve(), byId: () => acct };
      w.ImportGaps = require("../js/import-gaps.js");
      w.fetch = (url, opts) => {
        sent.push(opts.body ? Object.fromEntries(opts.body.entries()) : { url });
        const isPreview = opts.body && opts.body.get("preview");
        return Promise.resolve({ ok: true, json: () => Promise.resolve(isPreview ? previewResponse : { job_id: "j", trades: [] }) });
      };
    },
  });
  return { w: dom.window, d: dom.window.document, sent };
}
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
async function preview(env) {
  await tick(150);
  const fe = env.d.getElementById("csv-file");
  Object.defineProperty(fe, "files", { value: [new env.w.File(["x"], "t.csv")] });
  fe.dispatchEvent(new env.w.Event("change"));
  const btn = env.d.getElementById("run-btn"); btn.disabled = false; btn.click();
  await tick();
}
const GOOD = { preview: true, trades: TRADES, already_imported: ["CCC-20250702-093500"], file: { total: 4, first: "2025-01-10", last: "2026-03-05" } };

test("preview opens the panel, defaults to the latest period, and counts what will be added", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const env = boot(GOOD); await preview(env);
  const q = (id) => env.d.getElementById(id);
  assert.equal(q("imp-window").style.display, "block");
  assert.match(q("imp-file-sum").textContent, /4 trades in the file.*1 already in your journal/);
  assert.equal(q("imp-preset").value, "p:p2");
  assert.equal(q("imp-from").value, "2025-06-01");
  assert.equal(q("imp-count").textContent, "2 trade(s) will be added · 1 already in your journal (skipped)");
  assert.equal(env.sent[0].preview, "1");
});

test("breaks become range options and the break size is adjustable", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const env = boot(GOOD); await preview(env);
  const q = (id) => env.d.getElementById(id), values = () => [...q("imp-preset").options].map((o) => o.value);
  assert.deepEqual(values().filter((v) => v.startsWith("g:")), ["g:2026-03-05", "g:2025-07-01"]);
  q("imp-gap").value = "90"; q("imp-gap").dispatchEvent(new env.w.Event("change"));
  assert.equal(values().filter((v) => v.startsWith("g:")).length, 2); // both breaks are longer than 90 days
  q("imp-preset").value = "g:2025-07-01"; q("imp-preset").dispatchEvent(new env.w.Event("change"));
  assert.equal(q("imp-from").value, "2025-07-01");
  assert.equal(q("imp-newperiod").style.display, "block"); // no period starts that day -> offer one
});

test("unticking a trade lowers the count and is sent as exclude_ids with the dates", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const env = boot(GOOD); await preview(env);
  const q = (id) => env.d.getElementById(id);
  q("imp-preset").value = "all"; q("imp-preset").dispatchEvent(new env.w.Event("change"));
  assert.equal(q("imp-count").textContent, "3 trade(s) will be added · 1 already in your journal (skipped)");
  const rows = env.d.querySelectorAll(".imp-pick-row input"); assert.equal(rows.length, 4);
  rows[0].checked = false; rows[0].dispatchEvent(new env.w.Event("change")); // newest = DDD
  assert.match(q("imp-count").textContent, /2 trade\(s\) will be added.*1 unticked by you/);
  q("imp-go").click(); await tick();
  const last = env.sent[env.sent.length - 1];
  assert.equal(last.preview, undefined);
  assert.equal(last.exclude_ids, JSON.stringify(["DDD-20260305-093500"]));
  assert.equal(last.date_from, undefined);
});

test("a period range sends its dates; 'untick all in range' disables Import", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const env = boot(GOOD); await preview(env);
  const q = (id) => env.d.getElementById(id);
  q("imp-preset").value = "p:p1"; q("imp-preset").dispatchEvent(new env.w.Event("change"));
  assert.equal(q("imp-from").value, "2025-01-01"); assert.equal(q("imp-to").value, "2025-05-31"); // end is exclusive -> day before
  q("imp-pick-none").click();
  assert.equal(q("imp-go").disabled, true);
  q("imp-pick-all").click();
  assert.equal(q("imp-go").disabled, false);
  q("imp-go").click(); await tick();
  const last = env.sent[env.sent.length - 1];
  assert.equal(last.date_from, "2025-01-01"); assert.equal(last.date_to, "2025-05-31");
});

test("ticking 'start a new period' writes a ledger period entry on confirm", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const env = boot(GOOD); await preview(env);
  const q = (id) => env.d.getElementById(id);
  q("imp-preset").value = "g:2025-07-01"; q("imp-preset").dispatchEvent(new env.w.Event("change"));
  q("imp-np-on").checked = true; q("imp-np-amount").value = "500";
  q("imp-go").click(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(env.w.__ledger)), [{ _id: "nid", account_id: "a", date: "2025-07-01", amount: 500, period: true }]);
});

test("an out-of-date server (no preview support) is cancelled, not imported", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const env = boot({ job_id: "oops", trades: [] }); await preview(env);
  assert.match(env.d.getElementById("status").textContent, /out of date/);
  assert.equal(env.d.getElementById("imp-window").style.display, "none");
  assert.ok(env.sent.length >= 1);
});
