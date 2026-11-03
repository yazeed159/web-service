// chat-facts.js -- the "free" half of AI Chat.
//
// The old chat sent the model a tiny aggregate summary plus ~25 sample trades and hoped it
// could answer anything about the whole journal. It couldn't: time-of-day, weekday, trend,
// hold time, sizing, streaks and revenge-trading questions had no data behind them (and LLMs
// are bad at arithmetic over long lists anyway), so it guessed.
//
// This module does that work in the browser, for free:
//   computeFacts(rows)        -> { raw, blocks } ; blocks are short text tables, one per topic
//   routeTopics(text)         -> which blocks a question actually needs (so the LLM call only
//                                carries a few hundred relevant tokens, not the whole journal)
//   localAnswer(text, facts)  -> an instant, zero-credit answer for plain "what's my X" questions
//   findRelevantTrade(...)    -> the one trade a message is asking about ("last losing trade", a
//                                symbol, a date) so the model gets its line + chart indicators
//
// Pure functions, no DOM / network. Under Node it's module.exports (tests/chat-facts.test.js);
// in the browser it's window.ChatFacts.
(function (root) {
  "use strict";

  // ---------- tiny helpers ----------
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  const pnlOf = (r) => num(r.pnl_after_comm);
  const isWin = (r) => (r.win != null ? !!r.win : pnlOf(r) > 0);
  const r2 = (x) => Math.round(x * 100) / 100;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  const fmt = (x) => Math.abs(r2(x)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (x) => (x < 0 ? "-$" : "$") + fmt(x); // plain
  const smoney = (x) => (x < 0 ? "-$" : "+$") + fmt(x); // signed
  const pl = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const small = (n) => (n < 5 ? " (small sample)" : "");

  function toMin(s) {
    if (typeof s !== "string" || !s) return null;
    const p = s.split(":").map(Number);
    if (p.length < 2 || p.some((x) => !isFinite(x))) return null;
    return p[0] * 60 + p[1] + (p[2] || 0) / 60;
  }
  function holdMin(r) {
    const a = toMin(r.entry_time), b = toMin(r.exit_time);
    return a != null && b != null && b > a ? b - a : null;
  }
  const dowOf = (d) => (d ? new Date(d + "T12:00:00Z").getUTCDay() : null);
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const stamp = (r) => (r.trade_date || "") + " " + (r.entry_time || "");
  const sortChrono = (rows) => [...rows].sort((a, b) => stamp(a).localeCompare(stamp(b)));

  function fmtHold(m) {
    if (m == null) return "n/a";
    if (m < 1) return Math.round(m * 60) + "s";
    if (m < 60) return r2(m) + "m";
    return r2(m / 60) + "h";
  }

  // One line per trade -- same format the old chat used, so the server prompt still matches.
  function formatTradeLine(r) {
    const tags = (r.lesson_tags || []).join(",") || "-";
    return [
      r.id || "-", r.trade_date || "-", r.symbol || "-", r.side || "-", r.setup_type || "-",
      isWin(r) ? "WIN" : "LOSS", r.pnl_after_comm != null ? Number(r.pnl_after_comm).toFixed(2) : "-",
      r.shares != null ? r.shares : "-",
      `${r.entry_price != null ? r.entry_price : "-"}->${r.exit_price != null ? r.exit_price : "-"}`,
      tags, r.rvol_tag || "-",
    ].join(" | ");
  }

  // ---------- grouping ----------
  function group(rows, keyFn) {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (k == null || k === "") continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  }
  function stats(rs) {
    const wins = rs.filter(isWin).length;
    const net = sum(rs.map(pnlOf));
    return { n: rs.length, wins, winRate: pct(wins, rs.length), net: r2(net), avg: r2(rs.length ? net / rs.length : 0) };
  }
  function table(rows, keyFn, order) {
    const out = [];
    for (const [key, rs] of group(rows, keyFn)) out.push({ key: String(key), ...stats(rs) });
    if (order === "net") out.sort((a, b) => b.net - a.net);
    else out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }
  const line = (t) => `${t.key}: ${t.n} trades, ${t.winRate}% win, net ${smoney(t.net)}, avg ${smoney(t.avg)}/trade${small(t.n)}`;

  function timeBucket(r) {
    const m = toMin(r.entry_time);
    if (m == null) return null;
    const h = Math.floor(m / 60);
    if (h === 9) return m < 570 ? "09:00-09:29" : "09:30-09:59";
    return String(h).padStart(2, "0") + ":00-" + String(h).padStart(2, "0") + ":59";
  }
  const HOLD_BUCKETS = [
    ["<1m", 1], ["1-2m", 2], ["2-5m", 5], ["5-15m", 15], ["15-60m", 60], ["60m+", Infinity],
  ];
  function holdBucket(r) {
    const h = holdMin(r);
    if (h == null) return null;
    return HOLD_BUCKETS.find((b) => h < b[1])[0];
  }
  function weekStart(d) {
    const dt = new Date(d + "T12:00:00Z");
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    return dt.toISOString().slice(0, 10);
  }

  // ---------- the big computation ----------
  function computeFacts(input) {
    const rows = sortChrono(Array.isArray(input) ? input : []);
    const n = rows.length;
    if (!n) return { n: 0, raw: {}, blocks: { core: "No trades logged yet." }, fingerprint: "0" };

    const wins = rows.filter(isWin), losses = rows.filter((r) => !isWin(r));
    const net = sum(rows.map(pnlOf));
    const grossWin = sum(wins.map((r) => Math.max(0, pnlOf(r))));
    const grossLoss = sum(losses.map((r) => Math.max(0, -pnlOf(r))));
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;
    const pf = grossLoss > 0 ? grossWin / grossLoss : null;
    const payoff = avgLoss > 0 ? avgWin / avgLoss : null;
    const expectancy = net / n;

    // max drawdown on cumulative P&L (trade by trade)
    let eq = 0, peak = 0, maxDD = 0;
    for (const r of rows) { eq += pnlOf(r); peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }

    const dates = rows.map((r) => r.trade_date).filter(Boolean);
    const days = group(rows, (r) => r.trade_date);
    const dayStats = [...days].map(([d, rs]) => ({ date: d, n: rs.length, net: r2(sum(rs.map(pnlOf))) })).sort((a, b) => (a.date < b.date ? -1 : 1));
    const greenDays = dayStats.filter((d) => d.net > 0), redDays = dayStats.filter((d) => d.net < 0);
    const bestDay = [...dayStats].sort((a, b) => b.net - a.net)[0];
    const worstDay = [...dayStats].sort((a, b) => a.net - b.net)[0];

    const raw = {
      n, wins: wins.length, losses: losses.length, winRate: pct(wins.length, n), net: r2(net),
      profitFactor: pf == null ? null : r2(pf), avgWin: r2(avgWin), avgLoss: r2(avgLoss),
      payoff: payoff == null ? null : r2(payoff), expectancy: r2(expectancy), maxDrawdown: r2(maxDD),
      firstDate: dates[0] || null, lastDate: dates[dates.length - 1] || null,
      tradingDays: dayStats.length, greenDays: greenDays.length, redDays: redDays.length, bestDay, worstDay,
    };

    // ---- core
    const core = [
      `Journal: ${n} trades over ${dayStats.length} trading days (${raw.firstDate} to ${raw.lastDate}).`,
      `Win rate ${raw.winRate}% (${wins.length}W/${losses.length}L). Net P&L ${smoney(net)} after commissions. Expectancy ${smoney(expectancy)}/trade.`,
      `Avg win ${money(avgWin)}, avg loss ${money(avgLoss)}, payoff ratio ${payoff == null ? "n/a" : r2(payoff)}, profit factor ${pf == null ? (grossWin > 0 ? "infinite (no losses)" : "0") : r2(pf)}.`,
      `Max drawdown (cumulative, trade by trade) ${money(maxDD)}. Green days ${greenDays.length}, red days ${redDays.length}.`,
      bestDay ? `Best day ${bestDay.date} ${smoney(bestDay.net)} (${bestDay.n} trades); worst day ${worstDay.date} ${smoney(worstDay.net)} (${worstDay.n} trades).` : "",
    ].filter(Boolean).join("\n");

    // ---- setups
    const setups = table(rows, (r) => r.setup_type || "unspecified", "net");
    raw.setups = setups;
    const setupsB = "By setup (best to worst net):\n" + setups.map(line).join("\n");

    // ---- time of day
    const times = table(rows, timeBucket);
    raw.times = times;
    const timeB = times.length
      ? "By entry time (as logged):\n" + times.map(line).join("\n")
      : "Entry times are missing on these trades, so time-of-day can't be analysed.";

    // ---- weekday
    const dows = table(rows, (r) => { const d = dowOf(r.trade_date); return d == null ? null : DOW[d]; });
    dows.sort((a, b) => DOW.indexOf(a.key) - DOW.indexOf(b.key));
    raw.dows = dows;
    const dowB = "By weekday:\n" + dows.map(line).join("\n");

    // ---- trend: months if we have 3+, else weeks
    const months = new Set(dates.map((d) => d.slice(0, 7)));
    const periodFn = months.size >= 3 ? (r) => (r.trade_date ? r.trade_date.slice(0, 7) : null) : (r) => (r.trade_date ? weekStart(r.trade_date) : null);
    const periods = table(rows, periodFn);
    raw.periods = periods;
    raw.periodKind = months.size >= 3 ? "month" : "week (starting Monday)";
    const lastN = rows.slice(-20), prevN = rows.slice(-40, -20);
    raw.recent20 = stats(lastN);
    raw.prev20 = prevN.length ? stats(prevN) : null;
    const trendB = [
      `By ${raw.periodKind}:`,
      ...periods.slice(-12).map(line),
      `Last ${lastN.length} trades: ${raw.recent20.winRate}% win, net ${smoney(raw.recent20.net)}.`,
      raw.prev20 ? `Prior ${prevN.length} trades: ${raw.prev20.winRate}% win, net ${smoney(raw.prev20.net)}.` : "",
    ].filter(Boolean).join("\n");

    // ---- hold time
    const hw = wins.map(holdMin).filter((x) => x != null), hl = losses.map(holdMin).filter((x) => x != null);
    const holds = table(rows, holdBucket);
    holds.sort((a, b) => HOLD_BUCKETS.findIndex((x) => x[0] === a.key) - HOLD_BUCKETS.findIndex((x) => x[0] === b.key));
    raw.holds = holds;
    raw.avgHoldWin = hw.length ? r2(mean(hw)) : null;
    raw.avgHoldLoss = hl.length ? r2(mean(hl)) : null;
    const winsShorter = hw.length && hl.length ? pct(hw.filter((h) => h < mean(hl)).length, hw.length) : null;
    const holdB = hw.length || hl.length
      ? [
          `Avg hold: winners ${fmtHold(raw.avgHoldWin)} (median ${fmtHold(median(hw))}), losers ${fmtHold(raw.avgHoldLoss)} (median ${fmtHold(median(hl))}).`,
          winsShorter != null ? `${winsShorter}% of winners were held for less time than the average loser.` : "",
          `Avg win ${money(avgWin)} vs avg loss ${money(avgLoss)} (payoff ${payoff == null ? "n/a" : r2(payoff)}).`,
          "By hold time:", ...holds.map(line),
          "Note: only entry/exit times are logged, so peak-vs-exit giveback (how much a winner gave back before exit) is NOT available here; the Edge Analysis page's bar-level run measures it.",
        ].filter(Boolean).join("\n")
      : "Entry/exit times are missing, so hold time can't be analysed.";

    // ---- sizing
    const shares = rows.map((r) => num(r.shares)).filter((x) => x > 0);
    const medSh = median(shares), meanSh = mean(shares);
    const cv = meanSh ? Math.sqrt(mean(shares.map((x) => (x - meanSh) ** 2))) / meanSh : 0;
    const sortedLoss = [...losses].sort((a, b) => pnlOf(a) - pnlOf(b));
    const bigLosses = losses.filter((r) => avgLoss > 0 && -pnlOf(r) > 2 * avgLoss);
    raw.sizing = { median: Math.round(medSh), mean: Math.round(meanSh), cv: r2(cv) };
    const shWin = wins.map((r) => num(r.shares)).filter((x) => x > 0), shLoss = losses.map((r) => num(r.shares)).filter((x) => x > 0);
    const sizingB = shares.length
      ? [
          `Share size: median ${Math.round(medSh)}, mean ${Math.round(meanSh)}, min ${Math.min(...shares)}, max ${Math.max(...shares)}; variation (std/mean) ${r2(cv)} (${cv < 0.35 ? "fairly consistent" : cv < 0.7 ? "moderately varied" : "very inconsistent"}).`,
          `Avg shares on winners ${Math.round(mean(shWin))} vs losers ${Math.round(mean(shLoss))}.`,
          sortedLoss.length ? `Largest loss ${smoney(pnlOf(sortedLoss[0]))} is ${avgLoss ? r2(-pnlOf(sortedLoss[0]) / avgLoss) : "n/a"}x the average loss; ${bigLosses.length} losses were over 2x the average loss (${smoney(-sum(bigLosses.map((r) => -pnlOf(r))))} combined).` : "",
          "Planned stop / risk-per-trade is not logged, so true R-multiples can't be computed; this is share size and dollar loss only.",
        ].filter(Boolean).join("\n")
      : "Share counts are missing, so sizing can't be analysed.";

    // ---- streaks
    let best = { len: 0 }, worst = { len: 0 }, cur = null;
    for (let i = 0; i < rows.length; i++) {
      const w = isWin(rows[i]);
      if (cur && cur.win === w) { cur.len++; cur.to = i; cur.pnl += pnlOf(rows[i]); }
      else cur = { win: w, len: 1, from: i, to: i, pnl: pnlOf(rows[i]) };
      if (w && cur.len > best.len) best = { ...cur };
      if (!w && cur.len > worst.len) worst = { ...cur };
    }
    const streakInfo = (s) => (s.len ? { len: s.len, from: rows[s.from].trade_date, to: rows[s.to].trade_date, pnl: r2(s.pnl), fromIdx: s.from, toIdx: s.to } : null);
    raw.maxWinStreak = streakInfo(best);
    raw.maxLossStreak = streakInfo(worst);
    raw.currentStreak = cur ? { type: cur.win ? "win" : "loss", len: cur.len } : null;
    const streakLines = [];
    if (raw.maxWinStreak) streakLines.push(`Longest win streak: ${pl(raw.maxWinStreak.len, "trade")}, ${raw.maxWinStreak.from} to ${raw.maxWinStreak.to}, net ${smoney(raw.maxWinStreak.pnl)}.`);
    if (raw.maxLossStreak) {
      streakLines.push(`Longest losing streak: ${pl(raw.maxLossStreak.len, "trade")}, ${raw.maxLossStreak.from} to ${raw.maxLossStreak.to}, net ${smoney(raw.maxLossStreak.pnl)}. Trades in it:`);
      rows.slice(raw.maxLossStreak.fromIdx, raw.maxLossStreak.toIdx + 1).slice(0, 10).forEach((r) => streakLines.push("  " + formatTradeLine(r)));
    }
    if (raw.currentStreak) streakLines.push(`Current streak: ${raw.currentStreak.len} ${raw.currentStreak.type}${raw.currentStreak.len === 1 ? "" : "s"}.`);
    const streaksB = streakLines.join("\n");

    // ---- tilt / revenge / overtrading (same-day sequences)
    const quick = [], afterTwo = [], rest = [];
    const afterLossSize = [], afterWinSize = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], p = rows[i - 1], pp = rows[i - 2];
      const sameDay = p && p.trade_date === r.trade_date;
      let tagged = false;
      if (sameDay) {
        (isWin(p) ? afterWinSize : afterLossSize).push(num(r.shares));
        const gap = toMin(r.entry_time) != null && toMin(p.exit_time) != null ? toMin(r.entry_time) - toMin(p.exit_time) : null;
        if (!isWin(p) && gap != null && gap >= 0 && gap <= 10) { quick.push(r); tagged = true; }
        if (!isWin(p) && pp && pp.trade_date === r.trade_date && !isWin(pp)) { afterTwo.push(r); tagged = true; }
      }
      if (!tagged) rest.push(r);
    }
    const perDay = [...days.values()].map((rs) => rs.length);
    const medPerDay = median(perDay);
    const overDays = dayStats.filter((d) => d.n > Math.max(3, medPerDay * 1.5));
    raw.tilt = { quick: stats(quick), afterTwo: stats(afterTwo), rest: stats(rest) };
    const tiltB = [
      `Re-entries within 10 min of a same-day LOSING exit: ${quick.length ? line({ key: "these", ...stats(quick) }) : "none found"}.`,
      `Trades taken right after 2+ consecutive same-day losses: ${afterTwo.length ? line({ key: "these", ...stats(afterTwo) }) : "none found"}.`,
      `All other trades: ${line({ key: "baseline", ...stats(rest) })}.`,
      afterLossSize.length && afterWinSize.length
        ? `Avg shares on the trade right after a same-day loss ${Math.round(mean(afterLossSize))} vs right after a win ${Math.round(mean(afterWinSize))}.` : "",
      `Trades per day: median ${medPerDay}; green days avg ${r2(mean(greenDays.map((d) => d.n)))}, red days avg ${r2(mean(redDays.map((d) => d.n)))}.`,
      overDays.length ? `${overDays.length} unusually heavy days (> ${Math.max(3, medPerDay * 1.5)} trades): net ${smoney(sum(overDays.map((d) => d.net)))} combined; heaviest ${[...overDays].sort((a, b) => b.n - a.n)[0].date} (${[...overDays].sort((a, b) => b.n - a.n)[0].n} trades, ${smoney([...overDays].sort((a, b) => b.n - a.n)[0].net)}).` : "No unusually heavy (overtrading) days.",
      worstDay ? `Worst day ${worstDay.date}: ${worstDay.n} trades, ${smoney(worstDay.net)}.` : "",
    ].filter(Boolean).join("\n");

    // ---- lesson tags: what each costs / earns
    const tagMap = new Map();
    for (const r of rows) for (const t of r.lesson_tags || []) { if (!tagMap.has(t)) tagMap.set(t, []); tagMap.get(t).push(r); }
    const tags = [...tagMap].map(([key, rs]) => ({ key, ...stats(rs) })).sort((a, b) => a.net - b.net);
    raw.tags = tags;
    const untaggedLosses = losses.filter((r) => !(r.lesson_tags || []).length);
    const tagsB = tags.length
      ? [
          "Lesson tags by total P&L of tagged trades (worst first; a trade with several tags counts under each):",
          ...tags.slice(0, 12).map(line),
          `Losses with no lesson tag: ${untaggedLosses.length} of ${losses.length} (${smoney(sum(untaggedLosses.map(pnlOf)))}).`,
        ].join("\n")
      : "No lesson tags are applied to any trade yet.";

    // ---- symbols
    const syms = table(rows, (r) => r.symbol, "net").filter((t) => t.n >= 2);
    const symB = syms.length
      ? ["Best symbols (2+ trades):", ...syms.slice(0, 5).map(line), "Worst symbols (2+ trades):", ...syms.slice(-5).reverse().map(line)].join("\n")
      : "No symbol has been traded more than once.";

    // ---- side / float / rvol / grade
    const optional = (title, keyFn, order) => {
      const t = table(rows, keyFn, order);
      return t.length ? `${title}:\n` + t.map(line).join("\n") : "";
    };
    const sideB = optional("By side", (r) => r.side);
    const floatB = [optional("By float", (r) => r.float_tag), optional("By relative volume", (r) => r.rvol_tag)].filter(Boolean).join("\n");
    const gradeB = optional("By trade grade", (r) => r.grade);

    // ---- recent / notable trades
    const lastLoss = [...rows].reverse().find((r) => !isWin(r));
    const lastWin = [...rows].reverse().find(isWin);
    const worstT = [...rows].sort((a, b) => pnlOf(a) - pnlOf(b))[0];
    const bestT = [...rows].sort((a, b) => pnlOf(b) - pnlOf(a))[0];
    const recentB = [
      "Most recent trades (id | date | symbol | side | setup | result | net_pnl | shares | entry->exit | lesson_tags | rvol):",
      ...rows.slice(-8).map(formatTradeLine),
      lastLoss ? "Last losing trade: " + formatTradeLine(lastLoss) : "",
      lastWin ? "Last winning trade: " + formatTradeLine(lastWin) : "",
      "Biggest loss: " + formatTradeLine(worstT),
      "Biggest win: " + formatTradeLine(bestT),
    ].filter(Boolean).join("\n");

    const blocks = { core, setups: setupsB, time: timeB, dow: dowB, trend: trendB, hold: holdB, sizing: sizingB, streaks: streaksB, tilt: tiltB, tags: tagsB, symbols: symB, side: sideB, float: floatB, grade: gradeB, recent: recentB };
    for (const k of Object.keys(blocks)) if (!blocks[k]) delete blocks[k];

    return {
      n, raw, blocks,
      // changes whenever the journal does, so cached AI answers never go stale
      fingerprint: `${n}:${r2(net)}:${rows[n - 1].id || rows[n - 1].trade_date}`,
    };
  }

  // ---------- routing: which blocks does this question need? ----------
  const TOPIC_RULES = [
    ["tilt", /revenge|tilt|spiral|overtrad|over-trad|chas(e|ing)|fomo|emotion|impuls|after (a |my )?loss|after losing|re-?entr|averag(e|ing) down|discipline|rules?\b/],
    ["streaks", /streak|consecutive|in a row|losing run|winning run|hot hand|cold/],
    ["time", /time of day|what time|best time|which hour|hour|morning|afternoon|midday|open\b|first (hour|30|half)|premarket|pre-market|late in the day|\bwhen (do|should|am)\b/],
    ["dow", /day of (the )?week|weekday|monday|tuesday|wednesday|thursday|friday|which day|best day|worst day/],
    ["trend", /trend|improv|over time|lately|progress|getting (better|worse)|month|week by week|last \d+ trades|consisten/],
    ["hold", /\bhold|duration|cut(ting)? (my )?(winners|early)|too early|too late|late exit|early exit|exit(s|ed)?\b|scalp|runner|giveback|give back|let (it|them) run|take profit|premature/],
    ["sizing", /\bsiz(e|ed|ing)\b|risk|shares|position|oversiz|too big|too large|r[- ]?multiple|stop loss|\bstops?\b/],
    ["tags", /mistake|lesson|\btags?\b|cost(s|ing)? me|biggest (leak|problem|weakness)|repeated|recurring|error|bad habit|weakness|leak|worst habit/],
    ["setups", /setup|breakout|pattern|strateg|bull flag|pullback|vwap|orb|reclaim|playbook|ross|cameron|edge\b/],
    ["symbols", /symbol|ticker|stock|which names?|\bname(s)?\b/],
    ["side", /\blongs?\b|\bshorts?\b|\bside\b/],
    ["float", /float|rvol|relative volume|low[- ]float|in play/],
    ["grade", /\bgrade/],
    ["recent", /\blast\b|latest|recent|walk (me )?through|yesterday|today|this week|biggest (loss|win)|worst trade|best trade/],
  ];
  const OVERVIEW = ["setups", "tags", "tilt", "trend", "recent"];
  const MAX_BLOCKS = 4;

  function routeTopics(text) {
    const t = String(text || "").toLowerCase();
    const hits = [];
    for (const [topic, re] of TOPIC_RULES) if (re.test(t)) hits.push(topic);
    // "how does my execution compare to a Ross Cameron playbook" etc. wants the broad picture too
    if (/playbook|ross|cameron|execution|overall|how am i doing|summar|review|critique|coach|biggest/.test(t)) {
      for (const o of ["setups", "tilt", "tags", "hold"]) if (!hits.includes(o)) hits.push(o);
    }
    const topics = (hits.length ? hits : OVERVIEW).slice(0, MAX_BLOCKS);
    return topics;
  }

  // The blocks to send for a question: core always (it's ~100 tokens), plus the routed topics.
  function selectBlocks(text, facts) {
    const topics = routeTopics(text).filter((t) => facts.blocks[t]);
    const out = { core: facts.blocks.core };
    for (const t of topics) out[t] = facts.blocks[t];
    return { topics, blocks: out };
  }

  // ---------- zero-credit local answers ----------
  // Only plain "what's my X / which X" questions. Anything asking why / what to do / how to fix
  // goes to the model (with the right data attached) instead.
  const NEEDS_JUDGMENT = /\b(why|cause[sd]?|because|should|improve|fix|advice|tips?|compare|comparison|playbook|ross|cameron|mistake|reason|explain|walk (me )?through|common|in common|what do|how (do|can|should) i|what can i|better|worse|revenge|tilt|consistent(ly)?|cost(s|ing)? me|cutting|cut |stop trading|am i|too (early|late|big|large))\b/;
  const STOP = new Set(["what", "whats", "what's", "which", "setup", "setups", "rate", "win", "wins", "trade", "trades", "trading", "have", "does", "show", "give", "much", "many", "make", "money", "most", "best", "worst", "top", "with", "from", "about", "mine", "average", "total", "that", "this", "over", "time", "overall", "the", "and", "for", "how", "are", "was", "did", "has", "my"]);

  function pickSetups(text, facts) {
    const words = String(text).toLowerCase().replace(/[^a-z0-9\s_-]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w));
    const out = [];
    for (const s of facts.raw.setups || []) {
      const key = s.key.toLowerCase().replace(/[_-]+/g, " ");
      if (words.some((w) => key.includes(w) || (w.length > 4 && w.endsWith("s") && key.includes(w.slice(0, -1))))) out.push(s);
    }
    return out;
  }

  function localAnswer(text, facts) {
    if (!facts || !facts.n) return null;
    const t = String(text || "").toLowerCase().replace(/[’']/g, "'");
    if (NEEDS_JUDGMENT.test(t)) return null;
    const R = facts.raw;
    const ans = (body, topics, followups) => ({ text: body, topics, followups: followups || [] });

    // trend
    if (/trend|over time|lately|getting (better|worse)|improving|progress|by month|each month|month by month|week by week/.test(t)) {
      const rows = R.periods.slice(-8).map((p) => `${p.key}: ${p.winRate}% win, ${smoney(p.net)} (${p.n} trades)`);
      const l = R.recent20, p = R.prev20;
      return ans(
        [`**Win rate by ${R.periodKind}** (overall ${R.winRate}%):`, ...rows,
          p ? `Last ${l.n} trades: ${l.winRate}% win, ${smoney(l.net)}. The ${p.n} before that: ${p.winRate}% win, ${smoney(p.net)}.` : `Last ${l.n} trades: ${l.winRate}% win, ${smoney(l.net)}.`].join("\n"),
        ["trend"], ["Why is it moving that way?", "Which setup changed the most recently?"]);
    }
    // streaks
    if (/streak|consecutive|in a row/.test(t)) {
      const w = R.maxWinStreak, l = R.maxLossStreak, c = R.currentStreak;
      return ans(
        [l ? `**Longest losing streak:** ${pl(l.len, "trade")} (${l.from} to ${l.to}), ${smoney(l.pnl)}.` : "", w ? `**Longest win streak:** ${pl(w.len, "trade")} (${w.from} to ${w.to}), ${smoney(w.pnl)}.` : "",
          c ? `Right now: ${c.len} ${c.type}${c.len === 1 ? "" : "s"} in a row.` : ""].filter(Boolean).join("\n"),
        ["streaks"], ["What caused my longest losing streak?", "Am I revenge trading after losses?"]);
    }
    // time of day
    if (/time of day|what time|best time|which hour|best hour|worst hour|hours?\b.*(trade|best|worst)|when do i (trade|do|make|win)/.test(t)) {
      if (!R.times.length) return ans("Entry times are missing on your trades, so I can't break results down by time of day.", ["time"]);
      const rank = [...R.times].filter((b) => b.n >= 3).sort((a, b) => b.net - a.net);
      const pool = rank.length ? rank : [...R.times].sort((a, b) => b.net - a.net);
      const bestB = pool[0], worstB = pool[pool.length - 1];
      return ans(
        [`**Best window:** ${bestB.key}: ${smoney(bestB.net)} over ${bestB.n} trades (${bestB.winRate}% win).`,
          pool.length > 1 ? `**Worst window:** ${worstB.key}: ${smoney(worstB.net)} over ${worstB.n} trades (${worstB.winRate}% win).` : "",
          "", "All windows:", ...R.times.map((b) => `${b.key}: ${smoney(b.net)}, ${b.winRate}% win, ${b.n} trades${small(b.n)}`)].filter((x) => x !== null).join("\n"),
        ["time"], ["Should I stop trading my worst hour?", "What setups do I trade in my best window?"]);
    }
    // weekday
    if (/day of (the )?week|weekday|which day|best day|worst day|monday|tuesday|wednesday|thursday|friday/.test(t)) {
      if (!R.dows.length) return null;
      const byNet = [...R.dows].sort((a, b) => b.net - a.net);
      return ans(
        [`**Best day:** ${byNet[0].key} (${smoney(byNet[0].net)}, ${byNet[0].winRate}% win, ${byNet[0].n} trades).`,
          byNet.length > 1 ? `**Worst day:** ${byNet[byNet.length - 1].key} (${smoney(byNet[byNet.length - 1].net)}, ${byNet[byNet.length - 1].winRate}% win, ${byNet[byNet.length - 1].n} trades).` : "",
          "", ...R.dows.map((d) => `${d.key}: ${smoney(d.net)}, ${d.winRate}% win, ${d.n} trades${small(d.n)}`)].join("\n"),
        ["dow"], ["Why is my worst weekday worst?"]);
    }
    // setup questions: ranking, or "win rate on <setup>"
    const named = pickSetups(t, facts);
    if (/win ?rate|how often|results?|performance|how (am i|do i) do|p&l|pnl|profit|make|made/.test(t) && named.length && !/(which|best|worst|top|most|least)/.test(t)) {
      const rows = named.map((s) => `**${s.key}:** ${s.winRate}% win over ${s.n} trades, net ${smoney(s.net)} (avg ${smoney(s.avg)}/trade)${small(s.n)}`);
      if (named.length > 1) {
        const all = named.reduce((a, s) => ({ n: a.n + s.n, wins: a.wins + s.wins, net: a.net + s.net }), { n: 0, wins: 0, net: 0 });
        rows.push(`Combined: ${pct(all.wins, all.n)}% win over ${all.n} trades, net ${smoney(all.net)}.`);
      }
      return ans(rows.join("\n"), ["setups"], ["Which setup makes me the most money?", "Which setup should I stop trading?"]);
    }
    if (/(which|what|best|worst|top|most|least).*(setup|strategy|pattern)|(setup|strategy|pattern).*(best|worst|most|least|make|made|money|profit)/.test(t)) {
      const s = R.setups;
      if (!s.length) return null;
      const qual = s.filter((x) => x.n >= 3);
      const top = (qual.length ? qual : s)[0], bot = (qual.length ? qual : s)[(qual.length ? qual : s).length - 1];
      return ans(
        [`**Most profitable setup:** ${top.key} (${smoney(top.net)} over ${top.n} trades, ${top.winRate}% win).`,
          s.length > 1 ? `**Least profitable:** ${bot.key} (${smoney(bot.net)} over ${bot.n} trades, ${bot.winRate}% win).` : "",
          "", ...s.map((x) => `${x.key}: ${smoney(x.net)}, ${x.winRate}% win, ${x.n} trades${small(x.n)}`)].join("\n"),
        ["setups"], ["Which setup should I stop trading?", "How does my best setup compare to the Ross Cameron playbook?"]);
    }
    // single numbers
    if (/risk ?\/? ?reward|r:r|\br ?\/ ?r\b|payoff|reward ?(to|:|\/) ?risk|avg(erage)? (win|loss)|average (winner|loser)/.test(t)) {
      return ans(
        `**Average win ${money(R.avgWin)} vs average loss ${money(R.avgLoss)}** (payoff ratio ${R.payoff == null ? "n/a" : R.payoff}). With a ${R.winRate}% win rate that's ${smoney(R.expectancy)} per trade.\nThis is dollars won vs dollars lost. Planned stop/target isn't logged, so it isn't a true planned R:R.`,
        ["core", "hold"], ["Am I cutting winners too early?", "Am I sizing risk consistently?"]);
    }
    if (/profit factor/.test(t)) return ans(`**Profit factor: ${R.profitFactor == null ? "infinite (no losses yet)" : R.profitFactor}** (gross profit divided by gross loss) across ${R.n} trades.`, ["core"]);
    if (/expectancy|per trade|average trade/.test(t)) return ans(`**Expectancy: ${smoney(R.expectancy)} per trade** over ${R.n} trades (win rate ${R.winRate}%, avg win ${money(R.avgWin)}, avg loss ${money(R.avgLoss)}).`, ["core"]);
    if (/drawdown/.test(t)) return ans(`**Max drawdown: ${money(R.maxDrawdown)}** (peak to trough of cumulative P&L, trade by trade).`, ["core"]);
    if (/net p&l|net pnl|total (p&l|pnl|profit)|how much (have i|did i) (make|made|earn|lose|lost)|am i profitable|\bp&l\b|\bpnl\b/.test(t)) {
      return ans(`**Net P&L: ${smoney(R.net)}** after commissions across ${R.n} trades (${R.firstDate} to ${R.lastDate}). ${R.greenDays} green days, ${R.redDays} red days.`, ["core"]);
    }
    if (/how many trades|trade count|number of trades/.test(t)) return ans(`**${R.n} trades** over ${R.tradingDays} trading days (${R.firstDate} to ${R.lastDate}).`, ["core"]);
    if (/win ?rate|how often do i win|winning percentage/.test(t)) {
      return ans(`**Win rate: ${R.winRate}%** (${pl(R.wins, "win")}, ${pl(R.losses, "loss").replace("losss", "losses")} across ${pl(R.n, "trade")}).`, ["core"], ["Which setup has my best win rate?", "How's my win rate trending over time?"]);
    }
    return null;
  }

  // ---------- which single trade is the message about? ----------
  function findRelevantTrade(text, input) {
    const rows = sortChrono(Array.isArray(input) ? input : []);
    if (!rows.length) return null;
    const msg = String(text || "");
    const low = msg.toLowerCase();

    const symbols = Array.from(new Set(rows.map((t) => t.symbol).filter(Boolean)));
    // Short tickers (A, ON, IT, ALL...) are also ordinary words, so those only count when typed
    // in capitals (or with a leading $); longer ones match any case.
    const matchedSymbol = symbols.find((sym) => {
      const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return sym.length >= 4 ? new RegExp(`\\b${esc}\\b`, "i").test(msg) : new RegExp(`(^|[^A-Za-z])\\$?${esc}(?![A-Za-z])`).test(msg);
    });

    const wantLoss = /\b(loss|losing|loser|lost)\b/.test(low);
    const wantWin = /\b(win|winning|winner|won)\b/.test(low);
    const wantWorst = /\b(worst|biggest loss|largest loss|biggest loser)\b/.test(low);
    const wantBest = /\b(best trade|biggest win|largest win|biggest winner)\b/.test(low);
    const wantLast = /\b(last|latest|most recent|previous)\b/.test(low);

    let pool = matchedSymbol ? rows.filter((t) => t.symbol === matchedSymbol) : rows;
    if (!matchedSymbol && !(wantLast || wantWorst || wantBest)) return null;
    if (wantLoss && !wantBest) pool = pool.filter((t) => !isWin(t));
    else if (wantWin && !wantWorst) pool = pool.filter(isWin);
    if (!pool.length) return null;

    const dateMatch = pool.find((t) => t.trade_date && msg.includes(t.trade_date));
    if (dateMatch) return dateMatch;
    if (wantWorst) return [...pool].sort((a, b) => pnlOf(a) - pnlOf(b))[0];
    if (wantBest) return [...pool].sort((a, b) => pnlOf(b) - pnlOf(a))[0];
    return pool[pool.length - 1];
  }

  // Suggested next questions, by topic (free -- no model call).
  const FOLLOWUPS = {
    setups: ["Which setup should I stop trading?", "What do my biggest losers have in common?"],
    time: ["Which setups do I trade at my worst time?", "What time of day do I trade best?"],
    dow: ["Which weekday should I trade less?"],
    trend: ["What changed in my last 20 trades?", "Which setup is improving?"],
    hold: ["Am I cutting winners too early?", "How long do I hold my losers?"],
    sizing: ["Do I size up after losses?", "How big are my biggest losses vs average?"],
    streaks: ["What caused my longest losing streak?"],
    tilt: ["How do I do after two losses in a row?", "How many trades do I take on red days?"],
    tags: ["Which lesson tag costs me the most money?", "Which of my losses have no tag?"],
    recent: ["Walk through my last losing trade", "What did I do well recently?"],
    symbols: ["Which tickers keep costing me?"],
  };
  function followupsFor(topics, exclude) {
    const seen = new Set((exclude || []).map((s) => String(s).toLowerCase()));
    const out = [];
    for (const t of topics || []) for (const q of FOLLOWUPS[t] || []) {
      if (!seen.has(q.toLowerCase()) && !out.includes(q)) out.push(q);
    }
    return out.slice(0, 3);
  }

  const api = { computeFacts, routeTopics, selectBlocks, localAnswer, findRelevantTrade, formatTradeLine, followupsFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ChatFacts = api;
})(typeof window !== "undefined" ? window : globalThis);
