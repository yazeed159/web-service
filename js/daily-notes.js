// daily-notes.js — the trader's own daily plan + end-of-day review.
// Same storage pattern as grade.js / trade-notes.js: localStorage first,
// mirrored to the signed-in user's Supabase `user_kv` row via window.KV
// (RLS-scoped to auth.uid(); remote wins on load).
//
// One KV key, { days: { "YYYY-MM-DD": Day }, checklist: string[] }
//   Day = { plan, max_loss, goal, checks: { [item]: bool },
//           went_well, to_fix, went_well_tags: string[], to_fix_tags: string[],
//           followed_plan: true|false|null, tomorrow, updated }
//
// went_well_tags / to_fix_tags are the tap-to-toggle chip versions of the
// old went_well/to_fix free-text fields (kept around as an optional
// "anything else" note) -- point is to make most days fillable without
// typing at all. to_fix reuses TradeNotes.DEFAULT_MISTAKES as its default
// vocabulary (one list of "what goes wrong" for the whole app) rather than
// keeping a second, drifting copy here.
(function () {
  "use strict";
  const STORAGE_KEY = "trade.log:daily_notes";
  const DEFAULT_CHECKLIST = [
    "Checked scanner / catalysts",
    "Max daily loss set",
    "Named my A+ setups for today",
    "Position size fits my risk",
  ];
  const DEFAULT_WENT_WELL = [
    "Stuck to my plan", "Cut losers fast", "Waited for A+ setups",
    "Sized correctly", "Stayed calm", "Stopped after hitting goal",
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
  function tags(v) { return Array.isArray(v) ? Array.from(new Set(v.map((x) => String(x).trim()).filter(Boolean))) : []; }
  function isEmpty(d) {
    return d.max_loss == null && d.goal == null && !(d.plan || "").trim() &&
      !Object.values(d.checks || {}).some(Boolean) && !(d.went_well || "").trim() &&
      !(d.to_fix || "").trim() && !d.went_well_tags.length && !d.to_fix_tags.length &&
      d.followed_plan == null && !(d.tomorrow || "").trim();
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
      went_well_tags: tags(day.went_well_tags),
      to_fix_tags: tags(day.to_fix_tags),
      followed_plan: day.followed_plan === true ? true : day.followed_plan === false ? false : null,
      tomorrow: day.tomorrow || "",
      updated: new Date().toISOString(),
    };
    if (isEmpty(clean)) delete store.days[date]; else store.days[date] = clean;
    writeStore(store);
  }

  // Every went-well / to-fix tag the trader has actually used, merged with
  // the defaults, so the chip picker grows with them instead of ever
  // needing to be typed twice.
  function knownTags() {
    const wellSet = new Set(DEFAULT_WENT_WELL);
    const fixSet = new Set((window.TradeNotes && window.TradeNotes.DEFAULT_MISTAKES) || []);
    Object.values(readStore().days).forEach((d) => {
      (d.went_well_tags || []).forEach((t) => wellSet.add(t));
      (d.to_fix_tags || []).forEach((t) => fixSet.add(t));
    });
    return { went_well: Array.from(wellSet), to_fix: Array.from(fixSet) };
  }

  // Most recent OTHER day with a max loss / goal set, so a fresh day can
  // offer "use last time's numbers" instead of asking you to retype them.
  function lastPlanned(beforeDate) {
    const days = readStore().days;
    const found = Object.keys(days)
      .filter((d) => d !== beforeDate && (days[d].max_loss != null || days[d].goal != null))
      .sort().reverse()[0];
    return found ? { date: found, max_loss: days[found].max_loss, goal: days[found].goal } : null;
  }

  // Most recent OTHER day (strictly before beforeDate when comparable)
  // with "to fix" tags, so today's plan can surface a quiet reminder of
  // what you were working on last time -- computed live, nothing to save.
  function priorFocus(beforeDate) {
    const days = readStore().days;
    const found = Object.keys(days)
      .filter((d) => d < beforeDate && (days[d].to_fix_tags || []).length)
      .sort().reverse()[0];
    return found ? { date: found, tags: days[found].to_fix_tags } : null;
  }

  // Consecutive days, walking back from `fromDate`, with a saved entry --
  // a quick "you've planned/reviewed N days running" streak.
  function streak(fromDate) {
    const days = readStore().days;
    const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
    const pad = (n) => String(n).padStart(2, "0");
    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    let n = 0, cur = fromDate;
    while (days[cur]) { n++; const d = parse(cur); d.setDate(d.getDate() - 1); cur = iso(d); }
    return n;
  }

  window.DailyNotes = {
    get, allDays, save, getChecklist, setChecklist, DEFAULT_CHECKLIST,
    knownTags, lastPlanned, priorFocus, streak, DEFAULT_WENT_WELL,
  };
})();
