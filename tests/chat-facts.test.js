// node --test tests/chat-facts.test.js
// js/chat-facts.js is the zero-credit half of AI Chat: stats, topic routing, local answers, trade lookup.
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../js/chat-facts.js");

function mk(id, date, time, exit, pnl, over) {
  return Object.assign({
    id, trade_date: date, symbol: "SYM" + (id % 5 === 0 ? "A" : "B") + id, side: "long", setup_type: id % 2 ? "orb_breakout" : "vwap_reclaim",
    entry_time: time, exit_time: exit, shares: 1000, entry_price: 5, exit_price: 5.1,
    pnl_after_comm: pnl, win: pnl > 0, lesson_tags: pnl < 0 ? ["chased"] : [],
  }, over || {});
}
const rows = [
  mk(1, "2026-08-03", "09:31:00", "09:35:00", 120),
  mk(2, "2026-08-03", "09:40:00", "09:44:00", -80),
  mk(3, "2026-08-03", "09:46:00", "09:47:00", -150, { shares: 2000 }), // quick re-entry after a loss
  mk(4, "2026-08-04", "10:05:00", "10:30:00", 200),
  mk(5, "2026-08-05", "09:35:00", "09:36:00", -60),
  mk(6, "2026-08-05", "09:50:00", "09:51:00", -70),
  mk(7, "2026-08-05", "09:55:00", "09:58:00", -90),
  mk(8, "2026-09-02", "11:00:00", "11:20:00", 300),
  mk(9, "2026-09-03", "09:33:00", "09:50:00", 50),
  mk(10, "2026-10-01", "14:00:00", "14:05:00", -40, { symbol: "ON" }),
];

test("core numbers", () => {
  const f = F.computeFacts(rows);
  assert.equal(f.raw.n, 10);
  assert.equal(f.raw.wins, 4);
  assert.equal(f.raw.winRate, 40);
  assert.equal(f.raw.net, 180);
  assert.equal(f.raw.profitFactor, 1.37);
  assert.equal(f.raw.maxLossStreak.len, 3);
  assert.equal(f.raw.maxLossStreak.from, "2026-08-05");
  assert.match(f.blocks.core, /10 trades/);
});

test("time buckets split the 9:30 open from pre-open", () => {
  const f = F.computeFacts(rows);
  const keys = f.raw.times.map((t) => t.key);
  assert.ok(keys.includes("09:30-09:59"));
  assert.ok(keys.includes("14:00-14:59"));
  const b = f.raw.times.find((t) => t.key === "09:30-09:59");
  assert.equal(b.n, 7);
});

test("tilt block sees quick re-entry after a loss and 2-loss runs", () => {
  const f = F.computeFacts(rows);
  assert.equal(f.raw.tilt.quick.n, 2); // #3 (2 min after loss #2) and #7 (4 min after loss #6)
  assert.equal(f.raw.tilt.afterTwo.n, 1); // #7 follows two same-day losses
});

test("local answers are numeric and need no model", () => {
  const f = F.computeFacts(rows);
  assert.match(F.localAnswer("What's my win rate?", f).text, /40%/);
  assert.match(F.localAnswer("what time of day do I trade best?", f).text, /Best window/);
  assert.match(F.localAnswer("How's my win rate trending over time?", f).text, /by month/i);
  assert.match(F.localAnswer("Which setup makes me the most money?", f).text, /Most profitable setup/);
  assert.match(F.localAnswer("What's my win rate on breakout setups?", f).text, /orb_breakout/);
  assert.match(F.localAnswer("show me my longest losing streak", f).text, /3 trades/);
});

test("judgment / coaching questions are NOT answered locally", () => {
  const f = F.computeFacts(rows);
  for (const q of ["Why did I lose so much?", "Which setup should I stop trading?", "Am I revenge trading after losses?", "What's my most repeated mistake?", "How much did late exits cost me?", "Am I sizing risk consistently?", "Show me my longest losing streak and what caused it"]) {
    assert.equal(F.localAnswer(q, f), null, q);
  }
});

test("routing picks the data the question needs, capped", () => {
  assert.ok(F.routeTopics("am I revenge trading after losses?").includes("tilt"));
  assert.ok(F.routeTopics("am I cutting winners too early?").includes("hold"));
  assert.ok(F.routeTopics("am I sizing risk consistently?").includes("sizing"));
  assert.ok(F.routeTopics("which lesson tag costs me the most money?").includes("tags"));
  assert.ok(F.routeTopics("random chatter").length > 0); // overview fallback
  assert.ok(F.routeTopics("compare my execution to the Ross Cameron playbook revenge hold time size streak").length <= 4);
  const f = F.computeFacts(rows);
  const sel = F.selectBlocks("am I revenge trading?", f);
  assert.ok(sel.blocks.core && sel.blocks.tilt);
  assert.ok(!sel.blocks.dow);
});

test("trade lookup: last loss, worst trade, symbol, short tickers need capitals", () => {
  assert.equal(F.findRelevantTrade("walk through my last losing trade", rows).id, 10);
  assert.equal(F.findRelevantTrade("what about my worst trade", rows).id, 3);
  assert.equal(F.findRelevantTrade("what happened on SYMB2", rows).id, 2);
  assert.equal(F.findRelevantTrade("why was I on it so long", rows), null); // "it" is not ON
  assert.equal(F.findRelevantTrade("how did ON go", rows).id, 10);
  assert.equal(F.findRelevantTrade("how am I doing", rows), null);
  assert.equal(F.findRelevantTrade("2026-08-04 was good", rows), null);
});

test("empty journal is safe", () => {
  const f = F.computeFacts([]);
  assert.equal(f.n, 0);
  assert.equal(F.localAnswer("win rate", f), null);
  assert.equal(F.findRelevantTrade("last loss", []), null);
});

test("blocks stay small enough to be cheap", () => {
  const big = [];
  for (let i = 1; i <= 400; i++) big.push(mk(i, "2026-0" + (1 + (i % 9)) + "-" + String(1 + (i % 27)).padStart(2, "0"), "09:" + String(30 + (i % 30)).padStart(2, "0") + ":00", "10:" + String(i % 60).padStart(2, "0") + ":00", i % 3 ? 40 : -55));
  const f = F.computeFacts(big);
  const total = Object.values(f.blocks).join("\n").length;
  assert.ok(F.selectBlocks("revenge trading", f) && JSON.stringify(F.selectBlocks("revenge trading", f).blocks).length < 3500);
  assert.ok(total < 20000);
});
