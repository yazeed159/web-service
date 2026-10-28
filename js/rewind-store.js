(function () {
  "use strict";
  const R = (window.RewindKit = window.RewindKit || {});
  const { HISTORY_KEY, HISTORY_MAX, REVIEWED_KEY } = R;

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveHistoryEntry(entry) {
    try {
      const list = loadHistory();
      list.push(entry);
      while (list.length > HISTORY_MAX) list.shift();
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      // Mirror to Supabase (user_kv) so rewind session history survives a
      // cleared cache or a new device -- see KV in auth.js.
      if (window.KV) window.KV.set(HISTORY_KEY, list);
    } catch (e) { /* ignore — quiz still works without persistence */ }
  }

  function loadReviewed() {
    try {
      const parsed = JSON.parse(localStorage.getItem(REVIEWED_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) { return {}; }
  }
  function saveReviewed(map) {
    try {
      localStorage.setItem(REVIEWED_KEY, JSON.stringify(map));
      // Mirror to Supabase (user_kv) so "already rewinded" state survives
      // a cleared cache or a new device, same as HISTORY_KEY above.
      // Merge per trade id with another device's copy instead of overwriting it (see KV.setMerged).
      if (window.KV) {
        if (!window.KV.setMerged) window.KV.set(REVIEWED_KEY, map);
        else window.KV.setMerged(REVIEWED_KEY, map).then(function (r) {
          if (r && r.merged && r.value) { try { localStorage.setItem(REVIEWED_KEY, JSON.stringify(r.value)); } catch (e) { /* ignore */ } }
        });
      }
    } catch (e) { /* ignore — rewind still works without persistence */ }
  }
  // Called the first time a trade reaches the reveal stage (see
  // goToReveal below). Backtest-sourced trades are never marked --
  // their ids are synthetic and regenerated per run.
  function markReviewed(id) {
    const map = loadReviewed();
    if (map[id]) return;
    map[id] = true;
    saveReviewed(map);
  }
  Object.assign(R, { loadHistory, loadReviewed, markReviewed, saveHistoryEntry, saveReviewed });
})();
