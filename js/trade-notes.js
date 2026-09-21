// trade-notes.js — the trader's own per-trade journal entry: planned
// stop/target, setup tag, mistake tags, "followed my rules?" and free
// notes. Same storage pattern as grade.js: localStorage first (instant,
// offline-safe), mirrored to the signed-in user's Supabase `user_kv` row
// via window.KV, so it's private to that user (RLS on auth.uid()) and
// survives a cleared cache / new device. Remote copy wins on load.
//
// Schema (one KV key, { [tradeId]: entry }):
//   { plan_stop: number|null, plan_target: number|null,
//     setup: string, mistakes: string[], followed_rules: true|false|null,
//     notes: string, updated: ISO string }
// Empty entries are deleted rather than stored.
(function () {
  "use strict";
  const STORAGE_KEY = "trade.log:journal_entries";
  const DEFAULT_SETUPS = ["Dip buy", "Breakout", "Reversal", "VWAP reclaim", "Momentum scalp", "Other"];
  const DEFAULT_MISTAKES = ["Chased entry", "Early exit", "Held too long", "No stop", "Moved stop", "Oversized", "Revenge trade", "Overtrading", "Ignored plan", "FOMO"];

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function writeLocalOnly(store) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  }
  function writeStore(store) {
    writeLocalOnly(store);
    if (window.KV) window.KV.set(STORAGE_KEY, store);
  }
  if (window.KV) {
    window.KV.sync(STORAGE_KEY, function (remote) { writeLocalOnly(remote); });
  }

  function num(v) {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : null;
  }
  function isEmpty(e) {
    return !e || (e.plan_stop == null && e.plan_target == null && !e.setup &&
      !(e.mistakes && e.mistakes.length) && e.followed_rules == null && !(e.notes || "").trim());
  }

  function get(tradeId) { return readStore()[tradeId] || null; }
  function all() { return readStore(); }
  function save(tradeId, entry) {
    if (!tradeId) return;
    const store = readStore();
    const clean = {
      plan_stop: num(entry.plan_stop),
      plan_target: num(entry.plan_target),
      setup: (entry.setup || "").trim(),
      mistakes: Array.from(new Set((entry.mistakes || []).map((m) => String(m).trim()).filter(Boolean))),
      followed_rules: entry.followed_rules === true ? true : entry.followed_rules === false ? false : null,
      notes: entry.notes || "",
      updated: new Date().toISOString(),
    };
    if (isEmpty(clean)) delete store[tradeId]; else store[tradeId] = clean;
    writeStore(store);
  }

  // Planned risk/reward in R, and realised R, from the trader's own plan.
  // Risk per share = |entry - planned stop|. Returns nulls when there's no
  // usable plan (missing stop, or stop on the wrong side of entry).
  function metrics(trade, entry) {
    const out = { risk_per_share: null, risk_dollars: null, planned_rr: null, r_multiple: null };
    if (!trade || !entry || !entry.plan_stop) return out;
    const isShort = String(trade.side || "").toLowerCase() === "short";
    const risk = isShort ? entry.plan_stop - trade.entry_price : trade.entry_price - entry.plan_stop;
    if (!(risk > 0)) return out;
    out.risk_per_share = risk;
    if (trade.shares) {
      out.risk_dollars = risk * trade.shares;
      if (typeof trade.pnl_after_comm === "number") out.r_multiple = trade.pnl_after_comm / out.risk_dollars;
    }
    if (entry.plan_target) {
      const reward = isShort ? trade.entry_price - entry.plan_target : entry.plan_target - trade.entry_price;
      if (reward > 0) out.planned_rr = reward / risk;
    }
    return out;
  }

  // All distinct custom tags the user has used, so the picker can offer them.
  function knownTags() {
    const setups = new Set(DEFAULT_SETUPS), mistakes = new Set(DEFAULT_MISTAKES);
    Object.values(readStore()).forEach((e) => {
      if (e.setup) setups.add(e.setup);
      (e.mistakes || []).forEach((m) => mistakes.add(m));
    });
    return { setups: Array.from(setups), mistakes: Array.from(mistakes) };
  }

  window.TradeNotes = { get, all, save, metrics, knownTags, DEFAULT_SETUPS, DEFAULT_MISTAKES };
})();
