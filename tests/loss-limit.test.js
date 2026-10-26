// node --test tests/loss-limit.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../js/loss-limit.js");
const t = (time, pnl) => ({ entry_time: time, pnl_after_comm: pnl });

test("used is the worst running loss, even if the day recovers", () => {
  assert.equal(L.worstLoss([t("09:31", -120), t("09:50", -80), t("10:10", 300)]), 200);
  assert.equal(L.worstLoss([t("09:31", 100), t("09:40", -50)]), 0);   // never below the start
  assert.equal(L.worstLoss([]), 0);
});

test("trades are ordered by entry time, not array order", () => {
  assert.equal(L.worstLoss([t("10:10", 300), t("09:31", -120)]), 120);
});

test("plan limit beats the standing default; standing is the fallback", () => {
  assert.deepEqual(L.resolve({ max_loss: 150 }, 300), { amount: 150, source: "plan" });
  assert.deepEqual(L.resolve({}, 300), { amount: 300, source: "standing" });
  assert.deepEqual(L.resolve(null, 300), { amount: 300, source: "standing" });
  assert.equal(L.resolve({}, null), null);
  assert.equal(L.resolve({ max_loss: 0 }, 0), null);
});

test("a default only applies from the day it was set", () => {
  const st = { amount: 200, since: "2026-10-20" };
  assert.equal(L.resolve({}, st, "2026-10-19"), null);
  assert.deepEqual(L.resolve({}, st, "2026-10-20"), { amount: 200, source: "standing" });
  assert.deepEqual(L.resolve({ max_loss: 50 }, st, "2026-10-01"), { amount: 50, source: "plan" });
  assert.deepEqual(L.resolve({}, st), { amount: 200, source: "standing" });
});

test("state thresholds: ok, warn at 75%, breached at 100%", () => {
  const lim = { amount: 200, source: "standing" };
  assert.equal(L.evaluate([t("09:31", -100)], lim).state, "ok");
  assert.equal(L.evaluate([t("09:31", -150)], lim).state, "warn");
  assert.equal(L.evaluate([t("09:31", -199)], lim).state, "warn");
  const b = L.evaluate([t("09:31", -200)], lim);
  assert.equal(b.state, "breached"); assert.equal(b.remaining, 0);
  assert.equal(L.evaluate([t("09:31", -90), t("09:40", -130), t("09:50", 400)], lim).state, "breached");
});

test("remaining and ratio", () => {
  const e = L.evaluate([t("09:31", -50)], { amount: 200, source: "plan" });
  assert.equal(e.remaining, 150); assert.equal(e.ratio, 0.25); assert.equal(e.source, "plan");
});

test("no limit -> state none, never breached", () => {
  const e = L.evaluate([t("09:31", -9999)], null);
  assert.equal(e.state, "none"); assert.equal(e.remaining, null);
});

test("parseAmount accepts money-ish text, rejects junk", () => {
  assert.equal(L.parseAmount("$1,250.50"), 1250.5);
  assert.equal(L.parseAmount(" 250 "), 250);
  for (const bad of ["", "abc", "-5", "0", "12.345", "1e3", null, undefined, "1 000 000 000 000"]) assert.equal(L.parseAmount(bad), null, String(bad));
});
