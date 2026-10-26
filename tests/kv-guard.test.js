// node --test tests/kv-guard.test.js
// Two devices share one user_kv table. The guarded write must refuse to clobber a copy the other
// device saved in between, and must not raise false alarms on the device's own saves.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Pull the KV block out of auth.js so the test exercises the real code, not a copy.
const src = fs.readFileSync(path.join(__dirname, "../js/auth.js"), "utf8");
const start = src.indexOf("window.KV = (function () {");
const block = src.slice(start, src.indexOf("})();", start) + 5);

function fakeDb(initial) {
  const rows = Object.assign({}, initial);   // key -> value
  const q = (extra) => {
    const st = { op: "select", cols: "", filters: {}, payload: null };
    const run = () => {
      if (st.op === "upsert") { rows[st.payload.key] = JSON.parse(JSON.stringify(st.payload.value)); return { error: null }; }
      if (st.op === "delete") { delete rows[st.filters.key]; return { error: null }; }
      if (st.single) return { data: st.filters.key in rows ? { value: JSON.parse(JSON.stringify(rows[st.filters.key])) } : null, error: null };
      return { data: Object.keys(rows).map((k) => ({ key: k, value: JSON.parse(JSON.stringify(rows[k])) })), error: null };
    };
    const chain = {
      select(c) { st.cols = c; return chain; },
      upsert(p) { st.op = "upsert"; st.payload = p; return chain; },
      delete() { st.op = "delete"; return chain; },
      eq(k, v) { st.filters[k] = v; return chain; },
      maybeSingle() { st.single = true; return chain; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return chain;
  };
  return { rows, sb: { from: () => q() } };
}

async function device(db) {
  const win = { AUTH_READY: Promise.resolve({ user: { id: "me" } }), sb: db.sb, dispatchEvent() {} };
  const fn = new Function("window", "withClockSkewRetry", "console", "setTimeout", "CustomEvent", block + "\nreturn window.KV;");
  const KV = fn(win, (run) => Promise.resolve().then(run), console, () => 0, function () {});
  await KV.ready;
  return KV;
}

test("second device is refused when the first device saved in between", async () => {
  const db = fakeDb({ capital_ledger: [{ date: "2026-01-01", amount: 1000 }] });
  const phone = await device(db), laptop = await device(db);
  const withY = [{ date: "2026-01-01", amount: 1000 }, { date: "2026-02-01", amount: 500 }];
  assert.deepEqual(await phone.setGuarded("capital_ledger", withY), { ok: true });
  const r = await laptop.setGuarded("capital_ledger", [{ date: "2026-01-01", amount: 1000 }, { date: "2026-03-01", amount: 7 }]);
  assert.equal(r.ok, false); assert.equal(r.conflict, true);
  assert.deepEqual(r.remote, withY);
  assert.deepEqual(db.rows.capital_ledger, withY, "the refused write must not touch the server");
});

test("after adopting the other copy the device can save again", async () => {
  const db = fakeDb({ capital_ledger: [] });
  const a = await device(db), b = await device(db);
  await a.setGuarded("capital_ledger", [{ date: "2026-01-01", amount: 1 }]);
  const r = await b.setGuarded("capital_ledger", [{ date: "2026-01-02", amount: 2 }]);
  assert.equal(r.conflict, true);
  b.adopt("capital_ledger", r.remote);
  assert.deepEqual(b.get("capital_ledger"), [{ date: "2026-01-01", amount: 1 }]);
  const next = [...r.remote, { date: "2026-01-02", amount: 2 }];
  assert.deepEqual(await b.setGuarded("capital_ledger", next), { ok: true });
  assert.deepEqual(db.rows.capital_ledger, next);
});

test("a device's own consecutive saves never conflict", async () => {
  const db = fakeDb({});
  const a = await device(db);
  for (let i = 1; i <= 3; i++) assert.deepEqual(await a.setGuarded("capital_ledger", [{ date: "2026-01-0" + i, amount: i }]), { ok: true });
  assert.equal((await a.isStale("capital_ledger")), false);
});

test("key order in stored objects does not cause a false conflict", async () => {
  const db = fakeDb({ capital_ledger: [{ amount: 5, date: "2026-01-01" }] });
  const a = await device(db);
  db.rows.capital_ledger = [{ date: "2026-01-01", amount: 5 }];   // same data, other key order (jsonb reorders)
  assert.deepEqual(await a.setGuarded("capital_ledger", []), { ok: true });
});

test("isStale flips to true once another device writes", async () => {
  const db = fakeDb({ capital_ledger: [] });
  const a = await device(db), b = await device(db);
  assert.equal(await a.isStale("capital_ledger"), false);
  await b.set("capital_ledger", [{ date: "2026-01-01", amount: 9 }]);
  assert.equal(await a.isStale("capital_ledger"), true);
});

test("a brand-new key (absent everywhere) saves fine", async () => {
  const db = fakeDb({});
  const a = await device(db);
  assert.deepEqual(await a.setGuarded("capital_ledger", [{ date: "2026-01-01", amount: 1 }]), { ok: true });
});

test("deleting a key and re-saving it is not a conflict for the deleting device", async () => {
  const db = fakeDb({ daily_loss_limit: { amount: 100 } });
  const a = await device(db);
  await a.delete("daily_loss_limit");
  assert.deepEqual(await a.setGuarded("daily_loss_limit", { amount: 50 }), { ok: true });
});
