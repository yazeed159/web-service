// node --test tests/kv-merge.test.js
// Daily notes, trade notes and grades are each ONE stored value shared by every device. setMerged()
// must keep both devices' edits instead of last-save-wins.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "../js/auth.js"), "utf8");
const start = src.indexOf("window.KV = (function () {");
const block = src.slice(start, src.indexOf("})();", start) + 5);

function fakeDb(initial) {
  const rows = Object.assign({}, initial);
  const q = () => {
    const st = { op: "select", filters: {}, payload: null };
    const run = () => {
      if (st.op === "upsert") { rows[st.payload.key] = JSON.parse(JSON.stringify(st.payload.value)); return { error: null }; }
      if (st.op === "delete") { delete rows[st.filters.key]; return { error: null }; }
      if (st.single) return { data: st.filters.key in rows ? { value: JSON.parse(JSON.stringify(rows[st.filters.key])) } : null, error: null };
      return { data: Object.keys(rows).map((k) => ({ key: k, value: JSON.parse(JSON.stringify(rows[k])) })), error: null };
    };
    const chain = {
      select() { return chain; }, upsert(p) { st.op = "upsert"; st.payload = p; return chain; },
      delete() { st.op = "delete"; return chain; }, eq(k, v) { st.filters[k] = v; return chain; },
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
const K = "trade.log:journal_entries";

test("two devices editing different trades keep both edits", async () => {
  const db = fakeDb({ [K]: { t1: { notes: "a" } } });
  const phone = await device(db), laptop = await device(db);
  await phone.setMerged(K, { t1: { notes: "a" }, t2: { notes: "from phone" } });
  const r = await laptop.setMerged(K, { t1: { notes: "a" }, t3: { notes: "from laptop" } });
  assert.equal(r.ok, true); assert.equal(r.merged, true);
  assert.deepEqual(db.rows[K], { t1: { notes: "a" }, t2: { notes: "from phone" }, t3: { notes: "from laptop" } });
  assert.deepEqual(laptop.get(K), db.rows[K]);
});

test("different fields of the same entry both survive", async () => {
  const db = fakeDb({ [K]: { t1: { notes: "x", setup: "" } } });
  const a = await device(db), b = await device(db);
  await a.setMerged(K, { t1: { notes: "x", setup: "ORB" } });
  await b.setMerged(K, { t1: { notes: "edited later", setup: "" } });
  assert.deepEqual(db.rows[K], { t1: { notes: "edited later", setup: "ORB" } });
});

test("a deletion on one device is kept when the other did not touch that entry", async () => {
  const db = fakeDb({ g: { t1: 3, t2: 4 } });
  const a = await device(db), b = await device(db);
  await a.setMerged("g", { t1: 3, t2: 4, t3: 5 });
  await b.setMerged("g", { t1: 3 });                 // b deleted t2
  assert.deepEqual(db.rows.g, { t1: 3, t3: 5 });
});

test("both changed the same value: this device's latest edit wins, nothing else is lost", async () => {
  const db = fakeDb({ g: { t1: 2, t2: 2 } });
  const a = await device(db), b = await device(db);
  await a.setMerged("g", { t1: 5, t2: 2 });
  await b.setMerged("g", { t1: 1, t2: 4 });
  assert.deepEqual(db.rows.g, { t1: 1, t2: 4 });
});

test("daily notes shape: days merge per day, one device's other days survive", async () => {
  const base = { days: { "2026-10-20": { plan: "p" } }, checklist: null };
  const db = fakeDb({ dn: base });
  const a = await device(db), b = await device(db);
  await a.setMerged("dn", { days: { "2026-10-20": { plan: "p" }, "2026-10-21": { plan: "tue" } }, checklist: null });
  await b.setMerged("dn", { days: { "2026-10-20": { plan: "p", to_fix: "size" } }, checklist: null });
  assert.deepEqual(db.rows.dn.days, { "2026-10-20": { plan: "p", to_fix: "size" }, "2026-10-21": { plan: "tue" } });
});

test("no concurrent change: plain save, merged=false; own consecutive saves never merge", async () => {
  const db = fakeDb({});
  const a = await device(db);
  const r1 = await a.setMerged("g", { t1: 1 });
  const r2 = await a.setMerged("g", { t1: 1, t2: 2 });
  assert.equal(r1.merged, false); assert.equal(r2.merged, false);
  assert.deepEqual(db.rows.g, { t1: 1, t2: 2 });
});
