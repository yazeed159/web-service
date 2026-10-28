// tests/helpers/trades.js -- builds `trades` rows shaped like the Supabase table
// the Journal reads. Only fields the pages actually use are filled in.
let n = 0;
// 1-minute bars the trade page's chart expects (it reads bars[0].t).
const bars = (date) => Array.from({ length: 80 }, (_, i) => ({
  t: `${date} 09:${String(30 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
  o: 5 + i * 0.005, h: 5.1 + i * 0.005, l: 4.9 + i * 0.005, c: 5.02 + i * 0.005, v: 1000 + i,
}));
function trade(over = {}) {
  n += 1;
  const win = over.win !== undefined ? over.win : (over.pnl_after_comm ?? 10) > 0;
  const trade_date = over.trade_date || "2026-09-18";
  return {
    bars: bars(trade_date),
    id: "T" + n, symbol: "SYM" + n, trade_date: "2026-09-18", entry_time: "09:35:00", side: "long",
    shares: 100, entry_price: 5, exit_price: 5.4, pnl_before_comm: 40, pnl_after_comm: 38, commission: 2,
    win, setup_type: null, behavior_tags: [], lesson_tags: [],
    ...over,
  };
}
module.exports = { trade };
