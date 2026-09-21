// Unit tests for the journal modules (trade-notes.js, daily-notes.js,
// discipline.js, share-export.js). Run with:  node --test tests/journal.test.js
// No browser or Supabase: a tiny window/localStorage shim is installed first.
const test = require("node:test");
const assert = require("node:assert/strict");

global.window = global;
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
require("../js/utils.js");
require("../js/trade-notes.js");
require("../js/daily-notes.js");
require("../js/discipline.js");
require("../js/share-export.js");

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);
const reset = () => Object.keys(store).forEach((k) => delete store[k]);

test("metrics: long trade R and planned R:R", () => {
  const t = { side: "long", entry_price: 5, shares: 100, pnl_after_comm: 38 };
  const m = TradeNotes.metrics(t, { plan_stop: 4.8, plan_target: 5.6 });
  close(m.risk_dollars, 20); close(m.r_multiple, 1.9); close(m.planned_rr, 3);
});

test("metrics: short trade uses stop above entry", () => {
  const t = { side: "short", entry_price: 10, shares: 50, pnl_after_comm: -25 };
  const m = TradeNotes.metrics(t, { plan_stop: 10.5, plan_target: 9 });
  close(m.risk_dollars, 25); close(m.r_multiple, -1); close(m.planned_rr, 2);
});

test("metrics: stop on the wrong side or missing gives nulls, not garbage", () => {
  const t = { side: "long", entry_price: 5, shares: 100, pnl_after_comm: 10 };
  assert.equal(TradeNotes.metrics(t, { plan_stop: 5.2 }).r_multiple, null);
  assert.equal(TradeNotes.metrics(t, {}).r_multiple, null);
  assert.equal(TradeNotes.metrics(t, null).risk_dollars, null);
});

test("save: dedupes tags, drops non-positive prices, deletes empty entries", () => {
  reset();
  TradeNotes.save("A", { plan_stop: -3, plan_target: "abc", setup: " Breakout ", mistakes: ["FOMO", "FOMO", " "], followed_rules: true, notes: "" });
  const e = TradeNotes.get("A");
  assert.equal(e.plan_stop, null); assert.equal(e.plan_target, null);
  assert.equal(e.setup, "Breakout"); assert.deepEqual(e.mistakes, ["FOMO"]);
  TradeNotes.save("A", { plan_stop: "", setup: "", mistakes: [], followed_rules: null, notes: "  " });
  assert.equal(TradeNotes.get("A"), null);
});

test("save: followed_rules false is kept (not treated as empty)", () => {
  reset();
  TradeNotes.save("B", { followed_rules: false });
  assert.equal(TradeNotes.get("B").followed_rules, false);
});

test("DailyNotes: round trip and empty day is removed", () => {
  reset();
  DailyNotes.save("2026-09-18", { plan: "gappers", max_loss: 50, checks: { a: true } });
  assert.equal(DailyNotes.get("2026-09-18").max_loss, 50);
  DailyNotes.save("2026-09-18", { plan: "", max_loss: "", goal: null, checks: {}, followed_plan: null });
  assert.equal(DailyNotes.get("2026-09-18"), null);
});

test("DailyNotes: checklist defaults and dedupe", () => {
  reset();
  assert.ok(DailyNotes.getChecklist().length >= 4);
  DailyNotes.setChecklist(["x", "x", " ", "y"]);
  assert.deepEqual(DailyNotes.getChecklist(), ["x", "y"]);
});

test("Discipline: no data -> null score; max-loss breach lowers it", () => {
  assert.equal(Discipline.compute([], { entries: {}, days: {} }).score, null);
  const trades = [
    { id: "1", trade_date: "2026-09-18", entry_time: "09:35", pnl_after_comm: -40, shares: 100 },
    { id: "2", trade_date: "2026-09-18", entry_time: "09:50", pnl_after_comm: -30, shares: 100 },
  ];
  const held = Discipline.compute(trades, { entries: {}, days: { "2026-09-18": { max_loss: 100 } } });
  const broke = Discipline.compute(trades, { entries: {}, days: { "2026-09-18": { max_loss: 50 } } });
  assert.ok(broke.score < held.score, `${broke.score} !< ${held.score}`);
});

test("Discipline: rules answers drive the rules component", () => {
  const trades = [
    { id: "1", trade_date: "2026-09-18", entry_time: "09:35", pnl_after_comm: 5, shares: 100 },
    { id: "2", trade_date: "2026-09-18", entry_time: "09:50", pnl_after_comm: 5, shares: 100 },
  ];
  const good = Discipline.compute(trades, { entries: { 1: { followed_rules: true }, 2: { followed_rules: true } }, days: {} });
  const bad = Discipline.compute(trades, { entries: { 1: { followed_rules: false }, 2: { followed_rules: false } }, days: {} });
  assert.ok(good.score > bad.score);
});

test("share export: journal card present, notes HTML-escaped, R shown", () => {
  reset();
  TradeNotes.save("T1", { plan_stop: 4.8, plan_target: 5.6, setup: "Breakout", mistakes: ["Chased entry"], followed_rules: true, notes: "<img src=x onerror=alert(1)>" });
  const trade = { id: "T1", symbol: "ABCD", trade_date: "2026-09-18", entry_time: "09:35", exit_time: "09:40", entry_price: 5, exit_price: 5.4, shares: 100, pnl_before_comm: 40, pnl_after_comm: 38, commission: 2, win: true };
  const html = TradeLogShare.buildTradeSharePage(trade);
  assert.ok(html.includes("Trader's journal"));
  assert.ok(html.includes("+1.90R"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img"));
});

test("share export: set page has journal columns and omits notes", () => {
  reset();
  TradeNotes.save("T1", { setup: "Breakout", followed_rules: false, notes: "secret note" });
  const rows = [{ id: "T1", symbol: "ABCD", trade_date: "2026-09-18", entry_time: "09:35", entry_price: 5, exit_price: 5.4, shares: 100, pnl_after_comm: 38, win: true }];
  const html = TradeLogShare.buildSetSharePage(rows, {});
  assert.ok(html.includes("<th>My setup</th>") && html.includes("Breakout"));
  assert.ok(!html.includes("secret note"));
});
