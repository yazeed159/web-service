// daily-notes.js — the trader's own daily plan + end-of-day review.
// Same storage pattern as grade.js / trade-notes.js: localStorage first,
// mirrored to the signed-in user's Supabase `user_kv` row via window.KV
// (RLS-scoped to auth.uid(); remote wins on load).
//
// One KV key, { days: { "YYYY-MM-DD": Day }, checklist: string[] }
//   Day = { plan, max_loss, goal, checks: { [item]: bool },
//           went_well, to_fix, followed_plan: true|false|null,
//           tomorrow, updated }
(function () {
  "use strict";
  const STORAGE_KEY = "trade.log:daily_notes";
  const DEFAULT_CHECKLIST = [
    "Checked scanner / catalysts",
    "Max daily loss set",
    "Named my A+ setups for today",
    "Position size fits my risk",
  ];

  function readStore() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
      return { days: s.days || {}, checklist: Array.isArray(s.checklist) ? s.checklist : null };
    } catch (e) { return { days: {}, checklist: null }; }
  }
  function writeLocalOnly(store) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  }
  function writeStore(store) {
    writeLocalOnly(store);
    if (window.KV) window.KV.set(STORAGE_KEY, store);
  }
  if (window.KV) window.KV.sync(STORAGE_KEY, function (remote) { writeLocalOnly(remote); });

  function num(v) {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return isFinite(n) && n > 0 ? n : null;
  }
  function isEmpty(d) {
    return d.max_loss == null && d.goal == null && !(d.plan || "").trim() &&
      !Object.values(d.checks || {}).some(Boolean) && !(d.went_well || "").trim() &&
      !(d.to_fix || "").trim() && d.followed_plan == null && !(d.tomorrow || "").trim();
  }

  function getChecklist() { return readStore().checklist || DEFAULT_CHECKLIST.slice(); }
  function setChecklist(list) {
    const store = readStore();
    store.checklist = Array.from(new Set(list.map((x) => String(x).trim()).filter(Boolean)));
    writeStore(store);
  }
  function get(date) { return readStore().days[date] || null; }
  function allDays() { return readStore().days; }
  function save(date, day) {
    if (!date) return;
    const store = readStore();
    const clean = {
      plan: day.plan || "",
      max_loss: num(day.max_loss),
      goal: num(day.goal),
      checks: day.checks || {},
      went_well: day.went_well || "",
      to_fix: day.to_fix || "",
      followed_plan: day.followed_plan === true ? true : day.followed_plan === false ? false : null,
      tomorrow: day.tomorrow || "",
      updated: new Date().toISOString(),
    };
    if (isEmpty(clean)) delete store.days[date]; else store.days[date] = clean;
    writeStore(store);
  }

  window.DailyNotes = { get, allDays, save, getChecklist, setChecklist, DEFAULT_CHECKLIST };
})();
