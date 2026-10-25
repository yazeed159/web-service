// node --test tests/backup.test.js  -- backup file validation + restore planning/writing (fake Supabase, no network)
const test = require("node:test");
const assert = require("node:assert/strict");

function load(sb) {
  global.window = { AUTH_READY: Promise.resolve({ user: { id: "me", email: "m@x" } }), sb };
  global.document = { readyState: "complete", getElementById: () => null, addEventListener() {} };
  delete require.cache[require.resolve("../js/backup.js")];
  require("../js/backup.js");
  return window.Backup;
}
const file = () => ({
  app: "trade.log", format: 1, exported_at: "2026-10-25T00:00:00Z",
  accounts: [{ id: "a1", user_id: "old", name: "Main" }],
  trades: [{ id: "AAA-20260101-093500", user_id: "old", pnl_after_comm: 5 }],
  trade_details: [{ trade_id: "AAA-20260101-093500", user_id: "old" }],
  user_kv: [{ user_id: "old", key: "capital_ledger", value: [] }, { user_id: "old", key: "flex_token", value: "s3cret" }],
});

test("validate accepts a good file and rejects wrong app, format or shape", () => {
  const B = load({});
  const v = B.validate(file());
  assert.equal(v.ok, true); assert.deepEqual(v.counts, { accounts: 1, trades: 1, user_kv: 2, trade_details: 1 });
  assert.equal(B.validate({ ...file(), app: "other" }).ok, false);
  assert.equal(B.validate({ ...file(), format: 2 }).ok, false);
  assert.match(B.validate({ app: "trade.log", format: 1, accounts: [] }).error, /trades, user_kv/);
  assert.equal(B.validate(null).ok, false);
});

test("prepare restamps user_id, orders tables, uses the right conflict keys and drops secret-looking keys", () => {
  const B = load({});
  const plan = B.prepare(file(), "me");
  assert.deepEqual(plan.map((p) => p.table), ["accounts", "trades", "trade_details", "user_kv"]);
  assert.deepEqual(plan.map((p) => p.onConflict), ["id", "user_id,id", "user_id,trade_id", "user_id,key"]);
  assert.ok(plan.every((p) => p.rows.every((r) => r.user_id === "me")));
  assert.deepEqual(plan[3].rows.map((r) => r.key), ["capital_ledger"]);
  assert.equal(file().trades[0].user_id, "old"); // input untouched
});

test("prepare honours the per-section switches", () => {
  const B = load({});
  assert.deepEqual(B.prepare(file(), "me", { trades: false, details: false, accounts: false }).map((p) => p.table), ["user_kv"]);
});

test("restore writes in chunks, in order, and reports counts", async () => {
  const calls = [];
  const sb = { from: (t) => ({ upsert: (rows, o) => { calls.push([t, rows.length, o.onConflict]); return Promise.resolve({ error: null }); } }) };
  const B = load(sb);
  const f = file(); f.trades = Array.from({ length: 1200 }, (_, i) => ({ id: "T" + i, user_id: "old" }));
  const done = await B.restore(f, {});
  assert.deepEqual(calls.filter((c) => c[0] === "trades").map((c) => c[1]), [500, 500, 200]);
  assert.deepEqual(calls.map((c) => c[0]).filter((t, i, a) => a.indexOf(t) === i), ["accounts", "trades", "trade_details", "user_kv"]);
  assert.equal(done.trades, 1200); assert.equal(done.user_kv, 1);
});

test("restore stops at the first database error and says what was already restored", async () => {
  const sb = { from: (t) => ({ upsert: () => Promise.resolve({ error: t === "trades" ? { message: "boom" } : null }) }) };
  const B = load(sb);
  await assert.rejects(() => B.restore(file(), {}), /trades: boom.*already restored: accounts/);
});

test("restore refuses an invalid file and an empty selection", async () => {
  const B = load({ from: () => ({ upsert: () => Promise.resolve({}) }) });
  await assert.rejects(() => B.restore({ app: "nope" }, {}), /isn't a trade.log backup/);
  await assert.rejects(() => B.restore(file(), { accounts: false, trades: false, details: false, kv: false }), /Nothing selected/);
});

test("diff: counts new / replaced / identical and ignores user_id and timestamps", () => {
  const B = load({});
  const f = file(); f.trades = [{ id: "A", user_id: "old", pnl: 1 }, { id: "B", user_id: "old", pnl: 2 }, { id: "C", user_id: "old", pnl: 3 }];
  const cur = { accounts: [{ id: "a1", user_id: "me", name: "Main", created_at: "x" }], trades: [{ id: "A", user_id: "me", pnl: 1, created_at: "y" }, { id: "B", user_id: "me", pnl: 999 }], user_kv: [] };
  const d = B.diff(f, cur);
  assert.deepEqual(d.trades, { new: 1, changed: 1, same: 1 });
  assert.deepEqual(d.accounts, { new: 0, changed: 0, same: 1 });
});

test("diff: a list that is older than the current one reports what would be lost", () => {
  const B = load({});
  const f = file(); f.user_kv = [{ key: "capital_ledger", value: [{ id: 1 }] }, { key: "flex_token", value: "s" }];
  const cur = { accounts: [], trades: [], user_kv: [{ key: "capital_ledger", value: [{ id: 1 }, { id: 2 }, { id: 3 }] }] };
  const d = B.diff(f, cur);
  assert.equal(d.kv.length, 1); // secret-looking key never shown
  assert.equal(d.kv[0].label, "Deposits & periods"); assert.equal(d.kv[0].lost, 2); assert.equal(d.kv[0].added, 0); assert.equal(d.lostTotal, 2);
});

test("diff: objects report added / edited / lost keys, new keys are 'new', identical is silent", () => {
  const B = load({});
  const f = file(); f.user_kv = [{ key: "g", value: { a: 5, c: 1 } }, { key: "fresh", value: 1 }, { key: "same", value: [1] }];
  f.trades = []; f.accounts = []; f.trade_details = [];
  const cur = { accounts: [], trades: [], user_kv: [{ key: "g", value: { a: 4, b: 2 } }, { key: "same", value: [1] }] };
  const d = B.diff(f, cur);
  const g = d.kv.find((k) => k.key === "g");
  assert.deepEqual([g.added, g.changed, g.lost], [1, 1, 1]);
  assert.equal(d.kv.find((k) => k.key === "fresh").status, "new");
  assert.equal(d.kv.some((k) => k.key === "same"), false);
});

test("diff: identical data means nothing changes; section switches are honoured", () => {
  const B = load({});
  const f = file(); f.trade_details = undefined; f.user_kv = [{ key: "k", value: 1 }];
  const cur = { accounts: f.accounts, trades: f.trades, user_kv: [{ key: "k", value: 1 }] };
  assert.equal(B.diff(f, cur).nothingChanges, true);
  assert.equal(B.diff(f, { accounts: [], trades: [], user_kv: [] }, { trades: false, accounts: false, kv: false }).trades, null);
});
