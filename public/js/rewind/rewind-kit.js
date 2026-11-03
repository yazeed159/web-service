(function () {
  "use strict";
  const R = (window.RewindKit = window.RewindKit || {});

  // ==================================================================
  // Rewind — chart-reading practice built entirely from Supabase trades table +
  // data/trades/<id>.json — the same files journal.html/trade.html
  // already read. No backend, no chart_service.py call: every bar,
  // indicator, and lesson used here was already published for that
  // trade, so Rewind just crops what's shown and asks about it
  // before letting you see the rest. This is a practice tool, not a
  // graded test — there's no score, accuracy percentage, or streak,
  // just qualitative feedback (good / off / bad) on each call so you
  // can see your own tendencies.
  // ==================================================================

  const HISTORY_KEY = "rewind:history";
  const HISTORY_MAX = 50;

  // Set of trade ids (object map id -> true) already stepped through to
  // the reveal stage, mirrored to Supabase (user_kv) the same way
  // HISTORY_KEY is -- see loadReviewed/saveReviewed below. Only
  // log-sourced trades are tracked (backtest ids are synthetic and
  // regenerated per run, so "already seen" doesn't mean much there).
  // Kept out of `state` and always read fresh from localStorage, same
  // pattern as loadHistory(), so a KV.sync() callback updating
  // localStorage doesn't also need to keep an in-memory copy in sync.
  const REVIEWED_KEY = "rewind:reviewed";

  const els = {
    setupScreen: document.getElementById("quiz-setup-screen"),
    playScreen: document.getElementById("quiz-play-screen"),
    summaryScreen: document.getElementById("quiz-summary-screen"),
    setupSelect: document.getElementById("qf-setup"),
    resultSelect: document.getElementById("qf-result"),
    countRow: document.getElementById("qf-count-row"),
    sourceRow: document.getElementById("qf-source-row"),
    sourceHint: document.getElementById("qf-source-hint"),
    logFields: document.getElementById("qf-log-fields"),
    btFields: document.getElementById("qf-bt-fields"),
    btRunSelect: document.getElementById("qf-bt-run"),
    btHint: document.getElementById("qf-bt-hint"),
    blindCheck: document.getElementById("qf-blind"),
    includeReviewedCheck: document.getElementById("qf-include-reviewed"),
    progressList: document.getElementById("rw-progress-list"),
    resetAllBtn: document.getElementById("rw-reset-all-btn"),
    tickModeRow: document.getElementById("qf-tickmode-row"),
    tickModeHint: document.getElementById("qf-tickmode-hint"),
    candidateCount: document.getElementById("qf-candidate-count"),
    startBtn: document.getElementById("qf-start-btn"),
    historyBox: document.getElementById("quiz-history-box"),
    focusBox: document.getElementById("quiz-focus-box"),
    heroStat: document.getElementById("rw-hero-stat"),
    progressLabel: document.getElementById("qp-progress-label"),
    progressFill: document.getElementById("qp-progress-fill"),
    quitBtn: document.getElementById("qp-quit-btn"),
    card: document.getElementById("quiz-card"),
    recap: document.getElementById("qs-recap"),
    breakdown: document.getElementById("qs-breakdown"),
    review: document.getElementById("qs-review"),
    againBtn: document.getElementById("qs-again-btn"),
    reviewMissedBtn: document.getElementById("qs-review-missed-btn"),
    backToSetupBtn: document.getElementById("qs-setup-btn"),
  };

  const state = {
    index: [],
    detailCache: {},
    // "log" (default) reads your own your trades + their per-trade chart data (Supabase),
    // same as always. "backtest" instead pulls candidates from a saved
    // strategy run on chart_service.py -- see the "Blind backtester" field
    // group and normalizeBacktestTrade() below.
    source: "log",
    backtestRuns: [], // raw entries from GET /backtest/history
    backtestRunId: null,
    backtestReportCache: {}, // run id -> full /backtest/history/<id>/report response
    backtestTrades: [], // normalized, chart-ready trades for the currently selected run
    queue: [],
    qIndex: 0,
    blind: true,
    tickMode: "sim", // "sim" (synthesized, offline) or "real" (live prints from chart_service.py)
    playbackSpeed: 1, // 1x/2x/4x/8x/20x -- shared across the whole session
    results: [],
    lastFilters: null,
    current: null, // the in-progress question's working state
    recordedIds: new Set(), // trade ids already recorded this session — retries don't double-count
  };

  // ---------------------------------------------------------------
  // small shared helpers (same conventions as trade.js)
  // ---------------------------------------------------------------
// escapeHtml() now in utils.js (loads first on every page).
// toUnix() now in utils.js (loads first on every page).
  function fmtSignedPerShare(v) {
    if (!Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + fmtPrice(Math.abs(v));
  }
  // pnlPerShare() now in utils.js (loads first on every page).
  // Shared chart palette so "what actually happened" and "what you did"
  // are never the same color family: real fills stay green/red everywhere,
  // your own decisions (stop, chosen exit) live in a distinct blue/purple
  // family, and a genuine stop-out event gets its own amber so it doesn't
  // get mistaken for either group.
  const COLOR_REAL_ENTRY = "#2fd08a";
  const COLOR_REAL_EXIT = "#f2555a";
  const COLOR_YOUR_ENTRY = "#34c3d6";
  const COLOR_YOUR_STOP = "#5b93f0";
  const COLOR_YOUR_EXIT = "#b98cf2";
  const COLOR_STOP_EVENT = "#e8a94c";

  // IBKR's "Tiered" US stock commission schedule: $0.0035/share, with a
  // $0.35 floor and a 1%-of-trade-value ceiling per order. Applied once
  // per leg (entry fill, exit fill) -- a round-trip pays it twice. This
  // replaces naively scaling the logged trade's own commission per share,
  // which ignores the floor/ceiling and so understates small orders and
  // overstates low-priced/large ones.
  // ibkrTieredCommission() + IBKR_PER_SHARE/IBKR_MIN_PER_ORDER/
  // IBKR_MAX_PCT_OF_TRADE_VALUE now in utils.js (loads first on every page).
  // Bars are start-labeled minute candles; a floor-match (last bar whose
  // start time is <= the target time) finds the candle a given moment
  // actually falls inside — same rule trade.js uses for its markers.
  function barIndexAt(bars, unixTime) {
    let bestIdx = 0;
    for (let i = 0; i < bars.length; i++) {
      if (toUnix(bars[i].t) <= unixTime) bestIdx = i;
      else break;
    }
    return bestIdx;
  }
  // Baseline share count the size presets scale off of — not tied to what
  // was actually traded (that stays hidden until reveal), just a round
  // reference point so "size up / size down" means something concrete.
  const SIZE_BASELINE = 100;
  const SIZE_PRESETS = [
    { shares: 50, label: "Small", sub: "50 sh" },
    { shares: SIZE_BASELINE, label: "Standard", sub: "100 sh" },
    { shares: 200, label: "Large", sub: "200 sh" },
  ];
  const STOP_PRESETS = [
    { pct: 0.5, label: "Tight", sub: "0.5%" },
    { pct: 1, label: "Standard", sub: "1%" },
    { pct: 2, label: "Wide", sub: "2%" },
  ];

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- Stage A: entry decision ----------
  const BAR_SECONDS = 60; // data is 1-minute bars throughout
  Object.assign(R, { BAR_SECONDS, COLOR_REAL_ENTRY, COLOR_REAL_EXIT, COLOR_STOP_EVENT, COLOR_YOUR_ENTRY, COLOR_YOUR_EXIT, COLOR_YOUR_STOP, HISTORY_KEY, HISTORY_MAX, REVIEWED_KEY, SIZE_BASELINE, SIZE_PRESETS, STOP_PRESETS, barIndexAt, els, fmtSignedPerShare, shuffle, state });
})();
