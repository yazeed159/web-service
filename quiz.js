(function () {
  "use strict";

  // ==================================================================
  // Chart-reading quiz built entirely from data/trades.json +
  // data/trades/<id>.json — the same files journal.html/trade.html
  // already read. No backend, no chart_service.py call: every bar,
  // indicator, and lesson used here was already published for that
  // trade, so the quiz just crops what's shown and asks about it
  // before letting you see the rest.
  // ==================================================================

  const HISTORY_KEY = "quiz:history";
  const HISTORY_MAX = 50;

  const els = {
    setupScreen: document.getElementById("quiz-setup-screen"),
    playScreen: document.getElementById("quiz-play-screen"),
    summaryScreen: document.getElementById("quiz-summary-screen"),
    setupSelect: document.getElementById("qf-setup"),
    resultSelect: document.getElementById("qf-result"),
    countRow: document.getElementById("qf-count-row"),
    blindCheck: document.getElementById("qf-blind"),
    tickModeRow: document.getElementById("qf-tickmode-row"),
    tickModeHint: document.getElementById("qf-tickmode-hint"),
    candidateCount: document.getElementById("qf-candidate-count"),
    startBtn: document.getElementById("qf-start-btn"),
    historyBox: document.getElementById("quiz-history-box"),
    focusBox: document.getElementById("quiz-focus-box"),
    progressLabel: document.getElementById("qp-progress-label"),
    progressFill: document.getElementById("qp-progress-fill"),
    scoreChip: document.getElementById("qp-score-chip"),
    streak: document.getElementById("qp-streak"),
    quitBtn: document.getElementById("qp-quit-btn"),
    card: document.getElementById("quiz-card"),
    scoreWrap: document.getElementById("qs-score-wrap"),
    breakdown: document.getElementById("qs-breakdown"),
    review: document.getElementById("qs-review"),
    againBtn: document.getElementById("qs-again-btn"),
    reviewMissedBtn: document.getElementById("qs-review-missed-btn"),
    backToSetupBtn: document.getElementById("qs-setup-btn"),
  };

  const state = {
    index: [],
    detailCache: {},
    queue: [],
    qIndex: 0,
    blind: true,
    tickMode: "sim", // "sim" (synthesized, offline) or "real" (live prints from chart_service.py)
    results: [],
    streak: 0,
    lastFilters: null,
    current: null, // the in-progress question's working state
    recordedIds: new Set(), // trade ids already counted toward the score this quiz — retries don't double-count
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
    { shares: 50, label: "Small", sub: "50 sh · low conviction" },
    { shares: SIZE_BASELINE, label: "Standard", sub: "100 sh" },
    { shares: 200, label: "Large", sub: "200 sh · high conviction" },
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
  const REPLAY_SECONDS = 30; // sub-ticks synthesized per 1-min bar

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

  // Ticks for the "watch it print in" replay on the entry stage — only
  // the window from the bar's open up to the actual fill instant, so
  // real mode never leaks anything past the moment you're deciding at
  // (and sim mode is truncated + pinned to the real fill for the same
  // reason — see buildFormingBar above).
  function getEntryWatchTicks(trade, bar, prevClose, secondsIntoBar) {
    const simPrices = () => {
      const full = genSecondTicks(bar, prevClose, `${trade.id}:entrywatch`);
      const frac = Math.max(0, Math.min(1, secondsIntoBar / BAR_SECONDS));
      const cut = Math.max(1, Math.round(frac * REPLAY_SECONDS));
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

  // Auto-plays through `ticks`, one per `tickMs`, updating a live price
  // readout. `actions` is a list of {id, label, kbd, cls} buttons that are
  // clickable at any point during playback; clicking one locks in the
  // current second and price and stops playback. If nobody clicks before
  // the ticks run out, `defaultActionId` fires automatically on the last
  // second. Returns { stop } to let a caller tear it down early (e.g. the
  // quiz question changes underneath it).
  function runSecondReplay(container, ticks, opts) {
    const tickMs = opts.tickMs || 150;
    const unitLabel = opts.unitLabel || "second";
    const tag = opts.tag || "simulated seconds";
    const tagCls = opts.tagCls ? ` ${opts.tagCls}` : "";
    container.innerHTML = `
      <div class="quiz-replay-panel">
        <div class="quiz-replay-top">
          <span class="quiz-replay-price"></span>
          <span class="quiz-replay-tag${tagCls}">${escapeHtml(tag)}</span>
        </div>
        ${opts.fallbackNote ? `<div class="quiz-replay-fallback">${escapeHtml(opts.fallbackNote)}</div>` : ""}
        <div class="quiz-replay-track"><div class="quiz-replay-bar" id="qz-replay-fill"></div></div>
        <div class="quiz-replay-row" id="qz-replay-actions"></div>
        <div class="quiz-replay-sec" id="qz-replay-sec" style="margin-top:8px;"></div>
      </div>
    `;
    const priceEl = container.querySelector(".quiz-replay-price");
    const fillEl = container.querySelector("#qz-replay-fill");
    const secEl = container.querySelector("#qz-replay-sec");
    const actionsEl = container.querySelector("#qz-replay-actions");
    (opts.actions || []).forEach((a) => {
      const btn = document.createElement("button");
      btn.id = `qz-${a.id}`;
      btn.className = `quiz-answer-btn ${a.cls || ""}`;
      btn.innerHTML = `${escapeHtml(a.label)}${a.kbd ? ` <span class="kbd">${escapeHtml(a.kbd)}</span>` : ""}`;
      btn.addEventListener("click", () => finish(a.id));
      actionsEl.appendChild(btn);
    });

    // If given a live chart + the raw bar being replayed, push a real
    // forming candle that grows/wicks with each tick instead of just
    // updating the text readout -- same forming-candle look/colors the
    // entry stage uses for its own partial bar.
    const liveChart = opts.chartHandle && opts.bar ? opts.chartHandle : null;
    const barTime = liveChart ? toUnix(opts.bar.t) : null;
    let runningHigh = liveChart ? opts.bar.o : null;
    let runningLow = liveChart ? opts.bar.o : null;
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
        const frac = (idx + 1) / ticks.length;
        liveChart.volSeries.update({ time: barTime, value: Math.round((opts.bar.v || 0) * frac), color: "rgba(232,169,76,0.4)" });
      }
    }
    if (liveChart) {
      // Seed a zero-range candle before ticking so there's room for it on
      // the timescale, then make sure that room is actually visible.
      paintCandle(0);
      try { liveChart.chart.timeScale().fitContent(); } catch (e) {}
    }

    let i = 0, done = false, timer = null;
    function paint() {
      priceEl.textContent = "$" + fmtPrice(ticks[i]);
      secEl.textContent = `${unitLabel} ${i + 1} of ${ticks.length}`;
      fillEl.style.width = `${((i + 1) / ticks.length) * 100}%`;
      paintCandle(i);
    }
    function finish(actionId) {
      if (done) return;
      done = true;
      clearInterval(timer);
      actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true));
      opts.onAct && opts.onAct(actionId, i, ticks[i]);
    }
    // Lets a caller watch every printed tick without waiting for the replay
    // to finish -- used to auto-trigger a stop-loss the instant price
    // crosses it, same as it would in a real fill.
    function checkTick() { if (opts.onTick) opts.onTick(ticks[i], i); }
    paint();
    checkTick();
    timer = setInterval(() => {
      if (done) return;
      if (i >= ticks.length - 1) {
        clearInterval(timer);
        // onExhausted lets a caller move on (e.g. to the next bar) instead
        // of forcing a default action once the tape runs out -- falls back
        // to the old auto-fire-defaultActionId behavior when not given.
        if (opts.onExhausted) { done = true; actionsEl.querySelectorAll("button").forEach((b) => (b.disabled = true)); opts.onExhausted(); }
        else finish(opts.defaultActionId);
        return;
      }
      i++;
      paint();
      checkTick();
    }, tickMs);
    return { stop: () => { done = true; clearInterval(timer); } };
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
    } catch (e) { /* ignore — quiz still works without persistence */ }
  }

  // ---------------------------------------------------------------
  // boot: load the index, populate the setup screen
  // ---------------------------------------------------------------
  fetch("data/trades.json")
    .then((r) => (r.ok ? r.json() : []))
    .then((rows) => {
      state.index = Array.isArray(rows) ? rows : [];
      populateSetupOptions();
      renderCandidateCount();
      renderHistoryPanel();
    })
    .catch(() => {
      els.candidateCount.textContent = "Couldn't load data/trades.json.";
      els.startBtn.disabled = true;
    });

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

  function filterIndex(filters) {
    return state.index.filter((r) => {
      if (!r.id) return false;
      if (filters.setup && r.setup_type !== filters.setup) return false;
      if (filters.result === "win" && !r.win) return false;
      if (filters.result === "loss" && r.win) return false;
      if (filters.result === "flagged" && !(r.better_entry_price != null || r.better_exit_price != null)) return false;
      return true;
    });
  }

  function renderCandidateCount() {
    const filters = getFilters();
    const n = filterIndex(filters).length;
    els.candidateCount.innerHTML = `<b>${n}</b> matching trade${n === 1 ? "" : "s"} in your journal.`;
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
    startQuiz(filters, filterIndex(filters).map((r) => r.id));
  });

  function renderHistoryPanel() {
    const history = loadHistory();
    if (!history.length) {
      els.historyBox.innerHTML = `<div class="quiz-history-empty">No quizzes taken yet — your accuracy trend will show up here.</div>`;
      els.focusBox.innerHTML = "";
      return;
    }
    const recent = history.slice(-8).reverse();
    els.historyBox.innerHTML = recent.map((h) => {
      const color = h.accuracy >= 70 ? "var(--green)" : h.accuracy >= 40 ? "var(--amber)" : "var(--red)";
      return `<div class="quiz-history-row">
        <span class="hr-date">${escapeHtml(h.date)}</span>
        <span class="hr-track"><span class="hr-fill" style="width:${Math.max(4, h.accuracy)}%; background:${color}"></span></span>
        <span class="hr-val" style="color:${color}">${h.accuracy}% · ${h.count}q</span>
      </div>`;
    }).join("");

    const missTotals = {};
    history.forEach((h) => {
      Object.entries(h.missedSetups || {}).forEach(([k, v]) => { missTotals[k] = (missTotals[k] || 0) + v; });
    });
    const top = Object.entries(missTotals).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (!top.length) { els.focusBox.innerHTML = ""; return; }
    els.focusBox.innerHTML = `<div class="panel-box-head" style="margin-bottom:8px;"><span class="title">Setups to review</span></div>
      <div class="quiz-focus-list">
        ${top.map(([setup, n]) => `<a class="quiz-focus-item" href="playbooks.html?setup=${encodeURIComponent(setup)}">
          <span>${escapeHtml(setup.replace(/_/g, " "))}</span>
          <span class="fi-count">missed ${n}×</span>
        </a>`).join("")}
      </div>`;
  }

  // ---------------------------------------------------------------
  // chart building — a slimmed-down version of trade.js's chart, since
  // the quiz only needs candles + volume + VWAP/EMA overlays, cropped
  // to whatever the current stage should reveal.
  // ---------------------------------------------------------------
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
    const chart = LightweightCharts.createChart(el, { ...commonOpts, width: el.clientWidth, height: opts.height || 380 });
    const series = chart.addCandlestickSeries({
      upColor: "#2fd08a", downColor: "#f2555a", borderVisible: false,
      wickUpColor: "#2fd08a", wickDownColor: "#f2555a",
    });
    series.setData(candleData);
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.12, bottom: 0.2 } });

    const volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol" });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volSeries.setData(volData);

    chart.addLineSeries({ color: "#e8a94c", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(vwapData);
    chart.addLineSeries({ color: "#9aa8a1", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema9Data);
    chart.addLineSeries({ color: "#5b93f0", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(ema20Data);

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
    return { chart, series, volSeries, priceLineRefs, resizeObserver: ro };
  }
  function teardownChart(handle) {
    if (!handle) return;
    try { if (handle.resizeObserver) handle.resizeObserver.disconnect(); } catch (e) {}
    try { if (handle.pointerRo) handle.pointerRo.disconnect(); } catch (e) {}
    try { handle.chart.remove(); } catch (e) {}
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
    state.streak = 0;
    state.recordedIds = new Set();
    els.setupScreen.style.display = "none";
    els.summaryScreen.style.display = "none";
    els.playScreen.style.display = "";
    loadQuestion();
  }

  function fetchDetail(id) {
    if (state.detailCache[id]) return Promise.resolve(state.detailCache[id]);
    return fetch(`data/trades/${encodeURIComponent(id)}.json`)
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((trade) => { state.detailCache[id] = trade; return trade; });
  }

  function updateHeaderChrome() {
    els.progressLabel.textContent = `Question ${Math.min(state.qIndex + 1, state.queue.length)} / ${state.queue.length}`;
    els.progressFill.style.width = `${(state.qIndex / state.queue.length) * 100}%`;
    const correct = state.results.filter((r) => r.entryCorrect).length;
    els.scoreChip.textContent = state.results.length ? `${correct}/${state.results.length} correct calls` : "";
    els.streak.textContent = state.streak >= 2 ? `🔥 ${state.streak} in a row` : "";
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
      watchIdx: null, // bar currently playing in the post-entry watch stage
      checkpointAction: null, // "exit" once you click Exit; stays null if you watch through to the end of the data
      exitBarIdx: null, // bar index your chosen exit tick fell in
      chartHandle: null,
      replayHandle: null,
      userExitPrice: null,
      exitSecond: null,
      userShares: SIZE_BASELINE,
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
  // decision time — we don't want to show its eventual high/low if those
  // were set after (or are simply unrelated to) the actual fill. We only
  // know: the bar's open, and the fill price itself. So the "live" candle
  // shown pre-decision is built from just those two points, clamped so it
  // can never leak the bar's real (future-relative-to-entry) extremes.
  function buildFormingBar(fullBar, fillPrice, secondsIntoBar) {
    const frac = Math.max(0, Math.min(1, secondsIntoBar / BAR_SECONDS));
    return {
      t: fullBar.t,
      o: fullBar.o,
      h: Math.max(fullBar.o, fillPrice),
      l: Math.min(fullBar.o, fillPrice),
      c: fillPrice,
      v: Math.round((fullBar.v || 0) * frac),
      vwap: fullBar.vwap, ema9: fullBar.ema9, ema20: fullBar.ema20,
      _forming: true,
    };
  }

  function renderEntryStage() {
    const c = state.current;
    const trade = c.trade;
    const label = displayLabel(trade);
    const entryBar = c.bars[c.entryIdx];
    const entryUnix = toUnix(`${trade.trade_date} ${trade.entry_time}`);
    const secondsIntoBar = Math.max(0, entryUnix - toUnix(entryBar.t));
    const secondsRemaining = Math.max(0, BAR_SECONDS - secondsIntoBar);
    const formingBar = buildFormingBar(entryBar, trade.entry_price, secondsIntoBar);
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
          <span class="quiz-live-badge"><span class="quiz-live-dot"></span>${secondsRemaining}s left on this candle</span>
        </span>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>
      <div class="quiz-prompt">
        Price is at <b>$${fmtPrice(trade.entry_price)}</b> and this candle is still forming — you're deciding mid-bar, not after the close. This is a <b>${sidePretty}</b> setup. <b>Would you enter here?</b>
      </div>
      <div class="quiz-answer-row" id="quiz-entry-answer-row">
        <button class="quiz-answer-btn enter" id="qz-enter">Enter the trade <span class="kbd">Y</span></button>
        <button class="quiz-answer-btn pass" id="qz-pass">Pass <span class="kbd">N</span></button>
      </div>
      <button class="quiz-watch-btn" id="qz-watch-entry">▶ Watch it print in, tick by tick</button>
      <div id="quiz-entry-replay-slot"></div>
      <div id="quiz-stop-slot"></div>
    `;

    teardownChart(c.chartHandle);
    c.chartHandle = buildChart(document.getElementById("quiz-candle-chart"), visibleBars, { height: 380 });

    document.getElementById("qz-enter").addEventListener("click", () => handleEntryChoice(true, trade.entry_price));
    document.getElementById("qz-pass").addEventListener("click", () => handleEntryChoice(false));

    // Watching the tape is how you actually time your entry: press Enter
    // (or Pass) at whatever moment feels right while the ticks print in,
    // and that tick's price -- not necessarily the real fill -- becomes
    // your entry price. If you never click and it runs out, it defaults
    // to entering right at the real fill (same as not watching at all).
    const watchBtn = document.getElementById("qz-watch-entry");
    const answerRow = document.getElementById("quiz-entry-answer-row");
    const prevCloseEntry = c.entryIdx > 0 ? c.bars[c.entryIdx - 1].c : entryBar.o;
    watchBtn.addEventListener("click", () => {
      watchBtn.disabled = true;
      watchBtn.textContent = state.tickMode === "real" ? "Loading real ticks…" : "Loading…";
      getEntryWatchTicks(trade, entryBar, prevCloseEntry, secondsIntoBar).then(({ prices, real, fellBack }) => {
        if (state.current !== c || c.stage !== "entry") return;
        try {
        watchBtn.style.display = "none";
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
          defaultActionId: "enter",
          chartHandle: c.chartHandle,
          bar: entryBar,
          onAct: (actionId, tickIdx, price) => handleEntryChoice(actionId === "enter", price),
        });
        } catch (err) { showStageError(err); }
      }).catch(showStageError);
    });

    c.stage = "entry";
  }

  function handleEntryChoice(entered, price) {
    const c = state.current;
    try {
    if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; } // stop an in-progress "watch it print in" replay
    c.entered = entered;
    if (entered) c.userEntryPrice = Number.isFinite(price) ? price : c.trade.entry_price;
    const enterBtn = document.getElementById("qz-enter");
    const passBtn = document.getElementById("qz-pass");
    if (enterBtn) enterBtn.disabled = true;
    if (passBtn) passBtn.disabled = true;
    if (entered) renderStopStage();
    else goToReveal();
    } catch (err) { showStageError(err); }
  }

  // ---------- Stage B: stop-loss + position size ----------
  function renderStopStage() {
    const c = state.current;
    const trade = c.trade;
    const entryPrice = c.userEntryPrice;
    const slot = document.getElementById("quiz-stop-slot");
    slot.innerHTML = `
      <div class="quiz-stop-panel">
        <div class="quiz-prompt" style="margin-top:0;">You're in. <b>Where's your stop-loss?</b> Pick a quick option, type a price, or click the chart to place it.</div>
        <div class="quiz-preset-row" id="quiz-stop-presets">
          ${STOP_PRESETS.map((p) => `<button class="quiz-preset-btn" data-pct="${p.pct}">${p.label} <span class="dim">· ${p.sub}</span></button>`).join("")}
          <button class="quiz-preset-btn active" data-pct="">Custom</button>
        </div>
        <div class="quiz-stop-row">
          <input type="number" step="0.0001" id="quiz-stop-input" placeholder="e.g. ${fmtPrice(c.side === "short" ? entryPrice * 1.02 : entryPrice * 0.98)}">
        </div>
        <div class="quiz-risk-preview" id="quiz-risk-preview"></div>

        <div class="quiz-prompt">
          <b>How much size?</b> Size up on trades you like, size down on ones you're not sure about — pick a quick option or set your own.
        </div>
        <div class="quiz-preset-row" id="quiz-size-presets">
          ${SIZE_PRESETS.map((p) => `<button class="quiz-preset-btn${p.shares === SIZE_BASELINE ? " active" : ""}" data-shares="${p.shares}">${p.label} <span class="dim">· ${p.sub}</span></button>`).join("")}
          <button class="quiz-preset-btn" data-shares="">Custom</button>
        </div>
        <div class="quiz-size-row">
          <input type="number" step="1" min="1" id="quiz-size-input" value="${SIZE_BASELINE}">
          <span class="quiz-size-unit">shares</span>
        </div>
        <div class="quiz-size-preview" id="quiz-size-risk-preview"></div>

        <div class="quiz-stop-row" style="margin-top:16px;">
          <button class="quiz-answer-btn enter" id="quiz-stop-confirm" style="flex:none; min-width:190px;">Lock in stop &amp; size <span class="kbd">↵</span></button>
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
        const pct = Number(btn.dataset.pct);
        if (pct) {
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
      stopPresetBtns.forEach((b) => b.classList.toggle("active", b.dataset.pct === ""));
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
      stopPresetBtns.forEach((b) => b.classList.toggle("active", b.dataset.pct === ""));
      setPreview(price);
    });

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

  // ---------- Stage C: watch continuously from your entry until you exit ----------
  // Instead of jumping to one designated "checkpoint" bar, you now keep
  // watching bar after bar -- tick by tick -- from right after your entry
  // for as long as there's chart left to show. You can click Exit at any
  // point during any of it. Your own stop is checked live against every
  // tick as it prints, so it can trigger mid-bar exactly like a real fill
  // would, regardless of where the real entry/exit actually landed.
  function renderWatchStage() {
    const c = state.current;
    c.watchIdx = c.entryIdx + 1;
    if (c.watchIdx > c.bars.length - 1) {
      // Nothing left to watch after entry -- go straight to reveal, same
      // outcome as watching through to the end of the data and never
      // clicking Exit.
      goToReveal();
      return;
    }
    renderWatchBar();
  }

  function renderWatchBar() {
    const c = state.current;
    try {
    const trade = c.trade;
    const entryPrice = c.userEntryPrice;
    // Everything before the bar currently playing is settled chart history;
    // the current bar plays out second by second below instead of showing
    // as an already-closed candle.
    const historyBars = c.bars.slice(0, c.watchIdx);
    const bar = c.bars[c.watchIdx];
    const prevClose = historyBars.length ? historyBars[historyBars.length - 1].c : entryPrice;
    const unrealized = pnlPerShare(entryPrice, prevClose, c.side);
    const clockStr = new Date(bar.t.replace(" ", "T")).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const minutesIn = c.watchIdx - c.entryIdx;

    els.card.innerHTML = `
      <div class="quiz-card-head">
        <div class="quiz-symbol-line">
          <span>${escapeHtml(displayLabel(trade).name)}</span>
          <span class="side-pill ${c.side}">${c.side}</span>
        </div>
        <span class="quiz-clock">${escapeHtml(clockStr)} <span class="dim" style="font-weight:400;">· ${minutesIn} min in</span></span>
      </div>
      <div class="quiz-chart-wrap"><div id="quiz-candle-chart"></div></div>
      <div class="quiz-prompt">
        You're in at <b>$${fmtPrice(entryPrice)}</b>, stop at <b>$${fmtPrice(c.stopPrice)}</b>.
        Unrealized so far: <b style="color:${unrealized >= 0 ? "var(--green)" : "var(--red)"}">${fmtSignedPerShare(unrealized)}/sh</b>.
        Keep watching for as long as you like — <b>click Exit whenever you'd get out</b>.
      </div>
      <div id="quiz-replay-slot"></div>
    `;
    c.stage = "watch";

    teardownChart(c.chartHandle);
    const watchPriceLines = [
      { price: entryPrice, color: COLOR_YOUR_ENTRY, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "your entry" },
      { price: c.stopPrice, color: COLOR_YOUR_STOP, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "your stop" },
    ];
    if (Math.abs(trade.entry_price - entryPrice) > 0.0001) {
      watchPriceLines.push({ price: trade.entry_price, color: COLOR_REAL_ENTRY, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "real entry" });
    }
    c.chartHandle = buildChart(document.getElementById("quiz-candle-chart"), historyBars.length ? historyBars : c.bars.slice(0, c.watchIdx + 1), {
      height: 380,
      priceLines: watchPriceLines,
    });

    const replaySlot = document.getElementById("quiz-replay-slot");
    replaySlot.innerHTML = `<div class="quiz-replay-loading">${state.tickMode === "real" ? "Loading real ticks from the server…" : "Loading…"}</div>`;

    const watchIdxAtFetch = c.watchIdx;
    getCheckpointTicks(trade, bar, prevClose).then(({ prices, real, fellBack }) => {
      if (state.current !== c || c.stage !== "watch" || c.watchIdx !== watchIdxAtFetch) return; // moved on while this was in flight
      try {
      c.replayHandle = runSecondReplay(replaySlot, prices, {
        unitLabel: real ? "tick" : "second",
        tag: real ? "live ticks · server" : "simulated seconds",
        tagCls: real ? "live" : "",
        fallbackNote: fellBack ? "No live ticks came back for this window — showing the simulated path instead." : "",
        actions: [
          { id: "exit", label: "Exit now", kbd: "E", cls: "exit" },
        ],
        chartHandle: c.chartHandle,
        bar,
        onTick: (price) => {
          const breached = c.side === "short" ? price >= c.stopPrice : price <= c.stopPrice;
          if (breached) {
            if (c.replayHandle) { c.replayHandle.stop(); c.replayHandle = null; }
            c.stoppedOutEarly = true;
            c.stopOutIdx = c.watchIdx;
            c.userExitPrice = c.stopPrice;
            goToReveal();
          }
        },
        onExhausted: () => {
          // This bar's tape ran out without you clicking Exit -- move
          // straight on to the next bar and keep the tape rolling.
          c.watchIdx += 1;
          if (c.watchIdx > c.bars.length - 1) { goToReveal(); return; } // out of chart to watch
          renderWatchBar();
        },
        onAct: (actionId, tickIdx, price) => {
          c.checkpointAction = actionId;
          c.exitBarIdx = c.watchIdx;
          c.exitSecond = tickIdx;
          c.userExitPrice = price;
          goToReveal();
        },
      });
      } catch (err) { showStageError(err); }
    }).catch(showStageError);
    } catch (err) { showStageError(err); }
  }

  // ---------- grading ----------
  function gradeEntry(win, entered) {
    if (entered && win) return { label: "Good call — this one was a real winner.", tone: "good", correct: true };
    if (entered && !win) return { label: "This one lost in real life too.", tone: "bad", correct: false };
    if (!entered && !win) return { label: "Good discipline — this one was a loser.", tone: "good", correct: true };
    return { label: "This one worked out — you'd have missed it.", tone: "warn", correct: false };
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

      if (c.stoppedOutEarly) {
        userPnlPerShare = pnlPerShare(entryPrice, c.stopPrice, side);
        userExitFillPrice = c.stopPrice;
        exitGrade = { label: `Stopped out at $${fmtPrice(c.stopPrice)} while you were watching.`, tone: "warn" };
      } else if (c.checkpointAction === "exit") {
        const exitPrice = Number.isFinite(c.userExitPrice) ? c.userExitPrice : trade.exit_price;
        userPnlPerShare = pnlPerShare(entryPrice, exitPrice, side);
        userExitFillPrice = exitPrice;
        const diff = actualPnl - userPnlPerShare;
        const threshold = Math.max(0.15 * Math.abs(actualPnl || 0.01), 0.01);
        if (diff > threshold) exitGrade = { label: `You exited early — the move kept going. Riding it to the real exit made ${fmtSignedPerShare(diff)}/sh more.`, tone: "warn" };
        else if (diff < -threshold) exitGrade = { label: "Good exit — price gave back a lot of that move afterward.", tone: "good" };
        else exitGrade = { label: "Reasonable exit, close to how the trade actually played out.", tone: "good" };
      } else {
        // Never clicked Exit and never got stopped -- you watched all the
        // way through to the end of the available chart, same as holding.
        userPnlPerShare = actualPnl;
        userExitFillPrice = trade.exit_price;
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
    const grading = computeGrading(c);
    c.stage = "reveal";

    // Only the first pass through a given question counts toward the score —
    // hitting "Retry this question" lets you replay it for practice without
    // inflating (or resetting) your tally on the same trade.
    if (!state.recordedIds.has(trade.id)) {
      state.recordedIds.add(trade.id);
      state.results.push({
        id: trade.id, symbol: trade.symbol, setup_type: trade.setup_type, win: !!trade.win,
        entered: c.entered, entryCorrect: grading.entryGrade.correct,
        stopTone: grading.stopGrade ? grading.stopGrade.tone : null,
        exitTone: grading.exitGrade ? grading.exitGrade.tone : null,
        sizeTone: grading.sizeGrade ? grading.sizeGrade.tone : null,
      });
      state.streak = grading.entryGrade.correct ? state.streak + 1 : 0;
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
    if (c.stoppedOutEarly && c.stopOutIdx != null) {
      pointerDefs.push({ time: toUnix(c.bars[c.stopOutIdx].t), price: c.stopPrice, color: COLOR_STOP_EVENT, above: false, tooltip: `STOPPED OUT $${fmtPrice(c.stopPrice)}` });
    } else if (c.entered && c.checkpointAction === "exit" && c.exitBarIdx != null) {
      pointerDefs.push({ time: toUnix(c.bars[c.exitBarIdx].t), price: c.userExitPrice, color: COLOR_YOUR_EXIT, above: false, tooltip: `TEST EXIT $${fmtPrice(c.userExitPrice)}` });
    }

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
    // Your own exit fill gets its own line too, not just a pointer --
    // same treatment as "your stop" -- so its price is readable off the
    // right axis even without hovering. Skipped when you were stopped out
    // (that price already has a line via "your stop") or never exited.
    if (c.entered && !c.stoppedOutEarly && c.checkpointAction === "exit" && c.exitBarIdx != null) {
      priceLines.push({ price: c.userExitPrice, color: COLOR_YOUR_EXIT, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted, axisLabelVisible: true, title: "test exit" });
    }

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

    // "Real numbers" -- the actual trade's logged fill/commission/timing,
    // plus what your own size/entry/exit would've cost using IBKR's real
    // tiered commission schedule (per-share rate with a per-order floor
    // and ceiling) rather than just scaling the actual trade's commission
    // linearly by share count, which silently ignores both of those.
    const tradeCommission = Number(trade.commission) || 0;
    const tradeShares = Number(trade.shares) || 0;
    const userGross = c.entered && Number.isFinite(grading.userPnlPerShare) ? grading.userPnlPerShare * c.userShares : null;
    const userEntryCommission = (c.entered && c.userEntryPrice != null) ? ibkrTieredCommission(c.userShares, c.userEntryPrice) : 0;
    const userExitCommission = (c.entered && grading.userExitFillPrice != null) ? ibkrTieredCommission(c.userShares, grading.userExitFillPrice) : 0;
    const userCommission = c.entered ? userEntryCommission + userExitCommission : null;
    const userNet = (userGross != null && userCommission != null) ? userGross - userCommission : null;

    const lessonsHtml = (trade.lessons || []).map((l) => {
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
          <div class="rb-line">Net P&amp;L: <b style="color:${trade.pnl_after_comm >= 0 ? "var(--green)" : "var(--red)"}">${trade.pnl_after_comm >= 0 ? "+" : "-"}$${Math.abs(trade.pnl_after_comm).toFixed(2)}</b> actual${c.entered && userNet != null ? ` · <b style="color:${userNet >= 0 ? "var(--green)" : "var(--red)"}">${userNet >= 0 ? "+" : "-"}$${Math.abs(userNet).toFixed(2)}</b> yours` : ""}</div>
        </div>
      </div>

      ${trade.verdict ? `<div class="quiz-verdict-box"><span class="vb-label">What actually happened</span>${escapeHtml(trade.verdict)}</div>` : ""}
      ${lessonsHtml ? `<ul class="quiz-lesson-list">${lessonsHtml}</ul>` : ""}
      ${trade.walk_away_rule ? `<div class="quiz-walkaway"><b>Walk-away rule:</b> ${escapeHtml(trade.walk_away_rule)}</div>` : ""}

      <div class="quiz-next-row">
        <button class="btn-advanced" id="qz-replay-again-btn" type="button">↻ Retry this question</button>
        <a class="btn-advanced" href="trade.html?id=${encodeURIComponent(trade.id)}" target="_blank" rel="noopener">Open full trade page</a>
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
    } else if (c.stage === "reveal" && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      document.getElementById("qz-next")?.click();
    }
  });

  els.quitBtn.addEventListener("click", () => {
    if (!confirm("End this quiz? Your progress on the current question won't be saved.")) return;
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
  // session summary
  // ---------------------------------------------------------------
  function finishQuiz() {
    els.playScreen.style.display = "none";
    els.summaryScreen.style.display = "";

    const total = state.results.length;
    const correct = state.results.filter((r) => r.entryCorrect).length;
    const accuracy = total ? Math.round((correct / total) * 100) : 0;
    const color = accuracy >= 70 ? "var(--green)" : accuracy >= 40 ? "var(--amber)" : "var(--red)";
    const r = 58, circ = 2 * Math.PI * r;
    const dash = (accuracy / 100) * circ;

    els.scoreWrap.innerHTML = `
      <div class="score-gauge">
        <svg viewBox="0 0 132 132">
          <circle class="track" cx="66" cy="66" r="${r}"></circle>
          <circle class="fill" cx="66" cy="66" r="${r}" stroke="${color}" stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"></circle>
        </svg>
        <div class="center">
          <span class="num" style="color:${color}">${accuracy}</span>
          <span class="lbl">Read score</span>
        </div>
      </div>
      <div class="score-breakdown">
        <div class="score-row"><span class="k">Entry calls</span>
          <span class="track"><span class="fill" style="width:${Math.max(4, accuracy)}%; background:${color}"></span></span>
          <span class="v">${correct}/${total}</span>
        </div>
      </div>
    `;

    function tally(field) {
      const t = { good: 0, warn: 0, bad: 0, neutral: 0 };
      state.results.forEach((r) => { if (r[field]) t[r[field]] = (t[r[field]] || 0) + 1; });
      return t;
    }
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
      <div class="quiz-breakdown-row"><span class="br-k">Stop placement</span><span class="br-chips">${chipsHtml(stopTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Exit timing</span><span class="br-chips">${chipsHtml(exitTally)}</span></div>
      <div class="quiz-breakdown-row"><span class="br-k">Position sizing</span><span class="br-chips">${chipsHtml(sizeTally)}</span></div>
    `;

    els.review.innerHTML = `
      <table class="quiz-review-table">
        <thead><tr><th>Symbol</th><th>Setup</th><th>Outcome</th><th>Your call</th><th>Stop</th><th>Exit</th><th></th></tr></thead>
        <tbody>
          ${state.results.map((r) => `<tr>
            <td>${escapeHtml(r.symbol)}</td>
            <td>${escapeHtml((r.setup_type || "—").replace(/_/g, " "))}</td>
            <td><span class="pill ${r.win ? "win" : "loss"}">${r.win ? "Win" : "Loss"}</span></td>
            <td>${r.entryCorrect ? "✅" : "❌"} ${r.entered ? "Entered" : "Passed"}</td>
            <td>${r.stopTone ? `<span class="pill ${r.stopTone === "good" ? "good" : r.stopTone === "bad" ? "bad" : r.stopTone === "warn" ? "warn" : "neutral"}">${escapeHtml(r.stopTone)}</span>` : "—"}</td>
            <td>${r.exitTone ? `<span class="pill ${r.exitTone === "good" ? "good" : r.exitTone === "bad" ? "bad" : r.exitTone === "warn" ? "warn" : "neutral"}">${escapeHtml(r.exitTone)}</span>` : "—"}</td>
            <td><a href="trade.html?id=${encodeURIComponent(r.id)}" target="_blank" rel="noopener">view</a></td>
          </tr>`).join("")}
        </tbody>
      </table>
    `;

    const missedSetups = {};
    state.results.forEach((r) => { if (!r.entryCorrect) missedSetups[r.setup_type || "unspecified"] = (missedSetups[r.setup_type || "unspecified"] || 0) + 1; });
    saveHistoryEntry({ date: new Date().toISOString().slice(0, 10), count: total, accuracy, missedSetups });
  }

  els.againBtn.addEventListener("click", () => {
    const filters = state.lastFilters || getFilters();
    startQuiz(filters, filterIndex(filters).map((r) => r.id));
  });
  els.reviewMissedBtn.addEventListener("click", () => {
    const missedIds = state.results.filter((r) => !r.entryCorrect).map((r) => r.id);
    if (!missedIds.length) { alert("Nothing to review — you called every entry right!"); return; }
    const filters = state.lastFilters || getFilters();
    startQuiz(filters, missedIds);
  });
  els.backToSetupBtn.addEventListener("click", goToSetupScreen);

})();
