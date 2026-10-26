// node --test tests/review-math.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../js/review-math.js");

test("week is Monday-Sunday around any anchor, incl. a Sunday", () => {
  const w = R.range("week", "2026-10-25");               // a Sunday
  assert.equal(w.from, "2026-10-19"); assert.equal(w.to, "2026-10-25");
  assert.equal(w.prev, "2026-10-18"); assert.equal(w.next, "2026-10-26");
  assert.equal(R.range("week", "2026-10-19").from, "2026-10-19");
});

test("month covers 1st..last, incl. February and year end", () => {
  assert.deepEqual([R.range("month", "2028-02-10").from, R.range("month", "2028-02-10").to], ["2028-02-01", "2028-02-29"]);
  const dec = R.range("month", "2026-12-31");
  assert.equal(dec.to, "2026-12-31"); assert.equal(dec.next, "2027-01-01"); assert.equal(dec.label, "Dec 2026");
});

const T = (id, date, time, pnl, setup, tags) => ({ id, trade_date: date, entry_time: time, pnl_after_comm: pnl, setup_type: setup, behavior_tags: tags });
const trades = [
  T(1, "2026-10-19", "09:35", -60, "ORB", ["chased_entry"]),
  T(2, "2026-10-19", "09:50", -50, "ORB", ["clean_trade"]),
  T(3, "2026-10-20", "09:40", 200, "Gap & go", ["clean_trade"]),
  T(4, "2026-10-21", "09:31", -10, "Gap & go", ["oversized", "chased_entry"]),
  T(5, "2026-10-26", "09:31", 999, "ORB", ["clean_trade"]),   // next week -> excluded
];

test("sums, win rate, best/worst day and setup", () => {
  const s = R.summarize(trades, { from: "2026-10-19", to: "2026-10-25" });
  assert.equal(s.n, 4); assert.equal(s.net, 80); assert.equal(s.wins, 1); assert.equal(s.winRate, 0.25);
  assert.equal(s.tradingDays, 3);
  assert.equal(s.bestDay.date, "2026-10-20"); assert.equal(s.worstDay.date, "2026-10-19");
  assert.equal(s.bestSetup.setup, "Gap & go"); assert.equal(s.bestSetup.total, 190);
  assert.equal(s.worstSetup.setup, "ORB"); assert.equal(s.worstSetup.total, -110);
});

test("a single setup is best only (no duplicate worst)", () => {
  const s = R.summarize([T(1, "2026-10-19", "09:35", 5, "ORB", [])], { from: "2026-10-19", to: "2026-10-25" });
  assert.equal(s.bestSetup.setup, "ORB"); assert.equal(s.worstSetup, null);
});

test("rule breaks: not-clean trades, process tags ranked, limit breaches, plan not followed", () => {
  const s = R.summarize(trades, {
    from: "2026-10-19", to: "2026-10-25",
    limitFor: () => ({ amount: 100 }),
    days: { "2026-10-21": { followed_plan: false }, "2026-10-20": { followed_plan: true } },
    isProcessTag: (k) => k !== "oversized_not_process",
  });
  assert.equal(s.ruleBreaks.notClean, 2);
  assert.equal(s.ruleBreaks.topTags[0].tag, "chased_entry"); assert.equal(s.ruleBreaks.topTags[0].n, 2);
  assert.deepEqual(s.ruleBreaks.limitBreaches.map((b) => b.date), ["2026-10-19"]);   // -110 worst on the 19th
  assert.deepEqual(s.ruleBreaks.notFollowed, ["2026-10-21"]);
  assert.equal(s.ruleBreaks.total, 2 + 1 + 1);
});

test("untagged trades are not counted as rule breaks; empty period is safe", () => {
  const s = R.summarize([{ id: 1, trade_date: "2026-10-19", pnl_after_comm: 1 }], { from: "2026-10-19", to: "2026-10-25" });
  assert.equal(s.ruleBreaks.notClean, 0);
  const e = R.summarize([], { from: "2026-10-19", to: "2026-10-25" });
  assert.equal(e.n, 0); assert.equal(e.winRate, null); assert.equal(e.bestDay, null); assert.equal(e.bestSetup, null);
});
