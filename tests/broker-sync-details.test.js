// Tests for the "Sync details" list + attention pill in js/broker-connections.js.
// Run with:  node --test tests/broker-sync-details.test.js   (no browser, Supabase is stubbed)
const test = require("node:test");
const assert = require("node:assert/strict");

const FLEX = [
  { account_id: "a1", has_ibkr_flex_token: true, ibkr_flex_query_id: "123456", last_sync_status: "ok", last_sync_at: "2026-10-13T06:00:00Z" },
  { account_id: "a2", has_ibkr_flex_token: true, ibkr_flex_query_id: "123457", last_sync_status: "ok" },
  { account_id: "a4", has_ibkr_flex_token: true, ibkr_flex_query_id: "123459", last_sync_status: "ok" },
  { account_id: "a5", has_ibkr_flex_token: true, ibkr_flex_query_id: "123460", last_sync_status: "ok" },
  { account_id: "a3", has_ibkr_flex_token: true, ibkr_flex_query_id: "123458", last_sync_status: "failed", last_sync_at: "2026-10-13T06:00:00Z" },
];
const REPORT = { accounts: {
  a1: { at: "2026-10-13T06:00:00Z", deferred: 0,
        open_positions: [{ symbol: "BBB", side: "Long", qty: 75, avg_price: 10.3333, entry_time: "10:00:00", date: "2026-10-12" }],
        no_chart: [{ symbol: "AAA", id: "AAA-20261012-100000", date: "2026-10-12", reason: "No bars <b>", attempts: 3, next_retry: "2099-01-01T00:00:00Z" }],
        skipped: [{ symbol: "CCC", reason: "closing fills with no opening fill", fills: 1, qty: 30, date: "2026-10-12", first_time: "11:00:00" }] },
  a3: { at: "2026-10-13T06:00:00Z", open_positions: [], skipped: [],
        no_chart: [{ symbol: "ZZZ", reason: "x", attempts: 1, next_retry: null }] },
  a4: { at: "2026-10-13T06:00:00Z", open_positions: [{ symbol: "OPN", side: "Long", qty: 10, entry_time: "10:00:00", date: "2026-10-12" }], skipped: [], no_chart: [] },
  a5: { at: "2026-10-13T06:00:00Z", open_positions: [], skipped: [], no_chart: [{ symbol: "SAVED", id: "SAVED-1", reason: "x", attempts: 1 }] },
} };

let SAVED = ["SAVED-1"];
function query(data) { const b = { select: () => b, eq: () => b, limit: () => b, in: () => { b.__saved = true; return b; }, then: (f, g) => Promise.resolve({ data: b.__saved ? SAVED.map((id) => ({ id })) : data }).then(f, g) }; return b; }
global.window = global;
global.document = { createElement: () => ({}), head: { appendChild() {} } };
global.AUTH_READY = Promise.resolve({ user: { id: "u" } });
global.sb = { from: (t) => query(t === "user_kv" ? [{ value: JSON.stringify(REPORT) }] : FLEX) };
global.Accounts = { byId: () => ({ name: "X" }), isBrokerPaper: () => false };
require("../js/broker-connections.js");
const B = window.BrokerConnections;
const editor = (id) => { const el = { querySelector: () => ({ addEventListener() {}, classList: {} }) }; B.renderEditor(el, id, {}); return el.innerHTML; };

test("pill turns amber and counts stuck trades", async () => {
  await B.ready;
  assert.match(B.chipHtml("a1"), /bc-warn.*3 items need attention/);
});
test("account with no report keeps the normal pill and has no details block", async () => {
  await B.ready;
  assert.match(B.chipHtml("a2"), /bc-ok.*Auto-sync on/);
  assert.doesNotMatch(editor("a2"), /bc-details/);
});
test("a failed run still shows 'Last sync failed', not the attention text", async () => {
  await B.ready;
  assert.match(B.chipHtml("a3"), /Last sync failed/);
});
test("details list all three parts, open by default when something is stuck, and escape text", async () => {
  await B.ready;
  const h = editor("a1");
  assert.match(h, /<details class="bc-details" open>/);
  for (const s of ["No chart yet", "Open positions", "Skipped fills", "Still open", "Next retry"]) assert.ok(h.includes(s), s);
  assert.ok(h.includes("No bars &lt;b&gt;") && !h.includes("<b>No bars"));
});

test("an open position alone turns the pill amber as an item", async () => {
  await B.ready;
  assert.match(B.chipHtml("a4"), /bc-warn.*1 item needs attention/);
});
test("a stuck trade that has since been saved is dropped from the list and the pill", async () => {
  await B.ready;
  assert.match(B.chipHtml("a5"), /bc-ok.*Auto-sync on/);
  assert.match(editor("a5"), /Nothing is open, stuck or skipped/);
});

test("connected accounts get a Sync now button; the statement line shows what IBKR sent", async () => {
  await B.ready;
  const h = editor("a1");
  assert.match(h, /data-sync>Sync now</);
  REPORT.accounts.a1.statement = { from: "20261012", to: "20261012", period: "LastBusinessDay", fills: 14, closed: 3, latest_fill: "2026-10-12 15:58" };
  await B.reload();
  assert.match(editor("a1"), /IBKR statement: 2026-10-12 \(LastBusinessDay\) · 14 fills, latest 2026-10-12 15:58 · 3 closed trades/);
});
test("the status line shows the sync's own message on ok runs", async () => {
  await B.ready;
  FLEX[1].last_sync_at = "2026-10-13T06:00:00Z"; FLEX[1].last_sync_message = "No new trades (IBKR sent 14 fill(s), latest 2026-10-12 15:58)";
  await B.reload();
  assert.match(editor("a2"), /ok: No new trades/);
});
