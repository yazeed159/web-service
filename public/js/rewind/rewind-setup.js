(function () {
  "use strict";
  const R = (window.RewindKit = window.RewindKit || {});
  const { HISTORY_KEY, REVIEWED_KEY, els, loadHistory, loadReviewed, normalizeBacktestTrade, saveReviewed, state } = R;
  const startQuiz = (...args) => R.startQuiz(...args);

  // ---------------------------------------------------------------
  // boot: load the index, populate the setup screen
  // ---------------------------------------------------------------
  // trade.html's "Replay" button links here as ?trade=<id> to jump
  // straight into replaying that one trade, bypassing the setup
  // screen's source/filter picker entirely -- it already knows exactly
  // which trade it wants, so there's nothing to filter for. Falls back
  // to the normal setup screen if the id turns out to be invalid.
  const directTradeId = new URLSearchParams(window.location.search).get("trade");

  // report.js's "Rewind this trade" button hands a single backtest trade
  // off via localStorage (same-origin, so this new tab can read it right
  // away) -- same handoff pattern practice.js uses for its own "Practice
  // this trade" button. Deferred to DOMContentLoaded: reading localStorage
  // and building the chart is fully synchronous, with none of the network
  // latency the ?trade=<id> deep-link above naturally has before it ever
  // touches the chart -- running this immediately, mid-parse, would race
  // the deferred lightweight-charts <script> tag (still loading at that
  // point) and fail to render with nothing shown on screen.
  (function loadPendingBacktestHandoff() {
    const REWIND_HANDOFF_KEY = "rewind:pending_backtest_trade";
    let raw;
    try {
      raw = localStorage.getItem(REWIND_HANDOFF_KEY);
      if (raw) localStorage.removeItem(REWIND_HANDOFF_KEY);
    } catch (e) { raw = null; }
    if (!raw) return;

    function boot() {
      let t;
      try { t = JSON.parse(raw); } catch (e) { return; } // malformed handoff -- nothing to recover
      const run = { id: t.job_id, label: t.label };
      const trade = normalizeBacktestTrade(t, run);
      state.source = "backtest";
      state.detailCache[trade.id] = trade;
      startQuiz(getFilters(), [trade.id]);
    }

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  })();

  (window.fetchTradesIndexRaw || window.fetchTradesIndex)()
    .then((rows) => {
      state.index = Array.isArray(rows) ? rows : [];
      populateSetupOptions();
      renderCandidateCount();
      renderHistoryPanel();
      renderProgressPanel();
      if (directTradeId) startQuiz(state.lastFilters || getFilters(), [directTradeId]);
    })
    .catch(() => {
      els.candidateCount.textContent = "Couldn't load your trades.";
      els.startBtn.disabled = true;
    });

  // Once auth.js has this user's synced history down, a remote copy wins
  // (cross-device source of truth); otherwise whatever's local right now
  // gets pushed up as the seed.
  if (window.KV) {
    window.KV.sync(HISTORY_KEY, function (remote) {
      if (!Array.isArray(remote)) return;
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(remote)); } catch (e) { /* ignore */ }
      if (typeof renderHistoryPanel === "function") renderHistoryPanel();
    });
    window.KV.sync(REVIEWED_KEY, function (remote) {
      if (!remote || typeof remote !== "object" || Array.isArray(remote)) return;
      try { localStorage.setItem(REVIEWED_KEY, JSON.stringify(remote)); } catch (e) { /* ignore */ }
      renderProgressPanel();
      renderCandidateCount();
    });
  }

  function populateSetupOptions() {
    const setups = Array.from(new Set(state.index.map((r) => r.setup_type).filter(Boolean))).sort();
    for (const s of setups) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s.replace(/_/g, " ");
      els.setupSelect.appendChild(opt);
    }
  }

  function getFilters() {
    const countBtn = els.countRow.querySelector(".quiz-mode-btn.active");
    const tickBtn = els.tickModeRow.querySelector(".quiz-mode-btn.active");
    return {
      setup: els.setupSelect.value,
      result: els.resultSelect.value,
      count: countBtn ? Number(countBtn.dataset.count) : 10,
      blind: els.blindCheck.checked,
      includeReviewed: els.includeReviewedCheck ? els.includeReviewedCheck.checked : false,
      tickMode: tickBtn ? tickBtn.dataset.tickmode : "sim",
    };
  }

  // Shared win/loss/flagged predicate -- works on both a real journal
  // index row (Supabase trades table) and a normalized backtest trade, since
  // both carry the same flat `win` / `better_entry_price` /
  // `better_exit_price` fields. `setup` filtering is skipped for
  // backtest rows (a run is already one single strategy, picked via the
  // run selector instead of a setup-type dropdown).
  function matchesOutcome(r, filters) {
    if (filters.result === "win" && !r.win) return false;
    if (filters.result === "loss" && r.win) return false;
    if (filters.result === "flagged" && !(r.better_entry_price != null || r.better_exit_price != null)) return false;
    return true;
  }

  function filterIndex(filters) {
    // Skip anything already stepped through to the reveal (see
    // markReviewed/goToReveal) unless the "include already-rewinded
    // trades" box is checked -- this is what keeps a rewind session
    // from serving up the same trade twice.
    const reviewed = filters.includeReviewed ? null : loadReviewed();
    return state.index.filter((r) => {
      if (!r.id) return false;
      if (filters.setup && r.setup_type !== filters.setup) return false;
      if (reviewed && reviewed[r.id]) return false;
      return matchesOutcome(r, filters);
    });
  }

  function filterBacktestTrades(filters) {
    return state.backtestTrades.filter((r) => matchesOutcome(r, filters));
  }

  // Dispatches on state.source so the start button, "Rewind again", and
  // the candidate-count line all read from whichever source is active
  // without duplicating the win/loss/flagged logic per source.
  function getCandidateRows(filters) {
    return state.source === "backtest" ? filterBacktestTrades(filters) : filterIndex(filters);
  }

  function renderCandidateCount() {
    const filters = getFilters();
    const n = getCandidateRows(filters).length;
    if (state.source === "backtest") {
      els.candidateCount.innerHTML = state.backtestRunId
        ? `<b>${n}</b> matching trade${n === 1 ? "" : "s"} available to practice from this run.`
        : `Pick a saved backtest run above to see how many trades are available.`;
    } else {
      els.candidateCount.innerHTML = `<b>${n}</b> matching trade${n === 1 ? "" : "s"} in your journal.`;
    }
    els.startBtn.disabled = n === 0;
  }

  els.setupSelect.addEventListener("change", renderCandidateCount);
  els.resultSelect.addEventListener("change", renderCandidateCount);
  if (els.includeReviewedCheck) els.includeReviewedCheck.addEventListener("change", renderCandidateCount);
  els.countRow.querySelectorAll(".quiz-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.countRow.querySelectorAll(".quiz-mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderCandidateCount();
    });
  });
  els.tickModeRow.querySelectorAll(".quiz-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      els.tickModeRow.querySelectorAll(".quiz-mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      els.tickModeHint.classList.remove("hidden"); els.tickModeHint.style.display = btn.dataset.tickmode === "real" ? "" : "none";
    });
  });
  els.startBtn.addEventListener("click", () => {
    const filters = getFilters();
    state.lastFilters = filters;
    const rows = getCandidateRows(filters);
    // Backtest-sourced trades already have everything (bars included)
    // from the run's report -- pre-seed the detail cache so
    // fetchDetail() below never tries to hit data/trades/<id>.json for
    // a synthetic id that doesn't exist there.
    if (state.source === "backtest") rows.forEach((r) => { state.detailCache[r.id] = r; });
    startQuiz(filters, rows.map((r) => r.id));
  });

  function renderHistoryPanel() {
    const history = loadHistory();
    if (els.heroStat) {
      if (history.length) {
        const totalTrades = history.reduce((s, h) => s + (h.count || 0), 0);
        els.heroStat.classList.remove("hidden"); els.heroStat.style.display = "";
        els.heroStat.innerHTML = `<div class="rs-num">${totalTrades}</div><div class="rs-lbl">trade${totalTrades === 1 ? "" : "s"} reviewed</div>`;
      } else {
        els.heroStat.classList.remove("hidden"); els.heroStat.style.display = "none";
      }
    }
    if (!history.length) {
      els.historyBox.innerHTML = `<div class="quiz-history-empty">No sessions yet — they'll show up here once you run one.</div>`;
      els.focusBox.innerHTML = "";
      return;
    }
    const recent = history.slice(-8).reverse();
    els.historyBox.innerHTML = recent.map((h) => {
      const t = h.entryTally || {};
      const chips = [];
      if (t.good) chips.push(`<span class="pill good">${t.good}</span>`);
      if (t.warn) chips.push(`<span class="pill warn">${t.warn}</span>`);
      if (t.bad) chips.push(`<span class="pill bad">${t.bad}</span>`);
      return `<div class="quiz-history-row">
        <span class="hr-date">${escapeHtml(h.date)}</span>
        <span class="hr-count">${h.count} trade${h.count === 1 ? "" : "s"}${h.entered != null ? ` · ${h.entered} entered` : ""}</span>
        <span class="hr-chips">${chips.join(" ") || `<span class="dim">—</span>`}</span>
      </div>`;
    }).join("");

    // Only from log-sourced sessions -- backtest run labels aren't real
    // journal setup_types, so linking them into journal.html would 404.
    const reviewTotals = {};
    history.filter((h) => h.source !== "backtest").forEach((h) => {
      Object.entries(h.toReview || {}).forEach(([k, v]) => { reviewTotals[k] = (reviewTotals[k] || 0) + v; });
    });
    const top = Object.entries(reviewTotals).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!top.length) { els.focusBox.innerHTML = ""; return; }
    els.focusBox.innerHTML = `<div class="panel-box-head" style="margin-bottom:8px;"><span class="title">Setups worth revisiting</span></div>
      <div class="quiz-focus-list">
        ${top.map(([setup, n]) => `<a class="quiz-focus-item" href="journal.html?setup=${encodeURIComponent(setup)}">
          <span>${escapeHtml(setup.replace(/_/g, " "))}</span>
          <span class="fi-count">×${n}</span>
        </a>`).join("")}
      </div>`;
  }

  // "X of Y reviewed" -- overall plus one row per journal setup_type,
  // each (other than the "All setups" summary row) with its own reset
  // button. Backtest trades don't factor in here at all: `state.index`
  // is always your real journal, same list populateSetupOptions() uses.
  function renderProgressPanel() {
    if (!els.progressList) return;
    const rows = state.index.filter((r) => r.id);
    if (!rows.length) {
      els.progressList.innerHTML = `<div class="quiz-history-empty">No logged trades yet.</div>`;
      if (els.resetAllBtn) els.resetAllBtn.classList.remove("hidden"); els.resetAllBtn.style.display = "none";
      return;
    }
    const reviewed = loadReviewed();
    const bySetup = {};
    rows.forEach((r) => {
      const key = r.setup_type || "unlabeled";
      (bySetup[key] || (bySetup[key] = [])).push(r.id);
    });
    const setupKeys = Object.keys(bySetup).sort();

    function rowHtml(label, ids, setupKey) {
      const total = ids.length;
      const done = ids.filter((id) => reviewed[id]).length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      const resetBtn = setupKey
        ? `<button type="button" class="rw-progress-reset" data-setup="${escapeHtml(setupKey)}">Reset</button>`
        : `<span class="rw-progress-reset-spacer"></span>`;
      return `<div class="rw-progress-row${setupKey ? "" : " rw-progress-overall"}">
        <span class="rw-progress-name">${escapeHtml(label)}</span>
        <div class="rw-progress-bar"><div class="rw-progress-fill" style="width:${pct}%"></div></div>
        <span class="rw-progress-count">${done} / ${total}</span>
        ${resetBtn}
      </div>`;
    }

    const allIds = rows.map((r) => r.id);
    els.progressList.innerHTML = rowHtml("All setups", allIds, null)
      + setupKeys.map((s) => rowHtml(s.replace(/_/g, " "), bySetup[s], s)).join("");

    if (els.resetAllBtn) {
      els.resetAllBtn.classList.remove("hidden"); els.resetAllBtn.style.display = allIds.some((id) => reviewed[id]) ? "" : "none";
    }

    els.progressList.querySelectorAll(".rw-progress-reset").forEach((btn) => {
      btn.addEventListener("click", () => resetReviewedFor(btn.dataset.setup, bySetup[btn.dataset.setup]));
    });
  }

  async function resetReviewedFor(setupKey, ids) {
    const label = setupKey === "unlabeled" ? "unlabeled setups" : setupKey.replace(/_/g, " ");
    const ok = await UIModal.confirm(
      `Reset rewind progress for "${label}"? ${ids.length} trade${ids.length === 1 ? "" : "s"} will be eligible to come up again.`,
      { title: "Reset progress?", tone: "danger", confirmLabel: "Reset" }
    );
    if (!ok) return;
    const map = loadReviewed();
    ids.forEach((id) => { delete map[id]; });
    saveReviewed(map);
    renderProgressPanel();
    renderCandidateCount();
  }

  if (els.resetAllBtn) {
    els.resetAllBtn.addEventListener("click", async () => {
      const ok = await UIModal.confirm(
        "Reset all rewind progress? Every logged trade will be eligible to come up again.",
        { title: "Reset all progress?", tone: "danger", confirmLabel: "Reset all" }
      );
      if (!ok) return;
      saveReviewed({});
      renderProgressPanel();
      renderCandidateCount();
    });
  }
  Object.assign(R, { getCandidateRows, getFilters, renderCandidateCount, renderHistoryPanel, renderProgressPanel });
})();
