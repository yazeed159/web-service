// trade-notes.js — the trader's own per-trade journal entry: planned
// stop/target, setup tag, mistake tags, "followed my rules?" and free
// notes. Same storage pattern as grade.js: localStorage first (instant,
// offline-safe), mirrored to the signed-in user's Supabase `user_kv` row
// via window.KV, so it's private to that user (RLS on auth.uid()) and
// survives a cleared cache / new device. Remote copy wins on load.
//
// Schema (one KV key, { [tradeId]: entry }):
//   { plan_stop: number|null, plan_target: number|null,
//     no_stop: bool, no_target: bool,   // "None" chosen on purpose (no plan / undecided)
//     setup: string, mistakes: string[], followed_rules: true|false|null,
//     notes: string, updated: ISO string }
// Empty entries are deleted rather than stored.
(function () {
  "use strict";
  const STORAGE_KEY = "trade.log:journal_entries";

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {}; } catch (e) { return {}; }
  }
  function writeLocalOnly(store) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  }
  function writeStore(store) {
    writeLocalOnly(store);
    saveRemote(store);
  }
  // Two devices editing different trades must both keep their edits: merge instead of last-save-wins.
  function saveRemote(store) {
    if (!window.KV) return;
    if (!window.KV.setMerged) { window.KV.set(STORAGE_KEY, store); return; }
    window.KV.setMerged(STORAGE_KEY, store).then(function (r) { if (r && r.merged && r.value) writeLocalOnly(r.value); });
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
    return !e || (e.plan_stop == null && e.plan_target == null && !e.no_stop && !e.no_target && !e.setup &&
      !(e.mistakes && e.mistakes.length) && e.followed_rules == null && !(e.notes || "").trim());
  }

  function get(tradeId) { return readStore()[tradeId] || null; }
  function all() { return readStore(); }
  function save(tradeId, entry) {
    if (!tradeId) return;
    const store = readStore();
    const stop = num(entry.plan_stop), target = num(entry.plan_target);
    // Setup / mistakes / followed-rules used to be typed in by hand. Tags are automatic now and nothing
    // writes those fields any more, but entries already saved keep them (hidden, never deleted): a caller
    // that doesn't mention a field leaves the stored value alone.
    const prev = store[tradeId] || {};
    const keep = (k, fallback) => (entry[k] !== undefined ? entry[k] : prev[k] !== undefined ? prev[k] : fallback);
    const clean = {
      plan_stop: stop,
      plan_target: target,
      no_stop: stop == null && entry.no_stop === true,
      no_target: target == null && entry.no_target === true,
      setup: String(keep("setup", "") || "").trim(),
      mistakes: Array.from(new Set((keep("mistakes", []) || []).map((m) => String(m).trim()).filter(Boolean))),
      followed_rules: keep("followed_rules", null) === true ? true : keep("followed_rules", null) === false ? false : null,
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

  window.TradeNotes = { get, all, save, metrics };
})();
