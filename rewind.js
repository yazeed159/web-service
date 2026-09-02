(function () {
  "use strict";

  // ==================================================================
  // Rewind — chart-reading practice built entirely from data/trades.json +
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
    // "log" (default) reads your own data/trades.json + data/trades/<id>.json,
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
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function toUnix(t) {
    return Math.floor(new Date(String(t).replace(" ", "T") + "").getTime() / 1000);
  }
  function fmtPrice(v) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "—";
    const n = Number(v);
    return n.toFixed(Math.abs(n) < 5 ? 4 : 2);
  }
  function fmtSignedPerShare(v) {
    if (!Number.isFinite(v)) return "—";
    const sign = v >= 0 ? "+" : "-";
    return sign + "$" + fmtPrice(Math.abs(v));
  }
  function pnlPerShare(entry, exit, side) {
    return side === "short" ? entry - exit : exit - entry;
  }
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
  const IBKR_PER_SHARE = 0.0035;
  const IBKR_MIN_PER_ORDER = 0.35;
  const IBKR_MAX_PCT_OF_TRADE_VALUE = 0.01;
  function ibkrTieredCommission(shares, price) {
    if (!(shares > 0) || !(price > 0)) return 0;
    const raw = shares * IBKR_PER_SHARE;
    const ceiling = shares * price * IBKR_MAX_PCT_OF_TRADE_VALUE;
    return Math.max(IBKR_MIN_PER_ORDER, Math.min(raw, ceiling));
  }
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

  // ---------------------------------------------------------------
  // second-by-second replay — Polygon only gives us 1-min bars, so
  // there's no real tick feed to draw on. Instead we synthesize a
  // plausible intra-bar path: a deterministic (seeded, so a given
  // bar always replays the same way) walk from the previous close
  // through the bar's open, its high/low (order randomized per bar,
  // since either order is consistent with the same OHLC print), and
  // its close, with small random jitter layered on top so it doesn't
  // look like a robotic straight-line ramp. It's clearly labeled as
  // simulated in the UI — this is a practice aid, not real ticks.
  // Used for the checkpoint/exit stage only — the entry stage keeps
  // its forming-candle + live countdown badge look.
  // ---------------------------------------------------------------
  function seededRng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    };
  }
  const REPLAY_SECONDS = 60; // one sub-tick per real second of the 1-min bar

  function genSecondTicks(bar, prevClose, seed) {
    const n = REPLAY_SECONDS;
    const rng = seededRng(seed);
    const o = bar.o, h = bar.h, l = bar.l, c = bar.c;
    const start = Number.isFinite(prevClose) ? prevClose : o;
    const highFirst = rng() < 0.5;
    const waypoints = [
      { t: 0, p: start },
      { t: Math.round(n * 0.1), p: o },
      { t: Math.round(n * 0.42), p: highFirst ? h : l },
      { t: Math.round(n * 0.74), p: highFirst ? l : h },
      { t: n - 1, p: c },
    ];
    const range = Math.max(h - l, 0.0001);
    const jitterAmp = range * 0.07;
    const ticks = [];
    for (let s = 0; s < n; s++) {
      let a = waypoints[0], b = waypoints[waypoints.length - 1];
      for (let i = 0; i < waypoints.length - 1; i++) {
        if (s >= waypoints[i].t && s <= waypoints[i + 1].t) { a = waypoints[i]; b = waypoints[i + 1]; break; }
      }
      const span = Math.max(1, b.t - a.t);
      const frac = (s - a.t) / span;
      let price = a.p + (b.p - a.p) * frac;
      price += (rng() - 0.5) * 2 * jitterAmp;
      price = Math.min(h, Math.max(l, price));
      ticks.push(price);
    }
    ticks[n - 1] = c; // always land exactly on the bar's real close
    return ticks;
  }

  // ---------------------------------------------------------------
  // Real tick playback (opt-in, "Real ticks (from server)" on the setup
  // screen) — pulls actual trade prints for a bar's time window from
  // chart_service.py instead of synthesizing them. This calls a new
  // POST /tick-data route (added to chart_service.py alongside
  // /generate-chart and the /backtest/* routes — see README) rather than
  // anything Polygon's minute-bar aggregates give us directly.
  //
  // Request:  { symbol, start: <ISO>, end: <ISO> }  (start inclusive, end exclusive)
  // Response: { ticks: [ { t: <ISO or epoch ms>, p: <price> }, ... ] }
  //
  // Never rejects — any failure (no CHART_SERVICE_URL set, unreachable,
  // timeout, empty window) resolves to null so callers fall back to the
  // simulated path without extra error handling.
  // ---------------------------------------------------------------
  const CHART_SERVICE_FETCH_HEADERS = {
    "Content-Type": "application/json",
    // Same free-tier-ngrok workaround backtester.js/chat.js use.
    "ngrok-skip-browser-warning": "true",
  };
  function chartServiceBase() {
    const base = (window.CHART_SERVICE_URL || "").replace(/\/+$/, "");
    if (!base || base.includes("YOUR-NGROK-SUBDOMAIN")) return "";
    return base;
  }
  function fetchRealTicks(symbol, startUnix, endUnix) {
    const base = chartServiceBase();
    if (!base || !(endUnix > startUnix)) return Promise.resolve(null);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
    return fetch(`${base}/tick-data`, {
      method: "POST",
      headers: CHART_SERVICE_FETCH_HEADERS,
      signal: controller.signal,
      body: JSON.stringify({
        symbol,
        start: new Date(startUnix * 1000).toISOString(),
        end: new Date(endUnix * 1000).toISOString(),
      }),
    })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((data) => {
        const raw = data && Array.isArray(data.ticks) ? data.ticks : null;
        if (!raw || !raw.length) return null;
        const cleaned = raw
          .map((t) => ({
            time: Math.floor((typeof t.t === "number" ? (t.t > 2e12 ? t.t / 1e6 : t.t) : new Date(t.t).getTime()) / 1000),
            price: Number(t.p),
          }))
          .filter((t) => Number.isFinite(t.time) && Number.isFinite(t.price) && t.price > 0)
          .sort((a, b) => a.time - b.time);
        return cleaned.length >= 2 ? cleaned : null;
      })
      .catch(() => null)
      .finally(() => clearTimeout(timeout));
  }

  // ---------------------------------------------------------------
  // Blind backtester mode — practice generation instead of replay.
  //
  // Reuses the SAME saved-run machinery backtester.html / report.html
  // already talk to (GET /backtest/history and GET
  // /backtest/history/<id>/report on chart_service.py) rather than
  // inventing a new backend endpoint. A run's trades only carry `bars`
  // once they've been through the existing "Send to Journal" enrichment
  // step on the Backtester tab (chart_service.py's /enrich callback) --
  // trades without bars can't be charted here, so they're filtered out
  // up front and the setup screen tells you how many were usable.
  // ---------------------------------------------------------------

  function loadBacktestRuns() {
    const base = chartServiceBase();
    if (!base) {
      els.btRunSelect.innerHTML = `<option value="">Set CHART_SERVICE_URL in config.js first</option>`;
      els.btRunSelect.disabled = true;
      return;
    }
    els.btRunSelect.disabled = false;
    fetch(`${base}/backtest/history`, { headers: CHART_SERVICE_FETCH_HEADERS })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((entries) => {
        state.backtestRuns = Array.isArray(entries) ? entries : [];
        if (!state.backtestRuns.length) {
          els.btRunSelect.innerHTML = `<option value="">No saved runs yet — run one on the Backtester tab first</option>`;
          els.btRunSelect.disabled = true;
          return;
        }
        els.btRunSelect.innerHTML = `<option value="">Choose a run…</option>` + state.backtestRuns.map((e) => {
          const s = e.stats || {};
          const label = `${e.label || "(untitled run)"} — ${s.num_trades || 0} trades, ${s.win_rate != null ? s.win_rate.toFixed(0) + "%" : "—"} win`;
          return `<option value="${escapeHtml(e.id)}">${escapeHtml(label)}</option>`;
        }).join("");
      })
      .catch(() => {
        els.btRunSelect.innerHTML = `<option value="">Couldn't reach chart_service.py</option>`;
        els.btRunSelect.disabled = true;
      });
  }

  // Backend `/backtest/history/<id>/report` trades carry `date` (not
  // `trade_date`), a flat `better_entry_price`/`better_exit_price` (no
  // time -- see report.js's same normalization note), and no
  // side/lessons/walk_away_rule at all (the strategy is long-only and
  // never gets the full daily-pipeline verdict treatment, just whatever
  // the optional /enrich step attached). Map it onto the same shape
  // initQuestion()/goToReveal() already read from a real journal
  // trade.detail file, leaving the fields that don't exist for a
  // backtest trade out entirely rather than faking them -- reveal
  // already renders every one of those as an optional section.
  function normalizeBacktestTrade(t, run) {
    const runLabel = (run && run.label) || "backtest run";
    const setupType = (run && run.params && run.params.entry_mode) || runLabel;
    const id = `bt:${(run && run.id) || runLabel}:${t.symbol}:${t.date}:${t.entry_time}`.replace(/\s+/g, "_");
    return {
      id,
      _source: "backtest",
      _runLabel: runLabel,
      symbol: t.symbol,
      side: "long", // the backtester only ever simulates long breakout entries
      trade_date: t.date,
      entry_time: t.entry_time,
      exit_time: t.exit_time,
      entry_price: t.entry_price,
      exit_price: t.exit_price,
      shares: t.shares,
      win: !!t.win,
      pnl_before_comm: Number.isFinite(Number(t.pnl_dollars_gross)) ? Number(t.pnl_dollars_gross) : undefined,
      commission: Number.isFinite(Number(t.commission_total)) ? Number(t.commission_total) : undefined,
      pnl_after_comm: t.pnl_dollars,
      setup_type: setupType,
      bars: t.bars,
      verdict: t.verdict || null,
      lessons: [],
      better_entry_price: t.better_entry_price != null ? Number(t.better_entry_price) : null,
      better_exit_price: t.better_exit_price != null ? Number(t.better_exit_price) : null,
      walk_away_rule: null,
      _exitReason: t.exit_reason || null,
      _rMultiple: Number.isFinite(Number(t.r_multiple)) ? Number(t.r_multiple) : null,
    };
  }

  function loadBacktestRunTrades(runId) {
    state.backtestRunId = runId;
    state.backtestTrades = [];
    if (!runId) { renderCandidateCount(); return; }
    const base = chartServiceBase();
    els.btHint.style.display = "";
    els.btHint.innerHTML = "Loading this run's trades…";
    els.startBtn.disabled = true;

    const cached = state.backtestReportCache[runId];
    const p = cached ? Promise.resolve(cached) : fetch(`${base}/backtest/history/${encodeURIComponent(runId)}/report`, { headers: CHART_SERVICE_FETCH_HEADERS })
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((data) => { state.backtestReportCache[runId] = data; return data; });

    p.then((report) => {
      const run = state.backtestRuns.find((e) => e.id === runId) || { id: runId, label: report.label, params: report.params };
      const all = Array.isArray(report.trades) ? report.trades : [];
      const withCharts = all.filter((t) => Array.isArray(t.bars) && t.bars.length);
      state.backtestTrades = withCharts.map((t) => normalizeBacktestTrade(t, run));
      const missing = all.length - withCharts.length;
      els.btHint.innerHTML = withCharts.length
        ? `<b>${withCharts.length}</b> of ${all.length} trades in this run have charts available for practice.` +
          (missing ? ` ${missing} more haven't been sent through journal enrichment yet — use the Backtester tab's "Send to Journal" to add charts to them.` : "")
        : `None of this run's ${all.length} trade${all.length === 1 ? "" : "s"} have charts yet — go to the Backtester tab, open this run, and use "Send to Journal" to enrich it before practicing on it.`;
      renderCandidateCount();
    }).catch((err) => {
      els.btHint.innerHTML = `Couldn't load this run's trades (${escapeHtml(String(err.message))}).`;
      els.startBtn.disabled = true;
    });
  }

  function setSource(src) {
    state.source = src === "backtest" ? "backtest" : "log";
    els.sourceRow.querySelectorAll(".quiz-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.source === state.source));
    els.sourceHint.style.display = state.source === "backtest" ? "" : "none";
    els.logFields.style.display = state.source === "backtest" ? "none" : "";
    els.btFields.style.display = state.source === "backtest" ? "" : "none";
    if (state.source === "backtest") {
      if (!state.backtestRuns.length) loadBacktestRuns();
      loadBacktestRunTrades(els.btRunSelect.value || null);
    } else {
      renderCandidateCount();
    }
  }
  els.sourceRow.querySelectorAll(".quiz-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setSource(btn.dataset.source));
  });
  els.btRunSelect.addEventListener("change", () => loadBacktestRunTrades(els.btRunSelect.value || null));

  // Ticks for the checkpoint (mid-trade) bar — the full 60s window.
  function getCheckpointTicks(trade, bar, prevClose) {
    const simPrices = () => genSecondTicks(bar, prevClose, `${trade.id}:checkpoint`);
    if (state.tickMode !== "real") return Promise.resolve({ prices: simPrices(), real: false, fellBack: false });
    const start = toUnix(bar.t);
    return fetchRealTicks(trade.symbol, start, start + BAR_SECONDS).then((real) => (
      real ? { prices: real.map((t) => t.price), real: true, fellBack: false }
           : { prices: simPrices(), real: false, fellBack: true }
    ));
  }

  // The entry bar's full simulated path -- a pure function of the trade
  // (same seed every time), so the pre-entry tape and whatever's left of
  // the bar after you enter are always the SAME underlying walk, just
  // sliced at different points. That's what makes the post-entry
  // continuation (getEntryBarRemainderTicks below) pick up exactly where
  // the pre-entry tape (getEntryWatchTicks) left off instead of jumping
  // to an unrelated path.
  function simEntryBarTicks(trade, bar, prevClose) {
    return genSecondTicks(bar, prevClose, `${trade.id}:entrywatch`);
  }
  // How many ticks (1..REPLAY_SECONDS) are visible/elapsed by a given
  // point into the bar -- shared by the pre-entry tape's cutoff and the
  // default (un-watched) entry's implied tick index, so both agree on
  // exactly which tick your fill happened on.
  function entryTickCount(secondsIntoBar) {
    const frac = Math.max(0, Math.min(1, secondsIntoBar / BAR_SECONDS));
    return Math.max(1, Math.round(frac * REPLAY_SECONDS));
  }

  // Ticks for the "watch it print in" replay on the entry stage — only
  // the window from the bar's open up to the actual fill instant, so
  // real mode never leaks anything past the moment you're deciding at
  // (and sim mode is truncated + pinned to the real fill for the same
  // reason — see buildFormingBar above).
  function getEntryWatchTicks(trade, bar, prevClose, secondsIntoBar) {
    const simPrices = () => {
      const full = simEntryBarTicks(trade, bar, prevClose);
      const cut = entryTickCount(secondsIntoBar);
      const t = full.slice(0, cut);
      t[t.length - 1] = trade.entry_price;
      return t;
    };
    if (state.tickMode !== "real") return Promise.resolve({ prices: simPrices(), real: false, fellBack: false });
    const start = toUnix(bar.t);
    const end = Math.max(start + 1, start + Math.round(secondsIntoBar));
    return fetchRealTicks(trade.symbol, start, end).then((real) => (
      real ? { prices: real.map((t) => t.price), real: true, fellBack: false }
           : { prices: simPrices(), real: false, fellBack: true }
    ));
  }

  // Continues the SAME entry bar's tape from the tick you actually
  // entered on through to the bar's close -- this is what used to be
  // skipped entirely (the watch stage jumped straight to the *next*
  // bar), cutting off however much of the entry candle was still left
  // to play. entryTickIdx is 0-based into the REPLAY_SECONDS space (the
  // same index space getEntryWatchTicks/onAct use), so slicing the same
  // deterministic path one tick past it picks up exactly where your
  // fill happened, with no jump.
  function getEntryBarRemainderTicks(trade, bar, prevClose, entryTickIdx) {
    const simPrices = () => {
      const full = simEntryBarTicks(trade, bar, prevClose);
      full[entryTickIdx] = trade.entry_price; // anchor to your actual fill so there's no seam
      return full.slice(entryTickIdx + 1);
    };
    if (state.tickMode !== "real") return Promise.resolve({ prices: simPrices(), real: false, fellBack: false });
    const barStart = toUnix(bar.t);
    const start = barStart + entryTickIdx + 1;
    const end = barStart + BAR_SECONDS;
    if (end <= start) return Promise.resolve({ prices: [], real: false, fellBack: false });
    return fetchRealTicks(trade.symbol, start, end).then((real) => (
      real ? { prices: real.map((t) => t.price), real: true, fellBack: false }
           : { prices: simPrices(), real: false, fellBack: true }
    ));
  }

  // Speed choices for the tick playback -- 1x is real time (one tick per
  // real second), so a full 1-min bar takes 60 real seconds unless you
  // speed it up.
  const REPLAY_SPEEDS = [1, 2, 4, 8, 20];
  function fmtClock(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  // Auto-plays through `ticks` at real-time pace by default (one tick per
  // real second at 1x -- a synthesized bar's 60 ticks take 60 real seconds
  // unless sped up), updating a live price readout. `actions` is a list of
  // {id, label, kbd, cls} buttons that are clickable at any point during
  // playback; clicking one locks in the current tick's price and stops
  // playback. If nobody clicks before the ticks run out, `opts.onExhausted`
  // runs if given, else `defaultActionId` fires automatically. A speed
  // picker (1x-20x) is rendered in the panel; changing it mid-playback just
  // changes the pace of ticks still to come, it never skips any. Returns
  // { stop } to let a caller tear it down early (e.g. the quiz question
  // changes underneath it).
  function runSecondReplay(container, ticks, opts) {
    const baseTickMs = opts.tickMs || 1000; // 1 tick = 1 real second at 1x
    const unitLabel = opts.unitLabel || "second";
    const tag = opts.tag || "simulated seconds";
    const tagCls = opts.tagCls ? ` ${opts.tagCls}` : "";
    // hideProgress drops the sweeping loading-style track + the "X elapsed /
    // Y left" line from this panel entirely -- used once you're actually in
    // a trade, where opts.liveClockEl (a header element) carries that same
    // elapsed/remaining info instead, framed as a live ticking clock rather
    // than a bar that looks like something is still loading.
    const hideProgress = !!opts.hideProgress;
    container.innerHTML = `
      <div class="quiz-replay-panel">
        <div class="quiz-replay-top">
          <button type="button" class="quiz-speed-btn quiz-pause-btn" id="qz-replay-pause">&#10074;&#10074; Pause</button>
          <div class="quiz-speed-row" id="qz-replay-speeds">
            ${REPLAY_SPEEDS.map((sp) => `<button type="button" class="quiz-speed-btn${sp === state.playbackSpeed ? " active" : ""}" data-speed="${sp}">${sp}&times;</button>`).join("")}
          </div>
          <span class="quiz-replay-tag${tagCls}">${escapeHtml(tag)}</span>
        </div>
        ${opts.fallbackNote ? `<div class="quiz-replay-fallback">${escapeHtml(opts.fallbackNote)}</div>` : ""}
        ${hideProgress ? "" : `<div class="quiz-replay-track"><div class="quiz-replay-bar" id="qz-replay-fill"></div></div>`}
        <div class="quiz-replay-row" id="qz-replay-actions"></div>
        ${hideProgress ? "" : `<div class="quiz-replay-sec" id="qz-replay-sec" style="margin-top:8px;"></div>`}
      </div>
    `;
    const pauseBtn = container.querySelector("#qz-replay-pause");
    const fillEl = container.querySelector("#qz-replay-fill");
    const secEl = container.querySelector("#qz-replay-sec");
    const actionsEl = container.querySelector("#qz-replay-actions");
    const speedsEl = container.querySelector("#qz-replay-speeds");
    const liveClockEl = opts.liveClockEl || null;
    (opts.actions || []).forEach((a) => {
      const btn = document.createElement("button");
      btn.id = `qz-${a.id}`;
      btn.className = `quiz-answer-btn ${a.cls || ""}`;
      btn.innerHTML = `${escapeHtml(a.label)}${a.kbd ? ` <span class="kbd">${escapeHtml(a.kbd)}</span>` : ""}`;
      btn.addEventListener("click", () => finish(a.id));
      actionsEl.appendChild(btn);
    });
    speedsEl.querySelectorAll(".quiz-speed-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.playbackSpeed = Number(btn.dataset.speed) || 1;
        speedsEl.querySelectorAll(".quiz-speed-btn").forEach((b) => b.classList.toggle("active", b === btn));
        // Re-arm the wait with the new pace right away instead of letting
        // the slower/faster old delay run out first. Skipped while paused
        // -- resuming (not the speed click) is what should restart ticks.
        if (!done && !paused) { clearTimeout(timer); scheduleNext(); }
      });
    });
    // Pause just stops the timer from re-arming -- the tape holds exactly
    // where it is (last painted candle/price stays on screen) so you can
    // stop and think without losing your place. Action buttons (Enter,
    // Exit, etc.) stay live while paused, since deciding is the point.
    let paused = false;
    pauseBtn.addEventListener("click", () => {
      if (done) return;
      paused = !paused;
      pauseBtn.innerHTML = paused ? "&#9654; Resume" : "&#10074;&#10074; Pause";
      pauseBtn.classList.toggle("active", paused);
      if (paused) clearTimeout(timer);
      else scheduleNext();
    });

    // If given a live chart + the raw bar being replayed, push a real
    // forming candle that grows/wicks with each tick instead of just
    // updating the text readout -- same forming-candle look/colors the
    // entry stage uses for its own partial bar.
    const liveChart = opts.chartHandle && opts.bar ? opts.chartHandle : null;
    const barTime = liveChart ? toUnix(opts.bar.t) : null;
    // seedHigh/seedLow let a caller continue a candle that already has a
    // body (e.g. resuming the entry bar right after your fill) instead of
    // always resetting the wick back down to the bar's open -- without
    // them this defaults to the old flat-at-open start.
    let runningHigh = liveChart ? (opts.seedHigh != null ? opts.seedHigh : opts.bar.o) : null;
    let runningLow = liveChart ? (opts.seedLow != null ? opts.seedLow : opts.bar.o) : null;
    // volStartFrac lets volume continue accumulating from where an
    // earlier segment of the same bar left off, instead of restarting
    // the fraction from 0 for a partial tick set.
    const volStartFrac = opts.volStartFrac || 0;
    function paintCandle(idx) {
      if (!liveChart) return;
      const price = ticks[idx];
      if (price > runningHigh) runningHigh = price;
      if (price < runningLow) runningLow = price;
      liveChart.series.update({
        time: barTime, open: opts.bar.o, high: runningHigh, low: runningLow, close: price,
        color: "rgba(232,169,76,0.55)", borderColor: "#e8a94c", wickColor: "#e8a94c",
      });
      if (liveChart.volSeries) {
        const localFrac = (idx + 1) / ticks.length;
        const frac = volStartFrac + localFrac * (1 - volStartFrac);
        liveChart.volSeries.update({ time: barTime, value: Math.round((opts.bar.v || 0) * frac), color: "rgba(232,169,76,0.4)" });
      }
    }
    if (liveChart) {
      // Seed a zero-range candle before ticking so there's room for it on
      // the timescale, then make sure that room is actually visible.
      paintCandle(0);
      // Only snap/fit the visible range on demand (opts.autoFit === false
      // skips it) -- doing this on every bar of a multi-bar watch session
      // would yank the chart back to a full-fit view each time and wipe
      // out any zoom/pan the moment a new candle starts.
      if (opts.autoFit !== false) {
        try { liveChart.chart.timeScale().fitContent(); } catch (e) {}
      }
    }

    let i = 0, done = false, timer = null;
    // Some real fills happen just a couple seconds into a bar -- with a
    // straight 1 tick = 1 real second pace that's barely any time to
    // decide. minTotalMs (when given) stretches the per-tick delay so the
    // whole tape takes at least that long at 1x, without changing what's
    // shown -- it's the same ticks, just paced slower when there are few
    // of them. The speed picker still multiplies on top of this floor.
    const minTotalMs = opts.minTotalMs || 0;
    const effectiveBaseTickMs = minTotalMs > 0 ? Math.max(baseTickMs, minTotalMs / ticks.length) : baseTickMs;
    function currentTickMs() { return Math.max(20, Math.round(effectiveBaseTickMs / (state.playbackSpeed || 1))); }
    function paint() {
      if (unitLabel === "second") {
        // Real-time framing: how far into the candle we are and how much
        // is left, so it's obvious when the candle is about to close.
        const elapsed = i + 1, remaining = ticks.length - elapsed;
        if (secEl) secEl.textContent = `${fmtClock(elapsed)} elapsed \u00b7 ${fmtClock(remaining)} left on this candle`;
        // Same elapsed/remaining info, but ticking live up in the header
        // like an actual trading clock instead of a bar sweeping across a
        // panel -- this is what a live position should feel like.
        if (liveClockEl) {
          liveClockEl.innerHTML = `<span class="quiz-live-dot"></span>${fmtClock(elapsed)} <span class="dim" style="font-weight:400;">of ${fmtClock(ticks.length)} on this candle</span>`;
        }
      } else {
        // Real server ticks aren't evenly spaced in time, so a plain
        // count is more honest than a clock here.
        if (secEl) secEl.textContent = `${unitLabel} ${i + 1} of ${ticks.length}`;
        if (liveClockEl) liveClockEl.innerHTML = `<span class="quiz-live-dot"></span>${unitLabel} ${i + 1} of ${ticks.length}`;
      }
      if (fillEl) fillEl.style.width = `${((i + 1) / ticks.length) * 100}%`;
      paintCandle(i);
    }
    function finish(actionId) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
      pauseBtn.disabled = true;
      opts.onAct && opts.onAct(actionId, i, ticks[i]);
    }
    // Lets a caller watch every printed tick without waiting for the replay
    // to finish -- used to auto-trigger a stop-loss the instant price
    // crosses it, same as it would in a real fill.
    function checkTick() { if (opts.onTick) opts.onTick(ticks[i], i); }
    function scheduleNext() { timer = setTimeout(advance, currentTickMs()); }
    function advance() {
      if (done) return;
      if (i >= ticks.length - 1) {
        // onExhausted lets a caller move on (e.g. to the next bar) instead
        // of forcing a default action once the tape runs out -- falls back
        // to the old auto-fire-defaultActionId behavior when not given.
        if (opts.onExhausted) { done = true; actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true)); pauseBtn.disabled = true; opts.onExhausted(); }
        else finish(opts.defaultActionId);
        return;
      }
      i++;
      paint();
      checkTick();
      scheduleNext();
    }
    paint();
    checkTick();
    scheduleNext();
    return {
      stop: () => { done = true; clearTimeout(timer); },
      // Lets a caller outside this closure (e.g. a persistent partial-exit
      // button row that isn't rebuilt every tick) read the price/index of
      // whatever tick is currently on screen at the moment it's clicked.
      getPrice: () => ticks[i],
      getIndex: () => i,
    };
  }

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

  // ---------------------------------------------------------------
  // boot: load the index, populate the setup screen
  // ---------------------------------------------------------------
  window.fetchTradesIndex()
    .then((rows) => {
      state.index = Array.isArray(rows) ? rows : [];
      populateSetupOptions();
      renderCandidateCount();
      renderHistoryPanel();
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
      tickMode: tickBtn ? tickBtn.dataset.tickmode : "sim",
    };
  }

  // Shared win/loss/flagged predicate -- works on both a real journal
  // index row (data/trades.json) and a normalized backtest trade, since
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
    return state.index.filter((r) => {
      if (!r.id) return false;
      if (filters.setup && r.setup_type !== filters.setup) return false;
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
      els.tickModeHint.style.display = btn.dataset.tickmode === "real" ? "" : "none";
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
        els.heroStat.style.display = "";
        els.heroStat.innerHTML = `<div class="rs-num">${totalTrades}</div><div class="rs-lbl">trade${totalTrades === 1 ? "" : "s"} reviewed</div>`;
      } else {
        els.heroStat.style.display = "none";
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

  // ---------------------------------------------------------------
  // chart building — a slimmed-down version of trade.js's chart, since
  // the quiz only needs candles + volume + VWAP/EMA overlays, cropped
  // to whatever the current stage should reveal.
  // ---------------------------------------------------------------
  // A touch shorter on narrow phones so the chart doesn't eat the whole
  // screen before you've even reached the prompt/buttons below it --
  // still tall enough to read candle shapes, just not the full desktop
  // height. Checked at build time only (not on resize/rotate).
  function mobileChartHeight(base) {
    return window.innerWidth <= 480 ? Math.round(base * 0.8) : base;
  }
  function buildChart(el, bars, opts) {
    opts = opts || {};
    if (typeof LightweightCharts === "undefined") {
      // The charting library loads from an external CDN with `defer`, so on
      // a slow connection it's possible to reach this before it's finished.
      // Fail with a clear, actionable message instead of a bare
      // "LightweightCharts is not defined" crash that leaves the card stuck.
      throw new Error("Chart library hasn't finished loading yet — wait a moment and try again.");
    }
    el.innerHTML = "";
    const candleData = bars.map((b) => {
      const point = { time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c };
      if (b._forming) { point.color = "rgba(232,169,76,0.55)"; point.borderColor = "#e8a94c"; point.wickColor = "#e8a94c"; }
      return point;
    });
    const volData = bars.map((b) => ({
      time: toUnix(b.t), value: b.v,
      color: b._forming ? "rgba(232,169,76,0.4)" : (b.c >= b.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)"),
    }));
    const vwapData = bars.filter((b) => b.vwap != null).map((b) => ({ time: toUnix(b.t), value: b.vwap }));
    const ema9Data = bars.filter((b) => b.ema9 != null).map((b) => ({ time: toUnix(b.t), value: b.ema9 }));
    const ema20Data = bars.filter((b) => b.ema20 != null).map((b) => ({ time: toUnix(b.t), value: b.ema20 }));

    const commonOpts = {
      layout: { background: { color: "transparent" }, textColor: "#8b98a5" },
      grid: { vertLines: { color: "#1c2127" }, horzLines: { color: "#1c2127" } },
      rightPriceScale: { borderColor: "#232830", minimumWidth: 88 },
      timeScale: { borderColor: "#232830", timeVisible: true, secondsVisible: false },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    };
    const chart = LightweightCharts.createChart(el, { ...commonOpts, width: el.clientWidth, height: mobileChartHeight(opts.height || 380) });
    const series = chart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
    });
    series.setData(candleData);
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.12, bottom: 0.2 } });

    const volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volSeries.setData(volData);

    const vwapSeries = chart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    vwapSeries.setData(vwapData);
    const ema9Series = chart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ema9Series.setData(ema9Data);
    const ema20Series = chart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    ema20Series.setData(ema20Data);

    if (opts.markers && opts.markers.length) series.setMarkers(opts.markers);
    const priceLineRefs = {};
    (opts.priceLines || []).forEach((pl, i) => {
      priceLineRefs[pl.key || i] = series.createPriceLine(pl);
    });

    chart.timeScale().fitContent();
    let ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(() => { try { chart.applyOptions({ width: el.clientWidth }); } catch (e) {} });
      ro.observe(el);
    }
    return { chart, series, volSeries, vwapSeries, ema9Series, ema20Series, priceLineRefs, resizeObserver: ro };
  }
  function teardownChart(handle) {
    if (!handle) return;
    try { if (handle.resizeObserver) handle.resizeObserver.disconnect(); } catch (e) {}
    try { if (handle.pointerRo) handle.pointerRo.disconnect(); } catch (e) {}
    try { if (handle.eodRo) handle.eodRo.disconnect(); } catch (e) {}
    try { handle.chart.remove(); } catch (e) {}
  }

  // Pushes a bar's final OHLC/volume/overlay values onto an already-built
  // chart in place -- used when a watch-stage bar finishes playing so the
  // just-completed candle switches from the orange "forming" look to its
  // normal closed color without tearing down and rebuilding the chart
  // (which is what used to reset the view every ~4.5s).
  function finalizeBarOnChart(chartHandle, bar) {
    if (!chartHandle) return;
    const t = toUnix(bar.t);
    try {
      chartHandle.series.update({ time: t, open: bar.o, high: bar.h, low: bar.l, close: bar.c });
      if (chartHandle.volSeries) {
        chartHandle.volSeries.update({ time: t, value: bar.v, color: bar.c >= bar.o ? "rgba(47,208,138,0.4)" : "rgba(242,85,90,0.4)" });
      }
      if (bar.vwap != null && chartHandle.vwapSeries) chartHandle.vwapSeries.update({ time: t, value: bar.vwap });
      if (bar.ema9 != null && chartHandle.ema9Series) chartHandle.ema9Series.update({ time: t, value: bar.ema9 });
      if (bar.ema20 != null && chartHandle.ema20Series) chartHandle.ema20Series.update({ time: t, value: bar.ema20 });
    } catch (e) { /* chart already torn down */ }
  }

  // Vertical marker pinned to the last bar we actually have data for, so
  // during bar-by-bar playback it's obvious how much chart is left instead
  // of only finding out once the question ends.
  function attachEndOfDataLine(container, chartHandle, endTime) {
    const { chart } = chartHandle;
    container.style.position = container.style.position || "relative";
    const line = document.createElement("div");
    line.className = "quiz-eod-line";
    line.innerHTML = `<span class="quiz-eod-label">End of data</span>`;
    container.appendChild(line);
    function reposition() {
      try {
        const x = chart.timeScale().timeToCoordinate(endTime);
        if (x == null) { line.style.display = "none"; return; }
        line.style.display = "block";
        line.style.left = `${x}px`;
      } catch (e) { line.style.display = "none"; }
    }
    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(reposition); ro.observe(container); }
    chart.timeScale().subscribeVisibleLogicalRangeChange(reposition);
    reposition();
    requestAnimationFrame(reposition);
    setTimeout(reposition, 0);
    chartHandle.eodRo = ro;
  }

  // ---------------------------------------------------------------
  // exact-price pointer triangles -- the same look used on trade.html,
  // instead of lightweight-charts' native markers (which snap to a fixed
  // offset above/below the candle's own high/low, not the exact fill
  // price). A pointer's tip sits exactly where its price line is, so
  // there's only ever one thing marking a given price.
  //
  // Each pointer also owns a hover/tap tooltip with the exact price --
  // same behavior as trade.html. The tooltip is appended to `container`
  // directly rather than the (clipped) overlay, so it's never cut off at
  // the chart's edge.
  // ---------------------------------------------------------------
  const POINTER_H = 9;
  function attachPointers(container, chartHandle, pointerDefs) {
    const { chart, series } = chartHandle;
    container.style.position = "relative";
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:2;";
    container.appendChild(overlay);

    const pointers = pointerDefs.map((p) => {
      const el = document.createElement("div");
      el.style.cssText = `
        position:absolute; width:0; height:0; pointer-events:auto;
        border-left:6px solid transparent; border-right:6px solid transparent;
        filter: drop-shadow(0 0 1.5px #0b0d10) drop-shadow(0 0 1.5px #0b0d10);
        border-top:${p.above ? `${POINTER_H}px solid ${p.color}` : "0"};
        border-bottom:${p.above ? "0" : `${POINTER_H}px solid ${p.color}`};
      `;
      overlay.appendChild(el);

      let tooltip = null;
      if (p.tooltip) {
        tooltip = document.createElement("div");
        tooltip.className = "pointer-tooltip";
        tooltip.dataset.open = "0";
        tooltip.style.cssText = `
          position:absolute; display:none; width:180px; max-width:60vw;
          background:#181b22; border:1px solid ${p.color}; border-radius:8px;
          padding:8px 10px; font-size:12px; line-height:1.5; color:#eceef2;
          box-shadow:0 6px 20px rgba(0,0,0,.45); z-index:5; pointer-events:none;
        `;
        tooltip.textContent = p.tooltip;
        container.appendChild(tooltip);

        const openTooltip = () => {
          container.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
          tooltip.dataset.open = "1";
          tooltip.style.display = "block";
          reposition();
        };
        const closeTooltip = () => { tooltip.dataset.open = "0"; tooltip.style.display = "none"; };
        el.addEventListener("mouseenter", openTooltip);
        el.addEventListener("mouseleave", closeTooltip);
        // Tap-to-toggle so touch users (no mouseenter) can still reach it.
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (tooltip.dataset.open === "1") closeTooltip(); else openTooltip();
        });
      }

      return { ...p, el, tooltip };
    });

    // When two pointers land on (near enough) the same bar and price --
    // e.g. you exited right on the real exit bar, or your stop got hit
    // exactly at another marked level -- they'd stack exactly on top of
    // each other, and whichever was appended last would fully cover (and
    // block hover/tap on) the one underneath. Fan same-side clusters out
    // horizontally so every pointer stays visible and reachable.
    const CLUSTER_PX = 10;
    const FAN_PX = 14;
    function reposition() {
      try {
        const computed = pointers.map((p) => ({
          p,
          x: chart.timeScale().timeToCoordinate(p.time),
          y: series.priceToCoordinate(p.price),
        }));
        const placed = [];
        computed.forEach((item) => {
          if (item.x == null || item.y == null) { item.offsetX = 0; return; }
          const mates = placed.filter((u) => u.p.above === item.p.above && Math.abs(u.x - item.x) < CLUSTER_PX && Math.abs(u.y - item.y) < CLUSTER_PX);
          item.offsetX = mates.length * FAN_PX;
          placed.push(item);
        });
        computed.forEach(({ p, x, y, offsetX }) => {
          if (x == null || y == null) {
            p.el.style.display = "none";
            if (p.tooltip) { p.tooltip.style.display = "none"; p.tooltip.dataset.open = "0"; }
            return;
          }
          const px = x + (offsetX || 0);
          p.el.style.display = "block";
          p.el.style.left = `${px}px`;
          const pointerTop = p.above ? y - POINTER_H : y;
          p.el.style.top = `${pointerTop}px`;
          p.el.style.transform = "translateX(-50%)";
          if (p.tooltip && p.tooltip.dataset.open === "1") {
            p.tooltip.style.left = `${px + 8}px`;
            p.tooltip.style.top = `${p.above ? pointerTop - 8 : pointerTop + POINTER_H + 8}px`;
            p.tooltip.style.transform = p.above ? "translateY(-100%)" : "none";
          }
        });
      } catch (e) { /* chart already torn down */ }
    }

    let ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(reposition); ro.observe(container); }
    chart.timeScale().subscribeVisibleLogicalRangeChange(reposition);
    reposition();
    requestAnimationFrame(reposition);
    setTimeout(reposition, 0);
    chartHandle.pointerRo = ro;
  }

  // Any click outside a pointer tooltip closes whichever one is pinned
  // open -- otherwise a tapped-open tooltip would just sit there covering
  // the chart. Registered once here (not inside attachPointers) so it
  // doesn't pile up a duplicate listener on every question.
  document.addEventListener("click", () => {
    document.querySelectorAll(".pointer-tooltip").forEach((t) => { t.dataset.open = "0"; t.style.display = "none"; });
  });

  // ---------------------------------------------------------------
  // quiz flow
  // ---------------------------------------------------------------
  function startQuiz(filters, ids) {
    state.queue = shuffle(ids).slice(0, filters.count > 0 ? filters.count : ids.length);
    state.qIndex = 0;
    state.blind = filters.blind;
    state.tickMode = filters.tickMode === "real" ? "real" : "sim";
    state.results = [];
    state.recordedIds = new Set();
    els.setupScreen.style.display = "none";
    els.summaryScreen.style.display = "none";
    els.playScreen.style.display = "";
    loadQuestion();
  }

  function fetchDetail(id) {
    if (state.detailCache[id]) return Promise.resolve(state.detailCache[id]);
    // Backtest-sourced trades are always pre-seeded into detailCache
    // before the queue is built (see the start-button handler above) --
    // there's no data/trades/<id>.json to fall back to for a synthetic
    // "bt:..." id, so a cache miss here means something's wrong rather
    // than something to fetch.
    if (state.source === "backtest") return Promise.reject(new Error("This practice setup is no longer available."));
    return window.fetchTradeDetail(id)
      .then((trade) => { state.detailCache[id] = trade; return trade; });
  }

  function updateHeaderChrome() {
    els.progressLabel.textContent = `Trade ${Math.min(state.qIndex + 1, state.queue.length)} / ${state.queue.length}`;
    els.progressFill.style.width = `${(state.qIndex / state.queue.length) * 100}%`;
  }

  // Anything past the initial fetch runs inside click handlers, setInterval
  // ticks, or promise callbacks that a plain try/catch around the initial
  // fetch can't see -- a thrown error there is normally swallowed silently
  // by the browser, leaving whatever was on screen (often mid-action, with
  // its buttons already disabled) permanently stuck with nothing to click.
  // Every risky entry point below is wrapped so a failure instead lands
  // here: a clear message plus a way to move on.
  function showStageError(err) {
    if (state.current && state.current.replayHandle) { state.current.replayHandle.stop(); state.current.replayHandle = null; }
    els.card.innerHTML = `<div class="empty-state">Something went wrong showing this trade (${escapeHtml(String((err && err.message) || err))}). <button class="btn-advanced" id="qz-skip">Skip this question</button></div>`;
    const skip = document.getElementById("qz-skip");
    if (skip) skip.addEventListener("click", () => { state.qIndex++; loadQuestion(); });
  }

  function loadQuestion() {
    if (state.current && state.current.replayHandle) state.current.replayHandle.stop();
    updateHeaderChrome();
    if (state.qIndex >= state.queue.length) { finishQuiz(); return; }
    els.card.innerHTML = `<div class="loading-line">Loading chart…</div>`;
    fetchDetail(state.queue[state.qIndex])
      .then((trade) => initQuestion(trade))
      .catch(showStageError);
  }

  function initQuestion(trade) {
    const bars = Array.isArray(trade.bars) ? trade.bars : [];
    const side = trade.side === "short" ? "short" : "long";
    const entryUnix = toUnix(`${trade.trade_date} ${trade.entry_time}`);
    const exitUnix = toUnix(`${trade.trade_date} ${trade.exit_time}`);
    let entryIdx = barIndexAt(bars, entryUnix);
    let exitIdx = barIndexAt(bars, exitUnix);
    if (exitIdx <= entryIdx) exitIdx = Math.min(bars.length - 1, entryIdx + 1);

    state.current = {
      trade, bars, side, entryIdx, exitIdx,
      stage: "entry",
      entered: null,
      userEntryPrice: null,
      stopPrice: null,
      stoppedOutEarly: false, // set true the instant a live tick crosses your stop, whenever that happens
      stopOutIdx: null, // bar index the stop got hit in
      entrySecondsIntoBar: null, // how far into the entry bar the real fill happened
      entryBarPrevClose: null, // prior bar's close, feeds the entry bar's deterministic sim path
      entryTickIdx: null, // which tick (0..REPLAY_SECONDS-1) you actually entered on
      watchIdx: null, // bar currently playing in the post-entry watch stage
      checkpointAction: null, // "exit" once you click Exit; stays null if you watch through to the end of the data
      exitBarIdx: null, // bar index your last (fully-flattening) exit tick fell in
      chartHandle: null,
      replayHandle: null,
      userExitPrice: null,
      exitSecond: null,
      userShares: SIZE_BASELINE,
      // Scaling out: each entry is one closed tranche of the ORIGINAL
      // position -- { fraction, price, barIdx, tickIdx, tag }, tag is
      // "sell" (you clicked a Sell button), "stop" (your stop got hit), or
      // "held" (whatever was still open when the data ran out, synthesized
      // at reveal time). Fractions across the whole array always sum to 1
      // once the trade is fully closed. remainingFraction is how much of
      // the original size is still open right now.
      exits: [],
      remainingFraction: 1,
    };
    renderEntryStage();
  }

  // Puts the current question back exactly the way it looked when it first
  // loaded — same trade, back to the entry decision — so you can have
  // another go without leaving the quiz or affecting your queue position.
  function retryCurrentQuestion() {
    const c = state.current;
    if (!c) return;
    if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; }
    initQuestion(c.trade);
  }

  function displayLabel(trade) {
    return state.blind
      ? { name: `Setup #${state.qIndex + 1}`, date: "" }
      : { name: trade.symbol, date: trade.trade_date };
  }

  // ---------- Stage A: entry decision ----------
  const BAR_SECONDS = 60; // data is 1-minute bars throughout

  // The bar the entry fill happened inside is only *partially* known at
  // decision time, and that includes the fill price itself: the whole
  // point of "Watch it print in" is to find out where price actually
  // goes, so the chart you see before you've decided (or before you've
  // pressed watch) can't already show a candle reaching the real fill --
  // that would spoil the tape before it plays. So the default view is
  // just a flat, just-opened candle with no body yet. The entry prompt
  // still states the current price in text (you need that to decide),
  // but the chart's shape is only revealed once you've watched it print
  // or made your call -- see pushFormingBarPrice below.
  function buildFormingBar(fullBar) {
    return {
      t: fullBar.t, o: fullBar.o, h: fullBar.o, l: fullBar.o, c: fullBar.o, v: 0,
      vwap: fullBar.vwap, ema9: fullBar.ema9, ema20: fullBar.ema20,
      _forming: true,
    };
  }
  // Reveals the forming candle's body up to a given price, clamped so it
  // still never leaks the bar's real (future-relative-to-this-point)
  // extremes -- same clamp buildFormingBar used to apply up front. Used
  // once you've actually entered (or watched the tape) without a live
  // replay already having painted it tick by tick.
  function pushFormingBarPrice(chartHandle, bar, price, secondsIntoBar) {
    if (!chartHandle) return;
    const frac = Math.max(0, Math.min(1, secondsIntoBar / BAR_SECONDS));
    try {
      chartHandle.series.update({
        time: toUnix(bar.t), open: bar.o, high: Math.max(bar.o, price), low: Math.min(bar.o, price), close: price,
        color: "rgba(232,169,76,0.55)", borderColor: "#e8a94c", wickColor: "#e8a94c",
      });
      if (chartHandle.volSeries) {
        chartHandle.volSeries.update({ time: toUnix(bar.t), value: Math.round((bar.v || 0) * frac), color: "rgba(232,169,76,0.4)" });
      }
    } catch (e) { /* chart already torn down */ }
  }

  function renderEntryStage() {
    const c = state.current;
    const trade = c.trade;
    const label = displayLabel(trade);
    const entryBar = c.bars[c.entryIdx];
    const entryUnix = toUnix(`${trade.trade_date} ${trade.entry_time}`);
    const secondsIntoBar = Math.max(0, entryUnix - toUnix(entryBar.t));
    const secondsRemaining = Math.max(0, BAR_SECONDS - secondsIntoBar);
    c.entrySecondsIntoBar = secondsIntoBar;
    const formingBar = buildFormingBar(entryBar);
    const visibleBars = c.bars.slice(0, c.entryIdx).concat([formingBar]);
    const sidePretty = c.side === "short" ? "short" : "long";

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(label.name)}</span>
          ${label.date ? `<span class="dim" style="font-weight:400; font-size:13px;">${escapeHtml(label.date)}</span>` : ""}
          <span class="side-pill ${sidePretty}">${sidePretty}</span>
          <span class="pill">${escapeHtml((trade.setup_type || "unlabeled setup").replace(/_/g, " "))}</span>
        </div>
        <span class="quiz-clock">${escapeHtml(trade.entry_time)}
          <span class="quiz-live-badge"><span class="quiz-live-dot"></span>${fmtClock(secondsRemaining)} left on this candle</span>
        </span>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>
      <div class="quiz-prompt" id="qz-entry-prompt">
        Price is at <b>$${fmtPrice(trade.entry_price)}</b> and this candle is still forming — you're deciding mid-bar, not after the close. This is a <b>${sidePretty}</b> setup. <b>Would you enter here?</b>
      </div>
      <div class="quiz-answer-row" id="quiz-entry-answer-row">
        <button class="quiz-answer-btn enter" id="qz-enter">Enter the trade <span class="kbd">Y</span></button>
        <button class="quiz-answer-btn pass" id="qz-pass">Pass <span class="kbd">N</span></button>
      </div>
      <div id="quiz-entry-replay-slot"><div class="quiz-replay-loading">${state.tickMode === "real" ? "Loading real ticks…" : "Loading…"}</div></div>
      <div id="quiz-stop-slot"></div>
    `;

    teardownChart(c.chartHandle);
    c.chartHandle = buildChart(document.getElementById("quiz-candle-chart"), visibleBars, { height: 380 });

    document.getElementById("qz-enter").addEventListener("click", () => handleEntryChoice(true, trade.entry_price));
    document.getElementById("qz-pass").addEventListener("click", () => handleEntryChoice(false));

    // The tape starts printing the moment this screen loads -- no button
    // to press first. Press Enter (or Pass) at whatever moment feels right
    // while the ticks print in, and that tick's price -- not necessarily
    // the real fill -- becomes your entry price. If you never click and it
    // runs out, it defaults to entering right at the real fill (same as
    // never having watched at all). The static Enter/Pass row above stays
    // live in the meantime, so a click during the brief load is still
    // honored at the real fill price.
    const answerRow = document.getElementById("quiz-entry-answer-row");
    const prevCloseEntry = c.entryIdx > 0 ? c.bars[c.entryIdx - 1].c : entryBar.o;
    c.entryBarPrevClose = prevCloseEntry;
    getEntryWatchTicks(trade, entryBar, prevCloseEntry, secondsIntoBar).then(({ prices, real, fellBack }) => {
      if (state.current !== c || c.stage !== "entry") return;
      try {
      // Removed (not just hidden): the replay below creates its own
      // #qz-enter/#qz-pass buttons, and a hidden duplicate of those same
      // ids left in the DOM would silently win every document.getElementById
      // lookup -- including the Y/N/Enter/Escape keyboard shortcuts -- so
      // pressing a key would lock in the real fill price instead of
      // whatever tick you were actually watching.
      answerRow.remove();
      c.replayHandle = runSecondReplay(document.getElementById("quiz-entry-replay-slot"), prices, {
        unitLabel: real ? "tick" : "second",
        tag: real ? "live ticks · server" : "simulated seconds",
        tagCls: real ? "live" : "",
        fallbackNote: fellBack ? "No live ticks came back for this window — showing the simulated path instead." : "",
        actions: [
          { id: "enter", label: "Enter", kbd: "Y", cls: "enter" },
          { id: "pass", label: "Pass", kbd: "N", cls: "pass" },
        ],
        defaultActionId: "pass", // running out the clock without deciding = you didn't take it
        minTotalMs: 20000, // at least 20 real seconds to decide, even on a fast fill
        chartHandle: c.chartHandle,
        bar: entryBar,
        onAct: (actionId, tickIdx, price) => handleEntryChoice(actionId === "enter", price, tickIdx),
      });
      } catch (err) { showStageError(err); }
    }).catch(showStageError);

    c.stage = "entry";
  }

  // How long to hold on the entered/passed candle before moving into the
  // next stage -- previously this was instant, so entering (or passing)
  // snapped straight into the stop-loss prompt with no beat to actually
  // see where the fill landed.
  const ENTRY_SETTLE_MS = 1600;

  // tickIdx (0-based, in the REPLAY_SECONDS space) is only given when the
  // choice came from clicking during "Watch it print in" -- it's exactly
  // which tick you clicked on. When it's missing (you decided straight
  // from the static prompt, without watching), we derive the equivalent
  // index from the real fill's time into the bar, using the same rounding
  // the tape's own cutoff uses, so both paths agree on one tick index.
  function handleEntryChoice(entered, price, tickIdx) {
    const c = state.current;
    try {
    if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; } // stop an in-progress "watch it print in" replay
    c.entered = entered;
    if (entered) {
      c.userEntryPrice = Number.isFinite(price) ? price : c.trade.entry_price;
      c.entryTickIdx = Number.isFinite(tickIdx)
        ? tickIdx
        : entryTickCount(c.entrySecondsIntoBar || 0) - 1;
      // If the tape was watched, its own live-painted candle already
      // reflects this price -- only push it here for the un-watched path,
      // where the chart is still sitting flat at the open.
      if (!Number.isFinite(tickIdx)) {
        const entryBar = c.bars[c.entryIdx];
        pushFormingBarPrice(c.chartHandle, entryBar, c.userEntryPrice, c.entrySecondsIntoBar || 0);
      }
    }
    const enterBtn = document.getElementById("qz-enter");
    const passBtn = document.getElementById("qz-pass");
    if (enterBtn) enterBtn.disabled = true;
    if (passBtn) passBtn.disabled = true;
    const promptEl = document.getElementById("qz-entry-prompt");
    if (promptEl) {
      promptEl.innerHTML = entered
        ? `Filled at <b>$${fmtPrice(c.userEntryPrice)}</b>…`
        : `Passed.`;
    }
    setTimeout(() => {
      if (state.current !== c) return; // moved on (retry/quit/next question) while we were waiting
      if (entered) renderStopStage();
      else goToReveal();
    }, ENTRY_SETTLE_MS);
    } catch (err) { showStageError(err); }
  }

  // ---------- Stage B: stop-loss + position size ----------
  function renderStopStage() {
    const c = state.current;
    const trade = c.trade;
    const entryPrice = c.userEntryPrice;
    const slot = document.getElementById("quiz-stop-slot");

    // Default stop suggestion: reach for structure first -- the low of
    // the last fully-formed candle for a long, the high of it for a
    // short -- since that's the level a trader would actually reference,
    // not an arbitrary percentage. c.entryIdx - 1 is the last candle
    // that's fully known (the entry candle itself is still only
    // partially revealed at this point). Falls back to the flat 1%
    // preset when there's no prior candle yet (entry on the very first
    // bar of the dataset) or when that level would sit on the wrong
    // side of -- or right on top of -- entry, which can happen on a gap.
    const prevBar = c.entryIdx > 0 ? c.bars[c.entryIdx - 1] : null;
    const structurePrice = prevBar ? (c.side === "short" ? prevBar.h : prevBar.l) : null;
    const structureRisk = structurePrice != null ? (c.side === "short" ? structurePrice - entryPrice : entryPrice - structurePrice) : 0;
    const structureValid = structurePrice != null && structureRisk > 0;
    const structureLabel = c.side === "short" ? "Prior high" : "Prior low";
    const standardPreset = STOP_PRESETS.find((p) => p.pct === 1) || STOP_PRESETS[0];

    slot.innerHTML = `
      <div class="quiz-stop-panel">
        <div class="quiz-prompt" style="margin-top:0;">You're in at <b>$${fmtPrice(entryPrice)}</b>. Set your stop and size below — click the chart any time to move the stop.</div>
        <div class="quiz-stop-grid">
          <div class="qsg-col">
            <div class="qsg-label">Stop-loss</div>
            <div class="quiz-preset-row" id="quiz-stop-presets">
              ${structureValid ? `<button class="quiz-preset-btn active" data-kind="structure">${structureLabel} <span class="dim">· $${fmtPrice(structurePrice)}</span></button>` : ""}
              ${STOP_PRESETS.map((p) => `<button class="quiz-preset-btn${!structureValid && p === standardPreset ? " active" : ""}" data-kind="pct" data-pct="${p.pct}">${p.label} <span class="dim">· ${p.sub}</span></button>`).join("")}
              <button class="quiz-preset-btn" data-kind="custom">Custom</button>
            </div>
            <div class="quiz-stop-row">
              <input type="number" step="0.0001" id="quiz-stop-input" placeholder="e.g. ${fmtPrice(c.side === "short" ? entryPrice * 1.02 : entryPrice * 0.98)}">
            </div>
            <div class="quiz-risk-preview" id="quiz-risk-preview"></div>
          </div>
          <div class="qsg-col">
            <div class="qsg-label">Size</div>
            <div class="quiz-preset-row" id="quiz-size-presets">
              ${SIZE_PRESETS.map((p) => `<button class="quiz-preset-btn${p.shares === SIZE_BASELINE ? " active" : ""}" data-shares="${p.shares}">${p.label} <span class="dim">· ${p.sub}</span></button>`).join("")}
              <button class="quiz-preset-btn" data-shares="">Custom</button>
            </div>
            <div class="quiz-size-row">
              <input type="number" step="1" min="1" id="quiz-size-input" value="${SIZE_BASELINE}">
              <span class="quiz-size-unit">shares</span>
            </div>
            <div class="quiz-size-preview" id="quiz-size-risk-preview"></div>
          </div>
        </div>

        <div class="quiz-stop-row" style="margin-top:10px;">
          <button class="quiz-answer-btn enter" id="quiz-stop-confirm" style="flex:none; min-width:150px;">Lock in <span class="kbd">↵</span></button>
        </div>
        <div class="quiz-stop-hint" id="quiz-stop-error"></div>
      </div>
    `;
    c.stage = "stop";

    const input = document.getElementById("quiz-stop-input");
    const sizeInput = document.getElementById("quiz-size-input");
    const stopPresetBtns = Array.from(document.querySelectorAll("#quiz-stop-presets .quiz-preset-btn"));
    const sizePresetBtns = Array.from(document.querySelectorAll("#quiz-size-presets .quiz-preset-btn"));

    let previewLine = null;
    function updateSizeRiskPreview() {
      const el = document.getElementById("quiz-size-risk-preview");
      if (!el) return;
      const shares = Number(sizeInput.value);
      const price = Number(input.value);
      const risk = c.side === "short" ? price - entryPrice : entryPrice - price;
      el.textContent = (Number.isFinite(shares) && shares > 0 && risk > 0)
        ? `Total risk if stopped: $${(risk * shares).toFixed(2)} across ${shares} sh.`
        : "";
    }
    function setPreview(price) {
      if (!Number.isFinite(price)) return;
      if (previewLine) previewLine.applyOptions({ price });
      else previewLine = c.chartHandle.series.createPriceLine({
        price, color: COLOR_YOUR_STOP, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted,
        axisLabelVisible: true, title: "your stop",
      });
      const risk = c.side === "short" ? price - entryPrice : entryPrice - price;
      const el = document.getElementById("quiz-risk-preview");
      if (el) el.textContent = risk > 0
        ? `Risking $${fmtPrice(risk)}/sh (${((risk / entryPrice) * 100).toFixed(1)}%) if filled at $${fmtPrice(entryPrice)}.`
        : `That's on the wrong side of your entry ($${fmtPrice(entryPrice)}) — widen it out.`;
      updateSizeRiskPreview();
    }

    stopPresetBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        stopPresetBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const kind = btn.dataset.kind;
        if (kind === "structure") {
          input.value = fmtPrice(structurePrice);
          setPreview(structurePrice);
        } else if (kind === "pct") {
          const pct = Number(btn.dataset.pct);
          const mult = c.side === "short" ? 1 + pct / 100 : 1 - pct / 100;
          const price = entryPrice * mult;
          input.value = fmtPrice(price);
          setPreview(price);
        } else {
          input.focus();
        }
      });
    });
    sizePresetBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        sizePresetBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const shares = btn.dataset.shares;
        if (shares) { sizeInput.value = shares; updateSizeRiskPreview(); }
        else { sizeInput.focus(); sizeInput.select(); }
      });
    });

    input.addEventListener("input", () => {
      stopPresetBtns.forEach((b) => b.classList.toggle("active", b.dataset.kind === "custom"));
      setPreview(Number(input.value));
    });
    sizeInput.addEventListener("input", () => {
      sizePresetBtns.forEach((b) => b.classList.toggle("active", b.dataset.shares === ""));
      updateSizeRiskPreview();
    });
    c.chartHandle.chart.subscribeClick((param) => {
      if (!param.point || !c.chartHandle.series) return;
      const price = c.chartHandle.series.coordinateToPrice(param.point.y);
      if (price == null) return;
      input.value = fmtPrice(price);
      stopPresetBtns.forEach((b) => b.classList.toggle("active", b.dataset.kind === "custom"));
      setPreview(price);
    });

    // Pre-fill and preview the default the moment the stage renders --
    // structure when it's usable, otherwise the flat 1% preset -- instead
    // of leaving the input empty until you pick something yourself.
    if (structureValid) {
      input.value = fmtPrice(structurePrice);
      setPreview(structurePrice);
    } else {
      const mult = c.side === "short" ? 1 + standardPreset.pct / 100 : 1 - standardPreset.pct / 100;
      const price = entryPrice * mult;
      input.value = fmtPrice(price);
      setPreview(price);
    }

    document.getElementById("quiz-stop-confirm").addEventListener("click", () => {
      const price = Number(input.value);
      const shares = Number(sizeInput.value);
      const errorEl = document.getElementById("quiz-stop-error");
      if (!Number.isFinite(price) || price <= 0) { errorEl.textContent = "Enter a valid stop price first."; return; }
      const risk = c.side === "short" ? price - entryPrice : entryPrice - price;
      if (!(risk > 0)) { errorEl.textContent = `That stop is on the wrong side of your $${fmtPrice(entryPrice)} entry for a ${c.side}.`; return; }
      if (!Number.isFinite(shares) || shares <= 0) { errorEl.textContent = "Enter a valid share size too."; return; }
      c.userShares = Math.round(shares);
      confirmStop(price);
    });
  }

  function confirmStop(stopPrice) {
    const c = state.current;
    c.stopPrice = stopPrice;
    const slot = document.getElementById("quiz-stop-slot");
    if (slot) slot.querySelectorAll("button, input").forEach((elm) => (elm.disabled = true));
    renderWatchStage();
  }

  // Records a closed tranche of the ORIGINAL position -- clamps to
  // whatever's actually still open so a stray double-click can't oversell.
  // Returns the fraction actually applied (0 if nothing was left to sell).
  function recordExit(c, fraction, price, barIdx, tickIdx, tag) {
    const applied = Math.max(0, Math.min(fraction, c.remainingFraction));
    if (applied <= 1e-9 || !Number.isFinite(price)) return 0;
    c.exits.push({ fraction: applied, price, barIdx, tickIdx, tag });
    c.remainingFraction = Math.max(0, c.remainingFraction - applied);
    if (!c.checkpointAction) c.checkpointAction = "exit";
    c.exitBarIdx = barIdx;
    c.exitSecond = tickIdx;
    c.userExitPrice = price; // last exit's price -- kept for anything that only cares about "how it finally ended"
    return applied;
  }

  // ---------- Stage C: watch continuously from your entry until you exit ----------
  // Instead of jumping to one designated "checkpoint" bar, you now keep
  // watching bar after bar -- tick by tick -- from right after your entry
  // for as long as there's chart left to show. You can click Exit at any
  // point during any of it. Your own stop is checked live against every
  // tick as it prints, so it can trigger mid-bar exactly like a real fill
  // would, regardless of where the real entry/exit actually landed.
  function renderWatchStage() {
    const c = state.current;
    // Resume from the entry bar itself if there was any of it left when
    // you entered -- watchIdx === entryIdx means "still finishing this
    // candle". Only once that's played out do we move on to entryIdx + 1.
    // (Previously this always jumped straight to entryIdx + 1, silently
    // skipping whatever time was left on the candle you actually entered
    // on.)
    const hasEntryBarRemainder = c.entryTickIdx != null && c.entryTickIdx < REPLAY_SECONDS - 1;
    c.watchIdx = hasEntryBarRemainder ? c.entryIdx : c.entryIdx + 1;
    if (c.watchIdx > c.bars.length - 1) {
      // Nothing left to watch after entry -- go straight to reveal, same
      // outcome as watching through to the end of the data and never
      // clicking Exit.
      goToReveal();
      return;
    }
    buildWatchScreen();
  }

  // Builds the watch-stage DOM and chart exactly once per question. Bars
  // after this are played by renderWatchBar(), which only touches the
  // header text and the replay panel -- the chart itself is never torn
  // down and rebuilt again, so your zoom/pan (and the tape) stay put
  // candle after candle instead of snapping back to a full-fit view.
  function buildWatchScreen() {
    const c = state.current;
    try {
    const trade = c.trade;
    const entryPrice = c.userEntryPrice;

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(displayLabel(trade).name)}</span>
          <span class="side-pill ${c.side}">${c.side}</span>
        </div>
        <span class="quiz-clock">
          <span id="qz-watch-clock"></span>
          <span class="quiz-live-badge pos" id="qz-watch-live-clock" style="display:none;"></span>
        </span>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>
      <div class="quiz-prompt" id="qz-watch-prompt"></div>
      <div class="quiz-partial-row" id="qz-partial-row"></div>
      <div id="quiz-replay-slot"></div>
    `;
    c.stage = "watch";

    // Scale-out buttons -- wired once here (not rebuilt every tick/bar like
    // the replay panel's Exit button) so they stay live and clickable the
    // whole way through the watch stage, including the brief gap between
    // one bar's tape ending and the next one's ticks arriving.
    document.getElementById("qz-partial-row").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-sell]");
      if (!btn || btn.disabled) return;
      const frac = Number(btn.dataset.sell);
      if (!(frac > 0)) return;
      const handle = c.replayHandle;
      const price = handle && typeof handle.getPrice === "function" ? handle.getPrice() : null;
      if (!Number.isFinite(price)) return;
      const tickIdx = handle && typeof handle.getIndex === "function" ? handle.getIndex() : null;
      const applied = recordExit(c, frac, price, c.watchIdx, tickIdx, "sell");
      if (applied <= 0) return;
      if (c.remainingFraction <= 1e-9) {
        if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; }
        goToReveal();
      } else {
        renderPartialRow();
      }
    });

    teardownChart(c.chartHandle);
    // Everything before the bar currently playing is settled chart
    // history; the current (and every later) bar plays out second by
    // second instead of showing up as an already-closed candle.
    const historyBars = c.bars.slice(0, c.watchIdx);
    const watchPriceLines = [
      { price: entryPrice, color: COLOR_YOUR_ENTRY, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "your entry" },
      { price: c.stopPrice, color: COLOR_YOUR_STOP, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "your stop" },
    ];
    // Deliberately no "real entry"/"real exit" lines or pointers here --
    // the trade is still live at this stage, and showing where the real
    // fills landed (or even that they differ from yours) would spoil the
    // outcome before the reveal screen. Those only show up once you've
    // finished the trade.
    const chartEl = document.getElementById("quiz-candle-chart");
    // Fall back to just this one bar only when there's truly no earlier
    // history (watchIdx is the very first bar of the dataset) -- for the
    // entry-bar-remainder case there's no fallback needed since the
    // entry bar itself isn't finished yet and must not be shown as an
    // already-closed candle.
    c.chartHandle = buildChart(chartEl, historyBars.length ? historyBars : (c.watchIdx > 0 ? c.bars.slice(0, c.watchIdx + 1) : []), {
      height: 380,
      priceLines: watchPriceLines,
    });
    // Mark the last bar you actually have data for, so it's visible at a
    // glance how much runway is left instead of only finding out once
    // the tape runs dry.
    attachEndOfDataLine(chartEl, c.chartHandle, toUnix(c.bars[c.bars.length - 1].t));

    renderPartialRow();
    renderWatchBar();
    } catch (err) { showStageError(err); }
  }

  // Refreshes the persistent scale-out row: how much of the position is
  // still open, what's already been sold and at what price, and which
  // Sell buttons still make sense given what's left.
  function renderPartialRow() {
    const c = state.current;
    if (!c || c.stage !== "watch") return;
    const row = document.getElementById("qz-partial-row");
    if (!row) return;
    const pctOpen = Math.round(c.remainingFraction * 100);
    const soldParts = c.exits.filter((e) => e.tag === "sell").map((e) => `${Math.round(e.fraction * 100)}% at $${fmtPrice(e.price)}`);
    row.innerHTML = `
      <span class="qp-status">${pctOpen}% of position open${soldParts.length ? ` <span class="dim">\u00b7 sold ${escapeHtml(soldParts.join(", "))}</span>` : ""}</span>
      <div class="qp-btns">
        <button type="button" class="quiz-answer-btn partial" data-sell="0.25"${c.remainingFraction < 0.25 - 1e-9 ? " disabled" : ""}>Sell &frac14; <span class="kbd">2</span></button>
        <button type="button" class="quiz-answer-btn partial" data-sell="0.5"${c.remainingFraction < 0.5 - 1e-9 ? " disabled" : ""}>Sell &frac12; <span class="kbd">3</span></button>
      </div>
    `;
  }

  function renderWatchBar() {
    const c = state.current;
    try {
    const trade = c.trade;
    const entryPrice = c.userEntryPrice;
    // watchIdx === entryIdx means we're still finishing out the candle
    // you entered on, tick by tick from your fill -- not yet a fresh bar.
    const isEntryRemainder = c.watchIdx === c.entryIdx;
    const historyBars = c.bars.slice(0, c.watchIdx);
    const bar = c.bars[c.watchIdx];
    // Feeds the deterministic simulated path -- for the entry bar's
    // remainder this must be the exact value the pre-entry tape used
    // (c.entryBarPrevClose), so both halves of the same candle are the
    // same underlying walk instead of visibly disagreeing at the seam.
    const tickPrevClose = isEntryRemainder
      ? (c.entryBarPrevClose != null ? c.entryBarPrevClose : entryPrice)
      : (historyBars.length ? historyBars[historyBars.length - 1].c : entryPrice);
    // "Unrealized so far" for the remainder should read off your own
    // fill (you only just entered), not the close of the bar before it.
    const unrealized = pnlPerShare(entryPrice, isEntryRemainder ? entryPrice : tickPrevClose, c.side);
    const clockStr = new Date(bar.t.replace(" ", "T")).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const minutesIn = c.watchIdx - c.entryIdx;
    const barsLeft = c.bars.length - 1 - c.watchIdx;
    // Always shown, not just as a last-second warning -- so you can see
    // how much tape is left to plan around rather than getting surprised
    // when it runs out. BAR_SECONDS === 60, so bars left and minutes left
    // of chart data are the same number.
    const barsLeftColor = barsLeft <= 3 ? "var(--amber)" : "var(--text-faint)";
    const barsLeftLabel = `${barsLeft} bar${barsLeft === 1 ? "" : "s"} (~${barsLeft}m) of data left`;

    document.getElementById("qz-watch-clock").innerHTML =
      `${escapeHtml(clockStr)} <span class="dim" style="font-weight:400;">· ${minutesIn} min in</span>` +
      ` <span style="color:${barsLeftColor};">· ${barsLeftLabel}</span>`;
    const positionNote = c.remainingFraction < 1 - 1e-9
      ? ` You're still holding <b>${Math.round(c.remainingFraction * 100)}%</b> of the position.`
      : "";
    document.getElementById("qz-watch-prompt").innerHTML = `
      You're in at <b>$${fmtPrice(entryPrice)}</b>, stop at <b>$${fmtPrice(c.stopPrice)}</b>.
      Unrealized so far on the open portion: <b style="color:${unrealized >= 0 ? "var(--green)" : "var(--red)"}">${fmtSignedPerShare(unrealized)}/sh</b>.${positionNote}
      Keep watching for as long as you like — <b>sell some, sell it all, whenever you'd get out</b>.
    `;
    renderPartialRow();

    const replaySlot = document.getElementById("quiz-replay-slot");
    replaySlot.innerHTML = `<div class="quiz-replay-loading">${state.tickMode === "real" ? "Loading real ticks from the server…" : "Loading…"}</div>`;
    const liveClockEl = document.getElementById("qz-watch-live-clock");
    if (liveClockEl) liveClockEl.style.display = "none";
    // Nothing to sell against mid-fetch -- lock the scale-out buttons for
    // this brief gap rather than let a click read a stale/no price.
    document.querySelectorAll('#qz-partial-row button[data-sell]').forEach((b) => (b.disabled = true));

    const watchIdxAtFetch = c.watchIdx;
    const ticksPromise = isEntryRemainder
      ? getEntryBarRemainderTicks(trade, bar, tickPrevClose, c.entryTickIdx)
      : getCheckpointTicks(trade, bar, tickPrevClose);
    ticksPromise.then(({ prices, real, fellBack }) => {
      if (state.current !== c || c.stage !== "watch" || c.watchIdx !== watchIdxAtFetch) return; // moved on while this was in flight
      try {
      if (!prices.length) {
        // You entered right on the bar's final tick -- nothing left of
        // this candle to watch, so finalize it and move on to the next
        // bar instead of trying to play an empty tape.
        finalizeBarOnChart(c.chartHandle, bar);
        c.watchIdx += 1;
        if (c.watchIdx > c.bars.length - 1) { goToReveal(); return; }
        renderWatchBar();
        return;
      }
      if (liveClockEl) liveClockEl.style.display = "";
      renderPartialRow();
      c.replayHandle = runSecondReplay(replaySlot, prices, {
        unitLabel: real ? "tick" : "second",
        tag: real ? "live ticks · server" : "simulated seconds",
        tagCls: real ? "live" : "",
        fallbackNote: fellBack ? "No live ticks came back for this window — showing the simulated path instead." : "",
        // The chart already reflects everything through the previous bar
        // (or was just fit once in buildWatchScreen) -- re-fitting on
        // every later bar is exactly the "resets the chart view" behavior
        // this replaces, so skip it here.
        autoFit: false,
        // Once you're actually in the trade, replace the sweeping
        // "loading" progress bar with a plain ticking clock up in the
        // header -- closer to what a real trading platform looks like.
        hideProgress: true,
        liveClockEl,
        actions: [
          { id: "exit", label: c.remainingFraction < 1 - 1e-9 ? `Exit remaining ${Math.round(c.remainingFraction * 100)}%` : "Exit all", kbd: "E", cls: "exit" },
        ],
        chartHandle: c.chartHandle,
        bar,
        // Continuing the entry bar's own candle: seed the wick from what
        // it already showed (open..your fill) instead of resetting it
        // flat, and keep volume accumulating past what already printed.
        seedHigh: isEntryRemainder ? Math.max(bar.o, entryPrice) : undefined,
        seedLow: isEntryRemainder ? Math.min(bar.o, entryPrice) : undefined,
        volStartFrac: isEntryRemainder ? (c.entryTickIdx + 1) / REPLAY_SECONDS : 0,
        onTick: (price, tickIdx) => {
          const breached = c.side === "short" ? price >= c.stopPrice : price <= c.stopPrice;
          if (breached) {
            if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; }
            c.stoppedOutEarly = true;
            c.stopOutIdx = c.watchIdx;
            // A stop only closes out whatever's still open -- any earlier
            // partial sells keep their own locked-in prices.
            recordExit(c, c.remainingFraction, c.stopPrice, c.watchIdx, tickIdx, "stop");
            goToReveal();
          }
        },
        onExhausted: () => {
          // This bar's tape ran out without you clicking Exit -- finalize
          // it on the chart (swap from the orange forming look to its
          // normal closed color) and move straight on to the next bar,
          // without touching the DOM or rebuilding the chart.
          finalizeBarOnChart(c.chartHandle, bar);
          c.watchIdx += 1;
          if (c.watchIdx > c.bars.length - 1) { goToReveal(); return; } // out of chart to watch
          renderWatchBar();
        },
        onAct: (actionId, tickIdx, price) => {
          // Exit all -- closes whatever fraction is still open, whether
          // that's the full original position or whatever's left after
          // earlier partial sells.
          recordExit(c, c.remainingFraction, price, c.watchIdx, tickIdx, "sell");
          goToReveal();
        },
      });
      } catch (err) { showStageError(err); }
    }).catch(showStageError);
    } catch (err) { showStageError(err); }
  }

  // ---------- feedback (qualitative — good/off/bad, never a score) ----------
  function gradeEntry(win, entered) {
    if (entered && win) return { label: "Good call — this one was a real winner.", tone: "good" };
    if (entered && !win) return { label: "This one lost in real life too.", tone: "bad" };
    if (!entered && !win) return { label: "Good discipline — this one was a loser.", tone: "good" };
    return { label: "This one worked out — you'd have missed it.", tone: "warn" };
  }

  function gradeStop(side, entryPrice, stopPrice, suggestedStop) {
    const riskUser = side === "short" ? stopPrice - entryPrice : entryPrice - stopPrice;
    if (!(riskUser > 0)) return { label: "Stop was on the wrong side of your entry.", tone: "bad" };
    const sug = Number(suggestedStop);
    if (suggestedStop != null && Number.isFinite(sug)) {
      const riskSuggested = side === "short" ? sug - entryPrice : entryPrice - sug;
      if (riskSuggested > 0) {
        const ratio = riskUser / riskSuggested;
        if (ratio < 0.5) return { label: "Too tight — likely shaken out by normal noise.", tone: "bad" };
        if (ratio < 0.8) return { label: "A little tight versus the setup's stop.", tone: "warn" };
        if (ratio <= 1.3) return { label: "Well placed — close to the setup's stop.", tone: "good" };
        if (ratio <= 2.2) return { label: "A bit wide.", tone: "warn" };
        return { label: "Too wide — risking more than the setup called for.", tone: "bad" };
      }
    }
    const pct = (riskUser / entryPrice) * 100;
    return { label: `${pct.toFixed(1)}% risk — no AI stop logged on this trade to compare against.`, tone: "neutral" };
  }

  function computeGrading(c) {
    const trade = c.trade;
    const side = c.side;
    const entryPrice = c.userEntryPrice;
    const entryGrade = gradeEntry(trade.win, c.entered);

    let stopGrade = null, exitGrade = null, userPnlPerShare = null, userExitFillPrice = null;
    if (c.entered) {
      stopGrade = gradeStop(side, entryPrice, c.stopPrice, trade.suggested_stop);
      const actualPnl = pnlPerShare(entryPrice, trade.exit_price, side);

      // c.exits is fully normalized by the time reveal calls this -- its
      // fractions always sum to 1 (goToReveal tops up whatever was still
      // open with a "held to end" tranche first). Blend across however
      // many tranches you actually closed: one clean exit collapses back
      // to the old single-price math, scaling out just averages more terms
      // in, each weighted by how much of the position it covered.
      const totalFrac = c.exits.reduce((s, e) => s + e.fraction, 0) || 1;
      userPnlPerShare = c.exits.reduce((s, e) => s + e.fraction * pnlPerShare(entryPrice, e.price, side), 0) / totalFrac;
      userExitFillPrice = c.exits.reduce((s, e) => s + e.fraction * e.price, 0) / totalFrac;

      const manualTranches = c.exits.filter((e) => e.tag !== "held");
      const scaledOut = c.exits.filter((e) => e.tag === "sell").length > 1;

      if (c.stoppedOutEarly) {
        const stopFrac = c.exits.filter((e) => e.tag === "stop").reduce((s, e) => s + e.fraction, 0);
        exitGrade = stopFrac < 1 - 1e-9
          ? { label: `Scaled out first, then stopped out of the rest at $${fmtPrice(c.stopPrice)}.`, tone: "warn" }
          : { label: `Stopped out at $${fmtPrice(c.stopPrice)} while you were watching.`, tone: "warn" };
      } else if (manualTranches.length) {
        const diff = actualPnl - userPnlPerShare;
        const threshold = Math.max(0.15 * Math.abs(actualPnl || 0.01), 0.01);
        const prefix = scaledOut ? `Scaled out across ${manualTranches.length} sells (avg $${fmtPrice(userExitFillPrice)}). ` : "";
        if (diff > threshold) exitGrade = { label: `${prefix}You exited early — the move kept going. Riding it to the real exit made ${fmtSignedPerShare(diff)}/sh more.`, tone: "warn" };
        else if (diff < -threshold) exitGrade = { label: `${prefix}Good exit — price gave back a lot of that move afterward.`, tone: "good" };
        else exitGrade = { label: `${prefix}Reasonable exit, close to how the trade actually played out.`, tone: "good" };
      } else {
        // Never sold anything and never got stopped -- you watched all the
        // way through to the end of the available chart, same as holding.
        exitGrade = { label: "You held on — matches what actually happened.", tone: "neutral" };
      }
    }

    // Size grading is independent of how the entry/stop/exit played out --
    // it's just: did your conviction (bigger size = more confident) line up
    // with how the trade actually turned out?
    let sizeGrade = null;
    if (c.entered && Number.isFinite(c.userShares)) {
      const ratio = c.userShares / SIZE_BASELINE;
      if (ratio >= 1.3 && trade.win) sizeGrade = { label: `Sized up to ${c.userShares} sh and it paid off — good conviction.`, tone: "good" };
      else if (ratio >= 1.3 && !trade.win) sizeGrade = { label: `Sized up to ${c.userShares} sh on a loser — that conviction cost you more.`, tone: "bad" };
      else if (ratio <= 0.7 && !trade.win) sizeGrade = { label: `Sized down to ${c.userShares} sh — good instinct, this one lost.`, tone: "good" };
      else if (ratio <= 0.7 && trade.win) sizeGrade = { label: `Sized down to ${c.userShares} sh on a winner — left size on the table.`, tone: "warn" };
      else sizeGrade = { label: `Standard size (${c.userShares} sh).`, tone: "neutral" };
    }

    return { entryGrade, stopGrade, exitGrade, sizeGrade, userPnlPerShare, userExitFillPrice };
  }

  // ---------- Stage D: full reveal ----------
  function goToReveal() {
    const c = state.current;
    try {
    const trade = c.trade;
    // Top up whatever's still open with a synthetic "held to end" tranche
    // at the real exit price -- same as before when you never clicked
    // Exit at all, but now it also covers the leftover slice after a
    // partial scale-out where you never got around to closing the rest.
    if (c.entered && c.remainingFraction > 1e-9) {
      recordExit(c, c.remainingFraction, trade.exit_price, c.exitIdx, null, "held");
    }
    const grading = computeGrading(c);
    c.stage = "reveal";

    // Only the first pass through a given trade gets recorded in the recap —
    // hitting "Retry this question" lets you replay it for practice without
    // adding a second entry for the same trade.
    if (!state.recordedIds.has(trade.id)) {
      state.recordedIds.add(trade.id);
      state.results.push({
        id: trade.id, symbol: trade.symbol, setup_type: trade.setup_type, win: !!trade.win,
        source: trade._source === "backtest" ? "backtest" : "log",
        entered: c.entered, entryTone: grading.entryGrade.tone,
        stopTone: grading.stopGrade ? grading.stopGrade.tone : null,
        exitTone: grading.exitGrade ? grading.exitGrade.tone : null,
        sizeTone: grading.sizeGrade ? grading.sizeGrade.tone : null,
      });
    }

    const entryBar = c.bars[c.entryIdx], exitBar = c.bars[c.exitIdx];

    // The real entry/exit fills, your own stop (if you had one), and
    // whatever you actually did at exit time -- each gets both a
    // full-width price line (so the level is easy to read off the right
    // axis) and a pointer triangle sitting exactly on the fill (so the
    // exact bar/time is unambiguous too), same combination trade.html
    // uses. AI stop/target and better-entry/exit stay in the text panels
    // below rather than adding more lines to the chart.
    const pointerDefs = [
      { time: toUnix(entryBar.t), price: trade.entry_price, color: COLOR_REAL_ENTRY, above: true, tooltip: `REAL ENTRY $${fmtPrice(trade.entry_price)}` },
      { time: toUnix(exitBar.t), price: trade.exit_price, color: COLOR_REAL_EXIT, above: false, tooltip: `REAL EXIT $${fmtPrice(trade.exit_price)}` },
    ];
    if (c.entered && c.userEntryPrice != null) {
      pointerDefs.push({ time: toUnix(entryBar.t), price: c.userEntryPrice, color: COLOR_YOUR_ENTRY, above: true, tooltip: `TEST ENTRY $${fmtPrice(c.userEntryPrice)}` });
    }
    // One pointer per tranche you actually closed yourself (sell or stop)
    // -- skips synthetic "held" tranches since that price just duplicates
    // the real-exit line already on the chart. A single clean exit reads
    // as "TEST EXIT" same as before; more than one gets labeled with the
    // fraction so a scale-out is legible at a glance.
    const manualTranches = c.exits.filter((e) => e.tag !== "held");
    manualTranches.forEach((e) => {
      if (e.barIdx == null) return;
      const bar = c.bars[e.barIdx];
      if (!bar) return;
      const pct = Math.round(e.fraction * 100);
      const label = e.tag === "stop"
        ? (manualTranches.length > 1 ? `STOPPED OUT (${pct}%) $${fmtPrice(e.price)}` : `STOPPED OUT $${fmtPrice(e.price)}`)
        : (manualTranches.length > 1 ? `SOLD ${pct}% $${fmtPrice(e.price)}` : `TEST EXIT $${fmtPrice(e.price)}`);
      pointerDefs.push({ time: toUnix(bar.t), price: e.price, color: e.tag === "stop" ? COLOR_STOP_EVENT : COLOR_YOUR_EXIT, above: false, tooltip: label });
    });

    const priceLines = [
      { price: trade.entry_price, color: COLOR_REAL_ENTRY, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "real entry" },
      { price: trade.exit_price, color: COLOR_REAL_EXIT, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "real exit" },
    ];
    if (c.entered && c.userEntryPrice != null) {
      priceLines.push({ price: c.userEntryPrice, color: COLOR_YOUR_ENTRY, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "test entry" });
    }
    if (c.entered && c.stopPrice != null) {
      priceLines.push({ price: c.stopPrice, color: COLOR_YOUR_STOP, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "your stop" });
    }
    // Each closed tranche's price gets its own line too, not just a
    // pointer -- same treatment "your stop" already got -- so every fill
    // is readable off the right axis even without hovering. A stop
    // tranche is skipped here since that price already has a line via
    // "your stop".
    manualTranches.filter((e) => e.tag !== "stop").forEach((e, idx) => {
      const pct = Math.round(e.fraction * 100);
      priceLines.push({
        price: e.price, color: COLOR_YOUR_EXIT, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true,
        title: manualTranches.length > 1 ? `exit ${pct}%` : "test exit",
      });
    });

    const label = { name: trade.symbol, date: trade.trade_date }; // reveal always shows the real thing
    const winPillHtml = `<span class="pill ${trade.win ? "win" : "loss"}">${trade.win ? "Winner" : "Loser"}</span>`;

    function pillFor(tone) { return `pill ${tone === "good" ? "good" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : "neutral"}`; }

    const entryFillNote = (c.entered && c.userEntryPrice != null)
      ? ` at <b>$${fmtPrice(c.userEntryPrice)}</b>${Math.abs(c.userEntryPrice - trade.entry_price) > 0.0001 ? ` <span class="dim">(real fill: $${fmtPrice(trade.entry_price)})</span>` : ""}`
      : "";
    const entryRowHtml = `<div class="rb-line">You: <b>${c.entered ? "Entered" : "Passed"}</b>${entryFillNote}</div>
      <div class="rb-line"><span class="${pillFor(grading.entryGrade.tone)}">${escapeHtml(grading.entryGrade.label)}</span></div>`;

    const sugStopSane = Number.isFinite(Number(trade.suggested_stop)) && (c.side === "short" ? Number(trade.suggested_stop) > trade.entry_price : Number(trade.suggested_stop) < trade.entry_price);
    const stopRowHtml = grading.stopGrade
      ? `<div class="rb-line">You placed your stop at <b>$${fmtPrice(c.stopPrice)}</b>${sugStopSane ? ` · AI suggested <b>$${fmtPrice(trade.suggested_stop)}</b>` : ""}</div>
         <div class="rb-line"><span class="${pillFor(grading.stopGrade.tone)}">${escapeHtml(grading.stopGrade.label)}</span></div>`
      : `<div class="rb-line dim">You passed, so no stop to grade.</div>`;

    const exitRowHtml = grading.exitGrade
      ? `<div class="rb-line">Your result: <b style="color:${grading.userPnlPerShare >= 0 ? "var(--green)" : "var(--red)"}">${fmtSignedPerShare(grading.userPnlPerShare)}/sh</b>
           · Actual: <b style="color:${trade.win ? "var(--green)" : "var(--red)"}">${fmtSignedPerShare(pnlPerShare(trade.entry_price, trade.exit_price, c.side))}/sh</b></div>
         <div class="rb-line"><span class="${pillFor(grading.exitGrade.tone)}">${escapeHtml(grading.exitGrade.label)}</span></div>`
      : `<div class="rb-line dim">You passed, so no exit to grade.</div>`;

    const sizeRowHtml = grading.sizeGrade
      ? `<div class="rb-line">You sized: <b>${c.userShares} sh</b> <span class="dim">(actual trade: ${trade.shares} sh)</span></div>
         <div class="rb-line"><span class="${pillFor(grading.sizeGrade.tone)}">${escapeHtml(grading.sizeGrade.label)}</span></div>`
      : `<div class="rb-line dim">You passed, so no size to grade.</div>`;

    // "Real numbers" -- what your own size/entry/exit would've cost using
    // IBKR's real tiered commission schedule (per-share rate with a
    // per-order floor and ceiling), applied on BOTH sides of the
    // comparison. The dataset's logged trade.commission field is noisy
    // and doesn't track any consistent fee schedule -- e.g. two 50-share
    // trades in the same price range are logged at $0.02 and $2.01 -- so
    // trusting it verbatim for "actual" while computing "yours" from the
    // real schedule made the two sides incomparable (and made the real
    // trade look far cheaper than it would actually have cost). Instead,
    // recompute the actual trade's commission the same way, from its own
    // shares and entry/exit fill prices, so both numbers reflect the same
    // real-world schedule and differ only by what was actually traded.
    const tradeShares = Number(trade.shares) || 0;
    const tradeCommission = ibkrTieredCommission(tradeShares, trade.entry_price) + ibkrTieredCommission(tradeShares, trade.exit_price);
    const tradePnlBeforeComm = Number(trade.pnl_before_comm);
    const tradeNet = Number.isFinite(tradePnlBeforeComm) ? tradePnlBeforeComm - tradeCommission : Number(trade.pnl_after_comm) || 0;
    const userGross = c.entered && Number.isFinite(grading.userPnlPerShare) ? grading.userPnlPerShare * c.userShares : null;
    const userEntryCommission = (c.entered && c.userEntryPrice != null) ? ibkrTieredCommission(c.userShares, c.userEntryPrice) : 0;
    // Each tranche is its own real order -- sum commission per tranche
    // instead of applying one rate to a single blended price. Share counts
    // are allocated by cumulative rounding so they add up to exactly
    // c.userShares even when fractions like 1/4 don't divide it evenly.
    const userExitCommission = (() => {
      if (!c.entered) return 0;
      let cumFrac = 0, cumShares = 0, total = 0;
      c.exits.forEach((e) => {
        cumFrac += e.fraction;
        const newCumShares = Math.round(cumFrac * c.userShares);
        const shares = newCumShares - cumShares;
        cumShares = newCumShares;
        if (shares > 0) total += ibkrTieredCommission(shares, e.price);
      });
      return total;
    })();
    const userCommission = c.entered ? userEntryCommission + userExitCommission : null;
    const userNet = (userGross != null && userCommission != null) ? userGross - userCommission : null;

    function normalizeLesson(l) {
      if (typeof l !== "string") return l;
      try {
        const parsed = JSON.parse(l);
        return (parsed && typeof parsed === "object") ? parsed : l;
      } catch (e) { return l; /* genuinely plain text */ }
    }
    const lessonsHtml = (trade.lessons || []).map(normalizeLesson).map((l) => {
      if (typeof l === "string") return `<li>${escapeHtml(l)}</li>`;
      const how = l.how_to_know ? ` <span class="dim">— ${escapeHtml(l.how_to_know)}</span>` : "";
      return `<li><b>${escapeHtml((l.tag || "").replace(/_/g, " "))}</b>: ${escapeHtml(l.lesson || l.text || "")}${how}</li>`;
    }).join("");

    const isLast = state.qIndex >= state.queue.length - 1;

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(label.name)}</span>
          <span class="dim" style="font-weight:400; font-size:13px;">${escapeHtml(label.date)}</span>
          <span class="side-pill ${c.side}">${c.side}</span>
          <span class="pill">${escapeHtml((trade.setup_type || "unlabeled setup").replace(/_/g, " "))}</span>
          ${winPillHtml}
        </div>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>

      <div class="quiz-reveal-grid">
        <div class="quiz-reveal-box"><div class="rb-label">Entry</div>${entryRowHtml}</div>
        <div class="quiz-reveal-box"><div class="rb-label">Stop-loss</div>${stopRowHtml}</div>
        <div class="quiz-reveal-box"><div class="rb-label">Exit</div>${exitRowHtml}</div>
        <div class="quiz-reveal-box"><div class="rb-label">Position size</div>${sizeRowHtml}</div>
        <div class="quiz-reveal-box" style="grid-column:1/-1;"><div class="rb-label">Real numbers</div>
          <div class="rb-line">Entry <b>$${fmtPrice(trade.entry_price)}</b> actual${c.entered && c.userEntryPrice != null ? ` · <b>$${fmtPrice(c.userEntryPrice)}</b> yours` : ""} at <b>${escapeHtml(trade.entry_time)}</b> → Exit <b>$${fmtPrice(trade.exit_price)}</b> at <b>${escapeHtml(trade.exit_time)}</b> <span class="dim">(${escapeHtml(trade.time_in_trade || "—")} in trade)</span></div>
          <div class="rb-line">Shares: <b>${tradeShares}</b> actual${c.entered ? ` · <b>${c.userShares}</b> yours` : ""} &nbsp;·&nbsp; Commission: <b>$${tradeCommission.toFixed(2)}</b> actual${c.entered && userCommission != null ? ` · <b>$${userCommission.toFixed(2)}</b> yours` : ""}</div>
          <div class="rb-line">Net P&amp;L: <b style="color:${tradeNet >= 0 ? "var(--green)" : "var(--red)"}">${tradeNet >= 0 ? "+" : "-"}$${Math.abs(tradeNet).toFixed(2)}</b> actual${c.entered && userNet != null ? ` · <b style="color:${userNet >= 0 ? "var(--green)" : "var(--red)"}">${userNet >= 0 ? "+" : "-"}$${Math.abs(userNet).toFixed(2)}</b> yours` : ""}</div>
        </div>
      </div>

      ${trade.verdict ? `<div class="quiz-verdict-box"><span class="vb-label">What actually happened</span>${escapeHtml(trade.verdict)}</div>` : ""}
      ${lessonsHtml ? `<ul class="quiz-lesson-list">${lessonsHtml}</ul>` : ""}
      ${trade.walk_away_rule ? `<div class="quiz-walkaway"><b>Walk-away rule:</b> ${escapeHtml(trade.walk_away_rule)}</div>` : ""}

      <div class="quiz-next-row">
        <button class="btn-advanced" id="qz-replay-again-btn" type="button">↻ Retry this question</button>
        ${trade._source === "backtest"
          ? `<span class="btn-advanced" style="opacity:.6; cursor:default;" title="Generated from a backtest run, not saved in your journal">Practice-generated setup</span>`
          : `<a class="btn-advanced" href="trade.html?id=${encodeURIComponent(trade.id)}" target="_blank" rel="noopener">Open full trade page</a>`}
        <button class="btn-confirm" id="qz-next">${isLast ? "See results" : "Next question"} <span class="kbd">↵</span></button>
      </div>
    `;

    teardownChart(c.chartHandle);
    const chartEl = document.getElementById("quiz-candle-chart");
    c.chartHandle = buildChart(chartEl, c.bars, { height: 400, priceLines });
    attachPointers(chartEl, c.chartHandle, pointerDefs);

    document.getElementById("qz-replay-again-btn").addEventListener("click", () => retryCurrentQuestion());
    document.getElementById("qz-next").addEventListener("click", () => { state.qIndex++; loadQuestion(); });
    } catch (err) { showStageError(err); }
  }

  // ---------------------------------------------------------------
  // keyboard shortcuts — ignored while typing in the stop input
  // ---------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (els.playScreen.style.display === "none") return;
    const c = state.current;
    if (!c) return;
    const typing = document.activeElement && document.activeElement.tagName === "INPUT";
    if (c.stage === "entry" && !typing) {
      if (e.key === "y" || e.key === "Y" || e.key === "Enter") document.getElementById("qz-enter")?.click();
      if (e.key === "n" || e.key === "N" || e.key === "Escape") document.getElementById("qz-pass")?.click();
    } else if (c.stage === "watch" && !typing) {
      if (e.key === "e" || e.key === "E" || e.key === "1") document.getElementById("qz-exit")?.click();
      if (e.key === "2") document.querySelector('#qz-partial-row button[data-sell="0.25"]')?.click();
      if (e.key === "3") document.querySelector('#qz-partial-row button[data-sell="0.5"]')?.click();
    } else if (c.stage === "stop" && e.key === "Enter") {
      // Enter locks in from either input too, not just a click on the
      // button -- the whole point of tightening this stage's layout was
      // to cut down on hunting for a button below the fold.
      e.preventDefault();
      document.getElementById("quiz-stop-confirm")?.click();
    } else if (c.stage === "reveal" && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      document.getElementById("qz-next")?.click();
    }
  });

  els.quitBtn.addEventListener("click", async () => {
    const ok = await UIModal.confirm("End this session? Progress on the current trade won't be saved.", { title: "End session?", tone: "danger", confirmLabel: "End session" });
    if (!ok) return;
    goToSetupScreen();
  });

  function goToSetupScreen() {
    if (state.current && state.current.chartHandle) teardownChart(state.current.chartHandle);
    if (state.current && state.current.replayHandle) state.current.replayHandle.stop();
    state.current = null;
    els.playScreen.style.display = "none";
    els.summaryScreen.style.display = "none";
    els.setupScreen.style.display = "";
    renderHistoryPanel();
    renderCandidateCount();
  }

  // ---------------------------------------------------------------
  // session recap — deliberately no score, accuracy %, or streak.
  // Three clearly separated sections, top to bottom: what you did
  // (recap counts), how it read across the four kinds of call
  // (breakdown), then the trade-by-trade detail (review table).
  // ---------------------------------------------------------------
  function finishQuiz() {
    els.playScreen.style.display = "none";
    els.summaryScreen.style.display = "";

    const total = state.results.length;
    const entered = state.results.filter((r) => r.entered).length;
    const passed = total - entered;

    els.recap.innerHTML = `
      <div class="rewind-recap-stats">
        <div class="rewind-stat"><span class="rs-num">${total}</span><span class="rs-lbl">Trades reviewed</span></div>
        <div class="rewind-stat"><span class="rs-num">${entered}</span><span class="rs-lbl">Entered</span></div>
        <div class="rewind-stat"><span class="rs-num">${passed}</span><span class="rs-lbl">Passed</span></div>
      </div>
    `;

    function tally(field) {
      const t = { good: 0, warn: 0, bad: 0, neutral: 0 };
      state.results.forEach((r) => { if (r[field]) t[r[field]] = (t[r[field]] || 0) + 1; });
      return t;
    }
    const entryTally = tally("entryTone");
    const stopTally = tally("stopTone");
    const exitTally = tally("exitTone");
    const sizeTally = tally("sizeTone");
    function chipsHtml(t) {
      const parts = [];
      if (t.good) parts.push(`<span class="pill good">${t.good} good</span>`);
      if (t.warn) parts.push(`<span class="pill warn">${t.warn} off</span>`);
      if (t.bad) parts.push(`<span class="pill bad">${t.bad} bad</span>`);
      if (t.neutral) parts.push(`<span class="pill neutral">${t.neutral} n/a</span>`);
      return parts.join(" ") || `<span class="dim">—</span>`;
    }
    els.breakdown.innerHTML = `
      <div class="quiz-breakdown-row"><span class="br-k">Entry read</span><span class="br-chips">${chipsHtml(entryTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Stop placement</span><span class="br-chips">${chipsHtml(stopTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Exit timing</span><span class="br-chips">${chipsHtml(exitTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Position sizing</span><span class="br-chips">${chipsHtml(sizeTally)}</span></div>
    `;

    function tonePill(tone) {
      if (!tone) return `<span class="dim">—</span>`;
      const cls = tone === "good" ? "good" : tone === "bad" ? "bad" : tone === "warn" ? "warn" : "neutral";
      return `<span class="pill ${cls}">${escapeHtml(tone === "warn" ? "off" : tone)}</span>`;
    }
    els.review.innerHTML = `
      <table class="quiz-review-table">
        <thead><tr><th>Symbol</th><th>Setup</th><th>Actual outcome</th><th>You</th><th>Entry read</th><th>Stop</th><th>Exit</th><th></th></tr></thead>
        <tbody>
          ${state.results.map((r) => `<tr>
            <td>${escapeHtml(r.symbol)}</td>
            <td>${escapeHtml((r.setup_type || "—").replace(/_/g, " "))}</td>
            <td><span class="pill ${r.win ? "win" : "loss"}">${r.win ? "Win" : "Loss"}</span></td>
            <td>${r.entered ? "Entered" : "Passed"}</td>
            <td>${tonePill(r.entryTone)}</td>
            <td>${tonePill(r.stopTone)}</td>
            <td>${tonePill(r.exitTone)}</td>
            <td>${r.source === "backtest" ? `<span class="dim">—</span>` : `<a href="trade.html?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">view</a>`}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    `;

    const toReview = {};
    state.results.forEach((r) => { if (r.entryTone !== "good") toReview[r.setup_type || "unspecified"] = (toReview[r.setup_type || "unspecified"] || 0) + 1; });
    const sessionSource = state.results.length && state.results.every((r) => r.source === "backtest") ? "backtest" : "log";
    saveHistoryEntry({ date: new Date().toISOString().slice(0, 10), count: total, entered, passed, entryTally, toReview, source: sessionSource });
  }

  els.againBtn.addEventListener("click", () => {
    const filters = state.lastFilters || getFilters();
    const rows = getCandidateRows(filters);
    if (state.source === "backtest") rows.forEach((r) => { state.detailCache[r.id] = r; });
    startQuiz(filters, rows.map((r) => r.id));
  });
  els.reviewMissedBtn.addEventListener("click", async () => {
    const shakyIds = state.results.filter((r) => r.entryTone !== "good").map((r) => r.id);
    if (!shakyIds.length) { await UIModal.alert("Nothing to revisit — every entry read as a good call!", { title: "Nothing shaky here" }); return; }
    const filters = state.lastFilters || getFilters();
    startQuiz(filters, shakyIds);
  });
  els.backToSetupBtn.addEventListener("click", goToSetupScreen);

})();
